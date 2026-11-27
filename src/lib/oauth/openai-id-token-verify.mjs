/**
 * Official OpenAI OIDC discovery + JWKS cryptographic verification for Codex ID tokens.
 *
 * Uses Node's built-in `node:crypto` (`createPublicKey({ key, format: 'jwk' })` + `verify`)
 * so no extra runtime dependency is required. Supports RS256 and ES256 (IEEE-P1363 JWS signatures),
 * enforces issuer/audience/expiry/required claims, and verifies email + chatgpt_account_id.
 */
import crypto from 'node:crypto'
import { CODEX_OAUTH_CLIENT_ID, makeProxyFetch } from '../protocol/codex-models.mjs'

export const OPENAI_OIDC_ISSUER = 'https://auth.openai.com'
export const OPENAI_OIDC_CLIENT_ID = CODEX_OAUTH_CLIENT_ID
const ALLOWED_ALGS = new Set(['RS256', 'ES256'])
const CLOCK_TOLERANCE_SEC = 5
const MAX_OIDC_BODY_BYTES = 256 * 1024
const DEFAULT_JWKS_CACHE_TTL_MS = 10 * 60 * 1000
const B64URL_RE = /^[A-Za-z0-9_-]+$/

/** @type {Map<string, { keys: object[], expiresAt: number }>} */
const jwksCache = new Map()

export function resetOpenAiJwksCache() {
  jwksCache.clear()
}

function closeBody(body) {
  try {
    if (typeof body?.destroy === 'function') body.destroy()
    else if (typeof body?.cancel === 'function') body.cancel().catch(() => {})
  } catch {}
}

async function readBoundedText(res, maxBytes) {
  const body = res?.body
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = []
    let total = 0
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.length
      if (total > maxBytes) {
        closeBody(body)
        throw new Error('oidc_response_too_large')
      }
      chunks.push(buf)
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  if (typeof res?.text === 'function') {
    const text = await res.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('oidc_response_too_large')
    return text
  }
  if (res && typeof res.body === 'object' && res.body !== null) {
    const text = JSON.stringify(res.body)
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('oidc_response_too_large')
    return text
  }
  throw new Error('oidc_response_missing')
}

async function fetchOidcJson(fetchFn, url, signal) {
  const res = await fetchFn(url, {
    method: 'GET',
    redirect: 'manual',
    signal,
    headers: { accept: 'application/json' },
  })
  const status = Number(res?.status) || 0
  if (status !== 200) {
    closeBody(res?.body)
    throw new Error(`oidc_http_${status}`)
  }
  const text = await readBoundedText(res, MAX_OIDC_BODY_BYTES)
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('oidc_invalid_json')
  }
  return parsed
}

async function loadJwks({ fetchFn, signal, issuer, cacheTtlMs, forceRefresh, now }) {
  const cacheKey = issuer
  if (cacheTtlMs > 0 && !forceRefresh) {
    const cached = jwksCache.get(cacheKey)
    if (cached && cached.expiresAt > now()) {
      return { keys: cached.keys, fromCache: true }
    }
  }
  const discovery = await fetchOidcJson(fetchFn, `${issuer}/.well-known/openid-configuration`, signal)
  if (discovery.issuer !== issuer || typeof discovery.jwks_uri !== 'string') {
    throw new Error('oidc_metadata_invalid')
  }
  const jwksUrl = new URL(discovery.jwks_uri)
  const issuerOrigin = new URL(issuer).origin
  if (jwksUrl.origin !== issuerOrigin || jwksUrl.username || jwksUrl.password || jwksUrl.hash) {
    throw new Error('oidc_jwks_uri_invalid')
  }
  const jwks = await fetchOidcJson(fetchFn, jwksUrl.href, signal)
  if (!Array.isArray(jwks.keys)) throw new Error('oidc_jwks_invalid')
  if (cacheTtlMs > 0) {
    jwksCache.set(cacheKey, { keys: jwks.keys, expiresAt: now() + cacheTtlMs })
  }
  return { keys: jwks.keys, fromCache: false }
}

function parseJwt(token) {
  if (typeof token !== 'string' || !token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, sigB64] = parts
  if (!B64URL_RE.test(headerB64) || !B64URL_RE.test(payloadB64) || !B64URL_RE.test(sigB64)) return null
  try {
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'))
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
    if (!header || typeof header !== 'object' || Array.isArray(header)) return null
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    return {
      signingInput: Buffer.from(`${headerB64}.${payloadB64}`, 'ascii'),
      signature: Buffer.from(sigB64, 'base64url'),
      header,
      payload,
    }
  } catch {
    return null
  }
}

function candidateJwks(keys, { alg, kid }) {
  return keys.filter((k) => {
    if (!k || typeof k !== 'object') return false
    if (k.use && k.use !== 'sig') return false
    if (Array.isArray(k.key_ops) && !k.key_ops.includes('verify')) return false
    if (k.alg && k.alg !== alg) return false
    if (kid && k.kid !== kid) return false
    if (alg === 'RS256') return k.kty === 'RSA'
    if (alg === 'ES256') return k.kty === 'EC' && k.crv === 'P-256'
    return false
  })
}

function verifyWithKeys(parsed, keys) {
  const alg = parsed.header.alg
  const kid = typeof parsed.header.kid === 'string' && parsed.header.kid ? parsed.header.kid : ''
  const matches = candidateJwks(keys, { alg, kid })
  for (const jwk of matches) {
    try {
      const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' })
      const ok =
        alg === 'ES256'
          ? crypto.verify(
              'sha256',
              parsed.signingInput,
              { key: publicKey, dsaEncoding: 'ieee-p1363' },
              parsed.signature,
            )
          : crypto.verify('sha256', parsed.signingInput, publicKey, parsed.signature)
      if (ok) return true
    } catch {
      // Skip malformed/incompatible JWK entry and continue checking remaining candidates.
    }
  }
  return false
}

function claimsValid(payload, { issuer, audience, clockToleranceSec, nowSec }) {
  if (payload.iss !== issuer) return false
  const aud = payload.aud
  const audOk = aud === audience || (Array.isArray(aud) && aud.includes(audience))
  if (!audOk) return false
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return false
  if (nowSec > payload.exp + clockToleranceSec) return false
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) return false
  if (typeof payload.sub !== 'string' || !payload.sub.trim()) return false
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf)) return false
    if (nowSec + clockToleranceSec < payload.nbf) return false
  }
  return true
}

/**
 * Verify an OpenAI ID token against official OIDC discovery/JWKS and match email + workspace.
 *
 * Returns:
 *   { ok: true, verified: true, email, chatgpt_account_id, payload }
 *   { ok: false, error: 'token_verification_failed' | 'identity_mismatch' | 'canceled' }
 */
export async function verifyOpenAiIdToken({
  idToken,
  expectedEmail,
  expectedAccountId = null,
  proxyUrl = '',
  fetchImpl = null,
  signal = null,
  timeoutMs = 15_000,
  issuer = OPENAI_OIDC_ISSUER,
  audience = OPENAI_OIDC_CLIENT_ID,
  clockToleranceSec = CLOCK_TOLERANCE_SEC,
  cacheTtlMs = DEFAULT_JWKS_CACHE_TTL_MS,
  now = () => Date.now(),
} = {}) {
  if (signal?.aborted) return { ok: false, error: 'canceled' }
  const parsed = parseJwt(idToken)
  if (!parsed || !ALLOWED_ALGS.has(parsed.header.alg)) {
    return { ok: false, error: 'token_verification_failed' }
  }
  const fetchFn = fetchImpl || makeProxyFetch(proxyUrl, timeoutMs)
  try {
    const first = await loadJwks({ fetchFn, signal, issuer, cacheTtlMs, forceRefresh: false, now })
    let verified = verifyWithKeys(parsed, first.keys)
    if (!verified && first.fromCache) {
      const refreshed = await loadJwks({ fetchFn, signal, issuer, cacheTtlMs, forceRefresh: true, now })
      verified = verifyWithKeys(parsed, refreshed.keys)
    }
    if (!verified) return { ok: false, error: 'token_verification_failed' }
  } catch {
    if (signal?.aborted) return { ok: false, error: 'canceled' }
    return { ok: false, error: 'token_verification_failed' }
  }
  if (signal?.aborted) return { ok: false, error: 'canceled' }

  const nowSec = Math.floor(now() / 1000)
  if (!claimsValid(parsed.payload, { issuer, audience, clockToleranceSec, nowSec })) {
    return { ok: false, error: 'token_verification_failed' }
  }

  const profile =
    parsed.payload['https://api.openai.com/profile'] &&
    typeof parsed.payload['https://api.openai.com/profile'] === 'object'
      ? parsed.payload['https://api.openai.com/profile']
      : null
  const auth =
    parsed.payload['https://api.openai.com/auth'] && typeof parsed.payload['https://api.openai.com/auth'] === 'object'
      ? parsed.payload['https://api.openai.com/auth']
      : null
  const rawEmail =
    typeof parsed.payload.email === 'string' && parsed.payload.email.trim()
      ? parsed.payload.email
      : typeof profile?.email === 'string'
        ? profile.email
        : ''
  const actualEmail = rawEmail.trim().toLowerCase()
  const wantEmail = String(expectedEmail || '')
    .trim()
    .toLowerCase()
  const actualAccount = typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id.trim() : ''
  const wantAccount = expectedAccountId != null ? String(expectedAccountId).trim() : ''

  if (!actualEmail || !wantEmail || actualEmail !== wantEmail) {
    return { ok: false, error: 'identity_mismatch' }
  }
  if (!actualAccount) {
    return { ok: false, error: 'identity_mismatch' }
  }
  if (wantAccount && actualAccount !== wantAccount) {
    return { ok: false, error: 'identity_mismatch' }
  }

  return {
    ok: true,
    verified: true,
    email: actualEmail,
    chatgpt_account_id: actualAccount,
    payload: parsed.payload,
  }
}
