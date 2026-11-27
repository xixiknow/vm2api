import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import {
  Brain,
  ChevronDown,
  ChevronRight,
  Eye,
  Loader2,
  Play,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtAgo, fmtExpiresAt, fmtNum } from '@/lib/format'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { StatusMark } from '@/components/status-mark'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'
import {
  fmtDurationSec,
  IQ_BENCHMARK_LABELS,
  IQ_EFFORTS_BY_BENCHMARK,
  IQ_SKIP_REASON_LABELS,
  IQ_SLOT_MODE_LABELS,
  iqErrorText,
  iqStatusTone,
} from './format'
import { IqPreviewDialog } from './iq-preview-dialog'
import {
  gptIqConfigQueryOptions,
  gptIqEventsQueryOptions,
  gptIqModelsQueryOptions,
  gptIqSlotsQueryOptions,
  vmIqCheckQueryOptions,
} from './queries'
import type {
  GptIqBenchmark,
  GptIqServiceTier,
  GptIqSlotMode,
  SlotIqView,
} from './types'

type OverrideDraft = {
  benchmark: GptIqBenchmark
  model: string
  reasoning_effort: string
  service_tier: GptIqServiceTier
  interval_min: string
  auto_isolate_on_degraded: boolean
  isolate_threshold: string
  isolate_on_reference: boolean
}

function draftFromView(view: SlotIqView): OverrideDraft {
  const eff = view.effective
  return {
    benchmark: eff.benchmark,
    model: eff.model,
    reasoning_effort: eff.reasoning_effort,
    service_tier: eff.service_tier,
    interval_min: String(eff.interval_min),
    auto_isolate_on_degraded: eff.auto_isolate_on_degraded,
    isolate_threshold: String(eff.isolate_threshold),
    isolate_on_reference: eff.isolate_on_reference,
  }
}

function buildSparseOverrides(
  draft: OverrideDraft,
  view: SlotIqView
): Record<string, unknown> {
  const g = view.global_defaults
  const intOrNull = (raw: string, globalVal: number) => {
    const n = Number(raw)
    if (!Number.isFinite(n)) return n
    return n === globalVal ? null : Math.round(n)
  }
  return {
    benchmark: draft.benchmark === g.benchmark ? null : draft.benchmark,
    model: draft.model.trim() === g.model ? null : draft.model.trim(),
    reasoning_effort:
      draft.reasoning_effort === g.reasoning_effort
        ? null
        : draft.reasoning_effort,
    service_tier:
      draft.service_tier === g.service_tier ? null : draft.service_tier,
    interval_min: intOrNull(draft.interval_min, g.interval_min),
    auto_isolate_on_degraded:
      draft.auto_isolate_on_degraded === g.auto_isolate_on_degraded
        ? null
        : draft.auto_isolate_on_degraded,
    isolate_threshold: intOrNull(draft.isolate_threshold, g.isolate_threshold),
    isolate_on_reference:
      draft.isolate_on_reference === g.isolate_on_reference
        ? null
        : draft.isolate_on_reference,
  }
}

const MODES: GptIqSlotMode[] = ['inherit', 'enabled', 'disabled']

export function SlotIqControl({ vm }: { vm: Vm }) {
  const perms = useVmPerms()
  const qc = useQueryClient()
  const isCodex = isCodexVm(vm)
  const [expanded, setExpanded] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)

  const query = useQuery({
    ...vmIqCheckQueryOptions(vm.id),
    enabled: isCodex && perms.test,
  })
  const modelsQuery = useQuery({
    ...gptIqModelsQueryOptions(),
    enabled: isCodex && expanded,
  })
  const view = query.data
  const [draft, setDraft] = useState<OverrideDraft | null>(null)
  useEffect(() => {
    if (view) setDraft(draftFromView(view))
  }, [view])

  const syncAll = async (next?: SlotIqView) => {
    if (next) qc.setQueryData(vmIqCheckQueryOptions(vm.id).queryKey, next)
    await Promise.all([
      qc.invalidateQueries({ queryKey: vmIqCheckQueryOptions(vm.id).queryKey }),
      qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
      qc.invalidateQueries({ queryKey: gptIqSlotsQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: gptIqConfigQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: gptIqEventsQueryOptions().queryKey }),
    ])
  }

  const patchSlot = useMutation({
    mutationFn: (body: {
      mode?: GptIqSlotMode
      overrides?: Record<string, unknown> | null
    }) =>
      api<SlotIqView>(`/api/panel/vms/${encodeURIComponent(vm.id)}/iq-check`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: async (next, vars) => {
      await syncAll(next)
      if (vars.mode)
        toast.success(`测智模式已切换为「${IQ_SLOT_MODE_LABELS[vars.mode]}」`)
      else toast.success('已保存本槽个性化测智规则')
    },
    onError: (err) => toast.error(iqErrorText(err)),
  })

  const resetSlot = useMutation({
    mutationFn: () =>
      api<SlotIqView>(`/api/panel/vms/${encodeURIComponent(vm.id)}/iq-check`, {
        method: 'DELETE',
      }),
    onSuccess: async (next) => {
      await syncAll(next)
      setExpanded(false)
      toast.success('已还原为跟随全局测智设置')
    },
    onError: (err) => toast.error(iqErrorText(err)),
  })

  const runNow = useMutation({
    mutationFn: () =>
      api<{ view?: SlotIqView }>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/iq-check/run`,
        { method: 'POST' }
      ),
    onSuccess: async (res) => {
      toast.success('已发起测智任务')
      await syncAll(res.view)
    },
    onError: (err) => toast.error(iqErrorText(err)),
  })

  const cancelRun = useMutation({
    mutationFn: () =>
      api<{ view?: SlotIqView }>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/iq-check/run`,
        { method: 'DELETE' }
      ),
    onSuccess: async (res) => {
      toast.success('已取消测智任务')
      await syncAll(res.view)
    },
    onError: (err) => toast.error(iqErrorText(err)),
  })

  const unisolate = useMutation({
    mutationFn: () =>
      api<SlotIqView>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/iq-check/unisolate`,
        { method: 'POST' }
      ),
    onSuccess: async (next) => {
      toast.success('已解除降智隔离并恢复调度')
      await syncAll(next)
    },
    onError: (err) => toast.error(iqErrorText(err)),
  })

  if (!isCodex || !perms.test) return null
  if (query.isLoading || !view || !draft) return null

  const st = view.state
  const summary = view.summary
  const tone = iqStatusTone(st.last_status, {
    running: view.running,
    isolated: view.isolated,
    referenceOnly: st.last_reference_only,
  })
  const busy =
    patchSlot.isPending ||
    resetSlot.isPending ||
    runNow.isPending ||
    cancelRun.isPending ||
    unisolate.isPending
  const efforts = IQ_EFFORTS_BY_BENCHMARK[draft.benchmark]
  const modelOptions = Array.from(
    new Set(
      [
        'gpt-6-astra',
        draft.model,
        ...(modelsQuery.data?.items || []).map((m) => m.id),
      ].filter(Boolean)
    )
  )

  return (
    <div className='grid gap-2 rounded-md border bg-muted/15 px-3 py-2.5 text-xs'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex items-center gap-1.5 font-medium'>
          <Brain className='size-3.5 text-muted-foreground' />
          <span>GPT 测智（满血.AI）</span>
        </div>
        <StatusMark tone={tone} variant='pill' />
      </div>

      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='inline-flex rounded-md border bg-background p-0.5'>
          {MODES.map((m) => (
            <button
              key={m}
              type='button'
              disabled={busy}
              onClick={() => {
                if (m !== view.mode) patchSlot.mutate({ mode: m })
              }}
              className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                view.mode === m
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {IQ_SLOT_MODE_LABELS[m]}
            </button>
          ))}
        </div>

        <div className='flex flex-wrap items-center gap-1'>
          {st.has_artifact ? (
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-7 gap-1 px-2 text-[11px]'
              onClick={() => setPreviewOpen(true)}
            >
              <Eye className='size-3' />
              预览
            </Button>
          ) : null}
          {view.running ? (
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='h-7 gap-1 px-2 text-[11px]'
              disabled={cancelRun.isPending}
              onClick={() => cancelRun.mutate()}
            >
              <Square className='size-3' />
              取消
            </Button>
          ) : (
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='h-7 gap-1 px-2 text-[11px]'
              disabled={busy}
              onClick={() => runNow.mutate()}
            >
              {runNow.isPending ? (
                <Loader2 className='size-3 animate-spin' />
              ) : (
                <Play className='size-3' />
              )}
              立即测智
            </Button>
          )}
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className='h-7 gap-1 px-2 text-[11px]'
            onClick={() => setExpanded((v) => !v)}
          >
            <SlidersHorizontal className='size-3' />
            <span>个性规则</span>
            {view.has_overrides ? (
              <span className='text-[color:var(--status-ok)]'>· 已定制</span>
            ) : null}
            {expanded ? (
              <ChevronDown className='size-3' />
            ) : (
              <ChevronRight className='size-3' />
            )}
          </Button>
        </div>
      </div>

      <div className='flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground'>
        <span>
          {IQ_BENCHMARK_LABELS[view.effective.benchmark]} ·{' '}
          <span className='font-mono'>{view.effective.model}</span> · effort=
          {view.effective.reasoning_effort} · 每 {view.effective.interval_min}{' '}
          分钟
          {view.effective.auto_isolate_on_degraded
            ? ` · 降智 ${view.effective.isolate_threshold} 次自动隔离`
            : ''}
        </span>
        {summary && summary.summary_24h.total > 0 ? (
          <span className='font-mono tabular-nums'>
            24h 满血 {fmtNum(summary.summary_24h.normal)} / 降智{' '}
            {fmtNum(summary.summary_24h.degraded)} / 异常{' '}
            {fmtNum(summary.summary_24h.error)}
          </span>
        ) : null}
      </div>

      {view.isolated ? (
        <div className='flex flex-wrap items-center justify-between gap-2 rounded border border-[color:var(--status-bad-solid)]/40 bg-[color:var(--status-bad-solid)]/10 px-2.5 py-1.5 text-[11px]'>
          <div className='flex items-center gap-1.5 text-[color:var(--status-bad)]'>
            <TriangleAlert className='size-3.5 shrink-0' />
            <span>
              因测智判定降智已自动停止调度隔离
              {st.isolated_at ? `（${fmtAgo(st.isolated_at)}）` : ''}
              ，可先手动复测确认后解除隔离。
            </span>
          </div>
          <Button
            type='button'
            size='sm'
            variant='outline'
            className='h-6 gap-1 px-2 text-[11px]'
            disabled={unisolate.isPending}
            onClick={() => unisolate.mutate()}
          >
            <ShieldCheck className='size-3 text-[color:var(--status-ok)]' />
            解除隔离
          </Button>
        </div>
      ) : null}

      <div className='flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground'>
        <span>
          {st.last_checked_at
            ? `上次：${fmtAgo(st.last_checked_at) || fmtExpiresAt(st.last_checked_at)}（${fmtDurationSec(st.last_duration_ms)}）`
            : '尚未执行测智'}
        </span>
        <span>
          {view.skip_reason
            ? IQ_SKIP_REASON_LABELS[view.skip_reason] || view.skip_reason
            : view.next_run_at && view.effective.enabled
              ? `下次：${fmtExpiresAt(view.next_run_at)}`
              : view.effective.enabled
                ? '等待调度'
                : '定时已关闭'}
        </span>
      </div>

      {st.last_reason ? (
        <div className='rounded bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground'>
          {st.last_reason}
        </div>
      ) : null}

      {expanded ? (
        <div className='space-y-2.5 border-t pt-2.5'>
          <div className='grid gap-2 sm:grid-cols-2'>
            <label className='space-y-1'>
              <span className='text-[11px] text-muted-foreground'>
                检测模式
              </span>
              <Select
                value={draft.benchmark}
                onValueChange={(v: GptIqBenchmark) => {
                  const nextEfforts = IQ_EFFORTS_BY_BENCHMARK[v]
                  setDraft((d) =>
                    d
                      ? {
                          ...d,
                          benchmark: v,
                          reasoning_effort: nextEfforts.includes(
                            d.reasoning_effort
                          )
                            ? d.reasoning_effort
                            : 'low',
                        }
                      : d
                  )
                }}
              >
                <SelectTrigger className='h-8 text-xs'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='pelican'>鹈鹕骑行 (pelican)</SelectItem>
                  <SelectItem value='candy'>糖果检测 (candy)</SelectItem>
                  <SelectItem value='creative'>自由创作 (creative)</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className='space-y-1'>
              <span className='text-[11px] text-muted-foreground'>
                测试模型
              </span>
              <Input
                list={`iq-slot-models-${vm.id}`}
                className='h-8 font-mono text-xs'
                value={draft.model}
                onChange={(e) =>
                  setDraft((d) => (d ? { ...d, model: e.target.value } : d))
                }
              />
              <datalist id={`iq-slot-models-${vm.id}`}>
                {modelOptions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
            <label className='space-y-1'>
              <span className='text-[11px] text-muted-foreground'>
                推理强度
              </span>
              <Select
                value={draft.reasoning_effort}
                onValueChange={(v) =>
                  setDraft((d) => (d ? { ...d, reasoning_effort: v } : d))
                }
              >
                <SelectTrigger className='h-8 text-xs'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {efforts.map((ef) => (
                    <SelectItem key={ef} value={ef}>
                      {ef}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className='space-y-1'>
              <span className='text-[11px] text-muted-foreground'>
                检测间隔（分钟）
              </span>
              <Input
                type='number'
                min={1}
                max={1440}
                className='h-8 font-mono text-xs'
                value={draft.interval_min}
                onChange={(e) =>
                  setDraft((d) =>
                    d ? { ...d, interval_min: e.target.value } : d
                  )
                }
              />
            </label>
            <label className='space-y-1'>
              <span className='text-[11px] text-muted-foreground'>
                服务档位
              </span>
              <Select
                value={draft.service_tier || 'default'}
                onValueChange={(v) =>
                  setDraft((d) =>
                    d
                      ? {
                          ...d,
                          service_tier:
                            v === 'default' ? '' : (v as GptIqServiceTier),
                        }
                      : d
                  )
                }
              >
                <SelectTrigger className='h-8 text-xs'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='default'>默认标准</SelectItem>
                  <SelectItem value='priority'>Fast (priority)</SelectItem>
                  <SelectItem value='ultrafast'>UltraFast</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className='space-y-1'>
              <span className='text-[11px] text-muted-foreground'>
                连续降智隔离阈值（次）
              </span>
              <Input
                type='number'
                min={1}
                max={5}
                className='h-8 font-mono text-xs'
                value={draft.isolate_threshold}
                onChange={(e) =>
                  setDraft((d) =>
                    d ? { ...d, isolate_threshold: e.target.value } : d
                  )
                }
              />
            </label>
          </div>

          <div className='flex flex-wrap items-center justify-between gap-2'>
            <label className='flex items-center gap-2 text-[11px]'>
              <Switch
                checked={draft.auto_isolate_on_degraded}
                onCheckedChange={(v) =>
                  setDraft((d) =>
                    d ? { ...d, auto_isolate_on_degraded: v } : d
                  )
                }
              />
              <span>降智后自动停止调度隔离</span>
            </label>
            <label className='flex items-center gap-2 text-[11px]'>
              <Switch
                checked={draft.isolate_on_reference}
                onCheckedChange={(v) =>
                  setDraft((d) => (d ? { ...d, isolate_on_reference: v } : d))
                }
              />
              <span>「参考」级降智也触发隔离</span>
            </label>
          </div>

          <div className='flex items-center justify-end gap-2 pt-1'>
            {view.has_overrides ? (
              <Button
                type='button'
                size='sm'
                variant='ghost'
                className='h-7 text-[11px]'
                disabled={busy}
                onClick={() => resetSlot.mutate()}
              >
                还原全局默认
              </Button>
            ) : null}
            <Button
              type='button'
              size='sm'
              className='h-7 text-[11px]'
              disabled={busy}
              onClick={() =>
                patchSlot.mutate({
                  overrides: buildSparseOverrides(draft, view),
                })
              }
            >
              保存本槽规则
            </Button>
          </div>
        </div>
      ) : null}

      {st.history.length > 0 ? (
        <div className='border-t pt-1.5'>
          <button
            type='button'
            className='flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground'
            onClick={() => setHistoryOpen((v) => !v)}
          >
            {historyOpen ? (
              <ChevronDown className='size-3' />
            ) : (
              <ChevronRight className='size-3' />
            )}
            最近测智记录（{st.history.length} 条）
          </button>
          {historyOpen ? (
            <div className='mt-1.5 max-h-44 space-y-1 overflow-auto'>
              {st.history.slice(0, 15).map((item, idx) => (
                <div
                  key={`${item.at}-${idx}`}
                  className='flex flex-wrap items-center justify-between gap-2 rounded bg-muted/35 px-2 py-1 text-[11px]'
                >
                  <div className='flex items-center gap-1.5'>
                    <StatusMark
                      tone={iqStatusTone(item.status, {
                        isolated: item.isolated,
                        referenceOnly: item.reference_only,
                      })}
                      variant='pill'
                    />
                    <span className='font-mono text-muted-foreground'>
                      {IQ_BENCHMARK_LABELS[item.benchmark]} · {item.model}
                    </span>
                  </div>
                  <div className='flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground'>
                    <span>{fmtDurationSec(item.duration_ms)}</span>
                    <span>{fmtExpiresAt(item.at)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {st.has_artifact ? (
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
