import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import {
  CODEX_LOGIN_SERVICE_KEY,
  applyServicePatch,
  codexAccountFromLogin,
  isPrivateHost,
  loginWithService,
  publicServiceConfig,
  readServiceConfig,
  validateEndpoint,
} from '../../src/lib/oauth/codex-login-service.mjs'

const PASSWORD = 'SECRET-PASSWORD-xyz'
const MFA = 'JBSWY3DPEHPK3PXP'
const PROXY = 'socks5h://puser:SECRET-PROXY-PASS@10.0.0.5:1080'

function memorySettings(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    get: (key, fallback = null) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
    set: (key, value) => store.set(key, structuredClone(value)),
  }
}

function withDbSecret(t, value = 'unit-test-db-secret') {
  const prev = process.env.VM2API_DB_SECRET
  process.env.VM2API_DB_SECRET = value
  t.after(() => {
    if (prev === undefined) delete process.env.VM2API_DB_SECRET
    else process.env.VM2API_DB_SECRET = prev
  })
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function fakeJwt(payload) {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.sig`
}

function idToken(email, accountId = 'acct-123') {
  return fakeJwt({ email, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })
}

const CONFIG = { endpoint: 'https://login.example.test/api/v1/relogin', timeout_min: 1 }

function credential(email = 'user@example.com', extra = {}) {
  return {
    access_token: fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' } }),
    refresh_token: 'rt-1',
    id_token: idToken(email),
    expires_at: 1_900_000_000,
    ...extra,
  }
}

/** A fetch stand-in whose body streams `chunks`, and hangs (until aborted) when `hang` is set. */
function fakeFetch({ status = 200, chunks = [], hang = false, onRequest = null } = {}) {
  return async (url, init) => {
    onRequest?.(url, init)
    async function* gen() {
      for (const chunk of chunks) yield Buffer.from(chunk)
      if (hang) {
        await new Promise((_, reject) => {
          if (init.signal.aborted) reject(new Error('aborted'))
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
    }
    return { status, body: Readable.from(gen()) }
  }
}

function assertNoSecrets(value) {
  const text = JSON.stringify(value)
  for (const secret of [PASSWORD, MFA, 'SECRET-PROXY-PASS']) assert.ok(!text.includes(secret), `leaked ${secret}`)
}

test('endpoint must be https unless the host is private', () => {
  assert.deepEqual(validateEndpoint(''), { ok: true, value: '' })
  assert.equal(validateEndpoint('https://login.example.com/relogin').ok, true)
  assert.equal(validateEndpoint('http://login.example.com/relogin').error, 'endpoint_requires_https')
  for (const url of [
    'http://127.0.0.1:8080/x',
    'http://10.1.2.3/x',
    'http://192.168.1.9/x',
    'http://login-svc:8080/x',
    'http://host.docker.internal/x',
    'http://[::1]:9000/x',
  ]) {
    assert.equal(validateEndpoint(url).ok, true, url)
  }
  assert.equal(validateEndpoint('https://u:p@login.example.com/').error, 'invalid_endpoint')
  assert.equal(validateEndpoint('ftp://login.example.com/').error, 'invalid_endpoint')
  assert.equal(validateEndpoint('not a url').error, 'invalid_endpoint')
  assert.equal(isPrivateHost('8.8.8.8'), false)
  assert.equal(isPrivateHost('172.32.0.1'), false)
  assert.equal(isPrivateHost('172.20.0.1'), true)
})

test('header values are encrypted, kept when blank, and never returned', (t) => {
  withDbSecret(t)
  const settings = memorySettings()
  const first = applyServicePatch(settings, {
    endpoint: CONFIG.endpoint,
    headers: [{ name: 'X-Api-Key', value: 'SECRET-HEADER-VALUE' }],
    batch_concurrency: 3,
  })
  assert.equal(first.ok, true)
  const stored = settings.store.get(CODEX_LOGIN_SERVICE_KEY)
  assert.match(stored.headers[0].value, /^enc:v1:/)
  assert.ok(!JSON.stringify(stored).includes('SECRET-HEADER-VALUE'))

  const kept = applyServicePatch(settings, {
    headers: [{ name: 'x-api-key', value: '' }],
    guard: { fail_threshold: 4 },
  })
  assert.equal(kept.ok, true)
  assert.equal(settings.store.get(CODEX_LOGIN_SERVICE_KEY).headers[0].value, stored.headers[0].value)
  assert.equal(readServiceConfig(settings).guard.fail_threshold, 4)
  assert.equal(readServiceConfig(settings).guard.relogin_cooldown_min, 30)

  const view = publicServiceConfig(settings.store.get(CODEX_LOGIN_SERVICE_KEY))
  assert.deepEqual(view.headers, [{ name: 'x-api-key', value: '', value_set: true }])
  assert.equal(view.configured, true)
  assert.equal(view.batch_concurrency, 3)
  assert.ok(!JSON.stringify(view).includes('enc:v1:'))

  assert.equal(applyServicePatch(settings, { headers: [{ name: 'X-New', value: '' }] }).error, 'header_value_required')
  assert.equal(applyServicePatch(settings, { headers: [{ name: 'Host', value: 'x' }] }).error, 'invalid_header_name')
  assert.equal(
    applyServicePatch(settings, { headers: [{ name: 'X-A', value: 'a\r\nb' }] }).error,
    'invalid_header_value',
  )
  assert.equal(applyServicePatch(settings, { endpoint: 'http://public.example.com' }).error, 'endpoint_requires_https')
  assert.equal(applyServicePatch(settings, { endpoint: '' }).ok, true)
  assert.equal(publicServiceConfig(settings.store.get(CODEX_LOGIN_SERVICE_KEY)).configured, false)
})

test('login posts the sub2api payload with the slot proxy and skips heartbeats', async () => {
  let seen = null
  const result = await loginWithService({
    config: { ...CONFIG, headers: [{ name: 'X-Client', value: 'id-{{uuid}}' }] },
    email: 'user@example.com',
    password: PASSWORD,
    mfaSecret: MFA,
    proxyUrl: PROXY,
    randomId: () => 'fixed-uuid',
    fetchImpl: fakeFetch({
      chunks: [
        '{"type":"progress","stage":"password"}\n{"type":"heart',
        'beat"}\n',
        JSON.stringify({
          type: 'result',
          payload: { credential: { ...credential(), password: PASSWORD, mfa_secret: MFA, email: 'echo@evil.test' } },
        }),
        '\n',
      ],
      onRequest: (url, init) => {
        seen = { url, init }
      },
    }),
  })
  assert.equal(result.ok, true)
  assert.equal(seen.url, CONFIG.endpoint)
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.redirect, 'manual')
  assert.equal(seen.init.headers['x-client'], 'id-fixed-uuid')
  assert.equal(seen.init.headers.origin, 'https://login.example.test')
  assert.deepEqual(JSON.parse(seen.init.body), {
    action: 'start',
    email: 'user@example.com',
    auth_mode: 'password_2fa',
    password: PASSWORD,
    mfa_secret: MFA,
    proxy: PROXY,
  })
  assert.equal(result.credential.refresh_token, 'rt-1')
  assert.equal(result.credential.expires_at, 1_900_000_000_000)
  assert.equal(result.credential.email, undefined)
  assertNoSecrets(result)
})

test('a pretty-printed single JSON response works and no proxy field is sent when empty', async () => {
  let body = null
  const result = await loginWithService({
    config: CONFIG,
    email: 'user@example.com',
    password: PASSWORD,
    mfaSecret: MFA,
    fetchImpl: fakeFetch({
      chunks: [JSON.stringify({ credential: credential() }, null, 2)],
      onRequest: (_url, init) => {
        body = JSON.parse(init.body)
      },
    }),
  })
  assert.equal(result.ok, true)
  assert.equal(Object.hasOwn(body, 'proxy'), false)
})

test('failures map to short codes that never carry submitted secrets', async () => {
  const base = { config: CONFIG, email: 'user@example.com', password: PASSWORD, mfaSecret: MFA, proxyUrl: PROXY }
  const cases = [
    [{ chunks: ['{"error":{"code":"Invalid_Password","message":"bad ' + PASSWORD + '"}}'] }, 'login_rejected'],
    [{ chunks: [`{"error":{"code":"${PASSWORD}"}}`] }, 'login_rejected'],
    [{ chunks: ['{"status":"auth_failed"}'] }, 'login_rejected'],
    [
      { chunks: [JSON.stringify({ credential: { access_token: 'a', refresh_token: 'r' } })] },
      'login_credential_incomplete',
    ],
    [{ chunks: ['{"status":"ok"}'] }, 'login_no_credential'],
    [{ chunks: ['{"type":"heartbeat"}\n'] }, 'login_no_result'],
    [{ chunks: ['<html>oops</html>'] }, 'login_response_invalid'],
    [{ status: 502, chunks: [`upstream said ${PASSWORD}`] }, 'login_service_http'],
  ]
  const details = []
  for (const [opts, code] of cases) {
    const result = await loginWithService({ ...base, fetchImpl: fakeFetch(opts) })
    assert.equal(result.ok, false)
    assert.equal(result.error, code, JSON.stringify(opts))
    assertNoSecrets(result)
    details.push(result.detail)
  }
  assert.equal(details[0], 'invalid_password')
  assert.equal(details[1], 'relogin_rejected')
  assert.equal(details[2], 'auth_failed')

  const unreachable = await loginWithService({
    ...base,
    fetchImpl: async () => {
      throw new Error(`connect failed ${PASSWORD}`)
    },
  })
  assert.deepEqual(unreachable, { ok: false, error: 'login_service_unreachable' })
  assert.equal((await loginWithService({ ...base, config: {} })).error, 'login_service_unconfigured')
})

test('oversized, idle and cancelled responses stop the request', async () => {
  const base = { config: CONFIG, email: 'user@example.com', password: PASSWORD, mfaSecret: MFA }
  const big = await loginWithService({
    ...base,
    maxBytes: 64,
    fetchImpl: fakeFetch({ chunks: [`{"type":"progress","pad":"${'x'.repeat(200)}"}`] }),
  })
  assert.equal(big.error, 'login_response_too_large')

  const idle = await loginWithService({
    ...base,
    idleTimeoutMs: 30,
    fetchImpl: fakeFetch({ chunks: ['{"type":"progress"}\n'], hang: true }),
  })
  assert.equal(idle.error, 'login_idle_timeout')

  const ac = new AbortController()
  const pending = loginWithService({ ...base, signal: ac.signal, fetchImpl: fakeFetch({ hang: true }) })
  setTimeout(() => ac.abort(), 20)
  assert.equal((await pending).error, 'canceled')

  const already = new AbortController()
  already.abort()
  assert.equal((await loginWithService({ ...base, signal: already.signal, fetchImpl: fakeFetch() })).error, 'canceled')
})

test('codex account identity comes from the JWT, not echoed fields', () => {
  const made = codexAccountFromLogin({ ...credential('Real@Example.com'), chatgpt_account_id: 'acct-other' })
  assert.equal(made.ok, true)
  assert.equal(made.email, 'real@example.com')
  assert.equal(made.chatgpt_account_id, 'acct-123')
  assert.equal(made.account.email, 'real@example.com')
  assert.equal(made.account.chatgpt_account_id, 'acct-123')
  assert.equal(made.account.refresh_token, 'rt-1')
  assert.equal(made.account.expires_at, 1_900_000_000)

  const noEmail = codexAccountFromLogin({ ...credential(), id_token: fakeJwt({ sub: 'x' }) })
  assert.equal(noEmail.ok, true)
  assert.equal(noEmail.email, '')
  assert.equal(codexAccountFromLogin({ id_token: 'x' }).ok, false)
})
