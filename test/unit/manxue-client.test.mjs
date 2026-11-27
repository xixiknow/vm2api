import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCreateTestBody,
  createManxueTest,
  normalizeManxueBaseUrl,
  normalizeManxueResult,
  parseRetryAfterMs,
  pollManxueTest,
  validatePublicCallbackBaseUrl,
} from '../../src/lib/iq/manxue-client.mjs'

test('validatePublicCallbackBaseUrl enforces public HTTPS origin', () => {
  assert.deepEqual(validatePublicCallbackBaseUrl('', { allowEmpty: true }), { ok: true, url: '' })
  assert.equal(validatePublicCallbackBaseUrl('').ok, false)
  assert.equal(validatePublicCallbackBaseUrl('http://gateway.example.com').error, 'callback_base_url_https_required')
  assert.equal(validatePublicCallbackBaseUrl('https://localhost:8787').error, 'callback_base_url_not_public')
  assert.equal(validatePublicCallbackBaseUrl('https://127.0.0.1:8787').error, 'callback_base_url_not_public')
  assert.equal(validatePublicCallbackBaseUrl('https://192.168.1.10').error, 'callback_base_url_not_public')
  assert.equal(validatePublicCallbackBaseUrl('https://10.0.0.5').error, 'callback_base_url_not_public')
  assert.equal(validatePublicCallbackBaseUrl('https://[::1]/gw').error, 'callback_base_url_not_public')
  assert.deepEqual(validatePublicCallbackBaseUrl('https://gw.example.com/sub/'), {
    ok: true,
    url: 'https://gw.example.com/sub',
  })
})

test('normalizeManxueBaseUrl and buildCreateTestBody handle pelican/candy/creative', () => {
  assert.deepEqual(normalizeManxueBaseUrl('https://manxue.ai///'), { ok: true, url: 'https://manxue.ai' })
  assert.equal(normalizeManxueBaseUrl('ftp://manxue.ai').ok, false)

  const pelican = buildCreateTestBody({
    benchmark: 'pelican',
    baseUrl: 'https://gw.example.com/api/manxue-bridge/abc',
    apiKey: 'secret',
    model: 'gpt-6-astra',
    reasoningEffort: 'medium',
    serviceTier: 'priority',
  })
  assert.deepEqual(pelican, {
    benchmark: 'pelican',
    base_url: 'https://gw.example.com/api/manxue-bridge/abc',
    api_key: 'secret',
    model: 'gpt-6-astra',
    reasoning_effort: 'medium',
    service_tier: 'priority',
  })

  const candy = buildCreateTestBody({
    benchmark: 'candy',
    baseUrl: 'https://gw.example.com/api/manxue-bridge/abc',
    apiKey: 'secret',
    model: 'gpt-6-astra',
    reasoningEffort: 'xhigh',
  })
  assert.equal(candy.reasoning_effort, 'xhigh')
  assert.equal(candy.service_tier, undefined)
})

test('createManxueTest handles 202 acceptance and 429 Retry-After', async () => {
  const seen = []
  const okRes = await createManxueTest({
    apiBaseUrl: 'https://manxue.ai',
    benchmark: 'pelican',
    baseUrl: 'https://gw.example.com/api/manxue-bridge/n1',
    apiKey: 'sec',
    model: 'gpt-6-astra',
    idempotencyKey: 'idem-1',
    fetchImpl: async (url, init) => {
      seen.push({ url, init })
      return {
        status: 202,
        headers: new Map(),
        text: async () => JSON.stringify({ id: 'test-123', status: 'running', phase: 'generating' }),
      }
    },
  })
  assert.equal(okRes.ok, true)
  assert.equal(okRes.id, 'test-123')
  assert.equal(seen[0].url, 'https://manxue.ai/api/v1/tests')
  assert.equal(seen[0].init.headers['idempotency-key'], 'idem-1')

  const rlRes = await createManxueTest({
    apiBaseUrl: 'https://manxue.ai',
    benchmark: 'candy',
    baseUrl: 'https://gw.example.com/api/manxue-bridge/n2',
    apiKey: 'sec',
    model: 'gpt-6-astra',
    fetchImpl: async () => ({
      status: 429,
      headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '12' : null) },
      text: async () => JSON.stringify({ error: 'too_many_requests' }),
    }),
  })
  assert.equal(rlRes.ok, false)
  assert.equal(rlRes.rateLimited, true)
  assert.equal(rlRes.retryAfterMs, 12_000)
})

test('pollManxueTest polls until succeeded and backs off on 429', async () => {
  let step = 0
  const sleeps = []
  const polled = await pollManxueTest({
    apiBaseUrl: 'https://manxue.ai',
    testId: 't-1',
    timeoutMs: 60_000,
    pollIntervalMs: 1_000,
    random: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    fetchImpl: async () => {
      step += 1
      if (step === 1) {
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify({ id: 't-1', status: 'running', phase: 'generating' }),
        }
      }
      if (step === 2) {
        return {
          status: 429,
          headers: { get: (k) => (k === 'retry-after' ? '4' : null) },
          text: async () => JSON.stringify({ error: 'rate_limited' }),
        }
      }
      return {
        status: 200,
        headers: new Map(),
        text: async () =>
          JSON.stringify({
            id: 't-1',
            benchmark: 'pelican',
            status: 'succeeded',
            phase: 'complete',
            result: { html: '<!doctype html><html><svg></svg></html>', duration_ms: 42000, output_tokens: 3200 },
            assessment: { quality: 'normal', label: '正常', reason: '分类结果为正常', source: 'source_classifier:v1' },
          }),
      }
    },
  })
  assert.equal(polled.ok, true)
  assert.equal(polled.data.status, 'succeeded')
  assert.deepEqual(sleeps, [1000, 4000])
})

test('normalizeManxueResult maps pelican, reference-only, candy, and fallback preview', () => {
  const pelDegraded = normalizeManxueResult('pelican', {
    benchmark: 'pelican',
    status: 'succeeded',
    result: { html: '<html><body><svg/></body></html>', duration_ms: 55000, input_tokens: 400, output_tokens: 4100 },
    assessment: { quality: 'degraded', label: '疑似降智', reason: '疑似降智', source: 'source_classifier:v1' },
  })
  assert.equal(pelDegraded.status, 'degraded')
  assert.equal(pelDegraded.reference_only, false)
  assert.equal(pelDegraded.artifact?.kind, 'html')
  assert.match(pelDegraded.artifact?.html || '', /<svg/)

  const pelRef = normalizeManxueResult(
    'pelican',
    {
      benchmark: 'pelican',
      status: 'succeeded',
      result: {},
      assessment: {
        quality: 'degraded',
        label: '参考',
        reason: '分类器基于 gpt-6-astra 训练，无法保证其他模型测试的准确性。',
      },
    },
    { fallbackOutput: '```html\n<!doctype html><html>fallback</html>\n```' },
  )
  assert.equal(pelRef.status, 'degraded')
  assert.equal(pelRef.reference_only, true)
  assert.equal(pelRef.artifact?.html, '<!doctype html><html>fallback</html>')

  const candyFail = normalizeManxueResult('candy', {
    benchmark: 'candy',
    status: 'succeeded',
    candy: { status: 'incorrect', answer: '答案是 19 个', duration_ms: 21000, input_tokens: 4300, output_tokens: 900 },
  })
  assert.equal(candyFail.status, 'degraded')
  assert.equal(candyFail.artifact?.kind, 'candy')
  assert.equal(candyFail.artifact?.answer, '答案是 19 个')
  assert.equal(parseRetryAfterMs('5'), 5000)
})
