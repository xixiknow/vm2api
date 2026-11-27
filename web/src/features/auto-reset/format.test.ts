import { describe, expect, it } from 'vitest'
import {
  formatAutoResetResult,
  formatRescuePreviewText,
  formatRuleSummary,
  slotAutoResetTone,
} from './format'
import type {
  DynamicRescuePreview,
  EffectiveCodexAutoResetPolicy,
  SlotAutoResetState,
} from './types'

function policy(
  patch: Partial<EffectiveCodexAutoResetPolicy> = {}
): EffectiveCodexAutoResetPolicy {
  return {
    enabled: true,
    mode: 'inherit',
    has_overrides: false,
    triggers: { seven_day: true, five_hour: false, other_window: true },
    trigger_mode: 'upstream_limit',
    prefer_voucher_over_credits: true,
    smart_expiry_rescue: true,
    min_reset_remaining_min: 30,
    cooldown_min: 10,
    max_per_day: 0,
    no_card_recheck_min: 30,
    ...patch,
  }
}

function state(patch: Partial<SlotAutoResetState> = {}): SlotAutoResetState {
  return {
    auto_paused: false,
    paused_reason: null,
    consecutive_failures: 0,
    last_attempt_at: null,
    last_reset_at: null,
    last_result: null,
    last_trigger_window: null,
    last_rescue: false,
    last_rescue_reason: null,
    last_error: null,
    no_card_until: 0,
    daily_date: '2026-11-26',
    daily_count: 0,
    rate_sample_count: 0,
    ...patch,
  }
}

describe('auto-reset format helpers', () => {
  it('maps 3-state mode and paused state to clear status tones', () => {
    expect(
      slotAutoResetTone(policy({ enabled: true, mode: 'inherit' }), state())
        .text
    ).toBe('跟随全局 · 已开启')
    expect(
      slotAutoResetTone(policy({ enabled: false, mode: 'inherit' }), state())
        .text
    ).toBe('跟随全局 · 未开启')
    expect(
      slotAutoResetTone(policy({ enabled: true, mode: 'enabled' }), state())
        .text
    ).toBe('本槽已开启')
    expect(
      slotAutoResetTone(policy({ enabled: false, mode: 'disabled' }), state())
        .text
    ).toBe('本槽已关闭')
    const paused = slotAutoResetTone(
      policy(),
      state({ auto_paused: true, paused_reason: 'consecutive_failures' })
    )
    expect(paused.cls).toBe('bad')
    expect(paused.text).toBe('已自动暂停')
  })

  it('builds a concise rule summary reflecting triggers, priority, and caps', () => {
    const text = formatRuleSummary(policy({ max_per_day: 2 }))
    expect(text).toContain('7d/其他窗 满触发')
    expect(text).toContain('优先于积分')
    expect(text).toContain('动态临期抢救')
    expect(text).toContain('剩 <30m 跳过')
    expect(text).toContain('日限 2 张')
  })

  it('explains dynamic expiry rescue verdicts clearly across tiers', () => {
    const basePreview: DynamicRescuePreview = {
      should_rescue: true,
      needs_probe: false,
      tier: 3,
      reason: 'expiring_before_7d_fill',
      available_count: 1,
      earliest_expires_at: '2026-11-29T04:00:00Z',
      earliest_remaining_hours: 72,
      vouchers_within_7d: 1,
      max_7d_uses_before_expiry: 0,
      burn: {
        rate_per_hour: 0.008,
        rate_per_day_pct: 19.2,
        adjusted_rate_per_hour: 0.0096,
        source: 'window',
        active_ratio: 1,
        estimated_hours_to_fill_7d: 90,
      },
    }
    const rescueText = formatRescuePreviewText(basePreview, true)
    expect(rescueText).toContain('3.0 天后到期')
    expect(rescueText).toContain('19.2%/天')
    expect(rescueText).toContain('自动抢救')

    const absorbText = formatRescuePreviewText(
      {
        ...basePreview,
        should_rescue: false,
        tier: null,
        reason: '7d_can_absorb_vouchers',
      },
      true
    )
    expect(absorbText).toContain('可由 7d 满正常消耗')

    expect(formatRescuePreviewText(basePreview, false)).toBeNull()
    expect(formatAutoResetResult('failed', 'upstream_auth')).toContain(
      'GPT 凭证已失效'
    )
  })
})
