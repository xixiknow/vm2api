import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Eye, Loader2, Play, ShieldCheck, ShieldOff } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtResetClock } from '@/lib/fable-status'
import { fmtAgo, fmtExpiresAt, fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { StatusMark } from '@/components/status-mark'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import {
  fmtDurationSec,
  formatIq24hLine,
  IQ_BENCHMARK_LABELS,
  IQ_BUCKET_BG,
  IQ_BUCKET_LABEL,
  IQ_SKIP_REASON_LABELS,
  iqBucketState,
  iqErrorText,
  iqPillVisual,
  iqStatusTone,
  shouldShowIqBadge,
} from './format'
import { IqPreviewDialog } from './iq-preview-dialog'
import {
  gptIqConfigQueryOptions,
  gptIqEventsQueryOptions,
  gptIqSlotsQueryOptions,
  vmIqCheckQueryOptions,
} from './queries'

const PILL_CLS = {
  ok: 'border-[color:var(--status-ok-solid)]/35 bg-[color:var(--status-ok-solid)]/12 text-[color:var(--status-ok)]',
  bad: 'border-[color:var(--status-bad-solid)]/45 bg-[color:var(--status-bad-solid)]/14 text-[color:var(--status-bad)] font-semibold',
  caution:
    'border-[color:var(--status-caution-solid)]/40 bg-[color:var(--status-caution-solid)]/12 text-[color:var(--status-caution)]',
  warn: 'border-[color:var(--status-warn-solid)]/40 bg-[color:var(--status-warn-solid)]/12 text-[color:var(--status-warn)]',
  running: 'border-primary/40 bg-primary/10 text-primary',
  none: 'border-border/70 bg-muted/50 text-[color:var(--text-tertiary)]',
} as const

/**
 * Compact inline IQ status pill placed inside the `健康 · 24h` table cell for GPT slots.
 * Clicking opens the latest preview artifact when available (stopping row expand propagation).
 */
export function IqHealthPill({ vm }: { vm: Vm }) {
  const [previewOpen, setPreviewOpen] = useState(false)
  const iq = vm.iq_check
  if (!isCodexVm(vm) || !iq || !shouldShowIqBadge(iq)) return null

  const visual = iqPillVisual(iq)
  const canPreview = iq.has_artifact

  const pillContent = (
    <>
      {visual.tone === 'running' ? (
        <Loader2 className='size-2.5 shrink-0 animate-spin' aria-hidden />
      ) : iq.isolated ? (
        <ShieldOff className='size-2.5 shrink-0' aria-hidden />
      ) : null}
      <span>{visual.text}</span>
    </>
  )

  const pillClass = cn(
    'ml-auto inline-flex h-[18px] shrink-0 items-center gap-1 rounded border px-1.5 text-[10.5px] leading-none font-medium whitespace-nowrap transition-opacity',
    PILL_CLS[visual.tone],
    visual.muted && 'opacity-60',
    canPreview && 'cursor-pointer hover:brightness-110'
  )

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          {canPreview ? (
            <button
              type='button'
              data-row-stop
              className={pillClass}
              aria-label={`测智状态 ${visual.text}，点击预览最新结果`}
              onClick={(e) => {
                e.stopPropagation()
                setPreviewOpen(true)
              }}
            >
              {pillContent}
            </button>
          ) : (
            <span className={pillClass} aria-label={`测智状态 ${visual.text}`}>
              {pillContent}
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent side='top' className='max-w-xs space-y-1 text-[11px]'>
          <div className='flex items-center justify-between gap-3 font-semibold'>
            <span>
              测智 · {IQ_BENCHMARK_LABELS[iq.benchmark]} ({iq.model})
            </span>
            <span>{visual.text}</span>
          </div>
          <div>{formatIq24hLine(iq)}</div>
          {iq.last_checked_at ? (
            <div className='text-muted-foreground'>
              最近：
              {fmtAgo(iq.last_checked_at) || fmtExpiresAt(iq.last_checked_at)}
              {iq.last_duration_ms != null
                ? ` · ${fmtDurationSec(iq.last_duration_ms)}`
                : ''}
              {iq.stale_24h ? '（已超过 24h）' : ''}
            </div>
          ) : null}
          {iq.next_run_at && iq.enabled && !iq.isolated ? (
            <div className='text-muted-foreground'>
              下次计划：{fmtExpiresAt(iq.next_run_at)}
            </div>
          ) : null}
          {iq.isolated ? (
            <div className='text-[color:var(--status-bad)]'>
              已自动停止调度隔离 · 点开明细可复测或解除隔离
            </div>
          ) : null}
          {iq.reason ? (
            <div className='border-t pt-1 text-muted-foreground'>
              {iq.reason}
            </div>
          ) : null}
          {canPreview ? (
            <div className='text-[10.5px] opacity-80'>点击胶囊预览最新结果</div>
          ) : null}
        </TooltipContent>
      </Tooltip>
      {canPreview ? (
        <IqPreviewDialog
          vmId={vm.id}
          vmName={vm.name || vm.id}
          open={previewOpen}
          onOpenChange={setPreviewOpen}
        />
      ) : null}
    </>
  )
}

/**
 * 24-hour IQ check section embedded inside the expanded `VmRowDetail -> HealthCard`
 * for GPT (Codex) slots.
 */
export function IqTimeline24h({ vm }: { vm: Vm }) {
  const qc = useQueryClient()
  const [previewOpen, setPreviewOpen] = useState(false)
  const codex = isCodexVm(vm)
  const q = useQuery({
    ...vmIqCheckQueryOptions(vm.id),
    enabled: codex,
  })

  const invalidateAll = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: vmIqCheckQueryOptions(vm.id).queryKey }),
      qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
      qc.invalidateQueries({ queryKey: gptIqSlotsQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: gptIqConfigQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: gptIqEventsQueryOptions().queryKey }),
    ])

  const runNow = useMutation({
    mutationFn: () =>
      api(`/api/panel/vms/${encodeURIComponent(vm.id)}/iq-check/run`, {
        method: 'POST',
      }),
    onSuccess: async () => {
      toast.success(`已发起 ${vm.name || vm.id} 测智任务`)
      await invalidateAll()
    },
    onError: (err) => toast.error(iqErrorText(err)),
  })

  const unisolate = useMutation({
    mutationFn: () =>
      api(`/api/panel/vms/${encodeURIComponent(vm.id)}/iq-check/unisolate`, {
        method: 'POST',
      }),
    onSuccess: async () => {
      toast.success(`已解除 ${vm.name || vm.id} 降智隔离并恢复调度`)
      await invalidateAll()
    },
    onError: (err) => toast.error(iqErrorText(err)),
  })

  if (!codex) return null
  const view = q.data
  if (!view && !vm.iq_check) return null

  const summary = view?.summary ?? vm.iq_check
  if (!summary) return null

  const buckets = view?.state.buckets_24h
  const startMs = buckets ? Date.parse(buckets.start) : 0
  const slotMin = buckets?.slot_min ?? 30
  const tone = iqStatusTone(summary.status, {
    running: summary.running,
    isolated: summary.isolated,
    referenceOnly: summary.reference_only,
  })

  return (
    <div className='mt-3 border-t pt-2.5'>
      <div className='mb-1.5 flex flex-wrap items-center justify-between gap-2'>
        <div className='flex items-center gap-1.5 text-[11px] font-medium'>
          <span>测智 · 24h</span>
          <StatusMark tone={tone} variant='pill' />
          <span className='font-mono text-[10.5px] font-normal text-muted-foreground'>
            {IQ_BENCHMARK_LABELS[summary.benchmark]} · {summary.model} · 每{' '}
            {summary.interval_min}m
          </span>
        </div>
        <div className='flex items-center gap-1'>
          {summary.has_artifact ? (
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-6 gap-1 px-1.5 text-[11px]'
              onClick={() => setPreviewOpen(true)}
            >
              <Eye className='size-3' />
              预览
            </Button>
          ) : null}
          {summary.isolated ? (
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='h-6 gap-1 px-1.5 text-[11px]'
              disabled={unisolate.isPending}
              onClick={() => unisolate.mutate()}
            >
              <ShieldCheck className='size-3 text-[color:var(--status-ok)]' />
              解除隔离
            </Button>
          ) : null}
          <Button
            type='button'
            size='sm'
            variant='outline'
            className='h-6 gap-1 px-1.5 text-[11px]'
            disabled={summary.running || runNow.isPending}
            onClick={() => runNow.mutate()}
          >
            {summary.running ? (
              <Loader2 className='size-3 animate-spin' />
            ) : (
              <Play className='size-3' />
            )}
            {summary.running ? '测智中' : '立即测智'}
          </Button>
        </div>
      </div>

      {buckets ? (
        <div className='flex h-3.5 gap-px' aria-label='近 24 小时测智时间线'>
          {buckets.buckets.map((tuple, idx) => {
            const st = iqBucketState(tuple)
            const [n, d, u, e] = tuple
            const tLabel = startMs
              ? fmtResetClock(
                  new Date(startMs + idx * slotMin * 60_000).toISOString()
                ) || ''
              : ''
            const countText =
              n + d + u + e > 0
                ? `满血 ${n} / 降智 ${d} / 未知 ${u} / 异常 ${e}`
                : IQ_BUCKET_LABEL[st]
            return (
              <span
                key={idx}
                className='flex-1 rounded-[2px]'
                style={{ backgroundColor: IQ_BUCKET_BG[st] }}
                title={`${tLabel} · ${countText}`}
              />
            )
          })}
        </div>
      ) : null}

      <div className='mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground'>
        <span className='font-mono tabular-nums'>
          24h 满血 {fmtNum(summary.summary_24h.normal)} / 降智{' '}
          <b
            className={cn(
              summary.summary_24h.degraded > 0 &&
                'text-[color:var(--status-bad)]'
            )}
          >
            {fmtNum(summary.summary_24h.degraded)}
          </b>{' '}
          / 异常 {fmtNum(summary.summary_24h.error)}
        </span>
        <span>
          {summary.last_checked_at
            ? `上次 ${fmtAgo(summary.last_checked_at) || fmtExpiresAt(summary.last_checked_at)}`
            : '尚未执行'}
          {view?.skip_reason
            ? ` · ${IQ_SKIP_REASON_LABELS[view.skip_reason] || view.skip_reason}`
            : summary.next_run_at && summary.enabled && !summary.isolated
              ? ` · 下次 ${fmtResetClock(summary.next_run_at) ?? ''}`
              : ''}
        </span>
      </div>

      {summary.reason ? (
        <div
          className='mt-1 truncate text-[11px] text-muted-foreground'
          title={summary.reason}
        >
          {summary.reason}
        </div>
      ) : null}

      {summary.has_artifact ? (
        <IqPreviewDialog
          vmId={vm.id}
          vmName={vm.name || vm.id}
          open={previewOpen}
          onOpenChange={setPreviewOpen}
        />
      ) : null}
    </div>
  )
}
