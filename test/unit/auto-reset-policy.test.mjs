import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CODEX_AUTO_RESET } from '../../src/lib/oauth/auto-reset-config.mjs'
import {
  HOUR_MS,
  estimateSevenDayBurnRate,
  evaluateCodexAutoReset,
  evaluateDynamicExpiryRescue,
} from '../../src/lib/oauth/auto-reset-policy.mjs'

const NOW = Date.parse('2026-11-26T04:00:00Z')
const DAY_MS = 24 * HOUR_MS

function makeEffective(overrides = {}) {
  return {
    ...DEFAULT_CODEX_AUTO_RESET,
    enabled: true,
    mode: 'enabled',
    has_overrides: false,
    ...overrides,
    triggers: {
      ...DEFAULT_CODEX_AUTO_RESET.triggers,
      ...(overrides.triggers || {}),
    },
  }
}

function makeCodexVm({
  u5 = 0,
  rem5Hours = 3,
  u7 = 0,
  rem7Days = 4,
  vouchers = [],
  resetCreditsKnown = true,
  credits = null,
  activeHours = null,
  windowHistory = null,
  customWindows = null,
} = {}) {
  const extra = customWindows
    ? customWindows
    : {
        codex_primary_used_percent: u7,
        codex_primary_window_minutes: 10080,
        codex_primary_reset_at: new Date(NOW + rem7Days * DAY_MS).toISOString(),
        codex_secondary_used_percent: u5,
        codex_secondary_window_minutes: 300,
        codex_secondary_reset_at: new Date(NOW + rem5Hours * HOUR_MS).toISOString(),
      }
  return {
    id: 'vm-gpt-1',
    platform: 'openai',
    family: 'codex',
    policy: activeHours ? { active_hours: activeHours } : {},
    codex: {
      extra,
      ...(credits ? { credits } : {}),
      ...(windowHistory ? { window_history: windowHistory } : {}),
      ...(resetCreditsKnown
        ? {
            reset_credits: {
              available_count: vouchers.length,
              credits: vouchers.map((hoursFromNow) => ({
                expires_at: new Date(NOW + hoursFromNow * HOUR_MS).toISOString(),
              })),
              fetched_at: new Date(NOW - 5 * 60_000).toISOString(),
            },
          }
        : {}),
    },
  }
}

test('5h full with default rules skips when voucher expiry is beyond 7d (zero upstream calls)', () => {
  const vm = makeCodexVm({ u5: 100, rem5Hours: 4, u7: 30, rem7Days: 3, vouchers: [20 * 24] })
  const res = evaluateCodexAutoReset({ vm, effective: makeEffective(), now: NOW })
  assert.equal(res.action, 'skip')
  assert.equal(res.reason, 'expiry_beyond_7d')
  assert.equal(res.rescue, false)
})

test('Tier 1 rescue: voucher expiring before 5h natural reset rescues even below min_reset_remaining_min', () => {
  // 5h has only 20 min left (< 30 min guard), but voucher expires in 10 min!
  const vm = makeCodexVm({ u5: 100, rem5Hours: 20 / 60, u7: 10, rem7Days: 5, vouchers: [10 / 60] })
  const res = evaluateCodexAutoReset({ vm, effective: makeEffective({ min_reset_remaining_min: 30 }), now: NOW })
  assert.equal(res.action, 'probe_and_redeem')
  assert.equal(res.rescue, true)
  assert.equal(res.rescue_info.tier, 1)
  assert.equal(res.reason, 'expiring_before_5h_reset')
})

test('Tier 2 rescue: voucher expiring before next 5h cap triggers rescue based on 5h fill duration', () => {
  // 5h has 2h remaining -> it took 3h to fill 5h. Next earliest 5h cap is R5 + 3h = NOW + 5h.
  // Voucher expires in 4h (after R5, before R5 + 3h) -> Tier 2 rescue!
  const vm = makeCodexVm({ u5: 100, rem5Hours: 2, u7: 5, rem7Days: 6.9, vouchers: [4] })
  const res = evaluateCodexAutoReset({ vm, effective: makeEffective(), now: NOW })
  assert.equal(res.action, 'probe_and_redeem')
  assert.equal(res.rescue, true)
  assert.equal(res.rescue_info.tier, 2)
  assert.equal(res.reason, 'expiring_before_next_5h_cap')
})

test('Tier 3 rescue (single voucher): rescues when real 7d burn speed cannot fill 7d before expiry', () => {
  // 7d is 30% used, 2d remaining -> elapsed = 5d -> win rate = 6%/day (x1.2 = 7.2%/day).
  // Voucher expires in 3d: remaining 2d of current 7d adds ~14.4% (total 44.4% < 100%);
  // after 7d resets, 1d left adds ~7.2% (< 100%). max7dUses = 0 < 1 -> rescue!
  const vm = makeCodexVm({ u5: 100, rem5Hours: 4, u7: 30, rem7Days: 2, vouchers: [3 * 24] })
  const res = evaluateCodexAutoReset({ vm, effective: makeEffective(), now: NOW })
  assert.equal(res.action, 'probe_and_redeem')
  assert.equal(res.rescue, true)
  assert.equal(res.rescue_info.tier, 3)
  assert.equal(res.reason, 'expiring_before_7d_fill')
  assert.equal(res.rescue_info.max_7d_uses_before_expiry, 0)
})

test('Tier 3 skips single voucher when 7d velocity will reach 100% before expiry, but rescues surplus vouchers', () => {
  // 7d is 60% used, 4d remaining -> elapsed = 3d -> win rate = 20%/day (x1.2 = 24%/day).
  // In next 3d before expiry (minus 3h 5h-wait = 2.875d), 0.60 + 0.24 * 2.875 = 1.29 -> 1 full 7d cap!
  const singleVm = makeCodexVm({ u5: 100, rem5Hours: 3, u7: 60, rem7Days: 4, vouchers: [3 * 24] })
  const singleRes = evaluateCodexAutoReset({ vm: singleVm, effective: makeEffective(), now: NOW })
  assert.equal(singleRes.action, 'skip')
  assert.equal(singleRes.reason, '7d_can_absorb_vouchers')

  // Same slot, but holding 3 vouchers ALL expiring in 3 days: 7d can only absorb 1 < 3 -> rescue!
  const multiVm = makeCodexVm({
    u5: 100,
    rem5Hours: 3,
    u7: 60,
    rem7Days: 4,
    vouchers: [3 * 24, 3 * 24 + 1, 3 * 24 + 2],
  })
  const multiRes = evaluateCodexAutoReset({ vm: multiVm, effective: makeEffective(), now: NOW })
  assert.equal(multiRes.action, 'probe_and_redeem')
  assert.equal(multiRes.rescue, true)
  assert.equal(multiRes.rescue_info.tier, 3)
  assert.equal(multiRes.reason, 'surplus_vouchers_before_7d_fill')
})

test('burst velocity from recent rate_samples overrides slow 7d average to avoid false rescue', () => {
  // Slot sat idle for 4 days (u7 = 20% -> win rate = 5%/day), then surged +16% in the last 4h (96%/day!).
  // Voucher expires in 2d: recent burst shows 7d will easily fill before 2d -> do NOT falsely burn on 5h!
  const r7 = NOW + 3 * DAY_MS
  const vm = makeCodexVm({ u5: 100, rem5Hours: 3, u7: 20, rem7Days: 3, vouchers: [2 * 24] })
  const rateSamples = [
    { at: NOW - 4 * HOUR_MS, u7: 0.04, r7 },
    { at: NOW - 2 * HOUR_MS, u7: 0.12, r7 },
  ]
  const res = evaluateCodexAutoReset({ vm, effective: makeEffective(), rateSamples, now: NOW })
  assert.equal(res.action, 'skip')
  assert.equal(res.reason, '7d_can_absorb_vouchers')
  assert.equal(res.rescue_info.burn.source, 'recent')
})

test('active_hours scales short-span recent burst down to wall-clock daily burn rate', () => {
  const r7 = NOW + 5 * DAY_MS
  // Active 08:00-16:00 (8h/day = 1/3 ratio). Burned 0.06 in 3h active -> 0.02/active-hr -> 0.16/wall-day.
  const burn = estimateSevenDayBurnRate({
    u7: 0.1,
    reset7dMs: r7,
    rateSamples: [{ at: NOW - 3 * HOUR_MS, u7: 0.04, r7 }],
    activeHours: { start: '08:00', end: '16:00' },
    now: NOW,
  })
  assert.equal(burn.source, 'recent')
  assert.ok(Math.abs(burn.active_ratio - 1 / 3) < 0.001)
  assert.ok(Math.abs(burn.rate_per_day_pct - 16) < 0.2)
})

test('cold-start slot without velocity data skips Tier 3 while still honoring Tier 1', () => {
  // Brand new 7d window (only 1h elapsed, no samples, no prev history), voucher expires in 3d -> skip Tier 3.
  const vm = makeCodexVm({ u5: 100, rem5Hours: 4, u7: 5, rem7Days: 7 - 1 / 24, vouchers: [3 * 24] })
  const res = evaluateDynamicExpiryRescue({ vm, now: NOW, fiveHourCapActive: true })
  assert.equal(res.should_rescue, false)
  assert.equal(res.reason, 'insufficient_velocity_data')
})

test('7d full with spendable Codex credits prefers voucher by default and skips when prefer_voucher_over_credits=false', () => {
  const credits = {
    has_credits: true,
    unlimited: false,
    balance: '1000',
    fetched_at: new Date(NOW - 60_000).toISOString(),
  }
  const vm = makeCodexVm({ u5: 50, rem5Hours: 3, u7: 100, rem7Days: 3, vouchers: [15 * 24], credits })

  const preferVoucher = evaluateCodexAutoReset({
    vm,
    effective: makeEffective({ prefer_voucher_over_credits: true }),
    now: NOW,
  })
  assert.equal(preferVoucher.action, 'probe_and_redeem')
  assert.equal(preferVoucher.trigger_window, '7d')
  assert.equal(preferVoucher.rescue, false)

  const preferCredits = evaluateCodexAutoReset({
    vm,
    effective: makeEffective({ prefer_voucher_over_credits: false }),
    now: NOW,
  })
  assert.equal(preferCredits.action, 'skip')
  assert.equal(preferCredits.reason, 'spendable_credits')
})

test('min_reset_remaining_min skips 7d near natural reset; trigger_mode distinguishes 100% vs local_gate', () => {
  // 7d full with only 15 min left (< 30 min guard) and voucher expires in 10d -> skip
  const nearResetVm = makeCodexVm({ u5: 40, rem5Hours: 3, u7: 100, rem7Days: 15 / (24 * 60), vouchers: [10 * 24] })
  const nearRes = evaluateCodexAutoReset({
    vm: nearResetVm,
    effective: makeEffective({ min_reset_remaining_min: 30 }),
    now: NOW,
  })
  assert.equal(nearRes.action, 'skip')
  assert.equal(nearRes.reason, 'reset_soon')

  // 7d at 92% with local gate 90%
  const gateVm = makeCodexVm({ u5: 40, rem5Hours: 3, u7: 92, rem7Days: 3, vouchers: [10 * 24] })
  const upstreamOnly = evaluateCodexAutoReset({
    vm: gateVm,
    effective: makeEffective({ trigger_mode: 'upstream_limit' }),
    quotaPolicy: { limit_7d: 0.9 },
    now: NOW,
  })
  assert.equal(upstreamOnly.action, 'skip')

  const localGate = evaluateCodexAutoReset({
    vm: gateVm,
    effective: makeEffective({ trigger_mode: 'local_gate' }),
    quotaPolicy: { limit_7d: 0.9 },
    now: NOW,
  })
  assert.equal(localGate.action, 'probe_and_redeem')
  assert.equal(localGate.trigger_window, '7d')
})

test('non-standard 24h window triggers when other_window is enabled', () => {
  const vm = makeCodexVm({
    vouchers: [10 * 24],
    customWindows: {
      codex_primary_used_percent: 100,
      codex_primary_window_minutes: 1440,
      codex_primary_reset_at: new Date(NOW + 12 * HOUR_MS).toISOString(),
    },
  })
  const res = evaluateCodexAutoReset({ vm, effective: makeEffective(), now: NOW })
  assert.equal(res.action, 'probe_and_redeem')
  assert.equal(res.trigger_window, '24h')
})
