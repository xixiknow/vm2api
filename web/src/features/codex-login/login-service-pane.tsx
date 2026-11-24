import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { KeyRound, Plus, ShieldAlert, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtAgo } from '@/lib/format'
import { Button } from '@/components/ui/button'
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
import { ConfirmDialog } from '@/components/confirm-dialog'
import { QueryGate } from '@/components/query-gate'
import { SettingRow } from '@/components/setting-row'
import { StatusMark } from '@/components/status-mark'
import { PaneSection } from '@/features/settings/scheduler-controls'
import { codexLoginCodeText, codexLoginErrorText } from './batch-text'
import { profileTone } from './profile-tone'
import {
  CODEX_LOGIN_BASE,
  codexLoginProfilesQueryOptions,
  codexLoginServiceQueryOptions,
} from './queries'
import type {
  CodexLoginGuardRules,
  CodexLoginProfile,
  CodexLoginServiceConfig,
} from './types'

type HeaderRow = { key: number; name: string; value: string; saved: boolean }
type Form = {
  endpoint: string
  headers: HeaderRow[]
  timeout_min: string
  batch_concurrency: string
  guard_enabled: boolean
  guard: Record<keyof CodexLoginGuardRules, string>
}

const RULES: {
  key: keyof CodexLoginGuardRules
  label: string
  desc: string
}[] = [
  {
    key: 'probe_interval_min',
    label: '巡检间隔（分钟）',
    desc: '凭证正常时多久探一次。',
  },
  {
    key: 'recheck_interval_min',
    label: '复检间隔（分钟）',
    desc: '鉴权失败或网络异常后多久再探。',
  },
  {
    key: 'fail_threshold',
    label: '失效阈值（次）',
    desc: '连续几次鉴权失败才判定失效并重登。',
  },
  {
    key: 'relogin_cooldown_min',
    label: '重登冷却（分钟）',
    desc: '一次自动重登失败后，至少隔多久再试。',
  },
  {
    key: 'max_relogin_failures',
    label: '连续失败上限（次）',
    desc: '达到后暂停该槽自动重登，等人工处理。',
  },
]

let headerSeq = 0

function formOf(cfg: CodexLoginServiceConfig): Form {
  return {
    endpoint: cfg.endpoint,
    headers: cfg.headers.map((h) => ({
      key: ++headerSeq,
      name: h.name,
      value: '',
      saved: !!h.value_set,
    })),
    timeout_min: String(cfg.timeout_min),
    batch_concurrency: String(cfg.batch_concurrency),
    guard_enabled: cfg.guard_enabled,
    guard: Object.fromEntries(
      RULES.map((r) => [r.key, String(cfg.guard[r.key])])
    ) as Form['guard'],
  }
}

function bodyOf(form: Form) {
  return {
    endpoint: form.endpoint.trim(),
    headers: form.headers
      .filter((h) => h.name.trim())
      .map((h) => ({ name: h.name.trim(), value: h.value })),
    timeout_min: Number(form.timeout_min),
    batch_concurrency: Number(form.batch_concurrency),
    guard_enabled: form.guard_enabled,
    guard: Object.fromEntries(
      RULES.map((r) => [r.key, Number(form.guard[r.key])])
    ),
  }
}

function ServiceForm({ config }: { config: CodexLoginServiceConfig }) {
  const qc = useQueryClient()
  const [form, setForm] = useState<Form>(() => formOf(config))
  useEffect(() => setForm(formOf(config)), [config])

  const save = useMutation({
    mutationFn: () =>
      api<CodexLoginServiceConfig>(`${CODEX_LOGIN_BASE}/service`, {
        method: 'PUT',
        body: JSON.stringify(bodyOf(form)),
      }),
    onSuccess: (data) => {
      qc.setQueryData(codexLoginServiceQueryOptions().queryKey, data)
      toast.success('已保存 GPT 登录设置')
    },
    onError: (error) => toast.error(codexLoginErrorText(error)),
  })

  const setHeader = (key: number, patch: Partial<HeaderRow>) =>
    setForm((f) => ({
      ...f,
      headers: f.headers.map((h) => (h.key === key ? { ...h, ...patch } : h)),
    }))

  return (
    <>
      <PaneSection
        icon={KeyRound}
        title='登录服务'
        desc='邮箱 + 密码 + 2FA 的登录交给这个外部服务完成，协议与 sub2api 的重登接口兼容。'
      >
        <div className='flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5'>
          <ShieldAlert
            className='mt-0.5 size-4 shrink-0 text-destructive'
            aria-hidden
          />
          <p>
            服务会拿到账号密码、2FA
            长期密钥和槽位代理的账号密码，拿到就能完全控制账号。只填自建或完全可信的服务。公网地址必须是
            HTTPS。
          </p>
        </div>
        <div className='grid gap-1.5'>
          <label htmlFor='codex-login-endpoint' className='text-sm font-medium'>
            服务地址
          </label>
          <Input
            id='codex-login-endpoint'
            value={form.endpoint}
            placeholder='https://login.example.com/api/v1/relogin'
            spellCheck={false}
            onChange={(e) =>
              setForm((f) => ({ ...f, endpoint: e.target.value }))
            }
          />
          <p className='text-xs text-muted-foreground'>
            留空即关闭。请求体会带上该槽出口的代理地址（<code>proxy</code>{' '}
            字段），服务需用它登录。
          </p>
        </div>
        <div className='space-y-2'>
          <p className='text-sm font-medium'>额外请求头</p>
          {form.headers.map((h) => (
            <div key={h.key} className='flex gap-2'>
              <Input
                className='w-48 font-mono text-xs'
                value={h.name}
                aria-label='请求头名称'
                placeholder='X-Api-Key'
                onChange={(e) => setHeader(h.key, { name: e.target.value })}
              />
              <Input
                className='flex-1 font-mono text-xs'
                type='password'
                autoComplete='new-password'
                value={h.value}
                aria-label='请求头的值'
                placeholder={h.saved ? '已保存，留空不改' : '值，可用 {{uuid}}'}
                onChange={(e) => setHeader(h.key, { value: e.target.value })}
              />
              <Button
                variant='ghost'
                size='icon'
                aria-label='删除请求头'
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    headers: f.headers.filter((x) => x.key !== h.key),
                  }))
                }
              >
                <Trash2 className='size-4' />
              </Button>
            </div>
          ))}
          <Button
            variant='outline'
            size='sm'
            disabled={form.headers.length >= 20}
            onClick={() =>
              setForm((f) => ({
                ...f,
                headers: [
                  ...f.headers,
                  { key: ++headerSeq, name: '', value: '', saved: false },
                ],
              }))
            }
          >
            <Plus className='size-4' /> 添加请求头
          </Button>
        </div>
        <div className='divide-y'>
          <SettingRow
            label='单次登录超时（分钟）'
            desc='登录服务最长可用多久，1–60。'
          >
            <Input
              className='w-24'
              inputMode='numeric'
              value={form.timeout_min}
              onChange={(e) =>
                setForm((f) => ({ ...f, timeout_min: e.target.value }))
              }
            />
          </SettingRow>
          <SettingRow label='批量并发' desc='批量导入时同时登录几个账号，1–8。'>
            <Input
              className='w-24'
              inputMode='numeric'
              value={form.batch_concurrency}
              onChange={(e) =>
                setForm((f) => ({ ...f, batch_concurrency: e.target.value }))
              }
            />
          </SettingRow>
        </div>
      </PaneSection>

      <PaneSection
        icon={ShieldAlert}
        title='失效巡检'
        desc='对开启自动重登的 GPT 槽，经槽位出口拉模型列表（不发付费请求）。刷新令牌也被拒才算失效：出池并自动重登。'
        aside={
          <Switch
            checked={form.guard_enabled}
            aria-label='启用失效巡检'
            onCheckedChange={(v) =>
              setForm((f) => ({ ...f, guard_enabled: v }))
            }
          />
        }
      >
        <div className='divide-y'>
          {RULES.map((rule) => (
            <SettingRow key={rule.key} label={rule.label} desc={rule.desc}>
              <Input
                className='w-24'
                inputMode='numeric'
                value={form.guard[rule.key]}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    guard: { ...f.guard, [rule.key]: e.target.value },
                  }))
                }
              />
            </SettingRow>
          ))}
        </div>
      </PaneSection>

      <div className='flex items-center gap-3'>
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          保存
        </Button>
        {config.encryption_enabled ? null : (
          <span className='text-xs text-destructive'>
            服务端没有配置
            VM2API_DB_SECRET：可以导入，但不能保存密码，自动重登不可用。
          </span>
        )}
      </div>
    </>
  )
}

function ProfilesTable() {
  const qc = useQueryClient()
  const profiles = useQuery(codexLoginProfilesQueryOptions())
  const [removeId, setRemoveId] = useState('')
  const refresh = () =>
    qc.invalidateQueries({
      queryKey: codexLoginProfilesQueryOptions().queryKey,
    })

  const act = useMutation({
    mutationFn: ({
      vmId,
      path = '',
      method,
      body,
    }: {
      vmId: string
      path?: string
      method: string
      body?: unknown
    }) =>
      api(`${CODEX_LOGIN_BASE}/profiles/${encodeURIComponent(vmId)}${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    onSuccess: async (_data, vars) => {
      if (vars.path === '/relogin') toast.success(`${vars.vmId} 已开始重登`)
      await refresh()
    },
    onError: (error) => toast.error(codexLoginErrorText(error)),
  })

  const items = profiles.data?.items ?? []
  return (
    <PaneSection
      icon={Users}
      title='已登记槽位'
      desc='批量导入时勾选保存密码的槽，或在槽位详情「账号」页登记的槽。'
    >
      <QueryGate
        loading={profiles.isLoading}
        error={profiles.error}
        skeleton={null}
      >
        {items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>槽位</TableHead>
                <TableHead>邮箱</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>最近巡检</TableHead>
                <TableHead>最近重登</TableHead>
                <TableHead>自动重登</TableHead>
                <TableHead className='text-right'>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((p: CodexLoginProfile) => (
                <TableRow key={p.vm_id}>
                  <TableCell>
                    <Link
                      to='/vm/$id'
                      params={{ id: p.vm_id }}
                      className='font-mono text-xs underline-offset-4 hover:underline'
                    >
                      {p.vm_id}
                    </Link>
                  </TableCell>
                  <TableCell className='font-mono text-xs'>{p.email}</TableCell>
                  <TableCell>
                    <StatusMark tone={profileTone(p)} />
                  </TableCell>
                  <TableCell className='text-xs text-muted-foreground'>
                    {p.state.last_probe_at
                      ? fmtAgo(p.state.last_probe_at)
                      : '—'}
                  </TableCell>
                  <TableCell className='max-w-[16rem] text-xs text-muted-foreground'>
                    {p.state.last_relogin_at
                      ? `${fmtAgo(p.state.last_relogin_at)} · ${
                          p.state.last_relogin_result === 'ok'
                            ? '成功'
                            : codexLoginCodeText(
                                p.state.last_relogin_error,
                                p.state.last_relogin_detail
                              )
                        }`
                      : '—'}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={p.auto_relogin}
                      aria-label={`${p.vm_id} 自动重登`}
                      disabled={act.isPending}
                      onCheckedChange={(v) =>
                        act.mutate({
                          vmId: p.vm_id,
                          method: 'PUT',
                          body: v ? { resume: true } : { auto_relogin: false },
                        })
                      }
                    />
                  </TableCell>
                  <TableCell className='space-x-1 text-right'>
                    {p.state.auto_paused && p.auto_relogin ? (
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={act.isPending}
                        onClick={() =>
                          act.mutate({
                            vmId: p.vm_id,
                            method: 'PUT',
                            body: { resume: true },
                          })
                        }
                      >
                        恢复
                      </Button>
                    ) : null}
                    <Button
                      size='sm'
                      variant='outline'
                      disabled={
                        act.isPending ||
                        p.relogin.state !== 'idle' ||
                        p.secret_unreadable
                      }
                      onClick={() =>
                        act.mutate({
                          vmId: p.vm_id,
                          path: '/relogin',
                          method: 'POST',
                        })
                      }
                    >
                      立即重登
                    </Button>
                    <Button
                      size='icon'
                      variant='ghost'
                      aria-label={`删除 ${p.vm_id} 的登录资料`}
                      onClick={() => setRemoveId(p.vm_id)}
                    >
                      <Trash2 className='size-4' />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className='text-sm text-muted-foreground'>还没有登记的槽位。</p>
        )}
      </QueryGate>
      <ConfirmDialog
        open={!!removeId}
        onOpenChange={(open) => !open && setRemoveId('')}
        title='删除登录资料？'
        desc='删掉该槽保存的邮箱、密码和 2FA，之后不再巡检和自动重登。槽位和现有凭证不受影响。'
        confirmText='删除'
        destructive
        handleConfirm={() => {
          const vmId = removeId
          setRemoveId('')
          act.mutate({ vmId, method: 'DELETE' })
        }}
      />
    </PaneSection>
  )
}

/** 设置 →「GPT 登录」：登录服务、失效巡检规则、已登记槽位。自带保存，不走设置页草稿。 */
export function CodexLoginPane() {
  const service = useQuery(codexLoginServiceQueryOptions())
  return (
    <div className='space-y-3'>
      <QueryGate
        loading={service.isLoading}
        error={service.error}
        skeleton={null}
      >
        {service.data ? <ServiceForm config={service.data} /> : null}
      </QueryGate>
      <ProfilesTable />
    </div>
  )
}
