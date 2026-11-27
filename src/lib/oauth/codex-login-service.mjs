/**
 * External login service for GPT (Codex) slots using the `codex-auth-service` Callback v2 protocol.
 *
 * Flow:
 *   1. Caller acquires a concurrency permit in the global queue.
 *   2. vm2api generates a strict PKCE/state OAuth session bound to the slot's proxy exit.
 *   3. POST {endpoint}/v2/authenticate (Bearer token, NDJSON progress/heartbeat stream) → callback_url.
 *   4. vm2api strictly validates callback URL + state + exit consistency, consumes the session once,
 *      exchanges code + verifier directly with auth.openai.com via the same slot proxy, and
 *      cryptographically verifies the ID token via OIDC discovery/JWKS + email/workspace claims.
 *
 * Nothing here logs or echoes passwords, TOTP secrets, Bearer tokens, proxy credentials,
 * authorization codes, or PKCE verifiers.
 */
import crypto from 'node:crypto'
import nodeFetch from 'node-fetch'
import { encryptionEnabled, maybeDecrypt, maybeEncrypt } from '../db/secure.mjs'
import { parseCodexCredentialInput } from '../vm/codex-slot.mjs'
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  SELECTION_REASONS,
  WORKSPACE_KINDS,
  WORKSPACE_POLICIES,
  authenticateWithV2Service,
  checkAuthV2ServiceHealth,
  isPrivateHost,
  normalizeAuthV2Endpoint,
  normalizeV2MfaSecret,
  normalizeV2ProxyUrl,
} from './codex-auth-v2-client.mjs'
import { cancelCodexV2AuthSession, consumeCodexV2Callback, createCodexV2AuthSession } from './codex-oauth.mjs'
import { openaiIdentityFromOauthTokens } from './openai-jwt.mjs'

export { WORKSPACE_POLICIES, isPrivateHost, normalizeV2MfaSecret, normalizeV2ProxyUrl }

export const CODEX_LOGIN_SERVICE_KEY = 'codex_login_service'
export const CODEX_AUTH_TOKEN_ENV = 'VM2API_CODEX_AUTH_TOKEN'
export const SECRET_KEEP = '__KEEP__'

const MAX_SERVICE_TOKEN_LEN = 512
const WORKSPACE_POLICY_SET = new Set(WORKSPACE_POLICIES)
const WORKSPACE_KIND_SET = new Set(WORKSPACE_KINDS)
const SELECTION_REASON_SET = new Set(SELECTION_REASONS)

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

export function normalizeWorkspacePolicy(raw, fallback = 'auto') {
  const text = String(raw ?? '').trim()
  return WORKSPACE_POLICY_SET.has(text) ? text : fallback
}

export function validateEndpoint(raw) {
  const checked = normalizeAuthV2Endpoint(raw)
  return checked.ok ? { ok: true, value: checked.value } : { ok: false, error: checked.error }
}

export function envServiceToken() {
  return String(process.env[CODEX_AUTH_TOKEN_ENV] || '').trim()
}

function tokenReadable(value) {
  if (!value) return true
  try {
    maybeDecrypt(value)
    return true
  } catch {
    return false
  }
}

/** Stored Callback v2 service shape. Unknown legacy keys (headers, timeout_min) are safely dropped. */
export function normalizeServiceConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const checkedEndpoint = normalizeAuthV2Endpoint(src.endpoint || '')
  const endpoint = checkedEndpoint.ok ? checkedEndpoint.value : String(src.endpoint || '').trim()
  return {
    endpoint,
    service_token: typeof src.service_token === 'string' && src.service_token ? src.service_token : null,
    workspace_policy: normalizeWorkspacePolicy(src.workspace_policy, 'auto'),
    max_concurrency: clampInt(src.max_concurrency ?? src.batch_concurrency, 1, 512, 4),
    guard_enabled: src.guard_enabled !== false,
    guard: normalizeGuardRules(src.guard),
  }
}

export function resolveServiceToken(raw = {}) {
  const cfg = normalizeServiceConfig(raw)
  if (cfg.service_token) {
    try {
      const value = maybeDecrypt(cfg.service_token).trim()
      if (!value) return { ok: false, error: 'login_service_unconfigured' }
      return { ok: true, token: value, source: 'config' }
    } catch {
      return { ok: false, error: 'login_service_token_unreadable' }
    }
  }
  const fromEnv = envServiceToken()
  if (fromEnv) return { ok: true, token: fromEnv, source: 'env' }
  return { ok: false, error: 'login_service_unconfigured' }
}

export function isServiceConfigured(raw = {}) {
  const cfg = normalizeServiceConfig(raw)
  if (!cfg.endpoint) return false
  return !!cfg.service_token || !!envServiceToken()
}

export function publicServiceConfig(raw = {}, extra = {}) {
  const cfg = normalizeServiceConfig(raw)
  const envSet = !!envServiceToken()
  const unreadable = !!cfg.service_token && !tokenReadable(cfg.service_token)
  return {
    endpoint: cfg.endpoint,
    configured: isServiceConfigured(cfg),
    service_token_set: !!cfg.service_token || envSet,
    service_token_source: cfg.service_token ? 'config' : envSet ? 'env' : null,
    service_token_unreadable: unreadable,
    workspace_policy: cfg.workspace_policy,
    max_concurrency: cfg.max_concurrency,
    guard_enabled: cfg.guard_enabled,
    guard: cfg.guard,
    encryption_enabled: encryptionEnabled(),
    ...extra,
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

/** Merge a panel settings patch. Blank `service_token` keeps the saved token; `service_token_clear` removes it. */
export function applyServicePatch(settings, body = {}) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const prev = readServiceConfig(settings)
  const next = { ...prev }
  if (Object.hasOwn(src, 'endpoint')) {
    const checked = validateEndpoint(src.endpoint)
    if (!checked.ok) return { ok: false, error: checked.error }
    next.endpoint = checked.value
  }
  if (src.service_token_clear === true) {
    next.service_token = null
  }
  if (Object.hasOwn(src, 'service_token') && !isKeep(src.service_token)) {
    const value = String(src.service_token).trim()
    if (value.length > MAX_SERVICE_TOKEN_LEN || /[\r\n\0]/.test(value)) {
      return { ok: false, error: 'invalid_service_token' }
    }
    next.service_token = maybeEncrypt(value)
  }
  if (Object.hasOwn(src, 'workspace_policy')) {
    const policy = String(src.workspace_policy ?? '').trim()
    if (!WORKSPACE_POLICY_SET.has(policy)) return { ok: false, error: 'invalid_workspace_policy' }
    next.workspace_policy = policy
  }
  if (Object.hasOwn(src, 'max_concurrency')) {
    next.max_concurrency = src.max_concurrency
  }
  if (Object.hasOwn(src, 'guard_enabled')) next.guard_enabled = src.guard_enabled !== false
  if (src.guard && typeof src.guard === 'object') next.guard = { ...prev.guard, ...src.guard }
  const config = normalizeServiceConfig(next)
  settings.set(CODEX_LOGIN_SERVICE_KEY, config)
  return { ok: true, config }
}

export async function checkServiceHealth(config, opts = {}) {
  const cfg = normalizeServiceConfig(config)
  return checkAuthV2ServiceHealth({ endpoint: cfg.endpoint, ...opts })
}

function fail(error, extra = {}) {
  return { ok: false, error, ...extra }
}

/**
 * Full Callback v2 authentication flow for one account:
 *   create strict OAuth session → POST /v2/authenticate → validate callback & exit →
 *   single-use token exchange → OIDC/JWKS signature & identity verification.
 *
 * Caller MUST acquire its concurrency permit before invoking this function so the 10-minute
 * OAuth session TTL is never consumed waiting in queue.
 */
export async function loginWithService({
  config,
  email,
  password,
  mfaSecret = null,
  proxyUrl = '',
  vmId = null,
  installationId = null,
  expectedAccountId = null,
  workspacePolicy = null,
  resolveCurrentExit = null,
  signal = null,
  onProgress = null,
  fetchImpl = nodeFetch,
  exchangeFetchImpl = null,
  exchangeImpl = undefined,
  verifyImpl = undefined,
  randomId = () => crypto.randomUUID(),
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  const cfg = normalizeServiceConfig(config)
  if (!cfg.endpoint) return fail('login_service_unconfigured')
  const checkedEndpoint = normalizeAuthV2Endpoint(cfg.endpoint)
  if (!checkedEndpoint.ok) return fail(checkedEndpoint.error)

  const tokenRes = resolveServiceToken(cfg)
  if (!tokenRes.ok) return fail(tokenRes.error)
  if (signal?.aborted) return fail('canceled')

  const mfaChecked = normalizeV2MfaSecret(mfaSecret)
  if (!mfaChecked.ok) return fail(mfaChecked.error)

  const proxyChecked = normalizeV2ProxyUrl(proxyUrl)
  if (!proxyChecked.ok) return fail(proxyChecked.error)

  const policy = workspacePolicy != null ? normalizeWorkspacePolicy(workspacePolicy, '') : cfg.workspace_policy
  if (!policy) return fail('invalid_workspace_policy')

  const taskId = String(randomId()).trim().toLowerCase()
  let session
  try {
    session = createCodexV2AuthSession({
      taskId,
      vmId,
      email,
      installationId,
      boundExit: proxyChecked.value,
      expectedAccountId,
      workspacePolicy: policy,
      now: now(),
    })
  } catch (err) {
    return fail(err?.code || 'invalid_request')
  }

  const onAbort = () => cancelCodexV2AuthSession(taskId)
  signal?.addEventListener?.('abort', onAbort, { once: true })

  try {
    const authRes = await authenticateWithV2Service({
      endpoint: checkedEndpoint.value,
      serviceToken: tokenRes.token,
      input: {
        task_id: session.task_id,
        email,
        password,
        mfa_secret: mfaChecked.value,
        auth_url: session.auth_url,
        proxy: session.bound_exit,
        expires_at: session.expires_at,
        workspace_policy: policy,
        ...(expectedAccountId ? { expected_account_id: expectedAccountId } : {}),
      },
      signal,
      onProgress,
      idleTimeoutMs,
      fetchImpl,
      now,
    })

    if (!authRes.ok) {
      cancelCodexV2AuthSession(taskId)
      return fail(authRes.error, {
        ...(authRes.status ? { status: authRes.status } : {}),
        ...(authRes.stage ? { stage: authRes.stage } : {}),
        ...(authRes.retryable ? { retryable: true } : {}),
        ...(authRes.retryAfterMs ? { retryAfterMs: authRes.retryAfterMs } : {}),
      })
    }

    const consumed = await consumeCodexV2Callback({
      taskId,
      callbackUrl: authRes.callback_url,
      selectedWorkspace: authRes.selected_workspace || null,
      resolveCurrentExit,
      fetchImpl: exchangeFetchImpl || undefined,
      exchange: exchangeImpl,
      verify: verifyImpl,
      signal,
      onProgress,
      now,
    })
    if (!consumed.ok) {
      return fail(consumed.error, {
        ...(consumed.status ? { status: consumed.status } : {}),
      })
    }

    const selected = authRes.selected_workspace || null
    const workspace = {
      id: consumed.chatgpt_account_id,
      kind: selected?.kind && WORKSPACE_KIND_SET.has(selected.kind) ? selected.kind : null,
      name: typeof selected?.name === 'string' && selected.name.trim() ? selected.name.trim().slice(0, 200) : null,
      selection_reason:
        authRes.selection_reason && SELECTION_REASON_SET.has(authRes.selection_reason)
          ? authRes.selection_reason
          : null,
      candidate_count: Number.isInteger(authRes.candidate_count) ? authRes.candidate_count : null,
      selection_missing: !selected,
    }

    return {
      ok: true,
      verified: true,
      credential: consumed.credential,
      workspace,
    }
  } finally {
    signal?.removeEventListener?.('abort', onAbort)
    cancelCodexV2AuthSession(taskId)
  }
}

function sanitizeWorkspaceAttachment(workspace) {
  if (!workspace || typeof workspace !== 'object') return {}
  const out = {}
  if (WORKSPACE_KIND_SET.has(workspace.kind)) out.workspace_kind = workspace.kind
  if (typeof workspace.name === 'string' && workspace.name.trim()) {
    out.workspace_name = workspace.name.trim().slice(0, 200)
  }
  if (SELECTION_REASON_SET.has(workspace.selection_reason)) {
    out.workspace_selection_reason = workspace.selection_reason
  }
  if (Number.isInteger(workspace.candidate_count) && workspace.candidate_count >= 1) {
    out.workspace_candidate_count = workspace.candidate_count
  }
  if (workspace.selection_missing === true) {
    out.workspace_selection_missing = true
  }
  return out
}

/**
 * Turn a verified Callback v2 credential into a Codex slot account with whitelisted workspace metadata.
 * Identity comes from the JWTs, never from untrusted echoed fields.
 */
export function codexAccountFromLogin(credential = {}, { workspace = null } = {}) {
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
  const wsMeta = sanitizeWorkspaceAttachment(workspace)
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
  const account = { ...parsed.account, ...wsMeta }
  return {
    ok: true,
    account,
    email,
    chatgpt_account_id: accountId || null,
    workspace: workspace ? { ...workspace, id: accountId || workspace.id || null } : null,
  }
}
