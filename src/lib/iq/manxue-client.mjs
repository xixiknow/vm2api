/**
 * Client for https://manxue.ai/api (async degradation / IQ benchmark API).
 *
 * Bridge/callback benchmarks supported in v1:
 *   - `pelican`  : SVG pelican-on-a-bicycle HTML generation + local classifier
 *   - `candy`    : logic/math candy benchmark (passed / incorrect / error)
 *   - `creative` : free-form SVG/HTML creation + local classifier
 *
 * Endpoints:
 *   POST   /api/v1/tests       -> 202 Accepted { id, status, phase, expires_at }
 *   GET    /api/v1/tests/{id}  -> task progress & final result
 *   DELETE /api/v1/tests/{id}  -> cancel an unfinished task
 */
import net from 'node:net'
import fetch from 'node-fetch'

export const DEFAULT_MANXUE_BASE_URL = 'https://manxue.ai'
export const BRIDGE_BENCHMARKS = Object.freeze(['pelican', 'candy', 'creative'])
export const CANDY_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
export const HTML_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high'])
export const MANXUE_SERVICE_TIERS = Object.freeze(['', 'priority', 'ultrafast'])

export const DEFAULT_POLL_INTERVAL_MS = 3_000
export const DEFAULT_HTTP_TIMEOUT_MS = 20_000
export const MAX_ARTIFACT_HTML_BYTES = 512 * 1024
export const MAX_ARTIFACT_ANSWER_CHARS = 32_000

const MAX_RETRY_AFTER_MS = 120_000
const MIN_RETRY_AFTER_MS = 1_000

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

function isPrivateIpv6(raw) {
  const ip = String(raw || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
  if (!ip) return true
  if (ip === '::' || ip === '::1') return true
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true
  if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice('::ffff:'.length)
    if (net.isIPv4(mapped)) return isPrivateIpv4(mapped)
  }
  return false
}

/** Validate `api_base_url` (https:// or http:// for self-hosted/test instances). */
export function normalizeManxueBaseUrl(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: true, url: DEFAULT_MANXUE_BASE_URL }
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return { ok: false, error: 'invalid_api_base_url' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'invalid_api_base_url' }
  }
  if (!parsed.hostname) return { ok: false, error: 'invalid_api_base_url' }
  const cleanPath = parsed.pathname.replace(/\/+$/, '')
  return { ok: true, url: `${parsed.origin}${cleanPath}` }
}

/**
 * Validate `callback_base_url`: manxue.ai requires a public HTTPS origin (optionally with path prefix).
 * Rejects plain HTTP, loopback, RFC1918 private IPs, and `.local`/`.internal` hostnames.
 */
export function validatePublicCallbackBaseUrl(raw, { allowEmpty = false } = {}) {
  const text = String(raw ?? '').trim()
  if (!text) {
    return allowEmpty ? { ok: true, url: '' } : { ok: false, error: 'callback_base_url_required' }
  }
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return { ok: false, error: 'invalid_callback_base_url' }
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'callback_base_url_https_required' }
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { ok: false, error: 'invalid_callback_base_url' }
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return { ok: false, error: 'invalid_callback_base_url' }
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.invalid')
  ) {
    return { ok: false, error: 'callback_base_url_not_public' }
  }
  const ipVer = net.isIP(host)
  if (ipVer === 4 && isPrivateIpv4(host)) return { ok: false, error: 'callback_base_url_not_public' }
  if (ipVer === 6 && isPrivateIpv6(host)) return { ok: false, error: 'callback_base_url_not_public' }
  const cleanPath = parsed.pathname.replace(/\/+$/, '')
  return { ok: true, url: `${parsed.origin}${cleanPath}` }
}

export function allowedEffortsForBenchmark(benchmark) {
  return benchmark === 'candy' ? CANDY_REASONING_EFFORTS : HTML_REASONING_EFFORTS
}

export function parseRetryAfterMs(value, now = Date.now()) {
  if (value == null) return null
  const text = String(value).trim()
  if (!text) return null
  const secs = Number(text)
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Math.round(secs * 1000)))
  }
  const ts = Date.parse(text)
  if (Number.isFinite(ts)) {
    const delta = ts - now
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Math.round(delta)))
  }
  return null
}

function numOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

function truncateUtf8(str, maxBytes) {
  const text = String(str || '')
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const buf = Buffer.from(text, 'utf8')
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString('utf8')
}

async function fetchJsonWithTimeout(url, init = {}, { fetchImpl = fetch, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const signal = init.signal ? AbortSignal.any([ac.signal, init.signal]) : ac.signal
  try {
    const res = await fetchImpl(url, { ...init, signal })
    const status = Number(res?.status) || 0
    const retryAfterHeader = res?.headers?.get ? res.headers.get('retry-after') : res?.headers?.['retry-after']
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader)
    let data = null
    let rawText = ''
    try {
      rawText = typeof res?.text === 'function' ? await res.text() : ''
      if (rawText) data = JSON.parse(rawText)
    } catch {
      data = null
    }
    return { ok: status >= 200 && status < 300, status, retryAfterMs, data, rawText }
  } catch (err) {
    const aborted = Boolean(init.signal?.aborted)
    const timedOut = !aborted && ac.signal.aborted
    return {
      ok: false,
      status: 0,
      retryAfterMs: null,
      data: null,
      rawText: '',
      aborted,
      timedOut,
      error: aborted ? 'aborted' : timedOut ? 'request_timeout' : String(err?.message || err || 'network_error'),
    }
  } finally {
    clearTimeout(timer)
  }
}

export function buildCreateTestBody({ benchmark, baseUrl, apiKey, model, reasoningEffort = 'low', serviceTier = '' }) {
  const mode = String(benchmark || 'pelican').trim()
  if (!BRIDGE_BENCHMARKS.includes(mode)) {
    throw new Error(`unsupported benchmark: ${mode}`)
  }
  const body = {
    benchmark: mode,
    base_url: String(baseUrl || '').trim(),
    api_key: String(apiKey || '').trim(),
  }
  const cleanModel = String(model || '').trim()
  if (cleanModel) body.model = cleanModel
  else if (mode !== 'candy') throw new Error('model is required for pelican/creative benchmark')

  const allowedEfforts = allowedEffortsForBenchmark(mode)
  const eff = String(reasoningEffort || '').trim()
  if (eff && allowedEfforts.includes(eff)) {
    body.reasoning_effort = eff
  }

  const tier = String(serviceTier || '').trim()
  if (tier === 'priority' || tier === 'ultrafast') {
    body.service_tier = tier
  }
  return body
}

export async function createManxueTest({
  apiBaseUrl = DEFAULT_MANXUE_BASE_URL,
  benchmark,
  baseUrl,
  apiKey,
  model,
  reasoningEffort = 'low',
  serviceTier = '',
  idempotencyKey = '',
  fetchImpl = fetch,
  signal,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
} = {}) {
  const normBase = normalizeManxueBaseUrl(apiBaseUrl)
  if (!normBase.ok) return { ok: false, status: 0, retryable: false, error: normBase.error }
  let body
  try {
    body = buildCreateTestBody({ benchmark, baseUrl, apiKey, model, reasoningEffort, serviceTier })
  } catch (err) {
    return { ok: false, status: 400, retryable: false, error: String(err.message || err) }
  }
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
  }
  if (idempotencyKey) {
    headers['idempotency-key'] = String(idempotencyKey).slice(0, 128)
  }
  const res = await fetchJsonWithTimeout(
    `${normBase.url}/api/v1/tests`,
    { method: 'POST', headers, body: JSON.stringify(body), signal },
    { fetchImpl, timeoutMs },
  )
  if (res.ok && res.data?.id) {
    return {
      ok: true,
      status: res.status,
      id: String(res.data.id),
      data: res.data,
    }
  }
  const errMsg =
    res.data?.error?.message ||
    (typeof res.data?.error === 'string' ? res.data.error : null) ||
    res.data?.message ||
    res.error ||
    (res.status ? `manxue_http_${res.status}` : 'manxue_network_error')
  const retryable = res.status === 429 || res.status === 503 || res.status >= 500 || res.status === 0
  return {
    ok: false,
    status: res.status,
    retryable,
    rateLimited: res.status === 429 || res.status === 503,
    retryAfterMs: res.retryAfterMs,
    aborted: res.aborted === true,
    timedOut: res.timedOut === true,
    error: String(errMsg).slice(0, 300),
    data: res.data,
  }
}

export async function getManxueTest({
  apiBaseUrl = DEFAULT_MANXUE_BASE_URL,
  testId,
  fetchImpl = fetch,
  signal,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
} = {}) {
  const normBase = normalizeManxueBaseUrl(apiBaseUrl)
  if (!normBase.ok) return { ok: false, status: 0, retryable: false, error: normBase.error }
  const id = String(testId || '').trim()
  if (!id) return { ok: false, status: 400, retryable: false, error: 'missing_test_id' }

  const res = await fetchJsonWithTimeout(
    `${normBase.url}/api/v1/tests/${encodeURIComponent(id)}`,
    { method: 'GET', headers: { accept: 'application/json' }, signal },
    { fetchImpl, timeoutMs },
  )
  if (res.ok && res.data && typeof res.data === 'object') {
    return { ok: true, status: res.status, data: res.data }
  }
  const errMsg =
    res.data?.error?.message ||
    (typeof res.data?.error === 'string' ? res.data.error : null) ||
    res.data?.message ||
    res.error ||
    (res.status ? `manxue_http_${res.status}` : 'manxue_network_error')
  return {
    ok: false,
    status: res.status,
    expired: res.status === 404,
    rateLimited: res.status === 429 || res.status === 503,
    retryable: res.status === 429 || res.status === 503 || res.status >= 500 || res.status === 0,
    retryAfterMs: res.retryAfterMs,
    aborted: res.aborted === true,
    timedOut: res.timedOut === true,
    error: String(errMsg).slice(0, 300),
    data: res.data,
  }
}

export async function cancelManxueTest({
  apiBaseUrl = DEFAULT_MANXUE_BASE_URL,
  testId,
  fetchImpl = fetch,
  timeoutMs = 10_000,
} = {}) {
  const normBase = normalizeManxueBaseUrl(apiBaseUrl)
  const id = String(testId || '').trim()
  if (!normBase.ok || !id) return { ok: false }
  const res = await fetchJsonWithTimeout(
    `${normBase.url}/api/v1/tests/${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: { accept: 'application/json' } },
    { fetchImpl, timeoutMs },
  )
  return { ok: res.ok || res.status === 404, status: res.status }
}

/**
 * Strip accidental markdown code fences if fallback captured text wrapped the HTML.
 */
export function stripHtmlCodeFences(raw) {
  const text = String(raw || '').trim()
  if (!text) return ''
  const fenced = text.match(/^```(?:html|xml|svg)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i)
  return fenced ? fenced[1].trim() : text
}

/**
 * Normalize a terminal manxue.ai `/api/v1/tests/{id}` payload into a unified IQ check result.
 */
export function normalizeManxueResult(benchmark, data = {}, { fallbackOutput = null } = {}) {
  const mode = BRIDGE_BENCHMARKS.includes(data?.benchmark) ? data.benchmark : String(benchmark || 'pelican')
  const taskStatus = String(data?.status || '').toLowerCase()
  const topError = typeof data?.error === 'string' ? data.error.trim() : data?.error?.message || ''

  if (taskStatus === 'cancelled') {
    return {
      benchmark: mode,
      status: 'error',
      raw_status: 'cancelled',
      reference_only: false,
      label: '已取消',
      reason: topError || '检测任务已取消',
      source: null,
      duration_ms: null,
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      error: topError || 'cancelled',
      artifact: null,
    }
  }

  if (mode === 'candy') {
    const candy = data?.candy && typeof data.candy === 'object' ? data.candy : {}
    const cs = String(candy.status || '').toLowerCase()
    let status = 'error'
    let label = '检测异常'
    if (cs === 'passed') {
      status = 'normal'
      label = '通过'
    } else if (cs === 'incorrect') {
      status = 'degraded'
      label = '未通过'
    } else if (taskStatus === 'failed' || cs === 'error' || topError || candy.error) {
      status = 'error'
      label = '检测异常'
    } else {
      status = 'unknown'
      label = '无法判定'
    }
    const rawAnswer =
      typeof candy.answer === 'string' && candy.answer.trim()
        ? candy.answer.trim()
        : typeof fallbackOutput === 'string' && fallbackOutput.trim()
          ? fallbackOutput.trim()
          : ''
    const answer = rawAnswer ? rawAnswer.slice(0, MAX_ARTIFACT_ANSWER_CHARS) : ''
    const errText = String(candy.error || topError || '').trim() || null
    const reason =
      errText ||
      (status === 'normal'
        ? '糖果逻辑测试通过'
        : status === 'degraded'
          ? '糖果逻辑测试未通过（答案不符）'
          : '糖果检测异常')
    return {
      benchmark: mode,
      status,
      raw_status: cs || taskStatus || 'error',
      reference_only: false,
      label,
      reason,
      source: 'manxue:candy',
      duration_ms: numOrNull(candy.duration_ms),
      input_tokens: numOrNull(candy.input_tokens),
      output_tokens: numOrNull(candy.output_tokens),
      reasoning_tokens: numOrNull(candy.reasoning_tokens),
      error: status === 'error' ? errText || 'candy_error' : null,
      artifact: answer ? { kind: 'candy', answer } : null,
    }
  }

  // pelican / creative
  const resObj = data?.result && typeof data.result === 'object' ? data.result : {}
  const assessment = data?.assessment && typeof data.assessment === 'object' ? data.assessment : {}
  const rawQuality = String(assessment.quality || resObj.quality || '').toLowerCase()
  let status = 'unknown'
  if (rawQuality === 'normal') {
    status = 'normal'
  } else if (rawQuality === 'degraded' || rawQuality === 'suspicious') {
    status = 'degraded'
  } else if (taskStatus === 'failed' || topError) {
    status = 'error'
  } else if (rawQuality === 'unknown') {
    status = 'unknown'
  }

  const label =
    String(assessment.label || '').trim() ||
    (status === 'normal' ? '正常' : status === 'degraded' ? '疑似降智' : status === 'error' ? '检测失败' : '无法判定')
  const reason = String(assessment.reason || topError || '').trim() || null
  const referenceOnly = label === '参考' || /无法保证其他模型测试的准确性/.test(String(reason || ''))

  const rawHtmlCandidate =
    typeof resObj.html === 'string' && resObj.html.trim()
      ? resObj.html
      : typeof fallbackOutput === 'string' && fallbackOutput.trim()
        ? stripHtmlCodeFences(fallbackOutput)
        : ''
  const html = rawHtmlCandidate ? truncateUtf8(rawHtmlCandidate, MAX_ARTIFACT_HTML_BYTES) : ''
  const prompt = typeof resObj.prompt === 'string' && resObj.prompt.trim() ? resObj.prompt.trim().slice(0, 4000) : null

  return {
    benchmark: mode,
    status,
    raw_status: rawQuality || taskStatus || 'unknown',
    reference_only: referenceOnly,
    label,
    reason,
    source: typeof assessment.source === 'string' && assessment.source.trim() ? assessment.source.trim() : null,
    duration_ms: numOrNull(resObj.duration_ms),
    input_tokens: numOrNull(resObj.input_tokens),
    output_tokens: numOrNull(resObj.output_tokens),
    reasoning_tokens: numOrNull(resObj.reasoning_tokens),
    error: status === 'error' ? topError || reason || 'manxue_test_failed' : null,
    artifact: html ? { kind: 'html', html, prompt } : null,
  }
}

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

export async function pollManxueTest({
  apiBaseUrl = DEFAULT_MANXUE_BASE_URL,
  testId,
  timeoutMs = 300_000,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  fetchImpl = fetch,
  signal,
  now = () => Date.now(),
  sleep = defaultSleep,
  random = () => Math.random(),
  onProgress,
} = {}) {
  const deadline = now() + Math.max(15_000, Number(timeoutMs) || 300_000)
  let transientErrors = 0
  let backoffMs = Math.max(1_000, Number(pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS)

  while (true) {
    if (signal?.aborted) {
      await cancelManxueTest({ apiBaseUrl, testId, fetchImpl }).catch(() => {})
      return { ok: false, aborted: true, error: 'cancelled' }
    }
    if (now() >= deadline) {
      await cancelManxueTest({ apiBaseUrl, testId, fetchImpl }).catch(() => {})
      return { ok: false, timedOut: true, error: 'poll_timeout' }
    }

    const res = await getManxueTest({ apiBaseUrl, testId, fetchImpl, signal })
    if (res.aborted || signal?.aborted) {
      await cancelManxueTest({ apiBaseUrl, testId, fetchImpl }).catch(() => {})
      return { ok: false, aborted: true, error: 'cancelled' }
    }

    if (res.ok && res.data) {
      transientErrors = 0
      backoffMs = Math.max(1_000, Number(pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS)
      const st = String(res.data.status || '').toLowerCase()
      try {
        onProgress?.(res.data)
      } catch {}
      if (TERMINAL_STATUSES.has(st)) {
        return { ok: true, data: res.data }
      }
      const remaining = deadline - now()
      if (remaining <= 0) continue
      await sleep(Math.min(backoffMs, remaining), signal)
      continue
    }

    if (res.expired) {
      return { ok: false, expired: true, error: 'manxue_task_expired' }
    }

    transientErrors += 1
    if (!res.retryable || transientErrors >= 8) {
      return {
        ok: false,
        rateLimited: res.rateLimited === true,
        retryAfterMs: res.retryAfterMs,
        error: res.error || 'manxue_poll_failed',
      }
    }

    const jitter = Math.round(random() * 1_000)
    const waitMs = res.retryAfterMs != null ? res.retryAfterMs + jitter : Math.min(30_000, backoffMs * 2) + jitter
    backoffMs = Math.min(30_000, backoffMs * 2)
    const remaining = deadline - now()
    if (remaining <= 0) continue
    await sleep(Math.min(waitMs, remaining), signal)
  }
}
