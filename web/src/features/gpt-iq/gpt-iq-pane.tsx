import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Brain,
  CheckCircle2,
  Eye,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtAgo, fmtExpiresAt, fmtNum } from '@/lib/format'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { StatusMark } from '@/components/status-mark'
import { vmsListQueryOptions } from '@/features/vm/queries'
import {
  fmtDurationSec,
  IQ_BENCHMARK_HINTS,
  IQ_BENCHMARK_LABELS,
  IQ_EFFORTS_BY_BENCHMARK,
  IQ_SKIP_REASON_LABELS,
  IQ_SLOT_MODE_LABELS,
  iqErrorText,
  iqStatusTone,
} from './format'
import { IqPreviewDialog } from './iq-preview-dialog'
import {
  GPT_IQ_BASE,
  gptIqConfigQueryOptions,
  gptIqEventsQueryOptions,
  gptIqModelsQueryOptions,
  gptIqSlotsQueryOptions,
} from './queries'
import type {
  GptIqBenchmark,
  GptIqConfig,
  GptIqConfigPayload,
  GptIqServiceTier,
  GptIqSlotMode,
} from './types'

type ConfigDraft = {
  enabled: boolean
  api_base_url: string
  callback_base_url: string
  benchmark: GptIqBenchmark
  model: string
  reasoning_effort: string
  service_tier: GptIqServiceTier
  interval_min: string
  concurrency: string
  min_gap_sec: string
  timeout_sec: string
  auto_isolate_on_degraded: boolean
  isolate_threshold: string
  isolate_on_reference: boolean
  skip_unschedulable: boolean
  skip_quota_pct: string
}

function draftFromConfig(cfg: GptIqConfig): ConfigDraft {
  return {
    enabled: cfg.enabled,
    api_base_url: cfg.api_base_url,
    callback_base_url: cfg.callback_base_url,
    benchmark: cfg.benchmark,
    model: cfg.model,
    reasoning_effort: cfg.reasoning_effort,
    service_tier: cfg.service_tier,
    interval_min: String(cfg.interval_min),
    concurrency: String(cfg.concurrency),
    min_gap_sec: String(cfg.min_gap_sec),
    timeout_sec: String(cfg.timeout_sec),
    auto_isolate_on_degraded: cfg.auto_isolate_on_degraded,
    isolate_threshold: String(cfg.isolate_threshold),
    isolate_on_reference: cfg.isolate_on_reference,
    skip_unschedulable: cfg.skip_unschedulable,
    skip_quota_pct: String(cfg.skip_quota_pct),
  }
}

const MODES: GptIqSlotMode[] = ['inherit', 'enabled', 'disabled']

export function GptIqPane() {
  const qc = useQueryClient()
  const cfgQuery = useQuery(gptIqConfigQueryOptions())
  const slotsQuery = useQuery(gptIqSlotsQueryOptions())
  const eventsQuery = useQuery(gptIqEventsQueryOptions())
  const modelsQuery = useQuery(gptIqModelsQueryOptions())
  const [draft, setDraft] = useState<ConfigDraft | null>(null)
  const [previewTarget, setPreviewTarget] = useState<{
    id: string
    name: string
  } | null>(null)

  useEffect(() => {
    if (cfgQuery.data?.config) {
      setDraft(draftFromConfig(cfgQuery.data.config))
    }
  }, [cfgQuery.data?.config])

  const invalidateAll = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: gptIqConfigQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: gptIqSlotsQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: gptIqEventsQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
    ])

  const saveConfig = useMutation({
    mutationFn: (d: ConfigDraft) =>
      api<GptIqConfigPayload>(`${GPT_IQ_BASE}/config`, {
        method: 'PUT',
        body: JSON.stringify({
          enabled: d.enabled,
          api_base_url: d.api_base_url.trim(),
          callback_base_url: d.callback_base_url.trim(),
          benchmark: d.benchmark,
          model: d.model.trim(),
          reasoning_effort: d.reasoning_effort,
          service_tier: d.service_tier,
          interval_min: Number(d.interval_min),
          concurrency: Number(d.concurrency),
          min_gap_sec: Number(d.min_gap_sec),
          timeout_sec: Number(d.timeout_sec),
          auto_isolate_on_degraded: d.auto_isolate_on_degraded,
          isolate_threshold: Number(d.isolate_threshold),
          isolate_on_reference: d.isolate_on_reference,
          skip_unschedulable: d.skip_unschedulable,
          skip_quota_pct: Number(d.skip_quota_pct),
        }),
      }),
    onSuccess: async (saved) => {
      qc.setQueryData(gptIqConfigQueryOptions().queryKey, saved)
      toast.success('已保存 GPT 测智配置')
      await invalidateAll()
    },
    onError: (err) => toast.error(iqErrorText(err)),
  })

  const switchSlotMode = useMutation({
    mutationFn: ({ vmId, mode }: { vmId: string; mode: GptIqSlotMode }) =>
      api(`/api/panel/vms/${encodeURIComponent(vmId)}/iq-check`, {
        method: 'PUT',
        body: JSON.stringify({ mode }),
      }),
    onSuccess: async (_, vars) => {
      toast.success(
        `已将 ${vars.vmId} 切换为「${IQ_SLOT_MODE_LABELS[vars.mode]}」`
      )
      await invalidateAll()
    },
    onError: (err) => toast.error(iqErrorText(err)),
  })

  const runSlot = useMutation({
    mutationFn: (vmId: string) =>
      api(`/api/panel/vms/${encodeURIComponent(vmId)}/iq-check/run`, {
        method: 'POST',
      }),
    onSuccess: async (_, vmId) => {
      toast.success(`已发起 ${vmId} 测智任务`)
      await invalidateAll()
    },
    onError: (err) => toast.error(iqErrorText(err)),
  })

  const cancelSlot = useMutation({
    mutationFn: (vmId: string) =>
      api(`/api/panel/vms/${encodeURIComponent(vmId)}/iq-check/run`, {
        method: 'DELETE',
      }),
    onSuccess: async (_, vmId) => {
      toast.success(`已取消 ${vmId} 测智任务`)
      await invalidateAll()
    },
    onError: (err) => toast.error(iqErrorText(err)),
  })

  const unisolateSlot = useMutation({
    mutationFn: (vmId: string) =>
      api(`/api/panel/vms/${encodeURIComponent(vmId)}/iq-check/unisolate`, {
        method: 'POST',
      }),
    onSuccess: async (_, vmId) => {
      toast.success(`已解除 ${vmId} 降智隔离`)
      await invalidateAll()
    },
    onError: (err) => toast.error(iqErrorText(err)),
  })

  if (cfgQuery.isLoading || !draft) {
    return (
      <Card>
        <CardContent className='py-8 text-center text-sm text-muted-foreground'>
          正在加载 GPT 测智配置…
        </CardContent>
      </Card>
    )
  }

  const data = cfgQuery.data
  const summary = slotsQuery.data?.summary ?? data?.summary
  const slots = slotsQuery.data?.items ?? []
  const events = eventsQuery.data?.items ?? []
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
    <div className='space-y-4'>
      <Card>
        <CardHeader className='pb-3'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <div>
              <CardTitle className='flex items-center gap-2 text-base'>
                <Brain className='size-4' />
                GPT 测智（满血.AI 桥接）
              </CardTitle>
              <CardDescription className='mt-1 text-xs'>
                通过一次性单槽桥接直接调用{' '}
                <span className='font-mono'>manxue.ai/api/v1/tests</span>{' '}
                定时检测 GPT 账号是否降智，降智后可自动停止调度隔离账号。
              </CardDescription>
            </div>
            <div className='flex items-center gap-2'>
              <span className='text-xs text-muted-foreground'>
                全局定时开关
              </span>
              <Switch
                aria-label='启用 GPT 全局定时测智'
                checked={draft.enabled}
                onCheckedChange={(v) =>
                  setDraft((d) => (d ? { ...d, enabled: v } : d))
                }
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className='space-y-4'>
          {summary ? (
            <div className='grid grid-cols-2 gap-2 sm:grid-cols-5'>
              <div className='rounded-md border bg-muted/20 px-3 py-2'>
                <div className='text-[11px] text-muted-foreground'>
                  已开启槽位
                </div>
                <div className='font-mono text-sm font-bold tabular-nums'>
                  {summary.enabled_slots} / {summary.total_codex_slots}
                </div>
              </div>
              <div className='rounded-md border bg-muted/20 px-3 py-2'>
                <div className='text-[11px] text-muted-foreground'>
                  24h 满血
                </div>
                <div className='font-mono text-sm font-bold text-[color:var(--status-ok)] tabular-nums'>
                  {fmtNum(summary.normal_24h)}
                </div>
              </div>
              <div className='rounded-md border bg-muted/20 px-3 py-2'>
                <div className='text-[11px] text-muted-foreground'>
                  24h 降智
                </div>
                <div
                  className={`font-mono text-sm font-bold tabular-nums ${summary.degraded_24h > 0 ? 'text-[color:var(--status-bad)]' : ''}`}
                >
                  {fmtNum(summary.degraded_24h)}
                </div>
              </div>
              <div className='rounded-md border bg-muted/20 px-3 py-2'>
                <div className='text-[11px] text-muted-foreground'>
                  当前已隔离
                </div>
                <div
                  className={`font-mono text-sm font-bold tabular-nums ${summary.isolated_slots > 0 ? 'text-[color:var(--status-bad)]' : ''}`}
                >
                  {fmtNum(summary.isolated_slots)}
                </div>
              </div>
              <div className='rounded-md border bg-muted/20 px-3 py-2'>
                <div className='text-[11px] text-muted-foreground'>执行中</div>
                <div className='font-mono text-sm font-bold tabular-nums'>
                  {fmtNum(summary.running_slots)}
                </div>
              </div>
            </div>
          ) : null}

          <div
            className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
              data?.callback_ready
                ? 'border-[color:var(--status-ok-solid)]/35 bg-[color:var(--status-ok-solid)]/8 text-foreground'
                : 'border-[color:var(--status-warn-solid)]/45 bg-[color:var(--status-warn-solid)]/10 text-foreground'
            }`}
          >
            {data?.callback_ready ? (
              <CheckCircle2 className='mt-0.5 size-4 shrink-0 text-[color:var(--status-ok)]' />
            ) : (
              <TriangleAlert className='mt-0.5 size-4 shrink-0 text-[color:var(--status-warn)]' />
            )}
            <div className='space-y-0.5'>
              <div className='font-medium'>
                {data?.callback_ready
                  ? `公网 HTTPS 回调就绪：${data.effective_callback_base_url}`
                  : '尚未配置有效的公网 HTTPS 回调地址'}
              </div>
              <div className='text-[11px] text-muted-foreground'>
                桥接模式每次任务在内存中签发一次性随机路径（
                <span className='font-mono'>
                  /api/manxue-bridge/&lt;nonce&gt;/responses
                </span>
                ）与临时密钥，仅钉选单个 GPT 槽位，任务结束后立即作废。
                {data?.detected_callback_base_url
                  ? ` 留空时自动回落使用环境变量 PUBLIC_BASE_URL（${data.detected_callback_base_url}）。`
                  : ' 当前未检测到 https:// 开头的 PUBLIC_BASE_URL，请在下方填写您的公网 HTTPS 域名。'}
              </div>
            </div>
          </div>

          <div className='grid gap-3 sm:grid-cols-2'>
            <div className='space-y-1.5'>
              <Label htmlFor='iq-callback-base'>
                公网 HTTPS 回调根地址（本网关外网地址）
              </Label>
              <Input
                id='iq-callback-base'
                className='font-mono text-xs'
                placeholder={
                  data?.detected_callback_base_url ||
                  'https://gateway.example.com'
                }
                value={draft.callback_base_url}
                onChange={(e) =>
                  setDraft((d) =>
                    d ? { ...d, callback_base_url: e.target.value } : d
                  )
                }
              />
            </div>

            <div className='space-y-1.5'>
              <Label htmlFor='iq-api-base'>满血 API 地址</Label>
              <Input
                id='iq-api-base'
                className='font-mono text-xs'
                placeholder='https://manxue.ai'
                value={draft.api_base_url}
                onChange={(e) =>
                  setDraft((d) =>
                    d ? { ...d, api_base_url: e.target.value } : d
                  )
                }
              />
            </div>

            <div className='space-y-1.5'>
              <Label>检测模式（默认鹈鹕骑行）</Label>
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
                <SelectTrigger className='text-xs'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='pelican'>鹈鹕骑行 (pelican)</SelectItem>
                  <SelectItem value='candy'>糖果检测 (candy)</SelectItem>
                  <SelectItem value='creative'>自由创作 (creative)</SelectItem>
                </SelectContent>
              </Select>
              <p className='text-[11px] text-muted-foreground'>
                {IQ_BENCHMARK_HINTS[draft.benchmark]}
              </p>
            </div>

            <div className='space-y-1.5'>
              <Label htmlFor='iq-model'>测试模型</Label>
              <Input
                id='iq-model'
                list='iq-global-models'
                className='font-mono text-xs'
                value={draft.model}
                onChange={(e) =>
                  setDraft((d) => (d ? { ...d, model: e.target.value } : d))
                }
              />
              <datalist id='iq-global-models'>
                {modelOptions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <p className='text-[11px] text-muted-foreground'>
                manxue 分类器基于 <span className='font-mono'>gpt-6-astra</span>{' '}
                训练；其它模型结果将标注为「参考」。
              </p>
            </div>

            <div className='space-y-1.5'>
              <Label>推理强度 (reasoning_effort)</Label>
              <Select
                value={draft.reasoning_effort}
                onValueChange={(v) =>
                  setDraft((d) => (d ? { ...d, reasoning_effort: v } : d))
                }
              >
                <SelectTrigger className='text-xs'>
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
            </div>

            <div className='space-y-1.5'>
              <Label>服务档位 (service_tier)</Label>
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
                <SelectTrigger className='text-xs'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='default'>默认标准</SelectItem>
                  <SelectItem value='priority'>Fast (priority)</SelectItem>
                  <SelectItem value='ultrafast'>UltraFast</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className='grid gap-3 border-t pt-3 sm:grid-cols-4'>
            <div className='space-y-1'>
              <Label htmlFor='iq-interval' className='text-xs'>
                单账号间隔（分钟）
              </Label>
              <Input
                id='iq-interval'
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
            </div>
            <div className='space-y-1'>
              <Label htmlFor='iq-conc' className='text-xs'>
                全局并发上限
              </Label>
              <Input
                id='iq-conc'
                type='number'
                min={1}
                max={10}
                className='h-8 font-mono text-xs'
                value={draft.concurrency}
                onChange={(e) =>
                  setDraft((d) =>
                    d ? { ...d, concurrency: e.target.value } : d
                  )
                }
              />
            </div>
            <div className='space-y-1'>
              <Label htmlFor='iq-gap' className='text-xs'>
                提交最小间隔（秒）
              </Label>
              <Input
                id='iq-gap'
                type='number'
                min={0}
                max={300}
                className='h-8 font-mono text-xs'
                value={draft.min_gap_sec}
                onChange={(e) =>
                  setDraft((d) =>
                    d ? { ...d, min_gap_sec: e.target.value } : d
                  )
                }
              />
            </div>
            <div className='space-y-1'>
              <Label htmlFor='iq-timeout' className='text-xs'>
                单次超时（秒）
              </Label>
              <Input
                id='iq-timeout'
                type='number'
                min={60}
                max={600}
                className='h-8 font-mono text-xs'
                value={draft.timeout_sec}
                onChange={(e) =>
                  setDraft((d) =>
                    d ? { ...d, timeout_sec: e.target.value } : d
                  )
                }
              />
            </div>
          </div>

          <div className='grid gap-3 border-t pt-3 sm:grid-cols-2'>
            <div className='space-y-2.5'>
              <label className='flex items-center justify-between gap-3 rounded-md border bg-muted/15 px-3 py-2 text-xs'>
                <div>
                  <div className='font-medium'>降智后自动停止调度隔离账号</div>
                  <div className='text-[11px] text-muted-foreground'>
                    标记为「不可调度 ·
                    测智降智隔离」移出生产池并暂停该槽定时测智
                  </div>
                </div>
                <Switch
                  checked={draft.auto_isolate_on_degraded}
                  onCheckedChange={(v) =>
                    setDraft((d) =>
                      d ? { ...d, auto_isolate_on_degraded: v } : d
                    )
                  }
                />
              </label>
              <label className='flex items-center justify-between gap-3 rounded-md border bg-muted/15 px-3 py-2 text-xs'>
                <div>
                  <div className='font-medium'>「参考」级降智也自动隔离</div>
                  <div className='text-[11px] text-muted-foreground'>
                    默认关闭：非 gpt-6-astra 模型的参考结果仅告警不隔离
                  </div>
                </div>
                <Switch
                  checked={draft.isolate_on_reference}
                  onCheckedChange={(v) =>
                    setDraft((d) => (d ? { ...d, isolate_on_reference: v } : d))
                  }
                />
              </label>
            </div>

            <div className='space-y-2.5'>
              <div className='grid grid-cols-2 gap-2'>
                <div className='space-y-1'>
                  <Label htmlFor='iq-threshold' className='text-xs'>
                    连续降智隔离阈值（次）
                  </Label>
                  <Input
                    id='iq-threshold'
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
                </div>
                <div className='space-y-1'>
                  <Label htmlFor='iq-quota-skip' className='text-xs'>
                    高配额跳过阈值（%，0=不限）
                  </Label>
                  <Input
                    id='iq-quota-skip'
                    type='number'
                    min={0}
                    max={100}
                    className='h-8 font-mono text-xs'
                    value={draft.skip_quota_pct}
                    onChange={(e) =>
                      setDraft((d) =>
                        d ? { ...d, skip_quota_pct: e.target.value } : d
                      )
                    }
                  />
                </div>
              </div>
              <label className='flex items-center justify-between gap-3 rounded-md border bg-muted/15 px-3 py-2 text-xs'>
                <div>
                  <div className='font-medium'>
                    定时跳过非调度 / 休息时段槽位
                  </div>
                  <div className='text-[11px] text-muted-foreground'>
                    手动点击「立即测智」不受此限制，随时可对已隔离账号复测
                  </div>
                </div>
                <Switch
                  checked={draft.skip_unschedulable}
                  onCheckedChange={(v) =>
                    setDraft((d) => (d ? { ...d, skip_unschedulable: v } : d))
                  }
                />
              </label>
            </div>
          </div>

          <div className='flex items-center justify-end gap-2 border-t pt-3'>
            <Button
              type='button'
              size='sm'
              disabled={saveConfig.isPending}
              onClick={() => saveConfig.mutate(draft)}
            >
              {saveConfig.isPending ? '保存中…' : '保存测智配置'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className='pb-2'>
          <div className='flex items-center justify-between gap-2'>
            <div>
              <CardTitle className='text-sm'>GPT 槽位测智总览</CardTitle>
              <CardDescription className='text-xs'>
                逐个控制开启/关闭测智，查看 24h
                结果、预览作品或手动复测/解除隔离
              </CardDescription>
            </div>
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='h-7 gap-1 px-2 text-xs'
              onClick={() => void invalidateAll()}
            >
              <RefreshCw className='size-3' />
              刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {slots.length === 0 ? (
            <p className='py-4 text-center text-xs text-muted-foreground'>
              当前没有 GPT（Codex）槽位
            </p>
          ) : (
            <div className='overflow-x-auto'>
              <table className='w-full text-xs'>
                <thead>
                  <tr className='border-b text-left text-[11px] text-muted-foreground'>
                    <th className='py-1.5 pr-2 font-medium'>槽位</th>
                    <th className='py-1.5 pr-2 font-medium'>开关模式</th>
                    <th className='py-1.5 pr-2 font-medium'>最新结论</th>
                    <th className='py-1.5 pr-2 font-medium'>
                      24h 满血 / 降智 / 异常
                    </th>
                    <th className='py-1.5 pr-2 font-medium'>最近检测 / 状态</th>
                    <th className='py-1.5 text-right font-medium'>操作</th>
                  </tr>
                </thead>
                <tbody className='divide-y'>
                  {slots.map((row) => {
                    const s = row.summary
                    const tone = iqStatusTone(s.status, {
                      running: s.running,
                      isolated: row.isolated,
                      referenceOnly: s.reference_only,
                    })
                    return (
                      <tr key={row.vm_id}>
                        <td className='py-2 pr-2'>
                          <div className='font-mono font-medium'>
                            {row.vm_name}
                          </div>
                          <div className='text-[11px] text-muted-foreground'>
                            {row.email || row.vm_id}
                          </div>
                        </td>
                        <td className='py-2 pr-2'>
                          <div className='inline-flex rounded border bg-background p-0.5'>
                            {MODES.map((m) => (
                              <button
                                key={m}
                                type='button'
                                disabled={switchSlotMode.isPending}
                                onClick={() => {
                                  if (m !== row.mode)
                                    switchSlotMode.mutate({
                                      vmId: row.vm_id,
                                      mode: m,
                                    })
                                }}
                                className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${
                                  row.mode === m
                                    ? 'bg-primary text-primary-foreground'
                                    : 'text-muted-foreground hover:text-foreground'
                                }`}
                              >
                                {IQ_SLOT_MODE_LABELS[m]}
                              </button>
                            ))}
                          </div>
                        </td>
                        <td className='py-2 pr-2'>
                          <StatusMark tone={tone} variant='pill' />
                        </td>
                        <td className='py-2 pr-2 font-mono tabular-nums'>
                          <span className='text-[color:var(--status-ok)]'>
                            {s.summary_24h.normal}
                          </span>
                          {' / '}
                          <span
                            className={
                              s.summary_24h.degraded > 0
                                ? 'font-bold text-[color:var(--status-bad)]'
                                : 'text-muted-foreground'
                            }
                          >
                            {s.summary_24h.degraded}
                          </span>
                          {' / '}
                          <span className='text-muted-foreground'>
                            {s.summary_24h.error}
                          </span>
                        </td>
                        <td className='py-2 pr-2 text-[11px] text-muted-foreground'>
                          <div>
                            {s.last_checked_at
                              ? `${fmtAgo(s.last_checked_at) || fmtExpiresAt(s.last_checked_at)} · ${IQ_BENCHMARK_LABELS[s.benchmark]}`
                              : '未执行'}
                          </div>
                          {row.skip_reason ? (
                            <div className='text-[10.5px]'>
                              {IQ_SKIP_REASON_LABELS[row.skip_reason] ||
                                row.skip_reason}
                            </div>
                          ) : null}
                        </td>
                        <td className='py-2 text-right whitespace-nowrap'>
                          <div className='inline-flex items-center gap-1'>
                            {s.has_artifact ? (
                              <Button
                                type='button'
                                size='sm'
                                variant='ghost'
                                className='h-7 gap-1 px-2 text-[11px]'
                                onClick={() =>
                                  setPreviewTarget({
                                    id: row.vm_id,
                                    name: row.vm_name,
                                  })
                                }
                              >
                                <Eye className='size-3' />
                                预览
                              </Button>
                            ) : null}
                            {row.isolated ? (
                              <Button
                                type='button'
                                size='sm'
                                variant='outline'
                                className='h-7 gap-1 px-2 text-[11px]'
                                disabled={unisolateSlot.isPending}
                                onClick={() => unisolateSlot.mutate(row.vm_id)}
                              >
                                <ShieldCheck className='size-3 text-[color:var(--status-ok)]' />
                                解除隔离
                              </Button>
                            ) : null}
                            {s.running ? (
                              <Button
                                type='button'
                                size='sm'
                                variant='outline'
                                className='h-7 gap-1 px-2 text-[11px]'
                                disabled={cancelSlot.isPending}
                                onClick={() => cancelSlot.mutate(row.vm_id)}
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
                                disabled={runSlot.isPending}
                                onClick={() => runSlot.mutate(row.vm_id)}
                              >
                                {runSlot.isPending &&
                                runSlot.variables === row.vm_id ? (
                                  <Loader2 className='size-3 animate-spin' />
                                ) : (
                                  <Play className='size-3' />
                                )}
                                测智
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>最近测智与隔离事件</CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className='py-3 text-center text-xs text-muted-foreground'>
              暂无测智记录
            </p>
          ) : (
            <div className='max-h-64 space-y-1.5 overflow-auto text-xs'>
              {events.slice(0, 40).map((ev, idx) => (
                <div
                  key={`${ev.at}-${ev.vm_id}-${idx}`}
                  className='flex flex-wrap items-center justify-between gap-2 rounded border bg-muted/20 px-2.5 py-1.5'
                >
                  <div className='flex flex-wrap items-center gap-2'>
                    <span className='font-mono font-medium'>
                      {ev.vm_name || ev.vm_id}
                    </span>
                    <StatusMark
                      tone={
                        ev.outcome === 'isolated'
                          ? { key: 'isolated', text: '降智已隔离', cls: 'bad' }
                          : ev.outcome === 'recovered'
                            ? {
                                key: 'recovered',
                                text: '已解除隔离',
                                cls: 'ok',
                              }
                            : ev.outcome === 'rate_limited'
                              ? { key: 'rl', text: '上游限流退避', cls: 'warn' }
                              : iqStatusTone(
                                  ev.outcome as
                                    'normal' | 'degraded' | 'unknown' | 'error',
                                  { referenceOnly: ev.reference_only }
                                )
                      }
                      variant='pill'
                    />
                    {ev.benchmark ? (
                      <span className='font-mono text-[11px] text-muted-foreground'>
                        {IQ_BENCHMARK_LABELS[ev.benchmark]} · {ev.model}
                      </span>
                    ) : null}
                    {ev.reason || ev.error ? (
                      <span className='max-w-md truncate text-[11px] text-muted-foreground'>
                        {ev.reason || ev.error}
                      </span>
                    ) : null}
                  </div>
                  <div className='flex items-center gap-2 font-mono text-[11px] text-muted-foreground'>
                    {ev.duration_ms != null ? (
                      <span>{fmtDurationSec(ev.duration_ms)}</span>
                    ) : null}
                    <span>{fmtExpiresAt(ev.at)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {previewTarget ? (
        <IqPreviewDialog
          vmId={previewTarget.id}
          vmName={previewTarget.name}
          open={Boolean(previewTarget)}
          onOpenChange={(open) => {
            if (!open) setPreviewTarget(null)
          }}
        />
      ) : null}
    </div>
  )
}
