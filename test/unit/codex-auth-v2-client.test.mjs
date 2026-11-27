import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import {
  authenticateWithV2Service,
  checkAuthV2ServiceHealth,
  isPrivateHost,
  normalizeAuthV2Endpoint,
  normalizeV2MfaSecret,
  normalizeV2ProxyUrl,
  parseRetryAfterMs,
} from '../../src/lib/oauth/codex-auth-v2-client.mjs'

const TASK_ID = '00000000-0000-4000-8000-000000000001'
const PASSWORD = 'SECRET-PASSWORD-xyz'
const MFA = 'JBSWY3DPEHPK3PXP'
const TOKEN = 'SECRET-SERVICE-TOKEN-999'
const PROXY = 'socks5h://puser:SECRET-PROXY-PASS@10.0.0.5:1080'
const AUTH_URL =
  'https://auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&response_type=code&scope=openid+profile+email+offline_access&code_challenge=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&code_challenge_method=S256&state=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function makeInput(overrides = {}) {
  return {
    task_id: TASK_ID,
    email: 'User@Example.com',
    password: PASSWORD,
    mfa_secret: MFA,
    auth_url: AUTH_URL,
    proxy: PROXY,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    workspace_policy: 'auto',
    ...overrides,
  }
}

function fakeStreamFetch({
  status = 200,
  contentType = 'application/x-ndjson; charset=utf-8',
  headers = {},
  chunks = [],
  hang = false,
  onRequest = null,
} = {}) {
  return async (url, init) => {
    onRequest?.(url, init)
    if (init.method === 'DELETE') {
      return { status: 200, headers: new Map(), body: Readable.from(['{"status":"canceling"}']) }
    }
    const hdrs = new Map(Object.entries({ 'content-type': contentType, ...headers }))
    async function* gen() {
      for (const chunk of chunks) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (hang) {
        await new Promise((_, reject) => {
          if (init.signal.aborted) reject(new Error('aborted'))
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
    }
    return {
      status,
      headers: { get: (k) => hdrs.get(k.toLowerCase()) ?? null },
      body: Readable.from(gen()),
    }
  }
}

function assertNoSecrets(value) {
  const text = JSON.stringify(value)
  for (const s of [PASSWORD, MFA, TOKEN, 'SECRET-PROXY-PASS']) {
    assert.ok(!text.includes(s), `leaked secret ${s}`)
  }
}

test('endpoint normalization accepts base URL or /v2/authenticate and blocks unsafe URLs', () => {
  assert.deepEqual(normalizeAuthV2Endpoint(''), { ok: true, value: '', urls: null })
  const base = normalizeAuthV2Endpoint('http://127.0.0.1:8788/')
  assert.equal(base.ok, true)
  assert.equal(base.value, 'http://127.0.0.1:8788')
  assert.equal(base.urls.authenticateUrl, 'http://127.0.0.1:8788/v2/authenticate')
  assert.equal(base.urls.taskUrl(TASK_ID), `http://127.0.0.1:8788/v2/tasks/${TASK_ID}`)
  assert.equal(base.urls.healthzUrl, 'http://127.0.0.1:8788/healthz')
  assert.equal(base.urls.readyzUrl, 'http://127.0.0.1:8788/readyz')

  const full = normalizeAuthV2Endpoint('https://auth.example.com/prefix/v2/authenticate')
  assert.equal(full.ok, true)
  assert.equal(full.value, 'https://auth.example.com/prefix')
  assert.equal(full.urls.authenticateUrl, 'https://auth.example.com/prefix/v2/authenticate')

  assert.equal(normalizeAuthV2Endpoint('http://auth.example.com:8788').error, 'endpoint_requires_https')
  assert.equal(normalizeAuthV2Endpoint('http://u:p@127.0.0.1:8788').error, 'invalid_endpoint')
  assert.equal(normalizeAuthV2Endpoint('http://127.0.0.1:8788?foo=1').error, 'invalid_endpoint')
  assert.equal(normalizeAuthV2Endpoint('http://127.0.0.1:8788#frag').error, 'invalid_endpoint')
  assert.equal(isPrivateHost('auth-svc'), true)
  assert.equal(isPrivateHost('8.8.8.8'), false)
})

test('mfa_secret and proxy normalization follow Callback v2 strict rules', () => {
  assert.deepEqual(normalizeV2MfaSecret(null), { ok: true, value: null })
  assert.deepEqual(normalizeV2MfaSecret('   '), { ok: true, value: null })
  assert.deepEqual(normalizeV2MfaSecret('jbsw y3dp ehpk 3pxp==='), { ok: true, value: 'JBSWY3DPEHPK3PXP' })
  assert.deepEqual(normalizeV2MfaSecret('otpauth://totp/OpenAI:a@b.com?secret=jbswy3dpehpk3pxp&issuer=OpenAI'), {
    ok: true,
    value: 'JBSWY3DPEHPK3PXP',
  })
  assert.equal(normalizeV2MfaSecret('too-short').error, 'invalid_totp')
  assert.equal(normalizeV2MfaSecret('123456').error, 'invalid_totp')

  assert.equal(normalizeV2ProxyUrl('').error, 'proxy_required')
  assert.equal(normalizeV2ProxyUrl(null).error, 'proxy_required')
  assert.equal(normalizeV2ProxyUrl('socks5://u:p@10.0.0.1:1080').value, 'socks5h://u:p@10.0.0.1:1080')
  assert.equal(normalizeV2ProxyUrl('http://127.0.0.1:7890').value, 'http://127.0.0.1:7890/')
  assert.equal(normalizeV2ProxyUrl('ftp://10.0.0.1:21').error, 'invalid_proxy')
  assert.equal(normalizeV2ProxyUrl('socks5h://10.0.0.1:1080?x=1').error, 'invalid_proxy')
})

test('authenticateWithV2Service streams chunked NDJSON, strips unknown fields, and reports stages', async () => {
  const requests = []
  const stages = []
  const resultLine = JSON.stringify({
    type: 'result',
    task_id: TASK_ID,
    seq: 4,
    payload: {
      status: 'callback_ready',
      callback_url: 'http://localhost:1455/auth/callback?code=CODE123&state=STATE123',
      selected_workspace: { id: 'ws_org_1', kind: 'organization', name: 'Acme Team' },
      selection_reason: 'organization_preferred',
      candidate_count: 2,
    },
  })
  const res = await authenticateWithV2Service({
    endpoint: 'http://127.0.0.1:8788',
    serviceToken: TOKEN,
    input: { ...makeInput(), exchange_proxy: 'should-not-be-sent', extra_field: 123 },
    onProgress: (s) => stages.push(s),
    fetchImpl: fakeStreamFetch({
      chunks: [
        Buffer.from(`{"type":"accepted","task_id":"${TASK_ID}","seq":1,"stage":"authorizing"}\n{"type":"pro`),
        Buffer.from(`gress","task_id":"${TASK_ID}","seq":2,"stage":"verifying_password"}\n`),
        Buffer.from(`{"type":"heartbeat","task_id":"${TASK_ID}","seq":3,"stage":"verifying_password"}\n`),
        Buffer.from(`${resultLine}\n`),
      ],
      onRequest: (url, init) => requests.push({ url, init }),
    }),
  })
  assert.equal(res.ok, true)
  assert.equal(res.callback_url, 'http://localhost:1455/auth/callback?code=CODE123&state=STATE123')
  assert.deepEqual(res.selected_workspace, { id: 'ws_org_1', kind: 'organization', name: 'Acme Team' })
  assert.equal(res.selection_reason, 'organization_preferred')
  assert.equal(res.candidate_count, 2)
  assert.deepEqual(stages, ['authorizing', 'verifying_password', 'verifying_password'])

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'http://127.0.0.1:8788/v2/authenticate')
  assert.equal(requests[0].init.headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(requests[0].init.headers.accept, 'application/x-ndjson')
  const sentBody = JSON.parse(requests[0].init.body)
  assert.equal(sentBody.protocol_version, 2)
  assert.equal(sentBody.email, 'user@example.com')
  assert.equal(Object.hasOwn(sentBody, 'exchange_proxy'), false)
  assert.equal(Object.hasOwn(sentBody, 'extra_field'), false)
})

test('authenticateWithV2Service accepts direct-to-callback result without workspace metadata', async () => {
  const res = await authenticateWithV2Service({
    endpoint: 'http://127.0.0.1:8788',
    serviceToken: TOKEN,
    input: makeInput({ mfa_secret: null }),
    fetchImpl: fakeStreamFetch({
      chunks: [
        `{"type":"accepted","task_id":"${TASK_ID}","seq":1,"stage":"authorizing"}\n`,
        `{"type":"result","task_id":"${TASK_ID}","seq":2,"payload":{"status":"callback_ready","callback_url":"http://localhost:1455/auth/callback?code=c&state=s"}}\n`,
      ],
    }),
  })
  assert.equal(res.ok, true)
  assert.equal(res.selected_workspace, undefined)
})

test('authenticateWithV2Service rejects malformed NDJSON, bad seq, wrong task_id, missing result, and HTTP 200 business errors', async () => {
  const cases = [
    [
      'wrong content-type',
      {
        contentType: 'application/json',
        chunks: [`{"type":"accepted","task_id":"${TASK_ID}","seq":1,"stage":"authorizing"}\n`],
      },
      'stream_invalid',
    ],
    [
      'missing accepted first',
      { chunks: [`{"type":"progress","task_id":"${TASK_ID}","seq":1,"stage":"identifying"}\n`] },
      'stream_invalid',
    ],
    [
      'seq gap',
      {
        chunks: [
          `{"type":"accepted","task_id":"${TASK_ID}","seq":1,"stage":"authorizing"}\n`,
          `{"type":"progress","task_id":"${TASK_ID}","seq":3,"stage":"identifying"}\n`,
        ],
      },
      'stream_invalid',
    ],
    [
      'wrong task_id',
      {
        chunks: [
          `{"type":"accepted","task_id":"00000000-0000-4000-8000-000000000099","seq":1,"stage":"authorizing"}\n`,
        ],
      },
      'stream_invalid',
    ],
    [
      'missing result at EOF',
      { chunks: [`{"type":"accepted","task_id":"${TASK_ID}","seq":1,"stage":"authorizing"}\n`] },
      'stream_invalid',
    ],
    [
      'trailing bytes without newline',
      {
        chunks: [
          `{"type":"accepted","task_id":"${TASK_ID}","seq":1,"stage":"authorizing"}\n`,
          `{"type":"result","task_id":"${TASK_ID}","seq":2,"payload":{"status":"callback_ready","callback_url":"http://localhost:1455/auth/callback?code=c&state=s"}}`,
        ],
      },
      'stream_invalid',
    ],
    [
      'HTTP 200 business failure',
      {
        chunks: [
          `{"type":"accepted","task_id":"${TASK_ID}","seq":1,"stage":"authorizing"}\n`,
          `{"type":"result","task_id":"${TASK_ID}","seq":2,"payload":{"status":"failed","error":{"code":"workspace_not_found","stage":"selecting_workspace","retryable":false}}}\n`,
        ],
      },
      'workspace_not_found',
    ],
    ['oversized line', { chunks: [`{"type":"accepted","pad":"${'x'.repeat(70_000)}"}\n`] }, 'response_too_large'],
  ]

  for (const [label, opts, expectedError] of cases) {
    const res = await authenticateWithV2Service({
      endpoint: 'http://127.0.0.1:8788',
      serviceToken: TOKEN,
      input: makeInput(),
      fetchImpl: fakeStreamFetch(opts),
    })
    assert.equal(res.ok, false, label)
    assert.equal(res.error, expectedError, label)
    assertNoSecrets(res)
  }

  // Rejects numeric millisecond expires_at instead of UTC ISO.
  const msRes = await authenticateWithV2Service({
    endpoint: 'http://127.0.0.1:8788',
    serviceToken: TOKEN,
    input: makeInput({ expires_at: Date.now() + 600_000 }),
    fetchImpl: fakeStreamFetch(),
  })
  assert.equal(msRes.error, 'invalid_request')
})

test('429 preserves Retry-After and caller abort triggers DELETE /v2/tasks/:task_id', async () => {
  const rateLimited = await authenticateWithV2Service({
    endpoint: 'http://127.0.0.1:8788',
    serviceToken: TOKEN,
    input: makeInput(),
    fetchImpl: fakeStreamFetch({
      status: 429,
      contentType: 'application/json',
      headers: { 'retry-after': '22' },
      chunks: ['{"error":{"code":"capacity_exceeded","retryable":true}}'],
    }),
  })
  assert.equal(rateLimited.ok, false)
  assert.equal(rateLimited.error, 'capacity_exceeded')
  assert.equal(rateLimited.retryable, true)
  assert.equal(rateLimited.retryAfterMs, 22_000)
  assert.equal(parseRetryAfterMs('15'), 15_000)

  const methods = []
  const ac = new AbortController()
  const pending = authenticateWithV2Service({
    endpoint: 'http://127.0.0.1:8788',
    serviceToken: TOKEN,
    input: makeInput(),
    signal: ac.signal,
    fetchImpl: fakeStreamFetch({
      hang: true,
      onRequest: (url, init) => methods.push({ method: init.method, url }),
    }),
  })
  setTimeout(() => ac.abort(), 15)
  const aborted = await pending
  assert.equal(aborted.error, 'canceled')
  assert.ok(methods.some((m) => m.method === 'DELETE' && m.url === `http://127.0.0.1:8788/v2/tasks/${TASK_ID}`))
})

test('checkAuthV2ServiceHealth probes /healthz and /readyz without Bearer', async () => {
  const seen = []
  const ok = await checkAuthV2ServiceHealth({
    endpoint: 'http://127.0.0.1:8788/v2/authenticate',
    fetchImpl: async (url, init) => {
      seen.push({ url, auth: init.headers.authorization })
      const body = url.endsWith('/readyz') ? '{"ready":true,"engine":"http"}' : '{"ok":true}'
      return { status: 200, body: Readable.from([body]) }
    },
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.readyz.engine, 'http')
  assert.equal(seen.length, 2)
  assert.equal(seen[0].auth, undefined)
})
