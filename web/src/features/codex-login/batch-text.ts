import type { StatusTone } from '@/types/status'
import { isApiError } from '@/lib/api'
import type { CodexLoginBatch, CodexLoginRowStatus } from './types'

export const MAX_BATCH_ROWS = 100

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type BatchTextCheck =
  | { ok: true; count: number }
  | {
      ok: false
      line: number
      reason: 'format' | 'duplicate' | 'empty' | 'too_many'
    }

/**
 * 与后端同一套规则预检：`邮箱----密码----2FA密钥` 或逗号分隔，空行与 `#` 注释跳过。
 * 只报行号，从不回显行内容（里面有密码）。
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
    const mfa = (parts[2] || '').replace(/\s+/g, '')
    if (parts.length !== 3 || !EMAIL_RE.test(email) || !parts[1] || !mfa) {
      return { ok: false, line: i + 1, reason: 'format' }
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
  return `第 ${check.line} 行格式不对：需要 邮箱----密码----2FA密钥`
}

const ROW_TONE: Record<CodexLoginRowStatus, { text: string; cls: string }> = {
  pending: { text: '等待', cls: 'none' },
  checking: { text: '检查中', cls: 'warn' },
  provisioning: { text: '建槽中', cls: 'warn' },
  logging_in: { text: '登录中', cls: 'warn' },
  importing: { text: '导入中', cls: 'warn' },
  created: { text: '已导入', cls: 'ok' },
  skipped: { text: '已存在', cls: 'off' },
  failed: { text: '失败', cls: 'bad' },
  import_failed: { text: '导入失败', cls: 'bad' },
}

export function rowTone(status: CodexLoginRowStatus): StatusTone {
  const tone = ROW_TONE[status] || ROW_TONE.pending
  return { key: status, text: tone.text, cls: tone.cls }
}

const ERROR_TEXT: Record<string, string> = {
  login_service_unconfigured: '还没有配置登录服务',
  encryption_required: '保存密码需要先配置 VM2API_DB_SECRET',
  batch_running: '已有批次在运行',
  batch_not_found: '批次不存在或已过期',
  nothing_to_retry: '没有可重试的行',
  slot_create_failed: '建槽失败',
  no_free_proxy: '代理池没有空闲出口',
  exit_unavailable: '槽位出口不可用',
  login_rejected: '登录被拒',
  login_service_http: '登录服务返回错误',
  login_service_unreachable: '连不上登录服务',
  login_service_header_unreadable: '请求头无法解密，请重新填写',
  login_timeout: '登录超时',
  login_idle_timeout: '登录服务长时间无响应',
  login_response_invalid: '登录服务返回的数据无效',
  login_response_too_large: '登录服务返回的数据过大',
  login_no_result: '登录服务没有返回结果',
  login_no_credential: '登录服务没有返回凭证',
  login_credential_incomplete: '登录服务返回的凭证不完整',
  identity_mismatch: '登录到的账号与邮箱不符',
  import_failed: '写入凭证失败',
  enroll_failed: '保存登录资料失败',
  panel_not_ready: '面板未就绪，稍后重试',
  vm_not_found: '槽位不存在',
  vm_not_codex: '只有 GPT 槽可以登记密码登录',
  profile_missing: '这个槽还没有登记密码登录',
  secret_unreadable: '保存的密码无法解密（数据库密钥变了），请重新填写',
  internal_error: '内部错误',
  canceled: '已取消',
  invalid_email: '邮箱无效',
  password_required: '需要填写密码',
  invalid_totp: '2FA 密钥无效',
  cooldown: '重登冷却中',
  auto_paused: '自动重登已暂停',
  auto_relogin_off: '自动重登已关闭',
  invalid_endpoint: '登录服务地址无效',
  endpoint_requires_https: '公网登录服务必须用 HTTPS',
  header_value_required: '新请求头需要填写值',
  invalid_header_name: '请求头名称不合法或不允许自定义',
  invalid_header_value: '请求头的值不合法',
  duplicate_header: '请求头重复',
  refresh_rejected: '刷新令牌被拒',
  no_refresh_token: '没有刷新令牌',
  no_credential: '槽位没有凭证',
  upstream_forbidden: '账号被拒（非凭证问题）',
  proxy_required: '槽位没有出口',
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
    if (error.code === 'invalid_batch' || error.code === 'duplicate_email')
      return error.message
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
