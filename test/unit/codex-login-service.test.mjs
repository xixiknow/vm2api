import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import {
  CODEX_AUTH_TOKEN_ENV,
  CODEX_LOGIN_SERVICE_KEY,
  applyServicePatch,
  codexAccountFromLogin,
  isPrivateHost,
  isServiceConfigured,
  loginWithService,
  publicServiceConfig,
  readServiceConfig,
  validateEndpoint,
} from '../../src/lib/oauth/codex-login-service.mjs'
import { resetCodexAuthUrlSessions } from '../../src/lib/oauth/codex-oauth.mjs'

const PASSWORD = 'SECRET-PASSWORD-xyz'
const MFA = 'JBSWY3DPEHPK3PXP'
const SERVICE_TOKEN = 'SECRET-SERVICE-TOKEN-abc'
const PROXY = 'socks5h://puser:SECRET-PROXY-PASS@10.0.0.5:1080'
const TASK_ID = '00000000-0000-4000-8000-0000000000aa'

function memorySettings(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    get: (key, fallback = null) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
    set: (key, value) => store.set(key, structuredClone(value)),
  }
}

function withEnv(t, key, value) {
  const prev = process.env[key]
  if (value == null) delete process.env[key]
  else process.env[key] = value
  t.after(() => {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  })
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function fakeJwt(payload) {
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.sig`
}

function stateFromAuthUrl(authUrl) {
  const outer = new URL(authUrl)
  const inner = new URL(outer.searchParams.get('authorize_url') || '')
  return inner.searchParams.get('state') || ''
}

function assertNoSecrets(value) {
  const text = JSON.stringify(value)
  for (const secret of [PASSWORD, MFA, SERVICE_TOKEN, 'SECRET-PROXY-PASS']) {
    assert.ok(!text.includes(secret), `leaked ${secret}`)
  }
}

test('endpoint must be https unless host is private, and normalizes /v2/authenticate suffix', () => {
  assert.deepEqual(validateEndpoint(''), { ok: true, value: '' })
  assert.equal(validateEndpoint('https://auth.example.com/v2/authenticate').value, 'https://auth.example.com')
  assert.equal(validateEndpoint('http://auth.example.com/v2/authenticate').error, 'endpoint_requires_https')
  for (const url of [
    'http://127.0.0.1:8788',
    'http://127.0.0.1:8788/v2/authenticate',
    'http://10.1.2.3:8788',
    'http://auth-svc:8788',
    'http://host.docker.internal:8788',
    'http://[::1]:8788',
  ]) {
    assert.equal(validateEndpoint(url).ok, true, url)
  }
  assert.equal(validateEndpoint('https://u:p@auth.example.com').error, 'invalid_endpoint')
  assert.equal(isPrivateHost('8.8.8.8'), false)
  assert.equal(isPrivateHost('172.20.0.1'), true)
})

test('Callback v2 service config encrypts service_token, supports env fallback, and ignores legacy fields', (t) => {
  withEnv(t, 'VM2API_DB_SECRET', 'unit-test-db-secret')
  withEnv(t, CODEX_AUTH_TOKEN_ENV, null)
  const settings = memorySettings({
    [CODEX_LOGIN_SERVICE_KEY]: {
      endpoint: 'http://127.0.0.1:8788',
      headers: [{ name: 'X-Legacy', value: 'old' }],
      timeout_min: 25,
      batch_concurrency: 6,
    },
  })
  const migrated = readServiceConfig(settings)
  assert.equal(migrated.endpoint, 'http://127.0.0.1:8788')
  assert.equal(migrated.max_concurrency, 6)
  assert.equal(Object.hasOwn(migrated, 'headers'), false)
  assert.equal(isServiceConfigured(migrated), false)

  const saved = applyServicePatch(settings, {
    endpoint: 'http://127.0.0.1:8788/v2/authenticate',
    service_token: SERVICE_TOKEN,
    workspace_policy: 'prefer_organization',
    max_concurrency: 64,
    guard: { fail_threshold: 4 },
  })
  assert.equal(saved.ok, true)
  const stored = settings.store.get(CODEX_LOGIN_SERVICE_KEY)
  assert.match(stored.service_token, /^enc:v1:/)
  assert.ok(!JSON.stringify(stored).includes(SERVICE_TOKEN))

  // Blank service_token keeps the saved encrypted value.
  const kept = applyServicePatch(settings, { service_token: '', max_concurrency: 128 })
  assert.equal(kept.ok, true)
  assert.equal(settings.store.get(CODEX_LOGIN_SERVICE_KEY).service_token, stored.service_token)

  const view = publicServiceConfig(settings.store.get(CODEX_LOGIN_SERVICE_KEY))
  assert.equal(view.configured, true)
  assert.equal(view.service_token_set, true)
  assert.equal(view.service_token_source, 'config')
  assert.equal(view.workspace_policy, 'prefer_organization')
  assert.equal(view.max_concurrency, 128)
  assert.ok(!JSON.stringify(view).includes('enc:v1:'))
  assert.ok(!JSON.stringify(view).includes(SERVICE_TOKEN))

  // Clearing stored token falls back to env if present.
  assert.equal(applyServicePatch(settings, { service_token_clear: true }).ok, true)
  assert.equal(publicServiceConfig(settings.store.get(CODEX_LOGIN_SERVICE_KEY)).configured, false)
  process.env[CODEX_AUTH_TOKEN_ENV] = 'env-token'
  const envView = publicServiceConfig(settings.store.get(CODEX_LOGIN_SERVICE_KEY))
  assert.equal(envView.configured, true)
  assert.equal(envView.service_token_source, 'env')

  assert.equal(applyServicePatch(settings, { workspace_policy: 'invalid' }).error, 'invalid_workspace_policy')
  assert.equal(applyServicePatch(settings, { service_token: 'a\nb' }).error, 'invalid_service_token')
})

test('loginWithService completes full Callback v2 flow (auth → strict callback → exchange → JWKS verify)', async (t) => {
  t.after(resetCodexAuthUrlSessions)
  const stages = []
  let sentBody = null
  const result = await loginWithService({
    config: { endpoint: 'http://127.0.0.1:8788', service_token: SERVICE_TOKEN, workspace_policy: 'auto' },
    vmId: 'vm-01',
    email: 'user@example.com',
    password: PASSWORD,
    mfaSecret: MFA,
    proxyUrl: PROXY,
    randomId: () => TASK_ID,
    onProgress: (s) => stages.push(s),
    fetchImpl: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:8788/v2/authenticate')
      assert.equal(init.headers.authorization, `Bearer ${SERVICE_TOKEN}`)
      sentBody = JSON.parse(init.body)
      const state = stateFromAuthUrl(sentBody.auth_url)
      const events = [
        { type: 'accepted', task_id: TASK_ID, seq: 1, stage: 'authorizing' },
        { type: 'progress', task_id: TASK_ID, seq: 2, stage: 'verifying_mfa' },
        {
          type: 'result',
          task_id: TASK_ID,
          seq: 3,
          payload: {
            status: 'callback_ready',
            callback_url: `http://localhost:1455/auth/callback?code=CODE_V2&state=${state}`,
            selected_workspace: { id: 'ws_org_9', kind: 'organization', name: 'Org 9' },
            selection_reason: 'organization_preferred',
            candidate_count: 2,
          },
        },
      ]
      return {
        status: 200,
        headers: { get: (k) => (k === 'content-type' ? 'application/x-ndjson' : null) },
        body: Readable.from(events.map((e) => `${JSON.stringify(e)}\n`)),
      }
    },
    exchangeImpl: async ({ code, codeVerifier, proxyUrl }) => {
      assert.equal(code, 'CODE_V2')
      assert.ok(codeVerifier.length >= 43)
      assert.equal(proxyUrl, PROXY)
      return {
        ok: true,
        access_token: fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'ws_org_9' } }),
        refresh_token: 'rt-v2',
        id_token: fakeJwt({
          email: 'user@example.com',
          'https://api.openai.com/auth': { chatgpt_account_id: 'ws_org_9' },
        }),
        expires_at: 1_900_000_000_000,
      }
    },
    verifyImpl: async ({ expectedEmail, expectedAccountId }) => {
      assert.equal(expectedEmail, 'user@example.com')
      assert.equal(expectedAccountId, 'ws_org_9')
      return { ok: true, verified: true, email: 'user@example.com', chatgpt_account_id: 'ws_org_9' }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(sentBody.protocol_version, 2)
  assert.equal(sentBody.mfa_secret, MFA)
  assert.match(sentBody.expires_at, /Z$/)
  assert.equal(Object.hasOwn(sentBody, 'code_verifier'), false)
  assert.deepEqual(stages, ['authorizing', 'verifying_mfa', 'exchanging_token', 'verifying_identity'])
  assert.deepEqual(result.workspace, {
    id: 'ws_org_9',
    kind: 'organization',
    name: 'Org 9',
    selection_reason: 'organization_preferred',
    candidate_count: 2,
    selection_missing: false,
  })
  assertNoSecrets(result)

  const made = codexAccountFromLogin(result.credential, { workspace: result.workspace })
  assert.equal(made.ok, true)
  assert.equal(made.account.workspace_kind, 'organization')
  assert.equal(made.account.workspace_selection_reason, 'organization_preferred')
  assert.equal(made.account.workspace_candidate_count, 2)
})

test('loginWithService supports no-MFA (null), rejects empty proxy, and marks missing workspace metadata', async (t) => {
  t.after(resetCodexAuthUrlSessions)
  const noProxy = await loginWithService({
    config: { endpoint: 'http://127.0.0.1:8788', service_token: SERVICE_TOKEN },
    email: 'user@example.com',
    password: PASSWORD,
    mfaSecret: null,
    proxyUrl: '',
  })
  assert.equal(noProxy.ok, false)
  assert.equal(noProxy.error, 'proxy_required')

  let sentMfa = 'unset'
  const directCb = await loginWithService({
    config: { endpoint: 'http://127.0.0.1:8788', service_token: SERVICE_TOKEN },
    email: 'user@example.com',
    password: PASSWORD,
    mfaSecret: '',
    proxyUrl: PROXY,
    randomId: () => '00000000-0000-4000-8000-0000000000ab',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body)
      sentMfa = body.mfa_secret
      const state = stateFromAuthUrl(body.auth_url)
      return {
        status: 200,
        headers: { get: (k) => (k === 'content-type' ? 'application/x-ndjson' : null) },
        body: Readable.from([
          `${JSON.stringify({ type: 'accepted', task_id: body.task_id, seq: 1, stage: 'authorizing' })}\n`,
          `${JSON.stringify({ type: 'result', task_id: body.task_id, seq: 2, payload: { status: 'callback_ready', callback_url: `http://localhost:1455/auth/callback?code=C&state=${state}` } })}\n`,
        ]),
      }
    },
    exchangeImpl: async () => ({
      ok: true,
      access_token: fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'ws_direct' } }),
      refresh_token: 'rt-direct',
      id_token: fakeJwt({
        email: 'user@example.com',
        'https://api.openai.com/auth': { chatgpt_account_id: 'ws_direct' },
      }),
      expires_at: 0,
    }),
    verifyImpl: async ({ expectedAccountId }) => {
      assert.equal(expectedAccountId, null)
      return { ok: true, verified: true, email: 'user@example.com', chatgpt_account_id: 'ws_direct' }
    },
  })
  assert.equal(sentMfa, null)
  assert.equal(directCb.ok, true)
  assert.equal(directCb.workspace.id, 'ws_direct')
  assert.equal(directCb.workspace.selection_missing, true)
  assert.equal(directCb.workspace.selection_reason, null)
})
