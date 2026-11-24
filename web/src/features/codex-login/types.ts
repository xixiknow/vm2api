/** GPT 密码登录（`/api/panel/codex-login/*`）的面板类型。秘密只回 `*_set`。 */

export type CodexLoginGuardRules = {
  probe_interval_min: number
  recheck_interval_min: number
  fail_threshold: number
  relogin_cooldown_min: number
  max_relogin_failures: number
}

export type CodexLoginHeader = {
  name: string
  value: string
  value_set?: boolean
}

export type CodexLoginServiceConfig = {
  endpoint: string
  configured: boolean
  headers: CodexLoginHeader[]
  timeout_min: number
  batch_concurrency: number
  guard_enabled: boolean
  guard: CodexLoginGuardRules
  encryption_enabled: boolean
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
  vm_id: string | null
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
    exit_mode: 'pool' | 'local'
    save_login: boolean
    name_prefix: string
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
    trigger?: string
    started_at?: string | null
  }
}
