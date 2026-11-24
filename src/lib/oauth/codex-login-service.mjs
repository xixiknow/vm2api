/**
 * External login service for GPT (Codex) slots: email + password + TOTP secret → OAuth tokens.
 *
 * Protocol (sub2api relogin endpoint, plus `proxy`):
 *   POST {endpoint} {"action":"start","email","auth_mode":"password_2fa","password","mfa_secret","proxy"?}
 *   → NDJSON events or one JSON value. The first `{type:"result",payload}`, or object carrying
 *     `credential` / `error` / a terminal `status`, decides the outcome; heartbeats are skipped.
 *
 * The service receives the account password, the long-lived TOTP secret and the slot's proxy
 * credentials, so it must be self-hosted or fully trusted. Nothing here logs or echoes them:
 * failures surface as short codes only.
 */
import crypto from 'node:crypto'
import net from 'node:net'
import nodeFetch from 'node-fetch'
import { encryptionEnabled, maybeDecrypt, maybeEncrypt } from '../db/secure.mjs'
import { parseCodexCredentialInput } from '../vm/codex-slot.mjs'
import { openaiIdentityFromOauthTokens } from './openai-jwt.mjs'

export const CODEX_LOGIN_SERVICE_KEY = 'codex_login_service'
export const SECRET_KEEP = '__KEEP__'

const MAX_HEADERS = 20
const MAX_HEADER_VALUE = 512
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const IDLE_TIMEOUT_MS = 60_000
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'accept-encoding',
])
const TERMINAL_STATUS = new Set(['active', 'ok', 'success', 'succeeded', 'failed', 'error', 'auth_failed'])
const SUCCESS_STATUS = new Set(['active', 'ok', 'success', 'succeeded'])
const CREDENTIAL_FIELDS = [
  'access_token',
  'refresh_token',
  'id_token',
  'account_id',
  'chatgpt_account_id',
  'chatgpt_user_id',
  'user_id',
  'client_id',
  'plan_type',
]

export const DEFAULT_GUARD_RULES = Object.freeze({
  probe_interval_min: 30,
  recheck_interval_min: 5,
  fail_threshold: 2,
  relogin_cooldown_min: 30,
  max_relogin_failures: 3,
})

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (value === '' || value == null || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function normalizeGuardRules(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const d = DEFAULT_GUARD_RULES
  return {
    probe_interval_min: clampInt(src.probe_interval_min, 5, 24 * 60, d.probe_interval_min),
    recheck_interval_min: clampInt(src.recheck_interval_min, 1, 120, d.recheck_interval_min),
    fail_threshold: clampInt(src.fail_threshold, 1, 10, d.fail_threshold),
    relogin_cooldown_min: clampInt(src.relogin_cooldown_min, 5, 7 * 24 * 60, d.relogin_cooldown_min),
    max_relogin_failures: clampInt(src.max_relogin_failures, 1, 20, d.max_relogin_failures),
  }
}

function headerNameOk(name) {
  return HEADER_NAME.test(name) && !RESERVED_HEADERS.has(name.toLowerCase())
}

/** Stored shape. Header values stay as stored (encrypted when a DB secret is set). */
export function normalizeServiceConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const headers = []
  for (const row of Array.isArray(src.headers) ? src.headers : []) {
    const name = String(row?.name || '').trim()
    const value = row?.value == null ? '' : String(row.value)
    if (!headerNameOk(name) || !value) continue
    if (headers.some((h) => h.name.toLowerCase() === name.toLowerCase())) continue
    headers.push({ name, value })
    if (headers.length >= MAX_HEADERS) break
  }
  return {
    endpoint: String(src.endpoint || '').trim(),
    headers,
    timeout_min: clampInt(src.timeout_min, 1, 60, 25),
    batch_concurrency: clampInt(src.batch_concurrency, 1, 8, 2),
    guard_enabled: src.guard_enabled !== false,
    guard: normalizeGuardRules(src.guard),
  }
}

/** Loopback, RFC 1918 / ULA / link-local, and single-label or internal names (Docker services). */
export function isPrivateHost(hostname) {
  const host = String(hostname || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
  if (!host) return false
  const version = net.isIP(host)
  if (version === 4) {
    const [a, b] = host.split('.').map(Number)
    return (
      a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
    )
  }
  if (version === 6) return host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)
  if (host === 'localhost' || !host.includes('.')) return true
  return /\.(localhost|internal|local|lan|home\.arpa)$/.test(host)
}

/** Empty clears the setting. HTTPS everywhere; plain HTTP only to private hosts. No URL credentials. */
export function validateEndpoint(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: true, value: '' }
  let url
  try {
    url = new URL(text)
  } catch {
    return { ok: false, error: 'invalid_endpoint' }
  }
  if (url.username || url.password) return { ok: false, error: 'invalid_endpoint' }
  if (url.protocol === 'https:') return { ok: true, value: text }
  if (url.protocol === 'http:') {
    return isPrivateHost(url.hostname) ? { ok: true, value: text } : { ok: false, error: 'endpoint_requires_https' }
  }
  return { ok: false, error: 'invalid_endpoint' }
}

export function publicServiceConfig(raw = {}) {
  const cfg = normalizeServiceConfig(raw)
  return {
    endpoint: cfg.endpoint,
    configured: !!cfg.endpoint,
    headers: cfg.headers.map((h) => ({ name: h.name, value: '', value_set: true })),
    timeout_min: cfg.timeout_min,
    batch_concurrency: cfg.batch_concurrency,
    guard_enabled: cfg.guard_enabled,
    guard: cfg.guard,
    encryption_enabled: encryptionEnabled(),
  }
}

export function readServiceConfig(settings) {
  try {
    return normalizeServiceConfig(settings.get(CODEX_LOGIN_SERVICE_KEY, null) || {})
  } catch {
    return normalizeServiceConfig({})
  }
}

function isKeep(value) {
  const s = String(value ?? '').trim()
  return !s || s === SECRET_KEEP || /^•+$/.test(s)
}

/** Merge a panel patch. A blank header value keeps the saved value of the same header. */
export function applyServicePatch(settings, body = {}) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const prev = readServiceConfig(settings)
  const next = { ...prev }
  if (Object.hasOwn(src, 'endpoint')) {
    const checked = validateEndpoint(src.endpoint)
    if (!checked.ok) return { ok: false, error: checked.error }
    next.endpoint = checked.value
  }
  if (Object.hasOwn(src, 'headers')) {
    if (!Array.isArray(src.headers) || src.headers.length > MAX_HEADERS) return { ok: false, error: 'invalid_headers' }
    const headers = []
    for (const row of src.headers) {
      const name = String(row?.name || '').trim()
      if (!headerNameOk(name)) return { ok: false, error: 'invalid_header_name' }
      if (headers.some((h) => h.name.toLowerCase() === name.toLowerCase())) {
        return { ok: false, error: 'duplicate_header' }
      }
      if (isKeep(row?.value)) {
        const kept = prev.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
        if (!kept) return { ok: false, error: 'header_value_required' }
        headers.push({ name, value: kept.value })
        continue
      }
      const value = String(row.value)
      if (value.length > MAX_HEADER_VALUE || /[\r\n\0]/.test(value)) return { ok: false, error: 'invalid_header_value' }
      headers.push({ name, value: maybeEncrypt(value) })
    }
    next.headers = headers
  }
  for (const key of ['timeout_min', 'batch_concurrency']) {
    if (Object.hasOwn(src, key)) next[key] = src[key]
  }
  if (Object.hasOwn(src, 'guard_enabled')) next.guard_enabled = src.guard_enabled !== false
  if (src.guard && typeof src.guard === 'object') next.guard = { ...prev.guard, ...src.guard }
  const config = normalizeServiceConfig(next)
  settings.set(CODEX_LOGIN_SERVICE_KEY, config)
  return { ok: true, config }
}

function fail(error, extra = {}) {
  return { ok: false, error, ...extra }
}

function resolveHeaders(config, randomId) {
  const out = {}
  for (const row of config.headers) {
    let value
    try {
      value = maybeDecrypt(row.value)
    } catch {
      return null
    }
    if (value.includes('{{uuid}}')) value = value.replaceAll('{{uuid}}', randomId())
    out[row.name.toLowerCase()] = value
  }
  return out
}

function requestHeaders(endpoint, extra) {
  const origin = new URL(endpoint).origin
  return {
    'content-type': 'application/json',
    accept: 'application/x-ndjson, application/json',
    origin,
    referer: `${origin}/`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0',
    ...extra,
  }
}

/** Splits a byte stream into top-level JSON objects (NDJSON or one pretty-printed value). */
function createJsonObjectStream(maxBytes) {
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  let pos = 0
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  let total = 0
  return {
    push(chunk) {
      total += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      if (total > maxBytes) return { error: 'login_response_too_large', values: [] }
      buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      const values = []
      for (; pos < buf.length; pos++) {
        const ch = buf[pos]
        if (start < 0) {
          if (ch === '{') {
            start = pos
            depth = 1
            inString = false
            escaped = false
          } else if (!/\s/.test(ch)) {
            return { error: 'login_response_invalid', values }
          }
          continue
        }
        if (inString) {
          if (escaped) escaped = false
          else if (ch === '\\') escaped = true
          else if (ch === '"') inString = false
          continue
        }
        if (ch === '"') inString = true
        else if (ch === '{' || ch === '[') depth++
        else if (ch === '}' || ch === ']') {
          depth--
          if (depth === 0) {
            try {
              values.push(JSON.parse(buf.slice(start, pos + 1)))
            } catch {
              return { error: 'login_response_invalid', values }
            }
            start = -1
          }
        }
      }
      if (start < 0) {
        buf = ''
        pos = 0
      } else if (start > 0) {
        buf = buf.slice(start)
        pos -= start
        start = 0
      }
      return { values }
    },
  }
}

function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return toEpochMs(n)
    const t = Date.parse(value)
    if (Number.isFinite(t)) return t
  }
  return 0
}

function pickCredential(src) {
  const out = {}
  for (const key of CREDENTIAL_FIELDS) {
    const value = src[key]
    if (typeof value === 'string' && value.trim()) out[key] = value.trim()
  }
  const expiresAt = toEpochMs(src.expires_at ?? src.expired)
  if (expiresAt) out.expires_at = expiresAt
  return out
}

/** A provider code passes only when it is already a short identifier and carries no submitted secret. */
function providerCode(raw, secrets) {
  const code = String(raw ?? '').trim()
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(code)) return 'relogin_rejected'
  const lower = code.toLowerCase()
  for (const secret of secrets) {
    const s = String(secret || '').toLowerCase()
    if (s.length >= 4 && lower.includes(s)) return 'relogin_rejected'
  }
  return lower
}

function decideEvent(event, secrets) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null
  let payload
  if (String(event.type || '').trim() === 'result') {
    payload = event.payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail('login_response_invalid')
  } else if (
    Object.hasOwn(event, 'credential') ||
    Object.hasOwn(event, 'error') ||
    TERMINAL_STATUS.has(
      String(event.status || '')
        .trim()
        .toLowerCase(),
    )
  ) {
    payload = event
  } else {
    return null
  }
  const credential = payload.credential
  if (credential && typeof credential === 'object' && !Array.isArray(credential)) {
    const picked = pickCredential(credential)
    if (!picked.access_token || !picked.refresh_token || !picked.id_token) return fail('login_credential_incomplete')
    return { ok: true, credential: picked }
  }
  const err = payload.error
  if (err != null && err !== false && err !== '') {
    const code = err && typeof err === 'object' ? err.code : err
    return fail('login_rejected', { detail: providerCode(code, secrets) })
  }
  const status = String(payload.status || '')
    .trim()
    .toLowerCase()
  if (status && !SUCCESS_STATUS.has(status)) return fail('login_rejected', { detail: providerCode(status, secrets) })
  return fail('login_no_credential')
}

function closeBody(body) {
  try {
    if (typeof body?.destroy === 'function') body.destroy()
    else if (typeof body?.cancel === 'function') body.cancel().catch(() => {})
  } catch {}
}

async function readOutcome(res, { armIdle, maxBytes, reason, secrets }) {
  const parser = createJsonObjectStream(maxBytes)
  const body = res.body
  const consume = (chunk) => {
    armIdle()
    const step = parser.push(chunk)
    for (const event of step.values) {
      const decided = decideEvent(event, secrets)
      if (decided) return decided
    }
    return step.error ? fail(step.error) : null
  }
  try {
    if (body && typeof body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of body) {
        const decided = consume(chunk)
        if (decided) {
          closeBody(body)
          return decided
        }
      }
    } else if (typeof res.text === 'function') {
      const decided = consume(await res.text())
      if (decided) return decided
    }
  } catch {
    return fail(reason() || 'login_response_invalid')
  }
  return fail(reason() || 'login_no_result')
}

/**
 * One login through the configured service. Resolves to
 *   { ok: true, credential: { access_token, refresh_token, id_token, expires_at?, … } }
 *   { ok: false, error, status?, detail? }
 */
export async function loginWithService({
  config,
  email,
  password,
  mfaSecret,
  proxyUrl = '',
  signal = null,
  fetchImpl = nodeFetch,
  randomId = () => crypto.randomUUID(),
  idleTimeoutMs = IDLE_TIMEOUT_MS,
  maxBytes = MAX_RESPONSE_BYTES,
} = {}) {
  const cfg = normalizeServiceConfig(config)
  if (!cfg.endpoint) return fail('login_service_unconfigured')
  const checked = validateEndpoint(cfg.endpoint)
  if (!checked.ok) return fail(checked.error)
  const extra = resolveHeaders(cfg, randomId)
  if (!extra) return fail('login_service_header_unreadable')
  if (signal?.aborted) return fail('canceled')
  const payload = { action: 'start', email, auth_mode: 'password_2fa', password, mfa_secret: mfaSecret }
  if (proxyUrl) payload.proxy = proxyUrl
  const secrets = [password, mfaSecret, proxyUrl]

  const ac = new AbortController()
  let why = null
  const abort = (code) => {
    if (why) return
    why = code
    ac.abort()
  }
  const onAbort = () => abort('canceled')
  signal?.addEventListener?.('abort', onAbort, { once: true })
  const total = setTimeout(() => abort('login_timeout'), cfg.timeout_min * 60_000)
  let idle = null
  const armIdle = () => {
    clearTimeout(idle)
    idle = setTimeout(() => abort('login_idle_timeout'), idleTimeoutMs)
  }
  try {
    armIdle()
    let res
    try {
      res = await fetchImpl(cfg.endpoint, {
        method: 'POST',
        headers: requestHeaders(cfg.endpoint, extra),
        body: JSON.stringify(payload),
        signal: ac.signal,
        // Never replay a password to a redirect target.
        redirect: 'manual',
      })
    } catch {
      return fail(why || 'login_service_unreachable')
    }
    const status = Number(res?.status) || 0
    if (status < 200 || status >= 300) {
      closeBody(res?.body)
      return fail('login_service_http', { status })
    }
    return await readOutcome(res, { armIdle, maxBytes, reason: () => why, secrets })
  } finally {
    clearTimeout(total)
    clearTimeout(idle)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/**
 * Turn a login credential into a Codex account. Identity comes from the JWTs, never from
 * fields the service echoes, so a wrong account cannot pass the email check.
 */
export function codexAccountFromLogin(credential = {}) {
  const identity = openaiIdentityFromOauthTokens({
    id_token: credential.id_token,
    access_token: credential.access_token,
  })
  const email = String(identity.email || '')
    .trim()
    .toLowerCase()
  const accountId = String(
    identity.chatgpt_account_id || credential.chatgpt_account_id || credential.account_id || '',
  ).trim()
  const parsed = parseCodexCredentialInput({
    access_token: credential.access_token,
    refresh_token: credential.refresh_token,
    id_token: credential.id_token,
    expires_at: credential.expires_at || 0,
    ...(accountId ? { chatgpt_account_id: accountId } : {}),
    ...(email ? { email } : {}),
  })
  if (!parsed.ok || !parsed.account?.access_token || !parsed.account?.refresh_token) {
    return { ok: false, error: 'login_credential_incomplete' }
  }
  return { ok: true, account: parsed.account, email, chatgpt_account_id: accountId || null }
}
