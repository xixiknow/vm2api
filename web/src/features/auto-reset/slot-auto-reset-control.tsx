import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import {
  ChevronDown,
  ChevronRight,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtAgo } from '@/lib/format'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { StatusMark } from '@/components/status-mark'
import { useVmPerms } from '@/features/vm/vm-perms'
import {
  autoResetErrorText,
  formatAutoResetResult,
  formatPauseReason,
  formatRescuePreviewText,
  formatRuleSummary,
  SLOT_MODE_LABELS,
  slotAutoResetTone,
} from './format'
import {
  autoResetConfigQueryOptions,
  autoResetSlotsQueryOptions,
  vmAutoResetQueryOptions,
} from './queries'
import type {
  AutoResetSlotMode,
  AutoResetTriggerMode,
  CodexAutoResetOverrides,
  SlotAutoResetView,
} from './types'

type OverrideDraft = {
  seven_day: boolean
  five_hour: boolean
  other_window: boolean
  trigger_mode: AutoResetTriggerMode
  prefer_voucher_over_credits: boolean
  smart_expiry_rescue: boolean
  min_reset_remaining_min: string
  cooldown_min: string
  max_per_day: string
  no_card_recheck_min: string
}

function draftFromView(view: SlotAutoResetView): OverrideDraft {
  const eff = view.effective
  return {
    seven_day: eff.triggers.seven_day,
    five_hour: eff.triggers.five_hour,
    other_window: eff.triggers.other_window,
    trigger_mode: eff.trigger_mode,
    prefer_voucher_over_credits: eff.prefer_voucher_over_credits,
    smart_expiry_rescue: eff.smart_expiry_rescue,
    min_reset_remaining_min: String(eff.min_reset_remaining_min),
    cooldown_min: String(eff.cooldown_min),
    max_per_day: String(eff.max_per_day),
    no_card_recheck_min: String(eff.no_card_recheck_min),
  }
}

/** Build a sparse overrides patch containing only fields differing from global defaults (or null to clear). */
function buildSparseOverrides(
  draft: OverrideDraft,
  view: SlotAutoResetView
): Record<string, unknown> {
  const g = view.global_defaults
  const tr: Record<string, boolean | null> = {
    seven_day:
      draft.seven_day === g.triggers.seven_day ? null : draft.seven_day,
    five_hour:
      draft.five_hour === g.triggers.five_hour ? null : draft.five_hour,
    other_window:
      draft.other_window === g.triggers.other_window
        ? null
        : draft.other_window,
  }
  const numOrNull = (raw: string, globalVal: number) => {
    const n = Number(raw)
    if (!Number.isFinite(n)) return n
    return n === globalVal ? null : n
  }
  return {
    triggers: tr,
    trigger_mode:
      draft.trigger_mode === g.trigger_mode ? null : draft.trigger_mode,
    prefer_voucher_over_credits:
      draft.prefer_voucher_over_credits === g.prefer_voucher_over_credits
        ? null
        : draft.prefer_voucher_over_credits,
    smart_expiry_rescue:
      draft.smart_expiry_rescue === g.smart_expiry_rescue
        ? null
        : draft.smart_expiry_rescue,
    min_reset_remaining_min: numOrNull(
      draft.min_reset_remaining_min,
      g.min_reset_remaining_min
    ),
    cooldown_min: numOrNull(draft.cooldown_min, g.cooldown_min),
    max_per_day: numOrNull(draft.max_per_day, g.max_per_day),
    no_card_recheck_min: numOrNull(
      draft.no_card_recheck_min,
      g.no_card_recheck_min
    ),
  }
}

const MODES: AutoResetSlotMode[] = ['inherit', 'enabled', 'disabled']

export function SlotAutoResetControl({ vm }: { vm: Vm }) {
  const perms = useVmPerms()
  const qc = useQueryClient()
  const isCodex = isCodexVm(vm)
  const [expanded, setExpanded] = useState(false)

  const query = useQuery({
    ...vmAutoResetQueryOptions(vm.id),
    enabled: isCodex && perms.credential,
  })
  const view = query.data
  const [draft, setDraft] = useState<OverrideDraft | null>(null)
  useEffect(() => {
    if (view) setDraft(draftFromView(view))
  }, [view])

  const syncCaches = async (next: SlotAutoResetView) => {
    qc.setQueryData(vmAutoResetQueryOptions(vm.id).queryKey, next)
    await Promise.all([
      qc.invalidateQueries({ queryKey: autoResetSlotsQueryOptions().queryKey }),
      qc.invalidateQueries({
        queryKey: autoResetConfigQueryOptions().queryKey,
      }),
    ])
  }

  const patchSlot = useMutation({
    mutationFn: (body: {
      mode?: AutoResetSlotMode
      overrides?: CodexAutoResetOverrides | Record<string, unknown> | null
      resume?: boolean
      clear_backoff?: boolean
    }) =>
      api<SlotAutoResetView>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/auto-reset`,
        {
          method: 'PUT',
          body: JSON.stringify(body),
        }
      ),
    onSuccess: async (next, vars) => {
      await syncCaches(next)
      if (vars.resume) toast.success('已恢复该槽自动重置')
      else if (vars.mode)
        toast.success(`已切换为「${SLOT_MODE_LABELS[vars.mode]}」`)
      else toast.success('已保存本槽个性化自动重置规则')
    },
    onError: (error) => toast.error(autoResetErrorText(error)),
  })

  const resetSlot = useMutation({
    mutationFn: () =>
      api<SlotAutoResetView>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/auto-reset`,
        { method: 'DELETE' }
      ),
    onSuccess: async (next) => {
      await syncCaches(next)
      setExpanded(false)
      toast.success('已还原为跟随全局设置')
    },
    onError: (error) => toast.error(autoResetErrorText(error)),
  })

  if (!isCodex || !perms.credential) return null
  if (query.isLoading || !view || !draft) return null

  const tone = slotAutoResetTone(view.effective, view.state)
  const rescueText = formatRescuePreviewText(
    view.rescue_preview,
    view.effective.smart_expiry_rescue
  )
  const busy = patchSlot.isPending || resetSlot.isPending

  return (
    <div className='grid gap-2 rounded-md border bg-muted/15 px-3 py-2.5 text-xs'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex items-center gap-1.5 font-medium'>
          <RotateCcw className='size-3.5 text-muted-foreground' />
          <span>自动使用重置券</span>
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
              {SLOT_MODE_LABELS[m]}
            </button>
          ))}
        </div>

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

      <div className='text-[11px] text-muted-foreground'>
        {formatRuleSummary(view.effective)}
      </div>

      {rescueText ? (
        <div className='flex items-start gap-1.5 rounded bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground'>
          <Sparkles
            className={`mt-0.5 size-3 shrink-0 ${
              view.rescue_preview?.should_rescue
                ? 'text-[color:var(--status-warn)]'
                : 'text-muted-foreground'
            }`}
          />
          <span>{rescueText}</span>
        </div>
      ) : null}

      {view.state.auto_paused ? (
        <div className='flex flex-wrap items-center justify-between gap-2 rounded bg-[color:var(--status-warn-bg)] px-2.5 py-1.5 text-[11px] text-[color:var(--status-warn)]'>
          <span>已自动暂停：{formatPauseReason(view.state.paused_reason)}</span>
          <Button
            type='button'
            size='sm'
            variant='outline'
            className='h-6 px-2 text-[11px]'
            disabled={busy}
            onClick={() => patchSlot.mutate({ resume: true })}
          >
            恢复自动重置
          </Button>
        </div>
      ) : (
        <div className='flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground'>
          <span className='tabular-nums'>
            今日已自动使用 {view.state.daily_count}
            {view.effective.max_per_day > 0
              ? ` / ${view.effective.max_per_day}`
              : ''}{' '}
            张
          </span>
          <span>
            {view.state.last_reset_at
              ? `上次重置 ${fmtAgo(view.state.last_reset_at)}`
              : formatAutoResetResult(
                  view.state.last_result,
                  view.state.last_error
                )}
          </span>
        </div>
      )}

      {expanded ? (
        <div className='grid gap-2.5 border-t pt-2.5'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <span className='text-[11px] text-muted-foreground'>触发窗口</span>
            <div className='flex flex-wrap items-center gap-3 text-[11px]'>
              <label className='flex items-center gap-1.5'>
                <Checkbox
                  checked={draft.seven_day}
                  onCheckedChange={(v) =>
                    setDraft((d) => (d ? { ...d, seven_day: v === true } : d))
                  }
                />
                <span>7d</span>
              </label>
              <label className='flex items-center gap-1.5'>
                <Checkbox
                  checked={draft.five_hour}
                  onCheckedChange={(v) =>
                    setDraft((d) => (d ? { ...d, five_hour: v === true } : d))
                  }
                />
                <span>5h</span>
              </label>
              <label className='flex items-center gap-1.5'>
                <Checkbox
                  checked={draft.other_window}
                  onCheckedChange={(v) =>
                    setDraft((d) =>
                      d ? { ...d, other_window: v === true } : d
                    )
                  }
                />
                <span>其他</span>
              </label>
            </div>
          </div>

          <div className='flex flex-wrap items-center justify-between gap-2'>
            <span className='text-[11px] text-muted-foreground'>触发门槛</span>
            <div className='flex gap-1'>
              <Button
                type='button'
                size='sm'
                className='h-6 px-2 text-[11px]'
                variant={
                  draft.trigger_mode === 'upstream_limit'
                    ? 'default'
                    : 'outline'
                }
                onClick={() =>
                  setDraft((d) =>
                    d ? { ...d, trigger_mode: 'upstream_limit' } : d
                  )
                }
              >
                真实打满
              </Button>
              <Button
                type='button'
                size='sm'
                className='h-6 px-2 text-[11px]'
                variant={
                  draft.trigger_mode === 'local_gate' ? 'default' : 'outline'
                }
                onClick={() =>
                  setDraft((d) =>
                    d ? { ...d, trigger_mode: 'local_gate' } : d
                  )
                }
              >
                本地闸线
              </Button>
            </div>
          </div>

          <div className='flex items-center justify-between gap-2'>
            <span className='text-[11px] text-muted-foreground'>
              有积分时优先使用重置券
            </span>
            <Switch
              checked={draft.prefer_voucher_over_credits}
              onCheckedChange={(checked) =>
                setDraft((d) =>
                  d ? { ...d, prefer_voucher_over_credits: checked } : d
                )
              }
            />
          </div>

          <div className='flex items-center justify-between gap-2'>
            <span className='text-[11px] text-muted-foreground'>
              临期券动态智能抢救
            </span>
            <Switch
              checked={draft.smart_expiry_rescue}
              onCheckedChange={(checked) =>
                setDraft((d) =>
                  d ? { ...d, smart_expiry_rescue: checked } : d
                )
              }
            />
          </div>

          <div className='grid grid-cols-2 gap-2'>
            <label className='grid gap-1 text-[11px] text-muted-foreground'>
              <span>最小剩余时间（分钟）</span>
              <Input
                type='number'
                min={0}
                max={1440}
                className='h-7 text-xs tabular-nums'
                value={draft.min_reset_remaining_min}
                onChange={(e) =>
                  setDraft((d) =>
                    d ? { ...d, min_reset_remaining_min: e.target.value } : d
                  )
                }
              />
            </label>
            <label className='grid gap-1 text-[11px] text-muted-foreground'>
              <span>每日上限（0=不限）</span>
              <Input
                type='number'
                min={0}
                max={50}
                className='h-7 text-xs tabular-nums'
                value={draft.max_per_day}
                onChange={(e) =>
                  setDraft((d) =>
                    d ? { ...d, max_per_day: e.target.value } : d
                  )
                }
              />
            </label>
            <label className='grid gap-1 text-[11px] text-muted-foreground'>
              <span>冷却时间（分钟）</span>
              <Input
                type='number'
                min={1}
                max={1440}
                className='h-7 text-xs tabular-nums'
                value={draft.cooldown_min}
                onChange={(e) =>
                  setDraft((d) =>
                    d ? { ...d, cooldown_min: e.target.value } : d
                  )
                }
              />
            </label>
            <label className='grid gap-1 text-[11px] text-muted-foreground'>
              <span>无券退避（分钟）</span>
              <Input
                type='number'
                min={5}
                max={1440}
                className='h-7 text-xs tabular-nums'
                value={draft.no_card_recheck_min}
                onChange={(e) =>
                  setDraft((d) =>
                    d ? { ...d, no_card_recheck_min: e.target.value } : d
                  )
                }
              />
            </label>
          </div>

          <div className='flex flex-wrap items-center justify-between gap-2 pt-1'>
            {view.has_overrides ? (
              <Button
                type='button'
                size='sm'
                variant='ghost'
                className='h-7 px-2 text-[11px]'
                disabled={busy}
                onClick={() => resetSlot.mutate()}
              >
                还原跟随全局
              </Button>
            ) : (
              <span className='text-[11px] text-muted-foreground'>
                当前全部字段继承全局
              </span>
            )}
            <Button
              type='button'
              size='sm'
              className='h-7 px-2.5 text-[11px]'
              loading={patchSlot.isPending}
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
    </div>
  )
}
