import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cancelCodexV2AuthSession,
  consumeCodexV2Callback,
  createCodexV2AuthSession,
  deriveCodexSurfaceStableId,
  generateCodexAuthUrl,
  parseCodexOAuthCallback,
  resetCodexAuthUrlSessions,
  validateCodexV2Callback,
} from '../../src/lib/oauth/codex-oauth.mjs'

const TASK_ID = '00000000-0000-4000-8000-000000000010'
const PROXY = 'socks5h://u:p@10.0.0.7:1080/'

function stateFromDesktopAuthUrl(authUrl) {
  const outer = new URL(authUrl)
  const inner = new URL(outer.searchParams.get('authorize_url') || '')
  return inner.searchParams.get('state') || ''
}

test('generateCodexAuthUrl wraps official desktop-auth authorize URL', () => {
  resetCodexAuthUrlSessions()
  const generated = generateCodexAuthUrl({
    vmId: 'vm-codex-01',
    proxyUrl: 'socks5h://127.0.0.1:1080',
    installationId: '11111111-1111-4111-8111-111111111111',
  })
  assert.equal(generated.flavor, 'codex')
  assert.match(generated.auth_url, /^https:\/\/chatgpt\.com\/codex\/desktop-auth\?/)
  const outer = new URL(generated.auth_url)
  const inner = new URL(outer.searchParams.get('authorize_url') || '')
  assert.equal(inner.origin + inner.pathname, 'https://auth.openai.com/oauth/authorize')
  assert.equal(inner.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback')
  assert.equal(inner.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann')
  assert.equal(inner.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(inner.searchParams.get('originator'), 'Codex Desktop')
})

test('parseCodexOAuthCallback reads loopback URL', () => {
  const parsed = parseCodexOAuthCallback('http://localhost:1455/auth/callback?code=abc&state=xyz&foo=1')
  assert.equal(parsed.code, 'abc')
  assert.equal(parsed.state, 'xyz')
})

test('deriveCodexSurfaceStableId is stable UUID', () => {
  const a = deriveCodexSurfaceStableId('11111111-1111-4111-8111-111111111111')
  const b = deriveCodexSurfaceStableId('11111111-1111-4111-8111-111111111111')
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('validateCodexV2Callback strictly checks origin, path, state, duplicate params, iss, error, and code', () => {
  const ok = validateCodexV2Callback(
    'http://localhost:1455/auth/callback?code=CODE_1&state=STATE_1&iss=https%3A%2F%2Fauth.openai.com',
    'STATE_1',
  )
  assert.equal(ok.code, 'CODE_1')

  assert.throws(() => validateCodexV2Callback('http://localhost:1455/auth/callback?code=CODE_1', 'STATE_1'), {
    code: 'state_mismatch',
  })
  assert.throws(
    () => validateCodexV2Callback('http://localhost:1455/auth/callback?code=CODE_1&state=WRONG', 'STATE_1'),
    { code: 'state_mismatch' },
  )
  assert.throws(
    () => validateCodexV2Callback('http://127.0.0.1:1455/auth/callback?code=CODE_1&state=STATE_1', 'STATE_1'),
    { code: 'callback_invalid' },
  )
  assert.throws(
    () => validateCodexV2Callback('http://localhost:1455/auth/callback?code=a&code=b&state=STATE_1', 'STATE_1'),
    { code: 'callback_invalid' },
  )
  assert.throws(
    () => validateCodexV2Callback('http://localhost:1455/auth/callback?code=a&state=STATE_1#frag', 'STATE_1'),
    { code: 'callback_invalid' },
  )
  assert.throws(
    () => validateCodexV2Callback('http://localhost:1455/auth/callback?error=access_denied&state=STATE_1', 'STATE_1'),
    { code: 'oauth_authorization_error' },
  )
  assert.throws(
    () =>
      validateCodexV2Callback(
        'http://localhost:1455/auth/callback?code=a&state=STATE_1&iss=https%3A%2F%2Fevil.example.com',
        'STATE_1',
      ),
    { code: 'callback_invalid' },
  )
})

test('Callback v2 session enforces single-use atomic consumption, egress drift check, and cancel cleanup', async (t) => {
  t.after(resetCodexAuthUrlSessions)
  const session = createCodexV2AuthSession({
    taskId: TASK_ID,
    vmId: 'vm-1',
    email: 'user@example.com',
    boundExit: PROXY,
    expectedAccountId: 'ws_1',
  })
  assert.match(session.expires_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/)
  const state = stateFromDesktopAuthUrl(session.auth_url)
  const callbackUrl = `http://localhost:1455/auth/callback?code=AUTH_CODE&state=${state}`

  let exchangeCalls = 0
  let releaseExchange
  const exchangeGate = new Promise((r) => {
    releaseExchange = r
  })
  const first = consumeCodexV2Callback({
    taskId: TASK_ID,
    callbackUrl,
    selectedWorkspace: { id: 'ws_1', kind: 'organization' },
    resolveCurrentExit: () => PROXY,
    exchange: async ({ proxyUrl }) => {
      exchangeCalls++
      assert.equal(proxyUrl, PROXY)
      await exchangeGate
      return { ok: true, access_token: 'at', refresh_token: 'rt', id_token: 'idt', expires_at: 0 }
    },
    verify: async ({ expectedEmail, expectedAccountId }) => {
      assert.equal(expectedEmail, 'user@example.com')
      assert.equal(expectedAccountId, 'ws_1')
      return { ok: true, verified: true, email: 'user@example.com', chatgpt_account_id: 'ws_1' }
    },
  })
  // Concurrent duplicate callback is rejected immediately without a second exchange.
  const second = await consumeCodexV2Callback({
    taskId: TASK_ID,
    callbackUrl,
    resolveCurrentExit: () => PROXY,
    exchange: async () => assert.fail('duplicate callback must never trigger exchange'),
  })
  assert.equal(second.ok, false)
  assert.equal(second.error, 'task_already_finished')

  releaseExchange()
  const res1 = await first
  assert.equal(res1.ok, true)
  assert.equal(res1.chatgpt_account_id, 'ws_1')
  assert.equal(exchangeCalls, 1)

  // Egress drift mid-login aborts before exchange.
  const s2 = createCodexV2AuthSession({
    taskId: '00000000-0000-4000-8000-000000000011',
    vmId: 'vm-1',
    email: 'user@example.com',
    boundExit: PROXY,
  })
  const drifted = await consumeCodexV2Callback({
    taskId: s2.task_id,
    callbackUrl: `http://localhost:1455/auth/callback?code=C2&state=${stateFromDesktopAuthUrl(s2.auth_url)}`,
    resolveCurrentExit: () => 'socks5h://other:p@10.0.0.9:1080',
    exchange: async () => assert.fail('must not exchange when slot egress drifted'),
  })
  assert.equal(drifted.ok, false)
  assert.equal(drifted.error, 'proxy_changed')

  // Cancel prevents any later consumption.
  const s3 = createCodexV2AuthSession({
    taskId: '00000000-0000-4000-8000-000000000012',
    vmId: 'vm-1',
    email: 'user@example.com',
    boundExit: PROXY,
  })
  assert.equal(cancelCodexV2AuthSession(s3.task_id), true)
  const afterCancel = await consumeCodexV2Callback({
    taskId: s3.task_id,
    callbackUrl: `http://localhost:1455/auth/callback?code=C3&state=${stateFromDesktopAuthUrl(s3.auth_url)}`,
    exchange: async () => assert.fail('must not exchange canceled session'),
  })
  assert.equal(afterCancel.ok, false)
  assert.equal(afterCancel.error, 'expired')

  // Unknown exchange outcome consumes the session so the authorization code is never reused.
  const s4 = createCodexV2AuthSession({
    taskId: '00000000-0000-4000-8000-000000000013',
    vmId: 'vm-1',
    email: 'user@example.com',
    boundExit: PROXY,
  })
  const cb4 = `http://localhost:1455/auth/callback?code=C4&state=${stateFromDesktopAuthUrl(s4.auth_url)}`
  const unknown = await consumeCodexV2Callback({
    taskId: s4.task_id,
    callbackUrl: cb4,
    exchange: async () => ({ ok: false, error: 'exchange_outcome_unknown' }),
  })
  assert.equal(unknown.error, 'exchange_outcome_unknown')
  const reuse = await consumeCodexV2Callback({
    taskId: s4.task_id,
    callbackUrl: cb4,
    exchange: async () => assert.fail('must not reuse code after unknown outcome'),
  })
  assert.equal(reuse.ok, false)
})
