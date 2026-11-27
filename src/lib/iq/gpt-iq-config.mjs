/**
 * Storage, validation, 3-state inheritance and 24h rollup for GPT (Codex) IQ checks.
 *
 * Persisted in the existing `settings` key/value table (zero migrations, SQLite + PostgreSQL):
 *   - `gpt_iq_config`            : global config
 *   - `gpt_iq_slot:<vmId>`       : per-slot 3-state mode, overrides, state, 96-entry history & 24h buckets
 *   - `gpt_iq_artifact:<vmId>`   : latest preview payload (pelican/creative HTML or candy answer)
 *   - `gpt_iq_events`            : bounded global audit log (checks, degradations, isolations, recoveries)
 */
import {
  allowedEffortsForBenchmark,
  BRIDGE_BENCHMARKS,
  DEFAULT_MANXUE_BASE_URL,
  MANXUE_SERVICE_TIERS,
  normalizeManxueBaseUrl,
  validatePublicCallbackBaseUrl,
} from './manxue-client.mjs'

export const GPT_IQ_CONFIG_KEY = 'gpt_iq_config'
export const GPT_IQ_SLOT_PREFIX = 'gpt_iq_slot:'
export const GPT_IQ_ARTIFACT_PREFIX = 'gpt_iq_artifact:'
export const GPT_IQ_EVENTS_KEY = 'gpt_iq_events'

export const IQ_SLOT_MODES = Object.freeze(['inherit', 'enabled', 'disabled'])
export const IQ_STATUSES = Object.freeze(['normal', 'degraded', 'unknown', 'error'])

export const MAX_IQ_HISTORY = 96
export const MAX_IQ_EVENTS = 100
export const IQ_BUCKET_MINUTES = 30
export const IQ_BUCKET_MS = IQ_BUCKET_MINUTES * 60_000
export const IQ_BUCKET_COUNT_24H = 48
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60_000

export const DEFAULT_GPT_IQ_CONFIG = Object.freeze({
  enabled: false,
  api_base_url: DEFAULT_MANXUE_BASE_URL,
  callback_base_url: '',
  benchmark: 'pelican',
  model: 'gpt-6-astra',
  reasoning_effort: 'low',
  service_tier: '',
  interval_min: 5,
  concurrency: 2,
  min_gap_sec: 3,
  timeout_sec: 300,
  auto_isolate_on_degraded: true,
  isolate_threshold: 1,
  isolate_on_reference: false,
  skip_unschedulable: true,
  skip_quota_pct: 90,
})

const INT_LIMITS = Object.freeze({
  interval_min: { min: 1, max: 1440 },
  concurrency: { min: 1, max: 10 },
  min_gap_sec: { min: 0, max: 300 },
  timeout_sec: { min: 60, max: 600 },
  isolate_threshold: { min: 1, max: 5 },
  skip_quota_pct: { min: 0, max: 100 },
})

const GLOBAL_KEYS = new Set(Object.keys(DEFAULT_GPT_IQ_CONFIG))
const SLOT_OVERRIDE_KEYS = new Set([
  'benchmark',
  'model',
  'reasoning_effort',
  'service_tier',
  'interval_min',
  'auto_isolate_on_degraded',
  'isolate_threshold',
  'isolate_on_reference',
])

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function clampInt(value, min, max, fallback) {
  if (value == null || value === '' || typeof value === 'boolean') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function strictInt(value, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < min || value > max) return null
  return value
}

function nullableIso(value) {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function numOrNull(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

function clampEffortForBenchmark(effort, benchmark) {
  const allowed = allowedEffortsForBenchmark(benchmark)
  const clean = String(effort || '').trim()
  if (allowed.includes(clean)) return clean
  if (clean && ['xhigh', 'max', 'ultra'].includes(clean) && allowed.includes('high')) return 'high'
  return 'low'
}

export function normalizeGlobalIqConfig(raw = {}) {
  const src = isPlainObject(raw) ? raw : {}
  const apiRes = normalizeManxueBaseUrl(src.api_base_url)
  const cbRes = validatePublicCallbackBaseUrl(src.callback_base_url, { allowEmpty: true })
  const benchmark = BRIDGE_BENCHMARKS.includes(src.benchmark) ? src.benchmark : DEFAULT_GPT_IQ_CONFIG.benchmark
  const model =
    typeof src.model === 'string' && src.model.trim() && src.model.trim().length <= 200
      ? src.model.trim()
      : DEFAULT_GPT_IQ_CONFIG.model
  const reasoningEffort = clampEffortForBenchmark(src.reasoning_effort, benchmark)
  const serviceTier = MANXUE_SERVICE_TIERS.includes(src.service_tier)
    ? src.service_tier
    : DEFAULT_GPT_IQ_CONFIG.service_tier

  return {
    enabled: src.enabled === true,
    api_base_url: apiRes.ok ? apiRes.url : DEFAULT_GPT_IQ_CONFIG.api_base_url,
    callback_base_url: cbRes.ok ? cbRes.url : '',
    benchmark,
    model,
    reasoning_effort: reasoningEffort,
    service_tier: serviceTier,
    interval_min: clampInt(
      src.interval_min,
      INT_LIMITS.interval_min.min,
      INT_LIMITS.interval_min.max,
      DEFAULT_GPT_IQ_CONFIG.interval_min,
    ),
    concurrency: clampInt(
      src.concurrency,
      INT_LIMITS.concurrency.min,
      INT_LIMITS.concurrency.max,
      DEFAULT_GPT_IQ_CONFIG.concurrency,
    ),
    min_gap_sec: clampInt(
      src.min_gap_sec,
      INT_LIMITS.min_gap_sec.min,
      INT_LIMITS.min_gap_sec.max,
      DEFAULT_GPT_IQ_CONFIG.min_gap_sec,
    ),
    timeout_sec: clampInt(
      src.timeout_sec,
      INT_LIMITS.timeout_sec.min,
      INT_LIMITS.timeout_sec.max,
      DEFAULT_GPT_IQ_CONFIG.timeout_sec,
    ),
    auto_isolate_on_degraded:
      typeof src.auto_isolate_on_degraded === 'boolean'
        ? src.auto_isolate_on_degraded
        : DEFAULT_GPT_IQ_CONFIG.auto_isolate_on_degraded,
    isolate_threshold: clampInt(
      src.isolate_threshold,
      INT_LIMITS.isolate_threshold.min,
      INT_LIMITS.isolate_threshold.max,
      DEFAULT_GPT_IQ_CONFIG.isolate_threshold,
    ),
    isolate_on_reference:
      typeof src.isolate_on_reference === 'boolean'
        ? src.isolate_on_reference
        : DEFAULT_GPT_IQ_CONFIG.isolate_on_reference,
    skip_unschedulable:
      typeof src.skip_unschedulable === 'boolean' ? src.skip_unschedulable : DEFAULT_GPT_IQ_CONFIG.skip_unschedulable,
    skip_quota_pct: clampInt(
      src.skip_quota_pct,
      INT_LIMITS.skip_quota_pct.min,
      INT_LIMITS.skip_quota_pct.max,
      DEFAULT_GPT_IQ_CONFIG.skip_quota_pct,
    ),
  }
}

export function validateGlobalIqConfigPatch(raw, current = DEFAULT_GPT_IQ_CONFIG) {
  if (!isPlainObject(raw)) return { ok: false, error: 'invalid_config' }
  const patch = {}
  const targetBenchmark = Object.hasOwn(raw, 'benchmark') ? raw.benchmark : current.benchmark

  for (const [key, value] of Object.entries(raw)) {
    if (!GLOBAL_KEYS.has(key)) return { ok: false, error: 'invalid_field' }
    if (
      key === 'enabled' ||
      key === 'auto_isolate_on_degraded' ||
      key === 'isolate_on_reference' ||
      key === 'skip_unschedulable'
    ) {
      if (typeof value !== 'boolean') return { ok: false, error: `invalid_${key}` }
      patch[key] = value
      continue
    }
    if (key === 'api_base_url') {
      if (typeof value !== 'string') return { ok: false, error: 'invalid_api_base_url' }
      const checked = normalizeManxueBaseUrl(value)
      if (!checked.ok) return checked
      patch[key] = checked.url
      continue
    }
    if (key === 'callback_base_url') {
      if (typeof value !== 'string') return { ok: false, error: 'invalid_callback_base_url' }
      const checked = validatePublicCallbackBaseUrl(value, { allowEmpty: true })
      if (!checked.ok) return checked
      patch[key] = checked.url
      continue
    }
    if (key === 'benchmark') {
      if (!BRIDGE_BENCHMARKS.includes(value)) return { ok: false, error: 'invalid_benchmark' }
      patch[key] = value
      continue
    }
    if (key === 'model') {
      if (typeof value !== 'string') return { ok: false, error: 'invalid_model' }
      const clean = value.trim()
      if (!clean || clean.length > 200) return { ok: false, error: 'invalid_model' }
      patch[key] = clean
      continue
    }
    if (key === 'reasoning_effort') {
      if (typeof value !== 'string') return { ok: false, error: 'invalid_reasoning_effort' }
      const eff = value.trim()
      const allowed = allowedEffortsForBenchmark(
        BRIDGE_BENCHMARKS.includes(targetBenchmark) ? targetBenchmark : current.benchmark,
      )
      if (!allowed.includes(eff)) return { ok: false, error: 'invalid_reasoning_effort' }
      patch[key] = eff
      continue
    }
    if (key === 'service_tier') {
      if (typeof value !== 'string' || !MANXUE_SERVICE_TIERS.includes(value.trim())) {
        return { ok: false, error: 'invalid_service_tier' }
      }
      patch[key] = value.trim()
      continue
    }
    const limits = INT_LIMITS[key]
    if (limits) {
      const n = strictInt(value, limits.min, limits.max)
      if (n == null) return { ok: false, error: `invalid_${key}` }
      patch[key] = n
    }
  }
  return { ok: true, patch }
}

export function validateSlotOverridesPatch(raw, baseBenchmark = DEFAULT_GPT_IQ_CONFIG.benchmark) {
  if (!isPlainObject(raw)) return { ok: false, error: 'invalid_config' }
  const patch = {}
  const targetBenchmark =
    Object.hasOwn(raw, 'benchmark') && raw.benchmark !== null ? raw.benchmark : baseBenchmark || 'pelican'

  for (const [key, value] of Object.entries(raw)) {
    if (!SLOT_OVERRIDE_KEYS.has(key)) return { ok: false, error: 'invalid_field' }
    if (value === null) {
      patch[key] = null
      continue
    }
    if (key === 'benchmark') {
      if (!BRIDGE_BENCHMARKS.includes(value)) return { ok: false, error: 'invalid_benchmark' }
      patch[key] = value
      continue
    }
    if (key === 'model') {
      if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
        return { ok: false, error: 'invalid_model' }
      }
      patch[key] = value.trim()
      continue
    }
    if (key === 'reasoning_effort') {
      if (typeof value !== 'string') return { ok: false, error: 'invalid_reasoning_effort' }
      const allowed = allowedEffortsForBenchmark(
        BRIDGE_BENCHMARKS.includes(targetBenchmark) ? targetBenchmark : 'pelican',
      )
      if (!allowed.includes(value.trim())) return { ok: false, error: 'invalid_reasoning_effort' }
      patch[key] = value.trim()
      continue
    }
    if (key === 'service_tier') {
      if (typeof value !== 'string' || !MANXUE_SERVICE_TIERS.includes(value.trim())) {
        return { ok: false, error: 'invalid_service_tier' }
      }
      patch[key] = value.trim()
      continue
    }
    if (key === 'auto_isolate_on_degraded' || key === 'isolate_on_reference') {
      if (typeof value !== 'boolean') return { ok: false, error: `invalid_${key}` }
      patch[key] = value
      continue
    }
    const limits = INT_LIMITS[key]
    if (limits) {
      const n = strictInt(value, limits.min, limits.max)
      if (n == null) return { ok: false, error: `invalid_${key}` }
      patch[key] = n
    }
  }
  return { ok: true, patch }
}

export function normalizeSlotOverrides(raw = {}) {
  if (!isPlainObject(raw)) return {}
  const out = {}
  if (BRIDGE_BENCHMARKS.includes(raw.benchmark)) out.benchmark = raw.benchmark
  if (typeof raw.model === 'string' && raw.model.trim() && raw.model.trim().length <= 200) {
    out.model = raw.model.trim()
  }
  if (typeof raw.reasoning_effort === 'string') {
    const allowed = allowedEffortsForBenchmark(out.benchmark || 'candy')
    if (allowed.includes(raw.reasoning_effort.trim())) out.reasoning_effort = raw.reasoning_effort.trim()
  }
  if (typeof raw.service_tier === 'string' && MANXUE_SERVICE_TIERS.includes(raw.service_tier.trim())) {
    out.service_tier = raw.service_tier.trim()
  }
  if (typeof raw.auto_isolate_on_degraded === 'boolean') out.auto_isolate_on_degraded = raw.auto_isolate_on_degraded
  if (typeof raw.isolate_on_reference === 'boolean') out.isolate_on_reference = raw.isolate_on_reference
  for (const key of ['interval_min', 'isolate_threshold']) {
    const n = strictInt(raw[key], INT_LIMITS[key].min, INT_LIMITS[key].max)
    if (n != null) out[key] = n
  }
  return out
}

function normalizeHistoryItem(item) {
  if (!isPlainObject(item)) return null
  const at = nullableIso(item.at)
  if (!at) return null
  const status = IQ_STATUSES.includes(item.status) ? item.status : 'error'
  return {
    at,
    status,
    raw_status: typeof item.raw_status === 'string' ? item.raw_status.slice(0, 48) : status,
    reference_only: item.reference_only === true,
    benchmark: BRIDGE_BENCHMARKS.includes(item.benchmark) ? item.benchmark : 'pelican',
    model: typeof item.model === 'string' ? item.model.slice(0, 200) : '',
    reasoning_effort: typeof item.reasoning_effort === 'string' ? item.reasoning_effort.slice(0, 32) : '',
    label: typeof item.label === 'string' ? item.label.slice(0, 64) : '',
    reason: typeof item.reason === 'string' && item.reason ? item.reason.slice(0, 300) : null,
    duration_ms: numOrNull(item.duration_ms),
    input_tokens: numOrNull(item.input_tokens),
    output_tokens: numOrNull(item.output_tokens),
    reasoning_tokens: numOrNull(item.reasoning_tokens),
    error: typeof item.error === 'string' && item.error ? item.error.slice(0, 300) : null,
    trigger: item.trigger === 'manual' ? 'manual' : 'scheduled',
    isolated: item.isolated === true,
  }
}

function normalizeBucketRows(raw, now = Date.now()) {
  if (!Array.isArray(raw)) return []
  const minSlot = Math.floor(now / IQ_BUCKET_MS) - (IQ_BUCKET_COUNT_24H + 2)
  const bySlot = new Map()
  for (const row of raw) {
    if (!isPlainObject(row)) continue
    const slot = Number(row.slot)
    if (!Number.isInteger(slot) || slot < minSlot) continue
    bySlot.set(slot, {
      slot,
      normal: Math.max(0, Math.trunc(Number(row.normal) || 0)),
      degraded: Math.max(0, Math.trunc(Number(row.degraded) || 0)),
      unknown: Math.max(0, Math.trunc(Number(row.unknown) || 0)),
      error: Math.max(0, Math.trunc(Number(row.error) || 0)),
    })
  }
  return [...bySlot.values()].sort((a, b) => a.slot - b.slot).slice(-(IQ_BUCKET_COUNT_24H + 2))
}

export function recordBucketPoint(rows, { atMs, status }, now = Date.now()) {
  const list = normalizeBucketRows(rows, now)
  const slot = Math.floor(atMs / IQ_BUCKET_MS)
  const key = IQ_STATUSES.includes(status) ? status : 'error'
  let target = list.find((r) => r.slot === slot)
  if (!target) {
    target = { slot, normal: 0, degraded: 0, unknown: 0, error: 0 }
    list.push(target)
    list.sort((a, b) => a.slot - b.slot)
  }
  target[key] += 1
  return list.slice(-(IQ_BUCKET_COUNT_24H + 2))
}

/**
 * Align stored 30-min bucket rows into an exact 48-slot array ending at `now`.
 * Each entry is `[normal, degraded, unknown, error]`.
 */
export function rollupBuckets24h(rows, now = Date.now()) {
  const curSlot = Math.floor(now / IQ_BUCKET_MS)
  const startSlot = curSlot - (IQ_BUCKET_COUNT_24H - 1)
  const bySlot = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && Number.isInteger(row.slot)) bySlot.set(row.slot, row)
  }
  let normal = 0
  let degraded = 0
  let unknown = 0
  let error = 0
  const buckets = []
  for (let i = 0; i < IQ_BUCKET_COUNT_24H; i += 1) {
    const row = bySlot.get(startSlot + i)
    const n = row ? Math.max(0, Math.trunc(Number(row.normal) || 0)) : 0
    const d = row ? Math.max(0, Math.trunc(Number(row.degraded) || 0)) : 0
    const u = row ? Math.max(0, Math.trunc(Number(row.unknown) || 0)) : 0
    const e = row ? Math.max(0, Math.trunc(Number(row.error) || 0)) : 0
    normal += n
    degraded += d
    unknown += u
    error += e
    buckets.push([n, d, u, e])
  }
  return {
    start: new Date(startSlot * IQ_BUCKET_MS).toISOString(),
    slot_min: IQ_BUCKET_MINUTES,
    total: normal + degraded + unknown + error,
    normal,
    degraded,
    unknown,
    error,
    buckets,
  }
}

export function normalizeSlotState(raw = {}, now = Date.now()) {
  const src = isPlainObject(raw) ? raw : {}
  const history = Array.isArray(src.history)
    ? src.history.map(normalizeHistoryItem).filter(Boolean).slice(0, MAX_IQ_HISTORY)
    : []
  return {
    last_checked_at: nullableIso(src.last_checked_at),
    next_run_at: nullableIso(src.next_run_at),
    last_status: IQ_STATUSES.includes(src.last_status) ? src.last_status : null,
    last_raw_status: typeof src.last_raw_status === 'string' && src.last_raw_status ? src.last_raw_status : null,
    last_reference_only: src.last_reference_only === true,
    last_benchmark: BRIDGE_BENCHMARKS.includes(src.last_benchmark) ? src.last_benchmark : null,
    last_model: typeof src.last_model === 'string' && src.last_model ? src.last_model : null,
    last_reasoning_effort:
      typeof src.last_reasoning_effort === 'string' && src.last_reasoning_effort ? src.last_reasoning_effort : null,
    last_label: typeof src.last_label === 'string' && src.last_label ? src.last_label : null,
    last_reason: typeof src.last_reason === 'string' && src.last_reason ? src.last_reason.slice(0, 300) : null,
    last_source: typeof src.last_source === 'string' && src.last_source ? src.last_source.slice(0, 120) : null,
    last_duration_ms: numOrNull(src.last_duration_ms),
    last_input_tokens: numOrNull(src.last_input_tokens),
    last_output_tokens: numOrNull(src.last_output_tokens),
    last_reasoning_tokens: numOrNull(src.last_reasoning_tokens),
    last_error: typeof src.last_error === 'string' && src.last_error ? src.last_error.slice(0, 300) : null,
    has_artifact: src.has_artifact === true,
    isolated_at: nullableIso(src.isolated_at),
    consecutive_degraded: Math.max(0, Math.trunc(Number(src.consecutive_degraded) || 0)),
    consecutive_errors: Math.max(0, Math.trunc(Number(src.consecutive_errors) || 0)),
    backoff_until: Math.max(0, Number(src.backoff_until) || 0),
    history,
    buckets_24h: normalizeBucketRows(src.buckets_24h, now),
  }
}

export function normalizeSlotRecord(vmId, raw = {}, now = Date.now()) {
  const src = isPlainObject(raw) ? raw : {}
  return {
    vm_id: String(vmId || src.vm_id || ''),
    mode: IQ_SLOT_MODES.includes(src.mode) ? src.mode : 'inherit',
    overrides: normalizeSlotOverrides(src.overrides),
    state: normalizeSlotState(src.state, now),
    updated_at: nullableIso(src.updated_at),
  }
}

export function hasCustomIqOverrides(record) {
  if (!record) return false
  if (record.mode && record.mode !== 'inherit') return true
  return Object.keys(record.overrides || {}).length > 0
}

export function resolveEffectiveIqPolicy(globalConfig, slotRecord) {
  const base = normalizeGlobalIqConfig(globalConfig)
  const mode = IQ_SLOT_MODES.includes(slotRecord?.mode) ? slotRecord.mode : 'inherit'
  const ov = normalizeSlotOverrides(slotRecord?.overrides)
  const enabled = mode === 'enabled' ? true : mode === 'disabled' ? false : base.enabled
  const benchmark = ov.benchmark ?? base.benchmark
  const reasoningEffort = clampEffortForBenchmark(ov.reasoning_effort ?? base.reasoning_effort, benchmark)
  return {
    enabled,
    mode,
    benchmark,
    model: ov.model ?? base.model,
    reasoning_effort: reasoningEffort,
    service_tier: ov.service_tier ?? base.service_tier,
    interval_min: ov.interval_min ?? base.interval_min,
    auto_isolate_on_degraded: ov.auto_isolate_on_degraded ?? base.auto_isolate_on_degraded,
    isolate_threshold: ov.isolate_threshold ?? base.isolate_threshold,
    isolate_on_reference: ov.isolate_on_reference ?? base.isolate_on_reference,
    skip_unschedulable: base.skip_unschedulable,
    skip_quota_pct: base.skip_quota_pct,
    timeout_sec: base.timeout_sec,
    has_overrides: hasCustomIqOverrides({ mode, overrides: ov }),
  }
}

function mergeSlotOverrides(current, patch) {
  const next = { ...normalizeSlotOverrides(current) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next
}

/**
 * Compact per-VM summary attached to `GET /api/panel/vms` (`vm.iq_check`).
 * Intentionally omits history/buckets arrays to keep list payload small.
 */
export function buildVmIqSummary(
  record,
  effective,
  { running = false, isolated = false, nextRunAt = null, now = Date.now() } = {},
) {
  const st = record.state
  const rollup = rollupBuckets24h(st.buckets_24h, now)
  const lastMs = st.last_checked_at ? Date.parse(st.last_checked_at) : 0
  const stale24h = lastMs > 0 ? now - lastMs > TWENTY_FOUR_HOURS_MS : false
  return {
    enabled: effective.enabled,
    mode: effective.mode,
    running: running === true,
    isolated: isolated === true,
    isolated_at: st.isolated_at,
    status: st.last_status,
    raw_status: st.last_raw_status,
    reference_only: st.last_reference_only === true,
    label: st.last_label,
    reason: st.last_reason,
    benchmark: st.last_benchmark || effective.benchmark,
    model: st.last_model || effective.model,
    reasoning_effort: st.last_reasoning_effort || effective.reasoning_effort,
    interval_min: effective.interval_min,
    last_checked_at: st.last_checked_at,
    next_run_at: nextRunAt ?? st.next_run_at,
    last_duration_ms: st.last_duration_ms,
    last_error: st.last_error,
    has_artifact: st.has_artifact === true,
    stale_24h: stale24h,
    consecutive_degraded: st.consecutive_degraded,
    summary_24h: {
      total: rollup.total,
      normal: rollup.normal,
      degraded: rollup.degraded,
      unknown: rollup.unknown,
      error: rollup.error,
    },
  }
}

export function createGptIqStore({ settings, now = () => Date.now() } = {}) {
  const repo = () => (typeof settings === 'function' ? settings() : settings)
  const slotKey = (vmId) => `${GPT_IQ_SLOT_PREFIX}${vmId}`
  const artifactKey = (vmId) => `${GPT_IQ_ARTIFACT_PREFIX}${vmId}`

  function readConfig() {
    return normalizeGlobalIqConfig(repo().get(GPT_IQ_CONFIG_KEY, null))
  }

  function saveConfigPatch(body) {
    const current = readConfig()
    const validated = validateGlobalIqConfigPatch(body, current)
    if (!validated.ok) return validated
    const next = normalizeGlobalIqConfig({ ...current, ...validated.patch })
    repo().set(GPT_IQ_CONFIG_KEY, next)
    return { ok: true, config: next }
  }

  function getSlot(vmId) {
    const raw = repo().get(slotKey(vmId), null)
    return normalizeSlotRecord(vmId, raw || {}, now())
  }

  function listSlots() {
    const all = repo().all() || {}
    const out = []
    const t = now()
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(GPT_IQ_SLOT_PREFIX)) continue
      const vmId = key.slice(GPT_IQ_SLOT_PREFIX.length)
      if (!vmId) continue
      out.push(normalizeSlotRecord(vmId, value, t))
    }
    return out
  }

  function saveSlotPatch(vmId, body) {
    if (!isPlainObject(body)) return { ok: false, error: 'invalid_config' }
    const allowedTop = new Set(['mode', 'overrides'])
    for (const key of Object.keys(body)) {
      if (!allowedTop.has(key)) return { ok: false, error: 'invalid_field' }
    }
    const current = getSlot(vmId)
    const globalCfg = readConfig()
    let nextMode = current.mode
    if (Object.hasOwn(body, 'mode')) {
      if (!IQ_SLOT_MODES.includes(body.mode)) return { ok: false, error: 'invalid_mode' }
      nextMode = body.mode
    }
    let nextOverrides = current.overrides
    if (Object.hasOwn(body, 'overrides')) {
      if (body.overrides === null) {
        nextOverrides = {}
      } else {
        const baseBench = current.overrides.benchmark || globalCfg.benchmark
        const validated = validateSlotOverridesPatch(body.overrides, baseBench)
        if (!validated.ok) return validated
        nextOverrides = mergeSlotOverrides(current.overrides, validated.patch)
      }
    }
    const next = {
      vm_id: String(vmId),
      mode: nextMode,
      overrides: nextOverrides,
      state: current.state,
      updated_at: new Date(now()).toISOString(),
    }
    repo().set(slotKey(vmId), next)
    return { ok: true, record: next }
  }

  function resetSlotOverride(vmId) {
    const current = getSlot(vmId)
    const next = {
      ...current,
      mode: 'inherit',
      overrides: {},
      updated_at: new Date(now()).toISOString(),
    }
    repo().set(slotKey(vmId), next)
    return { ok: true, record: next }
  }

  function patchSlotState(vmId, mutator) {
    const t = now()
    const current = getSlot(vmId)
    const draft = {
      ...current.state,
      history: [...current.state.history],
      buckets_24h: current.state.buckets_24h.map((r) => ({ ...r })),
    }
    const mutated = typeof mutator === 'function' ? mutator(draft) || draft : { ...draft, ...(mutator || {}) }
    const next = {
      ...current,
      state: normalizeSlotState(mutated, t),
      updated_at: new Date(t).toISOString(),
    }
    repo().set(slotKey(vmId), next)
    return next
  }

  function getArtifact(vmId) {
    const raw = repo().get(artifactKey(vmId), null)
    return isPlainObject(raw) ? raw : null
  }

  function saveArtifact(vmId, artifact) {
    if (!artifact || typeof artifact !== 'object') return null
    repo().set(artifactKey(vmId), artifact)
    return artifact
  }

  function removeSlot(vmId) {
    repo().remove(slotKey(vmId))
    repo().remove(artifactKey(vmId))
  }

  function listEvents() {
    const raw = repo().get(GPT_IQ_EVENTS_KEY, [])
    return Array.isArray(raw) ? raw : []
  }

  function appendEvent(event) {
    const entry = {
      at: new Date(now()).toISOString(),
      ...event,
    }
    const next = [entry, ...listEvents()].slice(0, MAX_IQ_EVENTS)
    repo().set(GPT_IQ_EVENTS_KEY, next)
    return entry
  }

  return {
    readConfig,
    saveConfigPatch,
    getSlot,
    listSlots,
    saveSlotPatch,
    resetSlotOverride,
    patchSlotState,
    getArtifact,
    saveArtifact,
    removeSlot,
    listEvents,
    appendEvent,
  }
}
