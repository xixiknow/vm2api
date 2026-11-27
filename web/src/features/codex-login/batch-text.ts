import type { StatusTone } from '@/types/status'
import { isApiError } from '@/lib/api'
import type {
  CodexLoginBatch,
  CodexLoginRowStatus,
  CodexWorkspaceMeta,
  CodexWorkspacePolicy,
} from './types'

export const MAX_BATCH_ROWS = 100

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const BASE32_TOTP_RE = /^[A-Z2-7]{16,128}$/i

export type BatchTextCheck =
  | { ok: true; count: number }
  | {
      ok: false
      line: number
      reason: 'format' | 'invalid_totp' | 'duplicate' | 'empty' | 'too_many'
    }

function isValidTotpInput(raw: string): boolean {
  let text = raw.trim()
  if (!text) return true
  if (/^otpauth:\/\//i.test(text)) {
    try {
      const u = new URL(text)
      text = String(u.searchParams.get('secret') || '').trim()
    } catch {
      return false
    }
  }
  const cleaned = text.replace(/\s+/g, '').replace(/=+$/g, '')
  return BASE32_TOTP_RE.test(cleaned)
}

/**
 * 与后端同一套规则预检：`邮箱----密码----2FA密钥` 或 `邮箱----密码`（逗号同理），
 * 空行与 `#` 注释跳过。只报行号，从不回显行内容（里面有密码）。
 */
export function checkBatchText(text: string): BatchTextCheck {
  const seen = new Set<string>()
  let count = 0
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const parts = (
      line.includes('----') ? line.split('----') : line.split(',')
    ).map((p) => p.trim())
    const email = (parts[0] || '').toLowerCase()
    if (
      (parts.length !== 2 && parts.length !== 3) ||
      !EMAIL_RE.test(email) ||
      !parts[1]
    ) {
      return { ok: false, line: i + 1, reason: 'format' }
    }
    const rawMfa = parts.length === 3 ? parts[2] || '' : ''
    if (rawMfa && !isValidTotpInput(rawMfa)) {
      return { ok: false, line: i + 1, reason: 'invalid_totp' }
    }
    if (seen.has(email)) return { ok: false, line: i + 1, reason: 'duplicate' }
    seen.add(email)
    count++
  }
  if (!count) return { ok: false, line: 0, reason: 'empty' }
  if (count > MAX_BATCH_ROWS) return { ok: false, line: 0, reason: 'too_many' }
  return { ok: true, count }
}

export function batchTextProblem(check: BatchTextCheck): string {
  if (check.ok) return ''
  if (check.reason === 'empty') return '没有可导入的账号'
  if (check.reason === 'too_many') return `一次最多 ${MAX_BATCH_ROWS} 个账号`
  if (check.reason === 'duplicate') return `第 ${check.line} 行的邮箱和前面重复`
  if (check.reason === 'invalid_totp') {
    return `第 ${check.line} 行 2FA 密钥无效（需要 16–128 位 Base32 或 otpauth://）`
  }
  return `第 ${check.line} 行格式不对：需要 邮箱----密码 或 邮箱----密码----2FA密钥`
}

export const WORKSPACE_POLICY_OPTIONS: {
  value: CodexWorkspacePolicy
  label: string
  desc: string
}[] = [
  {
    value: 'auto',
    label: '自动选择（auto）',
    desc: '优先复用历史成功工作区，否则按组织 → 个人顺序选择。',
  },
  {
    value: 'prefer_organization',
    label: '优先组织（prefer_organization）',
    desc: '优先选择团队/组织工作区，再选个人工作区。',
  },
  {
    value: 'prefer_personal',
    label: '优先个人（prefer_personal）',
    desc: '优先选择个人工作区，再选组织工作区。',
  },
]

const STAGE_TEXT: Record<string, string> = {
  authorizing: '初始化授权',
  identifying: '提交账号',
  verifying_password: '验证密码',
  issuing_mfa: '发起 2FA',
  verifying_mfa: '验证 2FA',
  selecting_workspace: '选择工作区',
  capturing_callback: '获取回调',
  exchanging_token: '换取令牌',
  verifying_identity: '验签核对身份',
}

export function codexAuthStageText(stage: string | null | undefined): string {
  return stage ? STAGE_TEXT[stage] || stage : ''
}

const WORKSPACE_KIND_TEXT: Record<string, string> = {
  organization: '组织',
  personal: '个人',
  unknown: '未知类型',
}

const SELECTION_REASON_TEXT: Record<string, string> = {
  explicit_id: '指定工作区',
  single_workspace: '唯一工作区',
  history_success: '复用历史工作区',
  organization_preferred: '优先组织',
  personal_preferred: '优先个人',
  stable_fallback: '稳定回退',
}

export function codexWorkspaceKindText(
  kind: string | null | undefined
): string {
  return kind ? WORKSPACE_KIND_TEXT[kind] || kind : ''
}

export function codexWorkspaceReasonText(
  reason: string | null | undefined
): string {
  return reason ? SELECTION_REASON_TEXT[reason] || reason : ''
}

export function codexWorkspaceSummary(
  ws: CodexWorkspaceMeta | null | undefined
): string {
  if (!ws) return ''
  const parts: string[] = []
  if (ws.kind) parts.push(codexWorkspaceKindText(ws.kind))
  if (ws.name) parts.push(ws.name)
  if (ws.selection_missing) {
    parts.push('未返回选择元数据')
  } else if (ws.selection_reason) {
    parts.push(codexWorkspaceReasonText(ws.selection_reason))
  }
  if (ws.candidate_count && ws.candidate_count > 1) {
    parts.push(`${ws.candidate_count} 候选`)
  }
  if (!parts.length && ws.id) return ws.id
  return parts.join(' · ')
}

const ROW_TONE: Record<CodexLoginRowStatus, { text: string; cls: string }> = {
  pending: { text: '等待', cls: 'none' },
  checking: { text: '检查中', cls: 'warn' },
  provisioning: { text: '分代理建槽', cls: 'warn' },
  logging_in: { text: '登录中', cls: 'warn' },
  importing: { text: '导入中', cls: 'warn' },
  created: { text: '已导入', cls: 'ok' },
  skipped: { text: '已存在', cls: 'off' },
  failed: { text: '失败', cls: 'bad' },
  import_failed: { text: '导入失败', cls: 'bad' },
}

export function rowTone(
  status: CodexLoginRowStatus,
  stage?: string | null
): StatusTone {
  const tone = ROW_TONE[status] || ROW_TONE.pending
  if (status === 'logging_in' && stage) {
    return { key: status, text: codexAuthStageText(stage), cls: tone.cls }
  }
  return { key: status, text: tone.text, cls: tone.cls }
}

const ERROR_TEXT: Record<string, string> = {
  login_service_unconfigured: '还没有配置认证服务地址或服务密钥',
  login_service_token_unreadable: '认证服务密钥无法解密，请重新填写',
  invalid_service_token: '服务密钥不合法',
  invalid_workspace_policy: '工作区偏好设置无效',
  encryption_required: '保存密码需要先配置 VM2API_DB_SECRET',
  batch_running: '已有批次在运行',
  batch_not_found: '批次不存在或已过期',
  nothing_to_retry: '没有可重试的行',
  local_exit_unsupported: '批量导入仅支持代理池分配出口',
  slot_create_failed: '建槽失败',
  no_free_proxy: '代理池没有空闲出口，请先添加或启用代理',
  exit_unavailable: '槽位出口不可用',
  proxy_required: '槽位未绑定可用代理出口',
  proxy_unavailable: '槽位绑定的代理不可用',
  proxy_changed: '认证期间槽位代理发生变化，已中止换票',
  invalid_proxy: '槽位代理地址无效',
  proxy_unreachable: '代理不可达',
  unauthorized: '认证服务密钥错误（401）',
  capacity_exceeded: '认证服务并发已满，稍后重试',
  engine_not_ready: '认证服务引擎未就绪',
  service_stopping: '认证服务正在停止',
  auth_session_expiring: '授权会话剩余有效期不足，请重试',
  expired: '认证会话已过期',
  password_rejected: '账号或密码错误',
  mfa_secret_required: '账号需要 2FA 密钥（未提供）',
  mfa_failed: '2FA 验证失败，请核对密钥与系统时钟',
  workspace_not_found: '原工作区已失效或不在候选列表',
  workspace_unavailable: '未获取到可用工作区',
  workspace_selection_required: '需要选择工作区',
  interaction_required: '上游要求人工验证（暂不支持）',
  unsupported_auth_state: '遇到未支持的登录分支',
  auth_material_unavailable: '认证服务上游材料不兼容，请检查服务更新',
  auth_worker_failed: '认证工作线程异常（非密码错误），请检查并发与内存',
  upstream_rate_limited: '上游触发限流，请降低并发后重试',
  upstream_network_error: '上游网络错误',
  upstream_timeout: '上游认证超时',
  upstream_unavailable: '上游服务暂不可用',
  upstream_rejected: '上游拒绝了本次请求',
  stream_invalid: '认证服务返回流格式异常',
  response_too_large: '认证服务返回数据过大',
  callback_invalid: 'OAuth 回调地址校验失败',
  state_mismatch: 'OAuth 回调 state 不匹配',
  oauth_authorization_error: '上游 OAuth 授权报错',
  exchange_outcome_unknown: '换票响应丢失，请新建会话重试',
  exchange_rejected: 'OAuth 换票被上游拒绝',
  credential_incomplete: '换票返回凭据不完整',
  token_verification_failed: 'ID Token 签名或声明校验失败',
  identity_mismatch: '登录到的账号或工作区与预期不符',
  task_already_running: '任务已在运行中',
  task_already_finished: '任务已完成',
  login_service_unreachable: '连不上认证服务',
  login_credential_incomplete: '凭据不完整',
  slot_login_running: '该槽正在执行登录或重登',
  account_exists: '该账号或工作区已在其他槽位',
  import_failed: '写入凭证失败',
  enroll_failed: '保存登录资料失败',
  panel_not_ready: '面板未就绪，稍后重试',
  vm_not_found: '槽位不存在',
  vm_not_codex: '只有 GPT 槽可以使用密码登录',
  profile_missing: '这个槽还没有登记密码登录',
  secret_unreadable: '保存的密码无法解密（数据库密钥变了），请重新填写',
  internal_error: '内部错误',
  canceled: '已取消',
  invalid_email: '邮箱无效',
  password_required: '需要填写密码',
  invalid_password: '密码过长',
  invalid_totp: '2FA 密钥无效（需要 16–128 位 Base32 或 otpauth://）',
  cooldown: '重登冷却中',
  auto_paused: '自动重登已暂停',
  auto_relogin_off: '自动重登已关闭',
  invalid_endpoint: '认证服务地址无效',
  endpoint_requires_https: '公网认证服务必须用 HTTPS',
  refresh_rejected: '刷新令牌被拒',
  no_refresh_token: '没有刷新令牌',
  no_credential: '槽位没有凭证',
  upstream_forbidden: '账号被拒（非凭证问题）',
  timeout: '超时',
  fetch_failed: '网络错误',
}

const DETAIL_TEXT: Record<string, string> = {
  email_exists: '邮箱已在其他槽位',
  account_exists: '账号已在其他槽位',
}

const WARNING_TEXT: Record<string, string> = {
  login_ip_differs: '登录没有走槽位出口',
  start_failed: '凭证已导入，槽位启动失败',
  workspace_metadata_missing: '直达回调，未返回工作区选择元数据',
  enroll_failed: '凭证已导入，但保存自动重登资料失败',
}

export function codexLoginCodeText(
  code: string | null | undefined,
  detail?: string | null
): string {
  if (!code) return detail ? DETAIL_TEXT[detail] || detail : ''
  const base = ERROR_TEXT[code] || code
  if (!detail) return base
  const extra =
    DETAIL_TEXT[detail] ||
    (detail.startsWith('http_') ? `HTTP ${detail.slice(5)}` : detail)
  return `${base}（${extra}）`
}

export function codexLoginWarningText(code: string | null | undefined): string {
  return code ? WARNING_TEXT[code] || code : ''
}

/** 接口错误 → 文案。批次行错误的原文已带「第 N 行」，直接用。 */
export function codexLoginErrorText(error: unknown): string {
  if (isApiError(error)) {
    if (
      error.code === 'invalid_batch' ||
      error.code === 'duplicate_email' ||
      error.code === 'invalid_totp'
    ) {
      if (error.message.includes('第 ')) return error.message
    }
    return ERROR_TEXT[error.code] || error.message
  }
  return error instanceof Error ? error.message : String(error)
}

export function batchSummary(
  batch: CodexLoginBatch | null | undefined
): string {
  if (!batch) return ''
  const c = batch.counts
  const parts = [`共 ${c.total || 0}`]
  if (c.created) parts.push(`导入 ${c.created}`)
  if (c.skipped) parts.push(`已存在 ${c.skipped}`)
  const failed = (c.failed || 0) + (c.import_failed || 0)
  if (failed) parts.push(`失败 ${failed}`)
  const waiting = c.pending || 0
  if (waiting && batch.status !== 'running') parts.push(`未开始 ${waiting}`)
  return parts.join(' · ')
}

export function hasRetryableRows(
  batch: CodexLoginBatch | null | undefined
): boolean {
  return !!batch?.rows.some((row) => row.retryable)
}
