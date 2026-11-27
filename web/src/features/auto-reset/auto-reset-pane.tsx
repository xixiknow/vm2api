import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  History,
  RotateCcw,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtAgo } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { QueryGate } from '@/components/query-gate'
import { SettingRow } from '@/components/setting-row'
import { StatusMark } from '@/components/status-mark'
import { PaneSection } from '@/features/settings/scheduler-controls'
import {
  autoResetErrorText,
  formatAutoResetResult,
  formatPauseReason,
  formatRescuePreviewText,
  formatRescueReason,
  formatRuleSummary,
  SLOT_MODE_LABELS,
  slotAutoResetTone,
} from './format'
import {
  AUTO_RESET_BASE,
  autoResetConfigQueryOptions,
  autoResetEventsQueryOptions,
  autoResetSlotsQueryOptions,
  vmAutoResetQueryOptions,
} from './queries'
import type {
  AutoResetConfigPayload,
  AutoResetEvent,
  AutoResetSummary,
  AutoResetTriggerMode,
  CodexAutoResetRule,
  SlotAutoResetSummaryItem,
} from './types'

type CodexForm = {
  enabled: boolean
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

type SlotFilter = 'all' | 'custom' | 'paused' | 'vouchers'

function formFromRule(rule: CodexAutoResetRule): CodexForm {
  return {
    enabled: rule.enabled,
    seven_day: rule.triggers.seven_day,
    five_hour: rule.triggers.five_hour,
    other_window: rule.triggers.other_window,
    trigger_mode: rule.trigger_mode,
    prefer_voucher_over_credits: rule.prefer_voucher_over_credits,
    smart_expiry_rescue: rule.smart_expiry_rescue,
    min_reset_remaining_min: String(rule.min_reset_remaining_min),
    cooldown_min: String(rule.cooldown_min),
    max_per_day: String(rule.max_per_day),
    no_card_recheck_min: String(rule.no_card_recheck_min),
  }
}

function payloadFromForm(form: CodexForm) {
  return {
    codex: {
      enabled: form.enabled,
      triggers: {
        seven_day: form.seven_day,
        five_hour: form.five_hour,
        other_window: form.other_window,
      },
      trigger_mode: form.trigger_mode,
      prefer_voucher_over_credits: form.prefer_voucher_over_credits,
      smart_expiry_rescue: form.smart_expiry_rescue,
      min_reset_remaining_min: Number(form.min_reset_remaining_min),
      cooldown_min: Number(form.cooldown_min),
      max_per_day: Number(form.max_per_day),
      no_card_recheck_min: Number(form.no_card_recheck_min),
    },
  }
}

function SummaryBar({ summary }: { summary: AutoResetSummary }) {
  const stats = [
    { label: 'GPT 槽位', value: `${summary.total_gpt_slots}` },
    {
      label: '已知重置券',
      value: `${summary.total_vouchers} 张（${summary.voucher_slots} 槽）`,
    },
    { label: '动态抢救候选', value: `${summary.rescue_candidate_slots} 槽` },
    { label: '已个性化', value: `${summary.custom_slots} 槽` },
    { label: '已自动暂停', value: `${summary.paused_slots} 槽` },
  ]
  return (
    <div className='grid grid-cols-2 gap-2 sm:grid-cols-5'>
      {stats.map((item) => (
        <div
          key={item.label}
          className='rounded-lg border bg-muted/20 px-3 py-2'
        >
          <div className='text-[11px] text-muted-foreground'>{item.label}</div>
          <div className='mt-0.5 text-sm font-semibold tabular-nums'>
            {item.value}
          </div>
        </div>
      ))}
    </div>
  )
}

function GlobalCodexForm({ data }: { data: AutoResetConfigPayload }) {
  const qc = useQueryClient()
  const [form, setForm] = useState<CodexForm>(() =>
    formFromRule(data.config.codex)
  )
  useEffect(() => setForm(formFromRule(data.config.codex)), [data.config.codex])

  const save = useMutation({
    mutationFn: () =>
      api<AutoResetConfigPayload>(`${AUTO_RESET_BASE}/config`, {
        method: 'PUT',
        body: JSON.stringify(payloadFromForm(form)),
      }),
    onSuccess: async (saved) => {
      qc.setQueryData(autoResetConfigQueryOptions().queryKey, saved)
      await qc.invalidateQueries({
        queryKey: autoResetSlotsQueryOptions().queryKey,
      })
      toast.success('已保存 GPT 自动重置设置')
    },
    onError: (error) => toast.error(autoResetErrorText(error)),
  })

  return (
    <PaneSection
      icon={RotateCcw}
      title='GPT（Codex）自动使用重置券'
      desc='在额度耗尽时自动消费上游重置券恢复槽位。全局默认关闭，可在任意 GPT 槽详情页个性化覆盖。'
    >
      <div className='space-y-4'>
        <SummaryBar summary={data.summary} />

        <div className='flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5'>
          <ShieldAlert
            className='mt-0.5 size-4 shrink-0 text-destructive'
            aria-hidden
          />
          <p className='m-0'>
            上游重置券消耗后<strong>不可退回</strong>
            。系统在每次消费前都会经槽位 SOCKS5
            实时复核最新额度、积分余额与可用券数，并在消费后强制冷却，防止回读延迟导致连烧。
          </p>
        </div>

        <div className='divide-y'>
          <SettingRow
            label='全局开启 GPT 自动重置'
            desc='开启后，所有模式为「跟随全局」的 GPT 槽位都会按下方规则自动消费重置券；单个槽位仍可强制关闭或覆写规则。'
          >
            <Switch
              checked={form.enabled}
              onCheckedChange={(checked) =>
                setForm((f) => ({ ...f, enabled: checked }))
              }
            />
          </SettingRow>

          <SettingRow
            label='常规触发窗口'
            desc='建议只开 7d 周额度（默认关闭 5h 防止短窗口浪费重置券）；临期券可由下方动态抢救自动接管。'
          >
            <div className='flex flex-wrap items-center gap-4 text-sm'>
              <label className='flex items-center gap-2'>
                <Checkbox
                  checked={form.seven_day}
                  onCheckedChange={(v) =>
                    setForm((f) => ({ ...f, seven_day: v === true }))
                  }
                />
                <span>7 天（7d）</span>
              </label>
              <label className='flex items-center gap-2'>
                <Checkbox
                  checked={form.five_hour}
                  onCheckedChange={(v) =>
                    setForm((f) => ({ ...f, five_hour: v === true }))
                  }
                />
                <span>5 小时（5h）</span>
              </label>
              <label className='flex items-center gap-2'>
                <Checkbox
                  checked={form.other_window}
                  onCheckedChange={(v) =>
                    setForm((f) => ({ ...f, other_window: v === true }))
                  }
                />
                <span>其他窗口（如 24h）</span>
              </label>
            </div>
          </SettingRow>

          <SettingRow
            label='触发门槛'
            desc='仅真实打满会在窗口达 100% 或收到上游 429 时触发；若 OpenAI 本地闸线低于 100%，可选达本地闸线即触发。'
          >
            <div className='flex flex-wrap gap-2'>
              <Button
                type='button'
                size='sm'
                variant={
                  form.trigger_mode === 'upstream_limit' ? 'default' : 'outline'
                }
                onClick={() =>
                  setForm((f) => ({ ...f, trigger_mode: 'upstream_limit' }))
                }
              >
                仅上游真实打满（推荐）
              </Button>
              <Button
                type='button'
                size='sm'
                variant={
                  form.trigger_mode === 'local_gate' ? 'default' : 'outline'
                }
                onClick={() =>
                  setForm((f) => ({ ...f, trigger_mode: 'local_gate' }))
                }
              >
                达到本地闸线
              </Button>
            </div>
          </SettingRow>

          <SettingRow
            label='有 Codex 积分余额时优先使用重置券'
            desc='开启后，即使账号还有可用 Codex 积分余额，7d 满额也会优先消耗重置券恢复套餐额度、保住积分；关闭则先耗积分再烧券。'
          >
            <Switch
              checked={form.prefer_voucher_over_credits}
              onCheckedChange={(checked) =>
                setForm((f) => ({ ...f, prefer_voucher_over_credits: checked }))
              }
            />
          </SettingRow>

          <SettingRow
            label='临期券动态智能抢救'
            desc='不写死固定小时数：结合券的过期时间、5h/7d 实际消耗速度与 5h/7d 自然重置时间动态计算；当推算券在过期前无法靠 7d 满消耗完（或过期早于 5h 恢复 / 下次 5h 打满）时，趁本次 5h 满额自动抢救消费。'
          >
            <Switch
              checked={form.smart_expiry_rescue}
              onCheckedChange={(checked) =>
                setForm((f) => ({ ...f, smart_expiry_rescue: checked }))
              }
            />
          </SettingRow>

          <SettingRow
            label='距自然重置最小剩余时间（分钟）'
            desc='受限窗口距离自然刷新小于该时间时跳过等待自然恢复（0 = 不限；券在本次 5h 恢复前就将过期的必废兜底不受此限制）。'
          >
            <Input
              type='number'
              min={0}
              max={1440}
              className='w-28 text-right tabular-nums'
              value={form.min_reset_remaining_min}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  min_reset_remaining_min: e.target.value,
                }))
              }
            />
          </SettingRow>

          <SettingRow
            label='单槽冷却时间（分钟）'
            desc='同一槽两次自动消费至少间隔 N 分钟；即便消费后回读额度失败也会强制冷却，杜绝连烧。'
          >
            <Input
              type='number'
              min={1}
              max={1440}
              className='w-28 text-right tabular-nums'
              value={form.cooldown_min}
              onChange={(e) =>
                setForm((f) => ({ ...f, cooldown_min: e.target.value }))
              }
            />
          </SettingRow>

          <SettingRow
            label='单槽每日上限（张）'
            desc='按北京时间自然日限制单槽最多自动消耗张数，0 表示不限制。'
          >
            <Input
              type='number'
              min={0}
              max={50}
              className='w-28 text-right tabular-nums'
              value={form.max_per_day}
              onChange={(e) =>
                setForm((f) => ({ ...f, max_per_day: e.target.value }))
              }
            />
          </SettingRow>

          <SettingRow
            label='无券重查退避（分钟）'
            desc='查到暂无可用重置券后，N 分钟内不再重复查询上游；在槽位手动点「刷新额度和积分」会立即清除退避。'
          >
            <Input
              type='number'
              min={5}
              max={1440}
              className='w-28 text-right tabular-nums'
              value={form.no_card_recheck_min}
              onChange={(e) =>
                setForm((f) => ({ ...f, no_card_recheck_min: e.target.value }))
              }
            />
          </SettingRow>
        </div>

        <div className='flex items-center justify-end gap-2 border-t pt-3'>
          <Button
            type='button'
            size='sm'
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            保存全局配置
          </Button>
        </div>
      </div>
    </PaneSection>
  )
}

function SlotsOverviewSection({
  items,
}: {
  items: SlotAutoResetSummaryItem[]
}) {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<SlotFilter>('all')

  const refresh = async (vmId: string) => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: autoResetSlotsQueryOptions().queryKey }),
      qc.invalidateQueries({
        queryKey: autoResetConfigQueryOptions().queryKey,
      }),
      qc.invalidateQueries({
        queryKey: vmAutoResetQueryOptions(vmId).queryKey,
      }),
    ])
  }

  const resume = useMutation({
    mutationFn: (vmId: string) =>
      api(`/api/panel/vms/${encodeURIComponent(vmId)}/auto-reset`, {
        method: 'PUT',
        body: JSON.stringify({ resume: true }),
      }),
    onSuccess: async (_, vmId) => {
      await refresh(vmId)
      toast.success('已恢复该槽自动重置')
    },
    onError: (err) => toast.error(autoResetErrorText(err)),
  })

  const resetInherit = useMutation({
    mutationFn: (vmId: string) =>
      api(`/api/panel/vms/${encodeURIComponent(vmId)}/auto-reset`, {
        method: 'DELETE',
      }),
    onSuccess: async (_, vmId) => {
      await refresh(vmId)
      toast.success('已恢复跟随全局')
    },
    onError: (err) => toast.error(autoResetErrorText(err)),
  })

  const filtered = items.filter((item) => {
    if (filter === 'custom') return item.has_overrides
    if (filter === 'paused') return item.state.auto_paused
    if (filter === 'vouchers')
      return (item.voucher_summary?.available_count || 0) > 0
    return true
  })

  const filters: { id: SlotFilter; label: string }[] = [
    { id: 'all', label: `全部 (${items.length})` },
    {
      id: 'vouchers',
      label: `持券 (${items.filter((i) => (i.voucher_summary?.available_count || 0) > 0).length})`,
    },
    {
      id: 'custom',
      label: `已个性化 (${items.filter((i) => i.has_overrides).length})`,
    },
    {
      id: 'paused',
      label: `已暂停 (${items.filter((i) => i.state.auto_paused).length})`,
    },
  ]

  return (
    <PaneSection
      icon={SlidersHorizontal}
      title='GPT 槽位个性化与状态总览'
      desc='点击槽位名称可进入详情页调整该槽的三态开关与个性规则。'
    >
      <div className='space-y-3'>
        <div className='flex flex-wrap gap-1.5'>
          {filters.map((f) => (
            <Button
              key={f.id}
              type='button'
              size='sm'
              variant={filter === f.id ? 'default' : 'outline'}
              className='h-7 text-xs'
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </Button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <p className='m-0 py-4 text-center text-xs text-muted-foreground'>
            当前筛选条件下没有 GPT 槽位。
          </p>
        ) : (
          <div className='overflow-x-auto rounded-md border'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>槽位</TableHead>
                  <TableHead>状态 / 模式</TableHead>
                  <TableHead>重置券与动态评估</TableHead>
                  <TableHead>生效规则</TableHead>
                  <TableHead>今日 / 最近</TableHead>
                  <TableHead className='text-right'>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((item) => {
                  const tone = slotAutoResetTone(item.effective, item.state)
                  const rescueText = formatRescuePreviewText(
                    item.rescue_preview,
                    item.effective.smart_expiry_rescue
                  )
                  const count = item.voucher_summary?.available_count ?? 0
                  return (
                    <TableRow key={item.vm_id}>
                      <TableCell className='font-medium'>
                        <Link
                          to='/vm/$id'
                          params={{ id: item.vm_id }}
                          className='hover:underline'
                        >
                          {item.vm_name}
                        </Link>
                        <div className='font-mono text-[11px] text-muted-foreground'>
                          {item.vm_id}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className='flex flex-col items-start gap-1'>
                          <StatusMark tone={tone} variant='pill' />
                          <span className='text-[11px] text-muted-foreground'>
                            {SLOT_MODE_LABELS[item.mode]}
                            {item.has_overrides ? ' · 已覆写' : ''}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className='max-w-xs'>
                        <div className='text-xs font-medium tabular-nums'>
                          {item.voucher_summary?.known
                            ? `${count} 张`
                            : '未查询'}
                          {item.rescue_preview?.should_rescue ? (
                            <span className='ml-1.5 inline-flex items-center gap-0.5 text-[11px] text-[color:var(--status-warn)]'>
                              <Sparkles className='size-3' />
                              需临期抢救
                            </span>
                          ) : null}
                        </div>
                        {rescueText ? (
                          <div className='mt-0.5 text-[11px] text-muted-foreground'>
                            {rescueText}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className='max-w-xs text-[11px] text-muted-foreground'>
                        {formatRuleSummary(item.effective)}
                      </TableCell>
                      <TableCell className='text-xs'>
                        <div className='tabular-nums'>
                          今日 {item.state.daily_count}
                          {item.effective.max_per_day > 0
                            ? ` / ${item.effective.max_per_day}`
                            : ''}{' '}
                          张
                        </div>
                        <div className='text-[11px] text-muted-foreground'>
                          {item.state.auto_paused
                            ? formatPauseReason(item.state.paused_reason)
                            : formatAutoResetResult(
                                item.state.last_result,
                                item.state.last_error
                              )}
                        </div>
                      </TableCell>
                      <TableCell className='text-right'>
                        <div className='flex justify-end gap-1.5'>
                          {item.state.auto_paused ? (
                            <Button
                              type='button'
                              size='sm'
                              variant='outline'
                              className='h-7 text-xs'
                              disabled={resume.isPending}
                              onClick={() => resume.mutate(item.vm_id)}
                            >
                              恢复
                            </Button>
                          ) : null}
                          {item.has_overrides ? (
                            <Button
                              type='button'
                              size='sm'
                              variant='ghost'
                              className='h-7 text-xs'
                              disabled={resetInherit.isPending}
                              onClick={() => resetInherit.mutate(item.vm_id)}
                            >
                              还原继承
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </PaneSection>
  )
}

function EventsSection({ items }: { items: AutoResetEvent[] }) {
  return (
    <PaneSection
      icon={History}
      title='最近自动重置记录'
      desc='保留最近 50 条真实触发、临期抢救与异常暂停审计记录。'
    >
      {items.length === 0 ? (
        <p className='m-0 py-4 text-center text-xs text-muted-foreground'>
          暂无自动重置记录。
        </p>
      ) : (
        <div className='overflow-x-auto rounded-md border'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>槽位</TableHead>
                <TableHead>触发方式</TableHead>
                <TableHead>结果</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((ev, idx) => (
                <TableRow key={`${ev.at}-${ev.vm_id}-${idx}`}>
                  <TableCell
                    className='text-xs whitespace-nowrap tabular-nums'
                    title={new Date(ev.at).toLocaleString()}
                  >
                    {fmtAgo(ev.at)}
                  </TableCell>
                  <TableCell className='text-xs font-medium'>
                    <Link
                      to='/vm/$id'
                      params={{ id: ev.vm_id }}
                      className='hover:underline'
                    >
                      {ev.vm_name || ev.vm_id}
                    </Link>
                  </TableCell>
                  <TableCell className='text-xs'>
                    <span>{ev.trigger_window || '—'}</span>
                    {ev.rescue ? (
                      <span className='ml-1.5 rounded bg-[color:var(--status-warn-bg)] px-1.5 py-0.5 text-[11px] text-[color:var(--status-warn)]'>
                        临期抢救
                        {ev.rescue_tier ? ` T${ev.rescue_tier}` : ''}
                      </span>
                    ) : null}
                    {ev.rescue_reason ? (
                      <div className='mt-0.5 text-[11px] text-muted-foreground'>
                        {formatRescueReason(ev.rescue_reason)}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className='text-xs'>
                    <StatusMark
                      variant='pill'
                      tone={
                        ev.outcome === 'reset'
                          ? { key: 'ok', text: '已重置', cls: 'ok' }
                          : ev.outcome === 'reset_refresh_failed'
                            ? {
                                key: 'warn',
                                text: '已消费（回读失败）',
                                cls: 'warn',
                              }
                            : ev.outcome === 'paused'
                              ? {
                                  key: 'paused',
                                  text: '已自动暂停',
                                  cls: 'bad',
                                }
                              : { key: 'failed', text: '失败', cls: 'bad' }
                      }
                    />
                    {ev.error ? (
                      <div className='mt-0.5 text-[11px] text-muted-foreground'>
                        {ev.error}
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PaneSection>
  )
}

export function AutoResetPane() {
  const cfgQuery = useQuery(autoResetConfigQueryOptions())
  const slotsQuery = useQuery(autoResetSlotsQueryOptions())
  const eventsQuery = useQuery(autoResetEventsQueryOptions())

  return (
    <div className='space-y-4'>
      <QueryGate loading={cfgQuery.isLoading} error={cfgQuery.error}>
        {cfgQuery.data ? <GlobalCodexForm data={cfgQuery.data} /> : null}
      </QueryGate>

      <QueryGate loading={slotsQuery.isLoading} error={slotsQuery.error}>
        {slotsQuery.data ? (
          <SlotsOverviewSection items={slotsQuery.data.items} />
        ) : null}
      </QueryGate>

      <QueryGate loading={eventsQuery.isLoading} error={eventsQuery.error}>
        {eventsQuery.data ? (
          <EventsSection items={eventsQuery.data.items} />
        ) : null}
      </QueryGate>
    </div>
  )
}
