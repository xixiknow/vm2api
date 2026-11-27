export type AutoResetTriggerMode = 'upstream_limit' | 'local_gate'

export type AutoResetSlotMode = 'inherit' | 'enabled' | 'disabled'

export type CodexAutoResetTriggers = {
  seven_day: boolean
  five_hour: boolean
  other_window: boolean
}

export type CodexAutoResetRule = {
  enabled: boolean
  triggers: CodexAutoResetTriggers
  trigger_mode: AutoResetTriggerMode
  prefer_voucher_over_credits: boolean
  smart_expiry_rescue: boolean
  min_reset_remaining_min: number
  cooldown_min: number
  max_per_day: number
  no_card_recheck_min: number
}

export type AutoResetGlobalConfig = {
  codex: CodexAutoResetRule
}

export type AutoResetSummary = {
  global_enabled: boolean
  total_gpt_slots: number
  voucher_slots: number
  total_vouchers: number
  rescue_candidate_slots: number
  paused_slots: number
  custom_slots: number
  generated_at: string
}

export type AutoResetConfigPayload = {
  config: AutoResetGlobalConfig
  summary: AutoResetSummary
}

export type CodexAutoResetOverrides = {
  triggers?: Partial<CodexAutoResetTriggers>
  trigger_mode?: AutoResetTriggerMode
  prefer_voucher_over_credits?: boolean
  smart_expiry_rescue?: boolean
  min_reset_remaining_min?: number
  cooldown_min?: number
  max_per_day?: number
  no_card_recheck_min?: number
}

export type EffectiveCodexAutoResetPolicy = CodexAutoResetRule & {
  mode: AutoResetSlotMode
  has_overrides: boolean
}

export type SlotAutoResetState = {
  auto_paused: boolean
  paused_reason: string | null
  consecutive_failures: number
  last_attempt_at: string | null
  last_reset_at: string | null
  last_result: string | null
  last_trigger_window: string | null
  last_rescue: boolean
  last_rescue_reason: string | null
  last_error: string | null
  no_card_until: number
  daily_date: string
  daily_count: number
  rate_sample_count: number
}

export type VoucherSummary = {
  known: boolean
  available_count: number
  earliest_expires_at: string | null
  within_7d_count: number
}

export type BurnRateInfo = {
  rate_per_hour: number | null
  rate_per_day_pct: number | null
  adjusted_rate_per_hour: number | null
  source: 'recent' | 'window' | 'prev' | 'none'
  active_ratio: number
  estimated_hours_to_fill_7d: number | null
}

export type DynamicRescuePreview = {
  should_rescue: boolean
  needs_probe: boolean
  tier: 1 | 2 | 3 | null
  reason: string
  available_count: number
  earliest_expires_at: string | null
  earliest_remaining_hours: number | null
  vouchers_within_7d: number
  max_7d_uses_before_expiry: number | null
  burn: BurnRateInfo
}

export type SlotAutoResetView = {
  vm_id: string
  vm_name: string
  platform: 'codex' | 'claude'
  eligible: boolean
  ineligible_reason: string | null
  mode: AutoResetSlotMode
  overrides: CodexAutoResetOverrides
  has_overrides: boolean
  effective: EffectiveCodexAutoResetPolicy
  global_enabled: boolean
  global_defaults: CodexAutoResetRule
  state: SlotAutoResetState
  voucher_summary: VoucherSummary | null
  rescue_preview: DynamicRescuePreview | null
}

export type SlotAutoResetSummaryItem = {
  vm_id: string
  vm_name: string
  mode: AutoResetSlotMode
  has_overrides: boolean
  effective: EffectiveCodexAutoResetPolicy
  state: SlotAutoResetState
  voucher_summary: VoucherSummary | null
  rescue_preview: DynamicRescuePreview | null
}

export type AutoResetSlotsPayload = {
  items: SlotAutoResetSummaryItem[]
  summary: AutoResetSummary
}

export type AutoResetEvent = {
  at: string
  vm_id: string
  vm_name: string
  platform: string
  outcome: 'reset' | 'reset_refresh_failed' | 'failed' | 'paused'
  trigger_window: string | null
  rescue: boolean
  rescue_tier: number | null
  rescue_reason: string | null
  vouchers_before?: number
  windows_reset?: number
  warning?: string | null
  error?: string | null
}
