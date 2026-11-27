import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Activity, KeyRound, ShieldAlert, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtAgo } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import {
  WORKSPACE_POLICY_OPTIONS,
  codexLoginCodeText,
  codexLoginErrorText,
} from './batch-text'
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
  CodexLoginServiceHealth,
  CodexWorkspacePolicy,
} from './types'

type Form = {
  endpoint: string
  service_token: string
  service_token_clear: boolean
  workspace_policy: CodexWorkspacePolicy
  max_concurrency: string
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

function formOf(cfg: CodexLoginServiceConfig): Form {
  return {
    endpoint: cfg.endpoint,
    service_token: '',
    service_token_clear: false,
    workspace_policy: cfg.workspace_policy || 'auto',
    max_concurrency: String(cfg.max_concurrency ?? 4),
    guard_enabled: cfg.guard_enabled,
    guard: Object.fromEntries(
      RULES.map((r) => [r.key, String(cfg.guard[r.key])])
    ) as Form['guard'],
  }
}

function bodyOf(form: Form) {
  return {
    endpoint: form.endpoint.trim(),
    service_token: form.service_token,
    service_token_clear: form.service_token_clear,
    workspace_policy: form.workspace_policy,
    max_concurrency: Number(form.max_concurrency),
    guard_enabled: form.guard_enabled,
    guard: Object.fromEntries(
      RULES.map((r) => [r.key, Number(form.guard[r.key])])
    ),
  }
}

function ServiceForm({ config }: { config: CodexLoginServiceConfig }) {
  const qc = useQueryClient()
  const [form, setForm] = useState<Form>(() => formOf(config))
  const [health, setHealth] = useState<CodexLoginServiceHealth | null>(null)
  useEffect(() => setForm(formOf(config)), [config])

  const save = useMutation({
    mutationFn: () =>
      api<CodexLoginServiceConfig>(`${CODEX_LOGIN_BASE}/service`, {
        method: 'PUT',
        body: JSON.stringify(bodyOf(form)),
      }),
    onSuccess: (data) => {
      qc.setQueryData(codexLoginServiceQueryOptions().queryKey, data)
      setHealth(null)
      toast.success('已保存 GPT 登录设置')
    },
    onError: (error) => toast.error(codexLoginErrorText(error)),
  })

  const checkHealth = useMutation({
    mutationFn: () =>
      api<CodexLoginServiceHealth>(`${CODEX_LOGIN_BASE}/service/check`, {
        method: 'POST',
      }),
    onSuccess: (data) => {
      setHealth(data)
      if (data.ok) {
        toast.success(
          `认证服务就绪${data.readyz?.engine ? `（${data.readyz.engine}）` : ''}`
        )
      } else {
        toast.error(
          codexLoginCodeText(data.error || 'login_service_unreachable')
        )
      }
    },
    onError: (error) => toast.error(codexLoginErrorText(error)),
  })

  const tokenPlaceholder = config.service_token_unreadable
    ? '原密钥无法解密，请重新填写'
    : config.service_token_source === 'config'
      ? '已保存，留空不改'
      : config.service_token_source === 'env'
        ? '当前读取自环境变量 VM2API_CODEX_AUTH_TOKEN，填写将覆盖'
        : '填写 .local/service-token 内容'

  return (
    <>
      <PaneSection
        icon={KeyRound}
        title='认证服务（Callback v2）'
        desc='接入独立 codex-auth-service。认证服务仅执行登录并返回一次性 OAuth 回调，PKCE verifier 与正式令牌始终保存在 vm2api 本地。'
      >
        <div className='flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5'>
          <ShieldAlert
            className='mt-0.5 size-4 shrink-0 text-destructive'
            aria-hidden
          />
          <p>
            服务会接收账号密码、2FA 密钥和槽位代理凭据，只填自建或完全可信的
            codex-auth-service 实例。公网地址必须是 HTTPS；本机或内网可使用
            HTTP。
          </p>
        </div>

        <div className='grid gap-1.5'>
          <label htmlFor='codex-login-endpoint' className='text-sm font-medium'>
            服务地址
          </label>
          <div className='flex flex-wrap gap-2'>
            <Input
              id='codex-login-endpoint'
              className='min-w-64 flex-1 font-mono text-xs'
              value={form.endpoint}
              placeholder='http://127.0.0.1:8788'
              spellCheck={false}
              onChange={(e) =>
                setForm((f) => ({ ...f, endpoint: e.target.value }))
              }
            />
            <Button
              type='button'
              variant='outline'
              size='sm'
              loading={checkHealth.isPending}
              disabled={!config.endpoint || checkHealth.isPending}
              onClick={() => checkHealth.mutate()}
            >
              <Activity className='size-4' /> 检查连通性
            </Button>
          </div>
          <p className='text-xs text-muted-foreground'>
            留空即关闭。填基础地址（如 <code>http://127.0.0.1:8788</code>
            ）或完整 <code>/v2/authenticate</code> 地址均可。连通性检查探{' '}
            <code>/healthz</code> 与 <code>/readyz</code>
            （仅表示本地引擎就绪）。
          </p>
          {health ? (
            <p
              className={
                health.ok
                  ? 'text-xs text-[color:var(--status-ok)]'
                  : 'text-xs text-destructive'
              }
            >
              {health.ok
                ? `已连通：/healthz=${health.healthz?.status ?? 200}，/readyz=${health.readyz?.status ?? 200}${health.readyz?.engine ? `（engine=${health.readyz.engine}）` : ''}`
                : `检查未通过：${codexLoginCodeText(health.error || 'login_service_unreachable')}`}
            </p>
          ) : null}
        </div>

        <div className='grid gap-1.5'>
          <label htmlFor='codex-login-token' className='text-sm font-medium'>
            服务密钥（Bearer Token）
          </label>
          <Input
            id='codex-login-token'
            type='password'
            autoComplete='new-password'
            className='font-mono text-xs'
            value={form.service_token}
            placeholder={tokenPlaceholder}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                service_token: e.target.value,
                service_token_clear: false,
              }))
            }
          />
          {config.service_token_source === 'config' ? (
            <label className='flex items-center gap-2 text-xs text-muted-foreground'>
              <Checkbox
                checked={form.service_token_clear}
                onCheckedChange={(v) =>
                  setForm((f) => ({
                    ...f,
                    service_token_clear: v === true,
                    ...(v === true ? { service_token: '' } : {}),
                  }))
                }
              />
              清除已保存的服务密钥
            </label>
          ) : null}
          {config.service_token_unreadable ? (
            <p className='text-xs text-destructive'>
              数据库密钥已变更导致服务密钥无法解密，请重新填写并保存。
            </p>
          ) : null}
        </div>

        <div className='divide-y'>
          <SettingRow
            label='默认工作区策略'
            desc='首次批量导入或空槽登录时的自动选择偏好；重登默认锁定原工作区 ID。'
          >
            <Select
              value={form.workspace_policy}
              onValueChange={(v) =>
                setForm((f) => ({
                  ...f,
                  workspace_policy: v as CodexWorkspacePolicy,
                }))
              }
            >
              <SelectTrigger className='w-60'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WORKSPACE_POLICY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow
            label='全局登录并发'
            desc='批量导入、单槽登录与重登共用此并发上限（1–512），同代理 IP 自动串行防撞。请按认证服务 AUTH_MAX_CONCURRENCY 与主机内存逐步加压。'
          >
            <Input
              className='w-24'
              inputMode='numeric'
              value={form.max_concurrency}
              onChange={(e) =>
                setForm((f) => ({ ...f, max_concurrency: e.target.value }))
              }
            />
          </SettingRow>
        </div>

        {config.queue || config.egress_summary ? (
          <div className='flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground tabular-nums'>
            {config.queue ? (
              <span>
                队列：执行中 {config.queue.active}/
                {config.queue.max_concurrency}
                {config.queue.queued ? ` · 排队 ${config.queue.queued}` : ''}
                {config.queue.paused_until ? ' · 429 退避中' : ''}
              </span>
            ) : null}
            {config.egress_summary ? (
              <span>
                代理池：可用代理 {config.egress_summary.pool_usable_proxies} 条
                · 空闲绑定名额 {config.egress_summary.pool_free_slots}
              </span>
            ) : null}
          </div>
        ) : null}
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
            VM2API_DB_SECRET：可以一次性登录导入，但不能保存账号密码，自动重登不可用。
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
      desc='批量导入或单槽密码登录时勾选保存密码的槽，或在槽位详情「账号」页登记的槽。'
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
                    {p.state.auto_paused === 'workspace_not_found' ? (
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
                            body: { allow_workspace_reselect: true },
                          })
                        }
                      >
                        重选工作区
                      </Button>
                    ) : p.state.auto_paused && p.auto_relogin ? (
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

/** 设置 →「GPT 登录」：Callback v2 认证服务、失效巡检规则、已登记槽位。自带保存，不走设置页草稿。 */
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
