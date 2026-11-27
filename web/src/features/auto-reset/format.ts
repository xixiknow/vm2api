import type { StatusTone } from '@/types/status'
import type {
  AutoResetSlotMode,
  DynamicRescuePreview,
  EffectiveCodexAutoResetPolicy,
  SlotAutoResetState,
} from './types'

export const SLOT_MODE_LABELS: Record<AutoResetSlotMode, string> = {
  inherit: '跟随全局',
  enabled: '强制开启',
  disabled: '强制关闭',
}

const RESULT_LABELS: Record<string, string> = {
  reset: '已自动使用 1 张重置券',
  reset_refresh_failed: '已消费重置券（回读额度失败，已进冷却）',
  no_cards: '暂无可用重置券',
  spendable_credits: '账号有可用积分余额，按策略跳过',
  reset_soon: '临近自然重置，跳过',
  window_not_enabled: '当前受限窗口未启用自动重置',
  query_failed: '查询上游额度失败',
  failed: '自动使用重置券失败',
  not_limited: '上游额度已恢复，无需重置',
  expiry_beyond_7d: '券到期超过 7 天，暂无需抢救',
  '7d_can_absorb_vouchers': '按当前速率 7d 满可消化全部券',
  insufficient_velocity_data: '速率样本不足，暂缓 7d 推算抢救',
}

const RESCUE_REASON_LABELS: Record<string, string> = {
  expiring_before_5h_reset: '券将在本次 5h 自然恢复前过期（Tier 1 必废抢救）',
  expiring_before_next_5h_cap:
    '错过本次后券将在下次 5h 打满前过期（Tier 2 末班车）',
  expiring_before_7d_fill: '按当前 7d 速率过期前打不满 7d（Tier 3 动态抢救）',
  surplus_vouchers_before_7d_fill:
    '7 天内到期券数超过预计 7d 打满次数（Tier 3 消化多余临期券）',
}

const ERROR_LABELS: Record<string, string> = {
  consecutive_failures: '连续 3 次消费重置券失败',
  upstream_auth: 'GPT 凭证已失效',
  upstream_error: '上游返回错误',
  timeout: '上游请求超时',
  fetch_failed: '上游连接失败',
  proxy_required: '未绑定 SOCKS5 出口',
  refresh_failed: 'OAuth 刷新失败',
  reset_in_progress: '该槽正在执行重置',
}

export function formatAutoResetResult(
  result: string | null | undefined,
  error?: string | null
): string {
  if (!result) return '暂无触发记录'
  const base = RESULT_LABELS[result] || result
  if (error && (result === 'failed' || result === 'query_failed')) {
    return `${base}（${ERROR_LABELS[error] || error}）`
  }
  return base
}

export function formatRescueReason(reason: string | null | undefined): string {
  if (!reason) return ''
  return RESCUE_REASON_LABELS[reason] || reason
}

export function formatPauseReason(reason: string | null | undefined): string {
  if (!reason) return '自动重置已暂停'
  return ERROR_LABELS[reason] || reason
}

export function slotAutoResetTone(
  effective: EffectiveCodexAutoResetPolicy,
  state: SlotAutoResetState
): StatusTone {
  if (state.auto_paused) {
    return {
      key: 'paused',
      text: '已自动暂停',
      cls: 'bad',
      label: formatPauseReason(state.paused_reason),
    }
  }
  if (effective.mode === 'disabled') {
    return { key: 'disabled', text: '本槽已关闭', cls: 'off' }
  }
  if (effective.mode === 'enabled') {
    return { key: 'enabled', text: '本槽已开启', cls: 'ok' }
  }
  return effective.enabled
    ? { key: 'inherit-on', text: '跟随全局 · 已开启', cls: 'ok' }
    : { key: 'inherit-off', text: '跟随全局 · 未开启', cls: 'off' }
}

export function formatRuleSummary(
  policy: EffectiveCodexAutoResetPolicy
): string {
  const wins: string[] = []
  if (policy.triggers.seven_day) wins.push('7d')
  if (policy.triggers.five_hour) wins.push('5h')
  if (policy.triggers.other_window) wins.push('其他窗')
  const parts = [
    wins.length ? `${wins.join('/')} 满触发` : '未勾选窗口',
    policy.trigger_mode === 'local_gate' ? '达本地闸线' : '仅真实打满',
    policy.prefer_voucher_over_credits ? '优先于积分' : '先耗积分',
  ]
  if (policy.smart_expiry_rescue) parts.push('动态临期抢救')
  if (policy.min_reset_remaining_min > 0) {
    parts.push(`剩 <${policy.min_reset_remaining_min}m 跳过`)
  }
  if (policy.max_per_day > 0) parts.push(`日限 ${policy.max_per_day} 张`)
  return parts.join(' · ')
}

function formatHours(hours: number | null): string {
  if (hours == null || !Number.isFinite(hours)) return '—'
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分钟`
  if (hours < 48) return `${hours.toFixed(1)} 小时`
  return `${(hours / 24).toFixed(1)} 天`
}

/** Human-readable Chinese explanation of the live 3-tier dynamic rescue calculation. */
export function formatRescuePreviewText(
  preview: DynamicRescuePreview | null | undefined,
  smartRescueEnabled: boolean
): string | null {
  if (!preview || !smartRescueEnabled) return null
  if (preview.reason === 'voucher_unknown') {
    return '尚未查询重置券，5h 满额或手动刷新后将自动评估临期抢救'
  }
  if (preview.available_count <= 0) return null
  const expText =
    preview.earliest_remaining_hours != null
      ? `最近一张券 ${formatHours(preview.earliest_remaining_hours)}后到期`
      : `持有 ${preview.available_count} 张重置券`
  const rateText =
    preview.burn.rate_per_day_pct != null
      ? `当前 7d 速率约 ${preview.burn.rate_per_day_pct}%/天`
      : '速率样本积累中'

  if (preview.should_rescue) {
    if (preview.tier === 1) {
      return `${expText}（早于本次 5h 恢复），将立即抢救消费`
    }
    if (preview.tier === 2) {
      return `${expText}（早于下次 5h 打满），将在本次 5h 满额抢救消费`
    }
    const needText =
      preview.vouchers_within_7d > 1
        ? `7 天内到期 ${preview.vouchers_within_7d} 张，预计 7d 最多用掉 ${preview.max_7d_uses_before_expiry ?? 0} 张`
        : '预计到期前无法打满 7d'
    return `${expText} · ${rateText}，${needText}，5h 满额时将自动抢救`
  }

  if (preview.reason === 'expiry_beyond_7d') {
    return `${expText}（>7 天），暂无需 5h 抢救`
  }
  if (preview.reason === '7d_can_absorb_vouchers') {
    return `${expText} · ${rateText}，预计可由 7d 满正常消耗，不在 5h 抢救`
  }
  if (preview.reason === 'insufficient_velocity_data') {
    return `${expText} · ${rateText}（仅在过期早于 5h 恢复时兜底抢救）`
  }
  return `${expText} · ${rateText}`
}

export function autoResetErrorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return '操作失败，请稍后重试'
}
