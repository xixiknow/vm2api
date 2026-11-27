import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildVmIqSummary,
  createGptIqStore,
  DEFAULT_GPT_IQ_CONFIG,
  IQ_BUCKET_MS,
  recordBucketPoint,
  resolveEffectiveIqPolicy,
  rollupBuckets24h,
} from '../../src/lib/iq/gpt-iq-config.mjs'

function memorySettings() {
  const map = new Map()
  return {
    get(key, fallback = null) {
      return map.has(key) ? structuredClone(map.get(key)) : fallback
    },
    set(key, value) {
      map.set(key, structuredClone(value))
      return value
    },
    has(key) {
      return map.has(key)
    },
    remove(key) {
      map.delete(key)
    },
    all() {
      return Object.fromEntries([...map.entries()].map(([k, v]) => [k, structuredClone(v)]))
    },
  }
}

test('DEFAULT_GPT_IQ_CONFIG defaults to pelican, 5-minute interval, and auto-isolate on degraded', () => {
  assert.equal(DEFAULT_GPT_IQ_CONFIG.enabled, false)
  assert.equal(DEFAULT_GPT_IQ_CONFIG.benchmark, 'pelican')
  assert.equal(DEFAULT_GPT_IQ_CONFIG.interval_min, 5)
  assert.equal(DEFAULT_GPT_IQ_CONFIG.auto_isolate_on_degraded, true)
  assert.equal(DEFAULT_GPT_IQ_CONFIG.isolate_threshold, 1)
  assert.equal(DEFAULT_GPT_IQ_CONFIG.isolate_on_reference, false)
})

test('store validates global config, per-slot 3-state inheritance, and effort clamping', () => {
  let clock = Date.parse('2026-11-27T02:00:00Z')
  const store = createGptIqStore({ settings: memorySettings(), now: () => clock })

  // Invalid callback URL rejected
  assert.equal(store.saveConfigPatch({ callback_base_url: 'http://example.com' }).ok, false)
  assert.equal(store.saveConfigPatch({ interval_min: 0 }).ok, false)
  assert.equal(store.saveConfigPatch({ benchmark: 'html' }).ok, false)

  // Valid global config save
  const saved = store.saveConfigPatch({
    enabled: true,
    callback_base_url: 'https://gw.example.com/',
    benchmark: 'candy',
    reasoning_effort: 'xhigh',
    interval_min: 5,
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.config.callback_base_url, 'https://gw.example.com')
  assert.equal(saved.config.reasoning_effort, 'xhigh')

  // Slot inherits global, then overrides to pelican (clamps xhigh -> high automatically)
  const slot1 = store.saveSlotPatch('vm-1', {
    mode: 'enabled',
    overrides: { benchmark: 'pelican', interval_min: 10 },
  })
  assert.equal(slot1.ok, true)
  const eff = resolveEffectiveIqPolicy(store.readConfig(), slot1.record)
  assert.equal(eff.enabled, true)
  assert.equal(eff.benchmark, 'pelican')
  assert.equal(eff.reasoning_effort, 'high')
  assert.equal(eff.interval_min, 10)
  assert.equal(eff.has_overrides, true)

  // Reset returns to inherit
  store.resetSlotOverride('vm-1')
  const reset = resolveEffectiveIqPolicy(store.readConfig(), store.getSlot('vm-1'))
  assert.equal(reset.mode, 'inherit')
  assert.equal(reset.benchmark, 'candy')
  assert.equal(reset.has_overrides, false)
})

test('rollupBuckets24h tracks 48 aligned 30-min buckets and stale_24h accurately', () => {
  const base = Date.parse('2026-11-27T02:00:00Z')
  let rows = []
  rows = recordBucketPoint(rows, { atMs: base - 2 * IQ_BUCKET_MS, status: 'normal' }, base)
  rows = recordBucketPoint(rows, { atMs: base - 2 * IQ_BUCKET_MS, status: 'normal' }, base)
  rows = recordBucketPoint(rows, { atMs: base, status: 'degraded' }, base)
  // Older than 24h should be pruned
  rows = recordBucketPoint(rows, { atMs: base - 60 * IQ_BUCKET_MS, status: 'error' }, base)

  const rollup = rollupBuckets24h(rows, base)
  assert.equal(rollup.buckets.length, 48)
  assert.equal(rollup.normal, 2)
  assert.equal(rollup.degraded, 1)
  assert.equal(rollup.error, 0)
  assert.equal(rollup.total, 3)
  assert.deepEqual(rollup.buckets[47], [0, 1, 0, 0])
  assert.deepEqual(rollup.buckets[45], [2, 0, 0, 0])

  const store = createGptIqStore({ settings: memorySettings(), now: () => base })
  const rec = store.patchSlotState('vm-1', (st) => {
    st.last_checked_at = new Date(base - 25 * 60 * 60_000).toISOString()
    st.last_status = 'normal'
    st.buckets_24h = rows
    return st
  })
  const summary = buildVmIqSummary(rec, resolveEffectiveIqPolicy(store.readConfig(), rec), { now: base })
  assert.equal(summary.stale_24h, true)
  assert.equal(summary.summary_24h.total, 3)
})
