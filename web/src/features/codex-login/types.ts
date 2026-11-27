/** GPT 密码登录（Callback v2，`/api/panel/codex-login/*`）的面板类型。秘密只回 `*_set`。 */

export type CodexWorkspacePolicy =
  'auto' | 'prefer_organization' | 'prefer_personal'

export type CodexWorkspaceMeta = {
  id: string | null
  kind: 'personal' | 'organization' | 'unknown' | null
  name: string | null
  selection_reason: string | null
  candidate_count: number | null
  selection_missing: boolean
}

export type CodexLoginGuardRules = {
  probe_interval_min: number
  recheck_interval_min: number
  fail_threshold: number
  relogin_cooldown_min: number
  max_relogin_failures: number
}

export type CodexLoginQueueSnapshot = {
  active: number
  queued: number
  max_concurrency: number
  paused_until: string | null
}

export type CodexEgressSummary = {
  pool_usable_proxies: number
  pool_free_slots: number
  bind_limit: number
}

export type CodexLoginServiceHealth = {
  ok: boolean
  healthz?: { ok: boolean; status: number }
  readyz?: { ok: boolean; status: number; engine: string | null }
  error?: string
}

export type CodexLoginServiceConfig = {
  endpoint: string
  configured: boolean
  service_token_set: boolean
  service_token_source: 'config' | 'env' | null
  service_token_unreadable: boolean
  workspace_policy: CodexWorkspacePolicy
  max_concurrency: number
  guard_enabled: boolean
  guard: CodexLoginGuardRules
  encryption_enabled: boolean
  queue?: CodexLoginQueueSnapshot | null
  egress_summary?: CodexEgressSummary | null
}

export type CodexLoginRowStatus =
  | 'pending'
  | 'checking'
  | 'provisioning'
  | 'logging_in'
  | 'importing'
  | 'created'
  | 'skipped'
  | 'failed'
  | 'import_failed'

export type CodexLoginBatchRow = {
  id: string
  line: number
  email: string
  status: CodexLoginRowStatus
  stage: string | null
  vm_id: string | null
  proxy_id: string | null
  workspace: CodexWorkspaceMeta | null
  error: string | null
  detail: string | null
  warning: string | null
  retryable: boolean
}

export type CodexLoginBatch = {
  id: string
  status: 'running' | 'done' | 'canceled'
  created_at: string
  finished_at: string | null
  expires_at: string | null
  options: {
    save_login: boolean
    name_prefix: string
    workspace_policy: CodexWorkspacePolicy
  }
  counts: Partial<Record<CodexLoginRowStatus | 'total', number>>
  rows: CodexLoginBatchRow[]
}

export type CodexLoginProfileState = {
  last_probe_at: string | null
  last_probe_result: string | null
  next_probe_at: number
  auth_fail_streak: number
  last_relogin_at: string | null
  last_relogin_trigger: 'manual' | 'auto' | null
  last_relogin_result: 'ok' | 'failed' | 'canceled' | null
  last_relogin_error: string | null
  last_relogin_detail: string | null
  relogin_fail_streak: number
  cooldown_until: number
  auto_paused: string | null
  login_ip_differs: boolean
}

export type CodexLoginProfile = {
  vm_id: string
  email: string
  password_set: boolean
  totp_set: boolean
  auto_relogin: boolean
  secret_unreadable: boolean
  created_at: string | null
  updated_at: string | null
  state: CodexLoginProfileState
  vm_name: string | null
  vm_exists: boolean
  relogin: {
    state: 'idle' | 'queued' | 'running'
    stage?: string | null
    trigger?: string
    started_at?: string | null
  }
}

export type CodexSlotLoginTask = {
  id?: string
  vm_id?: string
  state: 'idle' | 'queued' | 'running' | 'ok' | 'failed' | 'canceled'
  stage?: string | null
  email?: string | null
  workspace?: CodexWorkspaceMeta | null
  error?: string | null
  detail?: string | null
  warning?: string | null
  started_at?: string | null
  finished_at?: string | null
  commit_result?: Record<string, unknown> | null
}
