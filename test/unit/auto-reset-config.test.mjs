import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CODEX_AUTO_RESET,
  MAX_AUTO_RESET_EVENTS,
  MAX_RATE_SAMPLES,
  appendRateSample,
  beijingDateKey,
  createAutoResetStore,
  resolveEffectiveCodexPolicy,
} from '../../src/lib/oauth/auto-reset-config.mjs'

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

test('global config defaults match GPT-first safety defaults and reject invalid patches', () => {
  const settings = memorySettings()
  const store = createAutoResetStore({ settings })
  const cfg = store.readConfig()

  assert.equal(cfg.codex.enabled, false)
  assert.deepEqual(cfg.codex.triggers, { seven_day: true, five_hour: false, other_window: true })
  assert.equal(cfg.codex.trigger_mode, 'upstream_limit')
  assert.equal(cfg.codex.prefer_voucher_over_credits, true)
  assert.equal(cfg.codex.smart_expiry_rescue, true)
  assert.equal(cfg.codex.min_reset_remaining_min, 30)
  assert.equal(cfg.codex.cooldown_min, 10)
  assert.equal(cfg.codex.max_per_day, 0)
  assert.equal(cfg.codex.no_card_recheck_min, 30)
  assert.deepEqual(cfg.codex, DEFAULT_CODEX_AUTO_RESET)

  assert.equal(store.saveConfigPatch({ codex: { cooldown_min: 0 } }).ok, false)
  assert.equal(store.saveConfigPatch({ codex: { max_per_day: 99 } }).ok, false)
  assert.equal(store.saveConfigPatch({ codex: { trigger_mode: 'invalid' } }).ok, false)
  assert.equal(store.saveConfigPatch({ codex: { unknown_key: true } }).ok, false)

  const saved = store.saveConfigPatch({
    codex: {
      enabled: true,
      triggers: { five_hour: true },
      max_per_day: 3,
    },
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.config.codex.enabled, true)
  assert.deepEqual(saved.config.codex.triggers, { seven_day: true, five_hour: true, other_window: true })
  assert.equal(saved.config.codex.max_per_day, 3)
  assert.equal(saved.config.codex.prefer_voucher_over_credits, true)
})

test('per-slot 3-state inheritance, sparse overrides, null clearing, and reset to inherit', () => {
  const settings = memorySettings()
  const store = createAutoResetStore({ settings })
  store.saveConfigPatch({
    codex: {
      enabled: false,
      triggers: { seven_day: true, five_hour: false, other_window: true },
      min_reset_remaining_min: 30,
    },
  })

  // Default inherit follows global (disabled)
  const initial = resolveEffectiveCodexPolicy(store.readConfig(), store.getSlot('vm-01'))
  assert.equal(initial.enabled, false)
  assert.equal(initial.mode, 'inherit')
  assert.equal(initial.has_overrides, false)

  // Force enable + custom rules on vm-01
  const p1 = store.saveSlotPatch('vm-01', {
    mode: 'enabled',
    overrides: {
      triggers: { five_hour: true },
      prefer_voucher_over_credits: false,
      min_reset_remaining_min: 60,
      max_per_day: 2,
    },
  })
  assert.equal(p1.ok, true)
  const eff1 = resolveEffectiveCodexPolicy(store.readConfig(), store.getSlot('vm-01'))
  assert.equal(eff1.enabled, true)
  assert.equal(eff1.mode, 'enabled')
  assert.equal(eff1.has_overrides, true)
  assert.equal(eff1.triggers.five_hour, true)
  assert.equal(eff1.triggers.seven_day, true)
  assert.equal(eff1.prefer_voucher_over_credits, false)
  assert.equal(eff1.min_reset_remaining_min, 60)
  assert.equal(eff1.max_per_day, 2)

  // Null clears individual override fields back to global
  const p2 = store.saveSlotPatch('vm-01', {
    overrides: {
      triggers: { five_hour: null },
      min_reset_remaining_min: null,
    },
  })
  assert.equal(p2.ok, true)
  const eff2 = resolveEffectiveCodexPolicy(store.readConfig(), store.getSlot('vm-01'))
  assert.equal(eff2.triggers.five_hour, false)
  assert.equal(eff2.min_reset_remaining_min, 30)
  assert.equal(eff2.max_per_day, 2)

  // Reset restores pure inherit
  store.resetSlotOverride('vm-01')
  const eff3 = resolveEffectiveCodexPolicy(store.readConfig(), store.getSlot('vm-01'))
  assert.equal(eff3.mode, 'inherit')
  assert.equal(eff3.enabled, false)
  assert.equal(eff3.has_overrides, false)
  assert.equal(eff3.max_per_day, 0)

  // Global enabled + slot force disabled
  store.saveConfigPatch({ codex: { enabled: true } })
  store.saveSlotPatch('vm-01', { mode: 'disabled' })
  const eff4 = resolveEffectiveCodexPolicy(store.readConfig(), store.getSlot('vm-01'))
  assert.equal(eff4.enabled, false)
  assert.equal(eff4.mode, 'disabled')
})

test('daily count rolls over on Beijing midnight and audit log stays bounded', () => {
  const settings = memorySettings()
  // 2026-11-26 23:55 Beijing time = 2026-11-26T15:55:00Z
  let clock = Date.parse('2026-11-26T15:55:00Z')
  const store = createAutoResetStore({ settings, now: () => clock })
  assert.equal(beijingDateKey(clock), '2026-11-26')

  store.patchSlotState('vm-01', (st) => {
    st.daily_count = 3
    return st
  })
  assert.equal(store.getSlot('vm-01').state.daily_count, 3)

  // Advance 10 minutes past Beijing midnight -> 2026-11-27 00:05
  clock += 10 * 60_000
  assert.equal(beijingDateKey(clock), '2026-11-27')
  assert.equal(store.getSlot('vm-01').state.daily_count, 0)

  for (let i = 0; i < MAX_AUTO_RESET_EVENTS + 10; i += 1) {
    store.appendEvent({ vm_id: `vm-${i}`, outcome: 'reset' })
  }
  const events = store.listEvents()
  assert.equal(events.length, MAX_AUTO_RESET_EVENTS)
  assert.equal(events[0].vm_id, `vm-${MAX_AUTO_RESET_EVENTS + 9}`)
})

test('7d rate_samples throttle dense updates, cap length, and reset on rollover or quota drop', () => {
  const t0 = Date.parse('2026-11-26T00:00:00Z')
  const r7 = t0 + 5 * 24 * 3600_000
  let samples = []

  // First sample recorded
  let res = appendRateSample(samples, { u7: 0.1, r7, now: t0 })
  assert.equal(res.changed, true)
  samples = res.samples

  // 2 minutes later with tiny delta -> skipped
  res = appendRateSample(samples, { u7: 0.105, r7, now: t0 + 2 * 60_000 })
  assert.equal(res.changed, false)

  // 15 minutes later with meaningful change -> appended
  res = appendRateSample(samples, { u7: 0.14, r7, now: t0 + 15 * 60_000 })
  assert.equal(res.changed, true)
  samples = res.samples
  assert.equal(samples.length, 2)

  // Quota reset drop >= 2% clears old trace
  res = appendRateSample(samples, { u7: 0.01, r7: r7 + 2 * 24 * 3600_000, now: t0 + 30 * 60_000 })
  assert.equal(res.changed, true)
  assert.equal(res.samples.length, 1)
  assert.equal(res.samples[0].u7, 0.01)

  // Bounded to MAX_RATE_SAMPLES
  samples = []
  for (let i = 0; i < MAX_RATE_SAMPLES + 5; i += 1) {
    res = appendRateSample(samples, { u7: Math.min(1, i * 0.05), r7, now: t0 + i * 20 * 60_000 })
    samples = res.samples
  }
  assert.equal(samples.length, MAX_RATE_SAMPLES)
})
