export type GptIqBenchmark = 'pelican' | 'candy' | 'creative'
export type GptIqSlotMode = 'inherit' | 'enabled' | 'disabled'
export type GptIqStatus = 'normal' | 'degraded' | 'unknown' | 'error'
export type GptIqServiceTier = '' | 'priority' | 'ultrafast'

export type GptIqConfig = {
  enabled: boolean
  api_base_url: string
  callback_base_url: string
  benchmark: GptIqBenchmark
  model: string
  reasoning_effort: string
  service_tier: GptIqServiceTier
  interval_min: number
  concurrency: number
  min_gap_sec: number
  timeout_sec: number
  auto_isolate_on_degraded: boolean
  isolate_threshold: number
  isolate_on_reference: boolean
  skip_unschedulable: boolean
  skip_quota_pct: number
}

export type GptIqSlotOverrides = Partial<
  Pick<
    GptIqConfig,
    | 'benchmark'
    | 'model'
    | 'reasoning_effort'
    | 'service_tier'
    | 'interval_min'
    | 'auto_isolate_on_degraded'
    | 'isolate_threshold'
    | 'isolate_on_reference'
  >
>

export type GptIqEffectivePolicy = {
  enabled: boolean
  mode: GptIqSlotMode
  benchmark: GptIqBenchmark
  model: string
  reasoning_effort: string
  service_tier: GptIqServiceTier
  interval_min: number
  auto_isolate_on_degraded: boolean
  isolate_threshold: number
  isolate_on_reference: boolean
  skip_unschedulable: boolean
  skip_quota_pct: number
  timeout_sec: number
  has_overrides: boolean
}

export type GptIqSummary24h = {
  total: number
  normal: number
  degraded: number
  unknown: number
  error: number
}

export type GptIqBuckets24h = GptIqSummary24h & {
  start: string
  slot_min: number
  /** 48 buckets of 30 min: [normal, degraded, unknown, error] */
  buckets: Array<[number, number, number, number]>
}

export type GptIqVmSummary = {
  enabled: boolean
  mode: GptIqSlotMode
  running: boolean
  isolated: boolean
  isolated_at: string | null
  status: GptIqStatus | null
  raw_status: string | null
  reference_only: boolean
  label: string | null
  reason: string | null
  benchmark: GptIqBenchmark
  model: string
  reasoning_effort: string
  interval_min: number
  last_checked_at: string | null
  next_run_at: string | null
  last_duration_ms: number | null
  last_error: string | null
  has_artifact: boolean
  stale_24h: boolean
  consecutive_degraded: number
  summary_24h: GptIqSummary24h
}

export type GptIqHistoryItem = {
  at: string
  status: GptIqStatus
  raw_status: string
  reference_only: boolean
  benchmark: GptIqBenchmark
  model: string
  reasoning_effort: string
  label: string
  reason: string | null
  duration_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  error: string | null
  trigger: 'scheduled' | 'manual'
  isolated: boolean
}

export type GptIqSlotState = {
  last_checked_at: string | null
  next_run_at: string | null
  last_status: GptIqStatus | null
  last_raw_status: string | null
  last_reference_only: boolean
  last_benchmark: GptIqBenchmark | null
  last_model: string | null
  last_reasoning_effort: string | null
  last_label: string | null
  last_reason: string | null
  last_source: string | null
  last_duration_ms: number | null
  last_input_tokens: number | null
  last_output_tokens: number | null
  last_reasoning_tokens: number | null
  last_error: string | null
  has_artifact: boolean
  isolated_at: string | null
  consecutive_degraded: number
  consecutive_errors: number
  backoff_until: number
  history: GptIqHistoryItem[]
  buckets_24h: GptIqBuckets24h
}

export type SlotIqView = {
  vm_id: string
  vm_name: string
  eligible: boolean
  mode: GptIqSlotMode
  overrides: GptIqSlotOverrides
  has_overrides: boolean
  effective: GptIqEffectivePolicy
  global_defaults: GptIqConfig
  running: boolean
  isolated: boolean
  skip_reason: string | null
  next_run_at: string | null
  state: GptIqSlotState
  summary: GptIqVmSummary | null
  updated_at: string | null
}

export type GptIqGlobalSummary = {
  total_codex_slots: number
  enabled_slots: number
  custom_slots: number
  running_slots: number
  isolated_slots: number
  normal_24h: number
  degraded_24h: number
  error_24h: number
  global_backoff_until: string | null
}

export type GptIqConfigPayload = {
  config: GptIqConfig
  summary: GptIqGlobalSummary
  detected_callback_base_url: string
  effective_callback_base_url: string
  callback_ready: boolean
}

export type GptIqSlotListItem = {
  vm_id: string
  vm_name: string
  email: string | null
  plan: string | null
  schedulable: boolean
  isolated: boolean
  skip_reason: string | null
  mode: GptIqSlotMode
  has_overrides: boolean
  effective: GptIqEffectivePolicy
  summary: GptIqVmSummary
}

export type GptIqSlotsPayload = {
  items: GptIqSlotListItem[]
  summary: GptIqGlobalSummary
}

export type GptIqEvent = {
  at: string
  vm_id: string
  vm_name?: string
  outcome: string
  benchmark?: GptIqBenchmark
  model?: string
  reasoning_effort?: string
  label?: string | null
  reason?: string | null
  reference_only?: boolean
  duration_ms?: number | null
  trigger?: string
  isolated?: boolean
  error?: string | null
}

export type GptIqArtifact = {
  checked_at: string
  benchmark: GptIqBenchmark
  model: string
  reasoning_effort: string
  status: GptIqStatus
  raw_status: string
  reference_only: boolean
  label: string
  reason: string | null
  source: string | null
  duration_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  kind: 'html' | 'candy'
  html?: string
  prompt?: string | null
  answer?: string
}

export type GptIqArtifactPayload = {
  vm_id: string
  vm_name: string
  artifact: GptIqArtifact
}
