/**
 * HTTP / NDJSON protocol client for `codex-auth-service` (Callback v2).
 *
 * Strictly adheres to Callback v2:
 *   - POST /v2/authenticate with Bearer auth, allowlisted JSON body, and strict NDJSON parsing
 *   - Contiguous `seq` starting at 1, `accepted` first, unique terminal `result`, `task_id` match
 *   - 64 KiB max line / 1 MiB max total stream, 60s idle timeout, overall OAuth session deadline
 *   - Non-200 JSON error parsing preserving `Retry-After` for 429/503 scheduling
 *   - Best-effort DELETE /v2/tasks/:task_id on caller abort
 *   - GET /healthz & GET /readyz diagnostics
 */
import net from 'node:net'
import nodeFetch from 'node-fetch'

export const AUTH_V2_PROTOCOL_VERSION = 2
export const AUTH_V2_STAGES = Object.freeze([
  'authorizing',
  'identifying',
  'verifying_password',
  'issuing_mfa',
  'verifying_mfa',
  'selecting_workspace',
  'capturing_callback',
])
export const WORKSPACE_POLICIES = Object.freeze(['auto', 'prefer_organization', 'prefer_personal'])
export const WORKSPACE_KINDS = Object.freeze(['personal', 'organization', 'unknown'])
export const SELECTION_REASONS = Object.freeze([
  'explicit_id',
  'single_workspace',
  'history_success',
  'organization_preferred',
  'personal_preferred',
  'stable_fallback',
])
export const AUTH_V2_ERROR_CODES = Object.freeze([
  'invalid_request',
  'invalid_auth_url',
  'unauthorized',
  'not_found',
  'method_not_allowed',
  'capacity_exceeded',
  'task_already_running',
  'task_already_finished',
  'service_stopping',
  'auth_session_expiring',
  'expired',
  'canceled',
  'internal_error',
  'response_too_large',
  'proxy_unreachable',
  'upstream_network_error',
  'upstream_timeout',
  'upstream_rate_limited',
  'upstream_unavailable',
  'upstream_rejected',
  'upstream_redirect_invalid',
  'password_rejected',
  'mfa_secret_required',
  'mfa_failed',
  'interaction_required',
  'workspace_selection_required',
  'workspace_not_found',
  'workspace_unavailable',
  'identity_mismatch',
  'unsupported_auth_state',
  'callback_invalid',
  'state_mismatch',
  'oauth_authorization_error',
  'auth_material_unavailable',
  'engine_not_ready',
  'stream_invalid',
  'exchange_outcome_unknown',
  'exchange_rejected',
  'credential_incomplete',
  'token_verification_failed',
  'configuration_invalid',
  'auth_worker_failed',
])

const STAGE_SET = new Set(AUTH_V2_STAGES)
const WORKSPACE_POLICY_SET = new Set(WORKSPACE_POLICIES)
const WORKSPACE_KIND_SET = new Set(WORKSPACE_KINDS)
const SELECTION_REASON_SET = new Set(SELECTION_REASONS)
const ERROR_CODE_SET = new Set(AUTH_V2_ERROR_CODES)
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,256}$/
const BASE32_TOTP_RE = /^[A-Z2-7]{16,128}$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UTC_ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/

export const MAX_NDJSON_LINE_BYTES = 65_536
export const MAX_NDJSON_TOTAL_BYTES = 1_048_576
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000
const MAX_ERROR_BODY_BYTES = 65_536
const CANCEL_TIMEOUT_MS = 3_000

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

/**
 * Validate and normalize a Callback v2 service endpoint.
 * Accepts either base URL (`http://127.0.0.1:8788`) or full `/v2/authenticate` URL.
 * Empty clears the setting. HTTPS everywhere; plain HTTP only to private/loopback hosts.
 */
export function normalizeAuthV2Endpoint(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: true, value: '', urls: null }
  if (text.length > 2048 || /[\r\n\t\\]/.test(text)) return { ok: false, error: 'invalid_endpoint' }
  let url
  try {
    url = new URL(text)
  } catch {
    return { ok: false, error: 'invalid_endpoint' }
  }
  if (url.username || url.password || url.search || url.hash) {
    return { ok: false, error: 'invalid_endpoint' }
  }
  if (url.protocol === 'http:') {
    if (!isPrivateHost(url.hostname)) return { ok: false, error: 'endpoint_requires_https' }
  } else if (url.protocol !== 'https:') {
    return { ok: false, error: 'invalid_endpoint' }
  }
  let basePath = url.pathname.replace(/\/+$/, '')
  if (basePath.endsWith('/v2/authenticate')) {
    basePath = basePath.slice(0, -'/v2/authenticate'.length)
  }
  const baseUrl = `${url.origin}${basePath}`
  return {
    ok: true,
    value: baseUrl,
    urls: {
      baseUrl,
      authenticateUrl: `${baseUrl}/v2/authenticate`,
      taskUrl: (taskId) => `${baseUrl}/v2/tasks/${encodeURIComponent(String(taskId).toLowerCase())}`,
      healthzUrl: `${baseUrl}/healthz`,
      readyzUrl: `${baseUrl}/readyz`,
    },
  }
}

/**
 * Normalize TOTP secret for Callback v2:
 *   - Empty/null → `{ ok: true, value: null }`
 *   - `otpauth://...` → extracts `secret` query parameter
 *   - Strips whitespace and trailing `=` padding, requires 16-128 Base32 chars (A-Z, 2-7).
 */
export function normalizeV2MfaSecret(raw) {
  if (raw == null) return { ok: true, value: null }
  let text = String(raw).trim()
  if (!text) return { ok: true, value: null }
  if (/^otpauth:\/\//i.test(text)) {
    try {
      const parsed = new URL(text)
      text = String(parsed.searchParams.get('secret') || '').trim()
    } catch {
      return { ok: false, error: 'invalid_totp' }
    }
  }
  const cleaned = text.replace(/\s+/g, '').replace(/=+$/g, '')
  if (!BASE32_TOTP_RE.test(cleaned)) return { ok: false, error: 'invalid_totp' }
  return { ok: true, value: cleaned.toUpperCase() }
}

/**
 * Validate and normalize a single-hop proxy URL for Callback v2.
 * Rejects empty/null (direct exit is not used by vm2api). Normalizes `socks5://` → `socks5h://`.
 */
export function normalizeV2ProxyUrl(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'proxy_required' }
  const text = raw.trim()
  if (!text) return { ok: false, error: 'proxy_required' }
  if (text.length > 4096 || /[\r\n\t\\]/.test(text)) return { ok: false, error: 'invalid_proxy' }
  let u
  try {
    u = new URL(text)
  } catch {
    return { ok: false, error: 'invalid_proxy' }
  }
  if (
    !['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol) ||
    !u.hostname ||
    u.hash ||
    u.search ||
    (u.pathname && u.pathname !== '/')
  ) {
    return { ok: false, error: 'invalid_proxy' }
  }
  if (u.protocol === 'socks5:') u.protocol = 'socks5h:'
  try {
    const user = decodeURIComponent(u.username)
    const password = decodeURIComponent(u.password)
    if (u.protocol === 'socks5h:' && (Buffer.byteLength(user) > 255 || Buffer.byteLength(password) > 255)) {
      return { ok: false, error: 'invalid_proxy' }
    }
  } catch {
    return { ok: false, error: 'invalid_proxy' }
  }
  return { ok: true, value: u.href }
}

export function parseRetryAfterMs(headerValue, nowMs = Date.now()) {
  if (headerValue == null) return null
  const text = String(headerValue).trim()
  if (!text) return null
  if (/^\d+$/.test(text)) {
    const sec = Number(text)
    if (Number.isFinite(sec) && sec >= 0) return Math.min(300_000, Math.max(1_000, sec * 1000))
    return null
  }
  const at = Date.parse(text)
  if (!Number.isFinite(at)) return null
  return Math.min(300_000, Math.max(1_000, at - nowMs))
}

function closeBody(body) {
  try {
    if (typeof body?.destroy === 'function') body.destroy()
    else if (typeof body?.cancel === 'function') body.cancel().catch(() => {})
  } catch {}
}

async function readBoundedErrorJson(res) {
  try {
    const body = res?.body
    let text = ''
    if (body && typeof body[Symbol.asyncIterator] === 'function') {
      const chunks = []
      let total = 0
      for await (const chunk of body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += buf.length
        if (total > MAX_ERROR_BODY_BYTES) {
          closeBody(body)
          return null
        }
        chunks.push(buf)
      }
      text = Buffer.concat(chunks).toString('utf8')
    } else if (typeof res?.text === 'function') {
      text = await res.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_ERROR_BODY_BYTES) return null
    } else if (typeof res?.json === 'function') {
      return await res.json()
    }
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

function sanitizeErrorCode(raw, fallback = 'upstream_rejected') {
  const code = String(raw ?? '')
    .trim()
    .toLowerCase()
  return ERROR_CODE_SET.has(code) ? code : fallback
}

function headerGet(headers, name) {
  if (!headers) return ''
  if (typeof headers.get === 'function') return String(headers.get(name) || '')
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return String(v || '')
  }
  return ''
}

function parseWorkspaceMetadata(payload, expectedAccountId) {
  const keys = ['selected_workspace', 'selection_reason', 'candidate_count']
  const hasAny = keys.some((k) => Object.hasOwn(payload, k))
  if (!hasAny) return { ok: true, metadata: null }
  const ws = payload.selected_workspace
  if (
    !ws ||
    typeof ws !== 'object' ||
    Array.isArray(ws) ||
    typeof ws.id !== 'string' ||
    !WORKSPACE_ID_RE.test(ws.id) ||
    !WORKSPACE_KIND_SET.has(ws.kind) ||
    !SELECTION_REASON_SET.has(payload.selection_reason) ||
    !Number.isInteger(payload.candidate_count) ||
    payload.candidate_count < 1 ||
    payload.candidate_count > 100
  ) {
    return { ok: false, error: 'stream_invalid' }
  }
  if (expectedAccountId && expectedAccountId !== ws.id) {
    return { ok: false, error: 'identity_mismatch' }
  }
  const cleanWorkspace = {
    id: ws.id,
    kind: ws.kind,
    ...(typeof ws.name === 'string' && ws.name.trim() ? { name: ws.name.trim().slice(0, 200) } : {}),
  }
  return {
    ok: true,
    metadata: {
      selected_workspace: cleanWorkspace,
      selection_reason: payload.selection_reason,
      candidate_count: payload.candidate_count,
    },
  }
}

/** Best-effort DELETE /v2/tasks/:task_id when caller aborts a running request. */
export async function cancelAuthV2Task({ endpoint, serviceToken, taskId, fetchImpl = nodeFetch }) {
  const checked = normalizeAuthV2Endpoint(endpoint)
  if (!checked.ok || !checked.urls || !serviceToken || !UUID_RE.test(String(taskId || ''))) return
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), CANCEL_TIMEOUT_MS)
  timer.unref?.()
  try {
    const res = await fetchImpl(checked.urls.taskUrl(taskId), {
      method: 'DELETE',
      redirect: 'manual',
      signal: ac.signal,
      headers: {
        authorization: `Bearer ${serviceToken}`,
        accept: 'application/json',
      },
    })
    closeBody(res?.body)
  } catch {
    // Best-effort cancellation; original POST disconnect also cancels on the server.
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Submit a Callback v2 authentication task and stream its NDJSON progress until terminal result.
 */
export async function authenticateWithV2Service({
  endpoint,
  serviceToken,
  input,
  signal = null,
  onProgress = null,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  fetchImpl = nodeFetch,
  now = () => Date.now(),
} = {}) {
  const checked = normalizeAuthV2Endpoint(endpoint)
  if (!checked.ok) return { ok: false, error: checked.error }
  if (!checked.urls) return { ok: false, error: 'login_service_unconfigured' }
  const token = String(serviceToken || '').trim()
  if (!token) return { ok: false, error: 'login_service_unconfigured' }
  if (signal?.aborted) return { ok: false, error: 'canceled' }

  const taskId = String(input?.task_id || '')
    .trim()
    .toLowerCase()
  if (!UUID_RE.test(taskId)) return { ok: false, error: 'invalid_request' }
  const expiresAt = String(input?.expires_at || '')
  if (!UTC_ISO_RE.test(expiresAt)) return { ok: false, error: 'invalid_request' }
  const budgetMs = Date.parse(expiresAt) - now()
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return { ok: false, error: 'expired' }

  const proxyChecked = normalizeV2ProxyUrl(input?.proxy)
  if (!proxyChecked.ok) return { ok: false, error: proxyChecked.error }

  const workspacePolicy = input?.workspace_policy
  if (workspacePolicy !== undefined && !WORKSPACE_POLICY_SET.has(workspacePolicy)) {
    return { ok: false, error: 'invalid_request' }
  }
  const expectedAccountId =
    input?.expected_account_id != null && String(input.expected_account_id).trim()
      ? String(input.expected_account_id).trim()
      : null
  if (expectedAccountId && !WORKSPACE_ID_RE.test(expectedAccountId)) {
    return { ok: false, error: 'invalid_request' }
  }

  // Strict allowlisted protocol v2 body — never send unknown fields (e.g. exchange_proxy).
  const payload = {
    protocol_version: AUTH_V2_PROTOCOL_VERSION,
    task_id: taskId,
    email: String(input.email || '')
      .trim()
      .toLowerCase(),
    password: String(input.password || ''),
    mfa_secret: input.mfa_secret ?? null,
    auth_url: String(input.auth_url || ''),
    proxy: proxyChecked.value,
    expires_at: expiresAt,
    ...(workspacePolicy ? { workspace_policy: workspacePolicy } : {}),
    ...(expectedAccountId ? { expected_account_id: expectedAccountId } : {}),
  }

  const ac = new AbortController()
  let abortReason = null
  let cancelDispatched = false
  const triggerAbort = (reason, remoteCancel = false) => {
    if (!abortReason) abortReason = reason
    ac.abort()
    if (remoteCancel && !cancelDispatched) {
      cancelDispatched = true
      void cancelAuthV2Task({ endpoint: checked.value, serviceToken: token, taskId, fetchImpl })
    }
  }
  const onExternalAbort = () => triggerAbort('canceled', true)
  signal?.addEventListener?.('abort', onExternalAbort, { once: true })

  const overallTimer = setTimeout(() => triggerAbort('expired', true), budgetMs)
  let idleTimer = null
  const armIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => triggerAbort('upstream_timeout', true), idleTimeoutMs)
  }

  try {
    armIdle()
    let res
    try {
      res = await fetchImpl(checked.urls.authenticateUrl, {
        method: 'POST',
        redirect: 'manual',
        signal: ac.signal,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/x-ndjson',
        },
        body: JSON.stringify(payload),
      })
    } catch {
      return { ok: false, error: abortReason || 'login_service_unreachable', retryable: !abortReason }
    }

    const status = Number(res?.status) || 0
    if (status !== 200) {
      const retryAfterMs = parseRetryAfterMs(headerGet(res?.headers, 'retry-after'), now())
      const errBody = await readBoundedErrorJson(res)
      closeBody(res?.body)
      const fallback =
        status === 401
          ? 'unauthorized'
          : status === 429
            ? 'capacity_exceeded'
            : status === 503
              ? 'engine_not_ready'
              : status === 409
                ? 'task_already_running'
                : 'upstream_rejected'
      const code = sanitizeErrorCode(errBody?.error?.code, fallback)
      const retryable = errBody?.error?.retryable === true || status === 429 || status === 503
      return {
        ok: false,
        error: code,
        status,
        retryable,
        ...(retryAfterMs != null ? { retryAfterMs } : status === 429 ? { retryAfterMs: 15_000 } : {}),
      }
    }

    const contentType = headerGet(res?.headers, 'content-type').toLowerCase()
    if (!contentType.startsWith('application/x-ndjson') || !res?.body) {
      closeBody(res?.body)
      return { ok: false, error: 'stream_invalid' }
    }

    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let totalBytes = 0
    let seq = 0
    let accepted = false
    let outcome = null
    let workspaceMeta = null

    const consumeLine = (line) => {
      if (!line.trim()) return { ok: false, error: 'stream_invalid' }
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return { ok: false, error: 'stream_invalid' }
      }
      if (!event || typeof event !== 'object' || Array.isArray(event)) return { ok: false, error: 'stream_invalid' }
      if (outcome || event.task_id !== taskId || event.seq !== ++seq) return { ok: false, error: 'stream_invalid' }
      if (!accepted && event.type !== 'accepted') return { ok: false, error: 'stream_invalid' }

      if (event.type === 'accepted' || event.type === 'progress' || event.type === 'heartbeat') {
        if (!STAGE_SET.has(event.stage) || (event.type === 'accepted' && accepted)) {
          return { ok: false, error: 'stream_invalid' }
        }
        accepted = true
        try {
          onProgress?.(event.stage)
        } catch {}
        return { ok: true }
      }

      if (event.type === 'result') {
        const p = event.payload
        if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, error: 'stream_invalid' }
        if (p.status === 'callback_ready' && typeof p.callback_url === 'string') {
          const parsedWs = parseWorkspaceMetadata(p, expectedAccountId)
          if (!parsedWs.ok) return parsedWs
          workspaceMeta = parsedWs.metadata
          outcome = p
          return { ok: true }
        }
        if (
          (p.status === 'failed' || p.status === 'expired' || p.status === 'canceled') &&
          p.error &&
          typeof p.error === 'object' &&
          ERROR_CODE_SET.has(p.error.code)
        ) {
          outcome = p
          return { ok: true }
        }
        return { ok: false, error: 'stream_invalid' }
      }

      return { ok: false, error: 'stream_invalid' }
    }

    try {
      const iterable =
        typeof res.body[Symbol.asyncIterator] === 'function'
          ? res.body
          : (async function* () {
              yield Buffer.from(await res.text())
            })()
      for await (const chunk of iterable) {
        armIdle()
        if (ac.signal.aborted) {
          closeBody(res.body)
          return { ok: false, error: abortReason || 'canceled' }
        }
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        totalBytes += bytes.length
        if (totalBytes > MAX_NDJSON_TOTAL_BYTES) {
          closeBody(res.body)
          return { ok: false, error: 'response_too_large' }
        }
        buffer += decoder.decode(bytes, { stream: true })
        let nl = buffer.indexOf('\n')
        while (nl >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          if (Buffer.byteLength(line, 'utf8') > MAX_NDJSON_LINE_BYTES) {
            closeBody(res.body)
            return { ok: false, error: 'response_too_large' }
          }
          const step = consumeLine(line)
          if (!step.ok) {
            closeBody(res.body)
            return step
          }
          nl = buffer.indexOf('\n')
        }
        if (Buffer.byteLength(buffer, 'utf8') > MAX_NDJSON_LINE_BYTES) {
          closeBody(res.body)
          return { ok: false, error: 'response_too_large' }
        }
      }
      buffer += decoder.decode()
    } catch {
      return { ok: false, error: abortReason || 'upstream_network_error', retryable: !abortReason }
    }

    if (ac.signal.aborted) return { ok: false, error: abortReason || 'canceled' }
    if (buffer || !outcome) return { ok: false, error: 'stream_invalid' }

    if (outcome.status !== 'callback_ready') {
      return {
        ok: false,
        error: sanitizeErrorCode(outcome.error.code),
        stage: STAGE_SET.has(outcome.error.stage) ? outcome.error.stage : null,
        retryable: outcome.error.retryable === true,
      }
    }

    return {
      ok: true,
      callback_url: outcome.callback_url,
      ...(workspaceMeta || {}),
    }
  } finally {
    clearTimeout(overallTimer)
    clearTimeout(idleTimer)
    signal?.removeEventListener?.('abort', onExternalAbort)
  }
}

/** Probe `/healthz` and `/readyz` on a Callback v2 service (no Bearer token required). */
export async function checkAuthV2ServiceHealth({ endpoint, fetchImpl = nodeFetch, timeoutMs = 5_000 } = {}) {
  const checked = normalizeAuthV2Endpoint(endpoint)
  if (!checked.ok) return { ok: false, error: checked.error }
  if (!checked.urls) return { ok: false, error: 'login_service_unconfigured' }

  const probeOne = async (url) => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: ac.signal,
        headers: { accept: 'application/json' },
      })
      const status = Number(res?.status) || 0
      const body = await readBoundedErrorJson(res)
      closeBody(res?.body)
      return { ok: status === 200, status, body }
    } catch {
      return { ok: false, status: 0, body: null }
    } finally {
      clearTimeout(timer)
    }
  }

  const [healthz, readyz] = await Promise.all([probeOne(checked.urls.healthzUrl), probeOne(checked.urls.readyzUrl)])
  const ready = readyz.ok && readyz.body?.ready !== false
  return {
    ok: healthz.ok && ready,
    healthz: { ok: healthz.ok, status: healthz.status },
    readyz: {
      ok: ready,
      status: readyz.status,
      engine: typeof readyz.body?.engine === 'string' ? readyz.body.engine : null,
    },
    ...(healthz.ok && ready ? {} : { error: !healthz.ok ? 'login_service_unreachable' : 'engine_not_ready' }),
  }
}
