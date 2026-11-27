import type { StatusTone } from '@/types/status'
import type {
  GptIqBenchmark,
  GptIqSlotMode,
  GptIqStatus,
  GptIqVmSummary,
} from './types'

export const IQ_SLOT_MODE_LABELS: Record<GptIqSlotMode, string> = {
  inherit: '跟随全局',
  enabled: '强制开启',
  disabled: '强制关闭',
}

export const IQ_BENCHMARK_LABELS: Record<GptIqBenchmark, string> = {
  pelican: '鹈鹕骑行',
  candy: '糖果检测',
  creative: '自由创作',
}

export const IQ_BENCHMARK_HINTS: Record<GptIqBenchmark, string> = {
  pelican: '生成内联 SVG 鹈鹕骑自行车动画，由满血分类器判定（支持动画预览）',
  candy: '逻辑推理糖果题，客观通过/未通过判定，响应较快（支持答案预览）',
  creative: '随机主题自由创作单文件 HTML 动画并由分类器判定（支持动画预览）',
}

export const IQ_EFFORTS_BY_BENCHMARK: Record<
  GptIqBenchmark,
  readonly string[]
> = {
  pelican: ['low', 'medium', 'high'],
  creative: ['low', 'medium', 'high'],
  candy: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
}

export const IQ_SKIP_REASON_LABELS: Record<string, string> = {
  iq_isolated: '已降智隔离（暂停定时）',
  schedule_disabled: '已关闭调度',
  resting: '非工作时段',
  quota_high: '配额已达跳过阈值',
  rate_limited: '账号限流冷却中',
  proxy_blocked: 'SOCKS5 代理不可用',
  credential_unavailable: '凭证无效或已吊销',
  slot_unavailable: '槽位不可用',
  backoff: '异常退避中',
  not_codex: '仅 GPT 槽支持',
}

export type IqPillVisual = {
  text: string
  tone: 'ok' | 'bad' | 'caution' | 'warn' | 'none' | 'running'
  muted?: boolean
}

/** Decide whether a GPT slot should show an IQ badge in the compact 24h Health cell. */
export function shouldShowIqBadge(
  iq: GptIqVmSummary | null | undefined
): boolean {
  if (!iq) return false
  return Boolean(
    iq.running ||
    iq.isolated ||
    iq.enabled ||
    iq.status != null ||
    iq.summary_24h.total > 0
  )
}

export function iqPillVisual(iq: GptIqVmSummary): IqPillVisual {
  if (iq.running) return { text: '测智中', tone: 'running' }
  if (iq.isolated) return { text: '降智隔离', tone: 'bad' }
  if (iq.status === 'degraded') {
    return {
      text: iq.reference_only ? '参考降智' : '降智',
      tone: iq.reference_only ? 'caution' : 'bad',
      muted: iq.stale_24h,
    }
  }
  if (iq.status === 'normal') {
    return {
      text: iq.reference_only ? '参考正常' : '满血',
      tone: iq.reference_only ? 'caution' : 'ok',
      muted: iq.stale_24h,
    }
  }
  if (iq.status === 'unknown') {
    return { text: '未知', tone: 'caution', muted: iq.stale_24h }
  }
  if (iq.status === 'error') {
    return { text: '测智错', tone: 'warn', muted: iq.stale_24h }
  }
  return { text: '待测智', tone: 'none' }
}

export function iqStatusTone(
  status: GptIqStatus | null | undefined,
  {
    running = false,
    isolated = false,
    referenceOnly = false,
  }: { running?: boolean; isolated?: boolean; referenceOnly?: boolean } = {}
): StatusTone {
  if (running) return { key: 'running', text: '测智中', cls: 'caution' }
  if (isolated) return { key: 'isolated', text: '降智隔离', cls: 'bad' }
  if (status === 'normal') {
    return referenceOnly
      ? { key: 'ref-normal', text: '参考正常', cls: 'caution' }
      : { key: 'normal', text: '满血', cls: 'ok' }
  }
  if (status === 'degraded') {
    return referenceOnly
      ? { key: 'ref-degraded', text: '参考降智', cls: 'caution' }
      : { key: 'degraded', text: '疑似降智', cls: 'bad' }
  }
  if (status === 'unknown')
    return { key: 'unknown', text: '无法判定', cls: 'caution' }
  if (status === 'error') return { key: 'error', text: '测智异常', cls: 'warn' }
  return { key: 'none', text: '未测智', cls: 'off' }
}

export type IqBucketState = 'ok' | 'bad' | 'caution' | 'warn' | 'none'

export function iqBucketState([normal, degraded, unknown, error]: [
  number,
  number,
  number,
  number,
]): IqBucketState {
  const total = normal + degraded + unknown + error
  if (total <= 0) return 'none'
  if (degraded > 0) return 'bad'
  if (error > 0 && normal === 0) return 'warn'
  if (unknown > 0 || error > 0) return 'caution'
  return 'ok'
}

export const IQ_BUCKET_BG: Record<IqBucketState, string> = {
  ok: 'var(--status-ok-solid)',
  bad: 'var(--status-bad-solid)',
  caution: 'var(--status-caution-solid)',
  warn: 'var(--status-warn-solid)',
  none: 'var(--muted)',
}

export const IQ_BUCKET_LABEL: Record<IqBucketState, string> = {
  ok: '满血',
  bad: '出现降智',
  caution: '存在未知或部分异常',
  warn: '测智异常',
  none: '无测智记录',
}

export function fmtDurationSec(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const sec = ms / 1000
  return sec >= 60
    ? `${Math.floor(sec / 60)}m${Math.round(sec % 60)}s`
    : `${sec.toFixed(1)}s`
}

export function formatIq24hLine(iq: GptIqVmSummary): string {
  const s = iq.summary_24h
  if (!s.total) return '近 24h 暂无测智记录'
  const parts = [`满血 ${s.normal}`]
  if (s.degraded) parts.push(`降智 ${s.degraded}`)
  if (s.unknown) parts.push(`未知 ${s.unknown}`)
  if (s.error) parts.push(`异常 ${s.error}`)
  return `近 24h（${s.total} 次）：${parts.join(' · ')}`
}

export function iqErrorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err || '操作失败')
}

const PREVIEW_CSP_META =
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:;\">"

/**
 * Inject a strict CSP meta tag into model-generated HTML before rendering inside
 * a sandboxed iframe (`sandbox="allow-scripts"`, without `allow-same-origin`).
 * Blocks external network fetches while preserving inline SVG / CSS / JS animation.
 */
export function wrapPreviewHtmlWithCsp(html: string): string {
  const raw = String(html || '')
  if (!raw.trim()) return ''
  if (/<head[^>]*>/i.test(raw)) {
    return raw.replace(/<head[^>]*>/i, (m) => `${m}\n${PREVIEW_CSP_META}`)
  }
  if (/<html[^>]*>/i.test(raw)) {
    return raw.replace(
      /<html[^>]*>/i,
      (m) => `${m}\n<head>${PREVIEW_CSP_META}</head>`
    )
  }
  return `<!doctype html><html><head><meta charset="utf-8">${PREVIEW_CSP_META}</head><body>${raw}</body></html>`
}
