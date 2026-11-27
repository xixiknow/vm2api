import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { proxyNamedLabel } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { StatusMark } from '@/components/status-mark'
import { dashboardQueryOptions } from '@/features/overview/queries'
import type { CommitResult } from '@/features/vm/credential-panel'
import { vmQueryOptions } from '@/features/vm/queries'
import {
  WORKSPACE_POLICY_OPTIONS,
  codexAuthStageText,
  codexLoginCodeText,
  codexLoginErrorText,
  codexLoginWarningText,
  codexWorkspaceSummary,
} from './batch-text'
import {
  CODEX_LOGIN_BASE,
  codexLoginProfilesQueryOptions,
  codexLoginServiceQueryOptions,
  codexSlotLoginQueryOptions,
} from './queries'
import type { CodexSlotLoginTask, CodexWorkspacePolicy } from './types'

/**
 * 单槽 GPT 密码登录表单（Callback v2）。
 * 复用于「导入 → 上线一台」「槽位详情 → 导入凭证」「虚拟机列表 → 重新授权弹窗」。
 * 密码与 2FA 不进 React 状态，提交后立即清空。
 */
export function CodexSlotPasswordLoginForm({
  vm,
  onCommitted,
}: {
  vm: Vm
  onCommitted?: (data: CommitResult, vmId: string, what: string) => void
}) {
  const qc = useQueryClient()
  const service = useQuery(codexLoginServiceQueryOptions())
  const taskQuery = useQuery(codexSlotLoginQueryOptions(vm.id))
  const [email, setEmail] = useState(vm.email || '')
  const [saveLogin, setSaveLogin] = useState(true)
  const [policyOverride, setPolicyOverride] = useState<
    CodexWorkspacePolicy | ''
  >('')
  const passwordRef = useRef<HTMLInputElement>(null)
  const totpRef = useRef<HTMLInputElement>(null)
  const handledTaskId = useRef('')

  const task = taskQuery.data ?? null
  const inFlight = task?.state === 'queued' || task?.state === 'running'
  const configured = !!service.data?.configured
  const encryption = service.data?.encryption_enabled !== false
  const effectiveSave = saveLogin && encryption
  const effectivePolicy: CodexWorkspacePolicy =
    policyOverride || service.data?.workspace_policy || 'auto'
  const proxyHint = vm.proxy?.host ? proxyNamedLabel(vm.proxy) : ''

  useEffect(() => {
    setEmail(vm.email || '')
    handledTaskId.current = ''
  }, [vm.id, vm.email])

  useEffect(() => {
    if (!task?.id || task.id === handledTaskId.current) return
    if (task.state !== 'ok') return
    handledTaskId.current = task.id
    void Promise.all([
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
      qc.invalidateQueries({
        queryKey: codexLoginProfilesQueryOptions().queryKey,
      }),
    ])
    const warn = codexLoginWarningText(task.warning)
    const msg = warn ? `已完成 GPT 密码登录（${warn}）` : '已完成 GPT 密码登录'
    toast.success(msg)
    onCommitted?.(
      (task.commit_result || {}) as CommitResult,
      vm.id,
      '已完成 GPT 密码登录'
    )
  }, [task, vm.id, qc, onCommitted])

  const start = useMutation({
    gcTime: 0,
    mutationFn: (allowWorkspaceReselect: boolean) =>
      api<CodexSlotLoginTask>(
        `${CODEX_LOGIN_BASE}/slots/${encodeURIComponent(vm.id)}/login`,
        {
          method: 'POST',
          body: JSON.stringify({
            email: email.trim(),
            password: passwordRef.current?.value || '',
            totp_secret: totpRef.current?.value || '',
            workspace_policy: effectivePolicy,
            save_login: effectiveSave,
            allow_workspace_reselect: allowWorkspaceReselect,
          }),
        }
      ),
    onSuccess: (data) => {
      if (passwordRef.current) passwordRef.current.value = ''
      if (totpRef.current) totpRef.current.value = ''
      qc.setQueryData(codexSlotLoginQueryOptions(vm.id).queryKey, data)
      toast.success('已开始 GPT 密码登录')
    },
    onError: (error) => toast.error(codexLoginErrorText(error)),
  })

  const cancel = useMutation({
    mutationFn: () =>
      api<CodexSlotLoginTask>(
        `${CODEX_LOGIN_BASE}/slots/${encodeURIComponent(vm.id)}/login/cancel`,
        { method: 'POST' }
      ),
    onSuccess: (data) => {
      qc.setQueryData(codexSlotLoginQueryOptions(vm.id).queryKey, data)
    },
    onError: (error) => toast.error(codexLoginErrorText(error)),
  })

  if (service.isSuccess && !configured) {
    return (
      <p className='text-xs text-muted-foreground'>
        还没有配置认证服务，请先在{' '}
        <Link
          to='/settings/$tab'
          params={{ tab: 'gptlogin' }}
          className='underline underline-offset-4'
        >
          设置 → GPT 登录
        </Link>{' '}
        填写 Callback v2 服务地址与服务密钥。
      </p>
    )
  }

  return (
    <form
      className='space-y-3'
      onSubmit={(e) => {
        e.preventDefault()
        start.mutate(false)
      }}
    >
      <p className='text-xs text-muted-foreground'>
        通过当前槽位代理{proxyHint ? `（${proxyHint}）` : ''}
        直接完成登录、换票与 OIDC/JWKS 验签。
      </p>

      <div className='grid gap-1.5'>
        <Label htmlFor={`codex-slot-login-email-${vm.id}`}>邮箱</Label>
        <Input
          id={`codex-slot-login-email-${vm.id}`}
          type='email'
          autoComplete='off'
          disabled={inFlight || start.isPending}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder='account@example.com'
        />
      </div>

      <div className='grid gap-1.5'>
        <Label htmlFor={`codex-slot-login-pw-${vm.id}`}>密码</Label>
        <Input
          id={`codex-slot-login-pw-${vm.id}`}
          ref={passwordRef}
          type='password'
          autoComplete='new-password'
          disabled={inFlight || start.isPending}
          placeholder='提交后立即清空，不回显'
        />
      </div>

      <div className='grid gap-1.5'>
        <Label htmlFor={`codex-slot-login-totp-${vm.id}`}>
          2FA 长期密钥（可选）
        </Label>
        <Input
          id={`codex-slot-login-totp-${vm.id}`}
          ref={totpRef}
          type='password'
          autoComplete='off'
          spellCheck={false}
          disabled={inFlight || start.isPending}
          placeholder='无 2FA 可留空；支持 Base32 或 otpauth://'
        />
      </div>

      <div className='grid gap-1.5'>
        <Label htmlFor={`codex-slot-login-policy-${vm.id}`}>工作区偏好</Label>
        <Select
          value={effectivePolicy}
          disabled={inFlight || start.isPending}
          onValueChange={(v) => setPolicyOverride(v as CodexWorkspacePolicy)}
        >
          <SelectTrigger
            id={`codex-slot-login-policy-${vm.id}`}
            className='w-full sm:w-64'
          >
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
      </div>

      <label className='flex items-center gap-2 text-xs'>
        <Checkbox
          checked={effectiveSave}
          disabled={!encryption || inFlight || start.isPending}
          onCheckedChange={(v) => setSaveLogin(v === true)}
        />
        <span>
          保存密码和 2FA，用于失效后自动重登
          {!encryption ? '（需配置 VM2API_DB_SECRET，不勾选可一次性登录）' : ''}
        </span>
      </label>

      {task && task.state !== 'idle' ? (
        <div className='space-y-1.5 rounded-md border px-3 py-2 text-xs'>
          <div className='flex items-center justify-between gap-2'>
            <StatusMark
              tone={
                task.state === 'ok'
                  ? { key: 'ok', text: '登录成功', cls: 'ok' }
                  : task.state === 'failed'
                    ? { key: 'failed', text: '登录失败', cls: 'bad' }
                    : task.state === 'canceled'
                      ? { key: 'canceled', text: '已取消', cls: 'off' }
                      : task.state === 'queued'
                        ? { key: 'queued', text: '排队等待名额', cls: 'warn' }
                        : {
                            key: 'running',
                            text: task.stage
                              ? `登录中 · ${codexAuthStageText(task.stage)}`
                              : '登录中',
                            cls: 'warn',
                          }
              }
            />
            {inFlight ? (
              <Button
                type='button'
                size='sm'
                variant='ghost'
                className='h-6 px-2 text-xs'
                loading={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                取消
              </Button>
            ) : null}
          </div>
          {task.state === 'failed' && task.error ? (
            <p className='text-destructive'>
              {codexLoginCodeText(task.error, task.detail)}
            </p>
          ) : null}
          {task.state === 'ok' && task.workspace ? (
            <p className='text-muted-foreground'>
              工作区：{codexWorkspaceSummary(task.workspace)}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className='flex flex-wrap items-center gap-2'>
        <Button
          type='submit'
          size='sm'
          loading={start.isPending || inFlight}
          disabled={!email.trim() || start.isPending || inFlight}
        >
          {inFlight ? '登录中…' : '密码登录并写入'}
        </Button>
        {task?.state === 'failed' && task.error === 'workspace_not_found' ? (
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={!email.trim() || start.isPending || inFlight}
            onClick={() => start.mutate(true)}
          >
            自动重选工作区并登录
          </Button>
        ) : null}
      </div>
    </form>
  )
}
