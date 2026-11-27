/**
 * Official Codex Desktop OAuth (chatgpt.com/codex/desktop-auth + PKCE).
 * Matches codex-proxy-rs: loopback callback is pasted back, exchange via slot SOCKS5.
 */
import crypto from 'node:crypto'
import {
  CODEX_APP_VERSION,
  CODEX_OAUTH_AUTHORIZE_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_DESKTOP_AUTH_URL,
  CODEX_OAUTH_ORIGINATOR,
  CODEX_OAUTH_REDIRECT_URI,
  CODEX_OAUTH_SCOPE,
  exchangeCodexAuthorizationCode,
  exchangeCodexAuthorizationCodeV2,
} from '../protocol/codex-models.mjs'
import { resolveSlotOAuthProxy } from '../vm/proxy-resolve.mjs'
import { normalizeV2ProxyUrl } from './codex-auth-v2-client.mjs'
import { OPENAI_OIDC_ISSUER, verifyOpenAiIdToken } from './openai-id-token-verify.mjs'

export const CODEX_OAUTH_SESSION_TTL_MS = 10 * 60 * 1000
const SURFACE_STABLE_ID_DOMAIN = Buffer.from('openai/codex-desktop/surface-stable-id/v1\0')
const MAX_CALLBACK_URL_LENGTH = 16_384

const sessions = new Map()
const v2Sessions = new Map()

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function sweepExpired(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (now - session.createdAt > CODEX_OAUTH_SESSION_TTL_MS) sessions.delete(id)
  }
}

function uuidBytes(value) {
  const hex = String(value || '')
    .trim()
    .replace(/-/g, '')
  if (/^[0-9a-f]{32}$/i.test(hex)) return Buffer.from(hex, 'hex')
  return crypto
    .createHash('sha256')
    .update(String(value || 'codex'))
    .digest()
    .subarray(0, 16)
}

export function deriveCodexSurfaceStableId(installationId) {
  const digest = crypto.createHash('sha256')
  digest.update(SURFACE_STABLE_ID_DOMAIN)
  digest.update(uuidBytes(installationId))
  const bytes = Buffer.from(digest.digest().subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function parseCodexOAuthCallback(raw) {
  const text = String(raw || '').trim()
  if (!text) return { code: '', state: '' }
  try {
    const url = new URL(text)
    return {
      code: String(url.searchParams.get('code') || '').trim(),
      state: String(url.searchParams.get('state') || '').trim(),
    }
  } catch {
    const hash = text.indexOf('#')
    if (hash !== -1) {
      return { code: text.slice(0, hash).trim(), state: text.slice(hash + 1).trim() }
    }
    const params = new URLSearchParams(text.includes('?') ? text.slice(text.indexOf('?') + 1) : text)
    return {
      code: String(params.get('code') || '').trim(),
      state: String(params.get('state') || '').trim(),
    }
  }
}

function buildDesktopAuthUrl({ state, codeChallenge, installationId }) {
  const inner = new URL(CODEX_OAUTH_AUTHORIZE_URL)
  const stableId = deriveCodexSurfaceStableId(installationId)
  inner.searchParams.set('response_type', 'code')
  inner.searchParams.set('client_id', CODEX_OAUTH_CLIENT_ID)
  inner.searchParams.set('redirect_uri', CODEX_OAUTH_REDIRECT_URI)
  inner.searchParams.set('scope', CODEX_OAUTH_SCOPE)
  inner.searchParams.set('code_challenge', codeChallenge)
  inner.searchParams.set('code_challenge_method', 'S256')
  inner.searchParams.set('id_token_add_organizations', 'true')
  inner.searchParams.set('codex_cli_simplified_flow', 'true')
  inner.searchParams.set('state', state)
  inner.searchParams.set('originator', CODEX_OAUTH_ORIGINATOR)
  inner.searchParams.set('codex_app_version', CODEX_APP_VERSION)
  inner.searchParams.set('source_surface_stable_id', stableId)
  inner.searchParams.set('codex_origin_stable_id', stableId)
  inner.searchParams.set('codex_streamlined_login', 'true')
  const outer = new URL(CODEX_OAUTH_DESKTOP_AUTH_URL)
  outer.searchParams.set('authorize_url', inner.toString())
  outer.searchParams.set('codex_streamlined_login', 'true')
  outer.searchParams.set('no_universal_links', '1')
  return outer.toString()
}

export function generateCodexAuthUrl({ vmId, proxyUrl, installationId } = {}) {
  sweepExpired()
  if (!vmId) throw fail('vm_required', 'vm_id required (先创建虚拟机)')
  if (proxyUrl == null) throw fail('proxy_required', '虚拟机未绑定 SOCKS5，请先分配代理再生成授权链接')
  const state = b64url(crypto.randomBytes(32))
  const codeVerifier = b64url(crypto.randomBytes(32))
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest())
  const sessionId = crypto.randomBytes(16).toString('hex')
  const createdAt = Date.now()
  const install = String(installationId || crypto.randomUUID())
  sessions.set(sessionId, {
    state,
    codeVerifier,
    proxyUrl: proxyUrl === '' ? '' : String(proxyUrl),
    vmId: String(vmId),
    installationId: install,
    createdAt,
  })
  return {
    auth_url: buildDesktopAuthUrl({ state, codeChallenge, installationId: install }),
    session_id: sessionId,
    expires_at: createdAt + CODEX_OAUTH_SESSION_TTL_MS,
    vm_id: String(vmId),
    flavor: 'codex',
  }
}

export async function exchangeCodexAuthCode({
  sessionId,
  code,
  vmId,
  vm,
  proxyPool,
  fetchImpl,
  exchange = exchangeCodexAuthorizationCode,
} = {}) {
  sweepExpired()
  const session = sessions.get(sessionId)
  if (!session || Date.now() - session.createdAt > CODEX_OAUTH_SESSION_TTL_MS) {
    if (session) sessions.delete(sessionId)
    throw fail('session_expired', '授权会话不存在或已过期，请重新生成授权链接')
  }
  if (vmId && session.vmId && session.vmId !== String(vmId)) {
    throw fail('session_vm_mismatch', '授权会话与当前虚拟机不匹配')
  }
  const parsed = parseCodexOAuthCallback(code)
  if (!parsed.code) throw fail('code_required', '请粘贴 Codex 回调 URL 或授权码')
  if (parsed.state && parsed.state !== session.state) {
    throw fail('state_mismatch', '回调 state 与授权会话不匹配')
  }
  // Codex exchanges on the control plane, so this URL is the one actually
  // dialled. Resolve it at the point of use: a pool reallocation inside
  // CODEX_OAUTH_SESSION_TTL_MS decides the exit, never the authorize-time
  // snapshot on the session, which stays only for audit. A fetch seam replaces
  // the transport, not the exit: resolution is not skipped for it.
  const px = resolveSlotOAuthProxy(vm, proxyPool)
  const tok = await exchange({
    code: parsed.code,
    codeVerifier: session.codeVerifier,
    proxyUrl: px,
    fetchImpl,
  })
  if (!tok.ok) {
    throw fail(tok.error || 'exchange_failed', 'Codex OAuth 换票失败，请重新生成授权链接')
  }
  sessions.delete(sessionId)
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    id_token: tok.id_token,
    expires_at: tok.expires_at,
    flavor: 'codex',
    source: 'codex-oauth',
  }
}

function sweepExpiredV2(now = Date.now()) {
  for (const [id, session] of v2Sessions) {
    if (now >= session.expiresAtMs) {
      session.codeVerifier = ''
      v2Sessions.delete(id)
    }
  }
}

function equalSecret(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8')
  const y = Buffer.from(String(b || ''), 'utf8')
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/**
 * Strict Callback v2 URL validation:
 *   - Exact origin + path `http://localhost:1455/auth/callback`
 *   - No userinfo, fragment, backslash, control chars, or duplicate query keys
 *   - Mandatory timing-safe `state` match
 *   - Optional `iss` must equal `https://auth.openai.com`
 *   - OAuth `error` rejects as `oauth_authorization_error`
 *   - Non-empty `code` without whitespace or control characters
 */
export function validateCodexV2Callback(raw, expectedState) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_CALLBACK_URL_LENGTH) {
    throw fail('callback_invalid', '回调地址无效')
  }
  if (raw.includes('\\') || /[\r\n\t]/.test(raw)) {
    throw fail('callback_invalid', '回调地址包含非法字符')
  }
  let u
  try {
    u = new URL(raw)
  } catch {
    throw fail('callback_invalid', '回调地址无法解析')
  }
  if (u.username || u.password || u.hash) {
    throw fail('callback_invalid', '回调地址不允许包含用户信息或 fragment')
  }
  const seen = new Set()
  for (const key of u.searchParams.keys()) {
    if (seen.has(key)) throw fail('callback_invalid', '回调地址包含重复参数')
    seen.add(key)
  }
  const base = new URL(CODEX_OAUTH_REDIRECT_URI)
  if (u.origin !== base.origin || u.pathname !== base.pathname) {
    throw fail('callback_invalid', '回调地址不匹配')
  }
  const gotState = u.searchParams.get('state')
  if (!gotState || !expectedState || !equalSecret(gotState, expectedState)) {
    throw fail('state_mismatch', '回调 state 与授权会话不匹配')
  }
  if (u.searchParams.has('iss') && u.searchParams.get('iss') !== OPENAI_OIDC_ISSUER) {
    throw fail('callback_invalid', '回调 iss 不匹配')
  }
  if (u.searchParams.has('error')) {
    throw fail('oauth_authorization_error', '上游 OAuth 返回错误')
  }
  const code = u.searchParams.get('code')
  if (!code || /[\s\x00-\x1f]/.test(code)) {
    throw fail('callback_invalid', '回调缺少合法授权码')
  }
  return { url: u.href, code }
}

/**
 * Create a strict Callback v2 OAuth session keyed by lowercase `task_id`.
 * Call ONLY after acquiring an execution slot so the 10-minute TTL is never spent queued.
 */
export function createCodexV2AuthSession({
  taskId,
  vmId,
  email,
  installationId,
  boundExit,
  expectedAccountId = null,
  workspacePolicy = 'auto',
  now = Date.now(),
} = {}) {
  sweepExpiredV2(now)
  const id = String(taskId || '')
    .trim()
    .toLowerCase()
  if (!id) throw fail('invalid_request', 'task_id required')
  if (v2Sessions.has(id)) throw fail('task_already_running', 'task_id already exists')
  const normalizedExit = normalizeV2ProxyUrl(boundExit)
  if (!normalizedExit.ok) throw fail(normalizedExit.error, '槽位未绑定可用代理出口')
  const state = b64url(crypto.randomBytes(32))
  const codeVerifier = b64url(crypto.randomBytes(32))
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest())
  const install = String(installationId || crypto.randomUUID())
  const expiresAtMs = now + CODEX_OAUTH_SESSION_TTL_MS
  const expiresAtIso = new Date(expiresAtMs).toISOString()
  const authUrl = buildDesktopAuthUrl({ state, codeChallenge, installationId: install })
  v2Sessions.set(id, {
    taskId: id,
    vmId: vmId ? String(vmId) : null,
    email: String(email || '')
      .trim()
      .toLowerCase(),
    state,
    codeVerifier,
    boundExit: normalizedExit.value,
    expectedAccountId: expectedAccountId ? String(expectedAccountId).trim() : null,
    workspacePolicy: workspacePolicy || 'auto',
    createdAt: now,
    expiresAtMs,
    expiresAtIso,
    consumed: false,
    canceled: false,
  })
  return {
    task_id: id,
    auth_url: authUrl,
    expires_at_ms: expiresAtMs,
    expires_at: expiresAtIso,
    bound_exit: normalizedExit.value,
  }
}

/** Atomically mark a Callback v2 session canceled and wipe its PKCE verifier. */
export function cancelCodexV2AuthSession(taskId) {
  const id = String(taskId || '')
    .trim()
    .toLowerCase()
  const session = v2Sessions.get(id)
  if (!session) return false
  session.canceled = true
  session.codeVerifier = ''
  v2Sessions.delete(id)
  return true
}

/**
 * Consume a Callback v2 callback URL once:
 *   1. Verify session is live, uncanceled, and unconsumed
 *   2. Strictly validate callback URL and state
 *   3. Check workspace consistency with `expectedAccountId` if present
 *   4. Verify slot egress has not drifted since session creation
 *   5. Atomically mark consumed BEFORE dispatching the single token exchange
 *   6. Exchange code + PKCE verifier via the bound exit
 *   7. Verify ID token cryptographically via OIDC/JWKS + email/workspace claims
 *   8. Always clean up session and PKCE verifier in `finally`
 */
export async function consumeCodexV2Callback({
  taskId,
  callbackUrl,
  selectedWorkspace = null,
  resolveCurrentExit = null,
  fetchImpl = null,
  exchange = exchangeCodexAuthorizationCodeV2,
  verify = verifyOpenAiIdToken,
  signal = null,
  onProgress = null,
  now = () => Date.now(),
} = {}) {
  const id = String(taskId || '')
    .trim()
    .toLowerCase()
  const session = v2Sessions.get(id)
  if (!session) return { ok: false, error: 'expired' }
  if (session.canceled || signal?.aborted) {
    cancelCodexV2AuthSession(id)
    return { ok: false, error: 'canceled' }
  }
  if (session.consumed) {
    return { ok: false, error: 'task_already_finished' }
  }
  const remainingMs = session.expiresAtMs - now()
  if (remainingMs <= 0) {
    session.codeVerifier = ''
    v2Sessions.delete(id)
    return { ok: false, error: 'expired' }
  }

  let parsed
  try {
    parsed = validateCodexV2Callback(callbackUrl, session.state)
  } catch (err) {
    session.codeVerifier = ''
    v2Sessions.delete(id)
    return { ok: false, error: err?.code || 'callback_invalid' }
  }

  if (selectedWorkspace && session.expectedAccountId && selectedWorkspace.id !== session.expectedAccountId) {
    session.codeVerifier = ''
    v2Sessions.delete(id)
    return { ok: false, error: 'identity_mismatch' }
  }

  if (typeof resolveCurrentExit === 'function') {
    let currentExit
    try {
      currentExit = resolveCurrentExit()
    } catch (err) {
      session.codeVerifier = ''
      v2Sessions.delete(id)
      return { ok: false, error: err?.code || 'proxy_unavailable' }
    }
    const normalizedCurrent = normalizeV2ProxyUrl(currentExit)
    if (!normalizedCurrent.ok) {
      session.codeVerifier = ''
      v2Sessions.delete(id)
      return { ok: false, error: 'proxy_unavailable' }
    }
    if (normalizedCurrent.value !== session.boundExit) {
      session.codeVerifier = ''
      v2Sessions.delete(id)
      return { ok: false, error: 'proxy_changed' }
    }
  }

  // Atomic single-use claim BEFORE any network I/O.
  session.consumed = true
  const verifier = session.codeVerifier
  const boundExit = session.boundExit
  const expectedEmail = session.email
  const targetAccountId = selectedWorkspace?.id || session.expectedAccountId || null

  const deadlineAc = new AbortController()
  const deadlineTimer = setTimeout(() => deadlineAc.abort(), Math.max(1, remainingMs))
  const combinedSignal = signal ? AbortSignal.any([deadlineAc.signal, signal]) : deadlineAc.signal

  try {
    try {
      onProgress?.('exchanging_token')
    } catch {}
    const tok = await exchange({
      code: parsed.code,
      codeVerifier: verifier,
      proxyUrl: boundExit,
      fetchImpl: fetchImpl || undefined,
      signal: combinedSignal,
      timeoutMs: Math.min(60_000, Math.max(3_000, remainingMs)),
    })
    if (signal?.aborted || session.canceled) return { ok: false, error: 'canceled' }
    if (deadlineAc.signal.aborted && !tok?.ok) return { ok: false, error: tok?.error || 'exchange_outcome_unknown' }
    if (!tok?.ok) {
      return { ok: false, error: tok?.error || 'exchange_rejected', ...(tok?.status ? { status: tok.status } : {}) }
    }

    try {
      onProgress?.('verifying_identity')
    } catch {}
    const verified = await verify({
      idToken: tok.id_token,
      expectedEmail,
      expectedAccountId: targetAccountId,
      proxyUrl: boundExit,
      fetchImpl: fetchImpl || undefined,
      signal: combinedSignal,
      timeoutMs: Math.min(30_000, Math.max(3_000, session.expiresAtMs - now())),
      now,
    })
    if (signal?.aborted || session.canceled) return { ok: false, error: 'canceled' }
    if (!verified?.ok) {
      return { ok: false, error: verified?.error || 'token_verification_failed' }
    }

    return {
      ok: true,
      verified: true,
      credential: {
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        id_token: tok.id_token,
        expires_at: tok.expires_at,
        email: verified.email,
        chatgpt_account_id: verified.chatgpt_account_id,
      },
      email: verified.email,
      chatgpt_account_id: verified.chatgpt_account_id,
    }
  } finally {
    clearTimeout(deadlineTimer)
    session.codeVerifier = ''
    v2Sessions.delete(id)
  }
}

export function resetCodexV2AuthSessions() {
  for (const session of v2Sessions.values()) session.codeVerifier = ''
  v2Sessions.clear()
}

export function resetCodexAuthUrlSessions() {
  sessions.clear()
  resetCodexV2AuthSessions()
}
