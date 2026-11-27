import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { StatusMark } from '@/components/status-mark'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  WORKSPACE_POLICY_OPTIONS,
  batchSummary,
  batchTextProblem,
  checkBatchText,
  codexLoginCodeText,
  codexLoginErrorText,
  codexLoginWarningText,
  codexWorkspaceSummary,
  hasRetryableRows,
  rowTone,
} from './batch-text'
import {
  CODEX_LOGIN_BASE,
  codexLoginBatchQueryOptions,
  codexLoginServiceQueryOptions,
} from './queries'
import type { CodexLoginBatch, CodexWorkspacePolicy } from './types'

/** 导入页「批量登录导入」：每行一个账号，仅走代理池自动分配，排队后逐个登录、换票验签并落盘。 */
export function CodexLoginBatchPanel() {
  const qc = useQueryClient()
  const service = useQuery(codexLoginServiceQueryOptions())
  const batchQuery = useQuery(codexLoginBatchQueryOptions())
  // 输入框不进 React 状态：密码只在 DOM 里，提交后立刻清掉。
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [problem, setProblem] = useState('')
  const [pastedCount, setPastedCount] = useState(0)
  const [saveLogin, setSaveLogin] = useState(true)
  const [prefix, setPrefix] = useState('')
  const [policyOverride, setPolicyOverride] = useState<
    CodexWorkspacePolicy | ''
  >('')
  const [confirmClear, setConfirmClear] = useState(false)

  const batch = batchQuery.data ?? null
  const running = batch?.status === 'running'
  const configured = !!service.data?.configured
  const encryption = service.data?.encryption_enabled !== false
  const blockedBySecret = saveLogin && !encryption
  const egress = service.data?.egress_summary ?? null
  const freeSlots = egress?.pool_free_slots ?? null
  const noFreeProxy = service.isSuccess && freeSlots !== null && freeSlots <= 0
  const exceedsFreeSlots =
    freeSlots !== null && freeSlots > 0 && pastedCount > freeSlots
  const effectivePolicy: CodexWorkspacePolicy =
    policyOverride || service.data?.workspace_policy || 'auto'

  // Polling stops when the batch ends: refresh slots and remaining proxy counts.
  const wasRunning = useRef(false)
  useEffect(() => {
    if (running) {
      wasRunning.current = true
      return
    }
    if (!wasRunning.current) return
    wasRunning.current = false
    void qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
    void qc.invalidateQueries({
      queryKey: codexLoginServiceQueryOptions().queryKey,
    })
  }, [running, qc])

  const store = (data: CodexLoginBatch | null) =>
    qc.setQueryData(codexLoginBatchQueryOptions().queryKey, data)
  const refreshAll = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      qc.invalidateQueries({
        queryKey: codexLoginServiceQueryOptions().queryKey,
      }),
    ])

  const start = useMutation({
    gcTime: 0,
    mutationFn: () =>
      api<CodexLoginBatch>(`${CODEX_LOGIN_BASE}/batches`, {
        method: 'POST',
        body: JSON.stringify({
          text: textRef.current?.value || '',
          save_login: saveLogin,
          name_prefix: prefix.trim(),
          workspace_policy: effectivePolicy,
        }),
      }),
    onSuccess: (data) => {
      if (textRef.current) textRef.current.value = ''
      setPastedCount(0)
      store(data)
      toast.success(`已开始导入 ${data.rows.length} 个账号`)
    },
    onError: (error) => toast.error(codexLoginErrorText(error)),
  })

  const action = useMutation({
    mutationFn: ({ path, method }: { path: string; method: string }) =>
      api<CodexLoginBatch | null>(`${CODEX_LOGIN_BASE}/batches/${path}`, {
        method,
      }),
    onSuccess: async (data, vars) => {
      store(vars.method === 'DELETE' ? null : data)
      await refreshAll()
    },
    onError: (error) => toast.error(codexLoginErrorText(error)),
  })

  const submit = () => {
    const check = checkBatchText(textRef.current?.value || '')
    if (!check.ok) {
      setProblem(batchTextProblem(check))
      return
    }
    setProblem('')
    start.mutate()
  }

  const finishedRows = batch
    ? batch.rows.filter((r) => r.status === 'created')
    : []

  return (
    <div className='space-y-5'>
      <p className='max-w-[68ch] text-sm leading-relaxed text-muted-foreground'>
        每行一个 GPT 账号：
        <code className='font-mono'>邮箱----密码----2FA密钥</code> 或{' '}
        <code className='font-mono'>邮箱----密码</code>
        （也可用逗号分隔，无 2FA 可省略第 3 列；2FA 填长期 Base32 密钥或{' '}
        <code className='font-mono'>otpauth://</code>，不是六位验证码）。
        每个账号自动从代理池分配非本机出口，登录、换票与推理走同一代理，已在其他槽里的账号会跳过。
      </p>

      {service.isSuccess && !configured ? (
        <Alert>
          <AlertTitle>还没有配置认证服务</AlertTitle>
          <AlertDescription>
            <span>
              先在{' '}
              <Link
                to='/settings/$tab'
                params={{ tab: 'gptlogin' }}
                className='underline underline-offset-4'
              >
                设置 → GPT 登录
              </Link>{' '}
              填好 Callback v2 认证服务地址与服务密钥。
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      {noFreeProxy ? (
        <Alert variant='destructive'>
          <AlertTitle>代理池没有空闲出口</AlertTitle>
          <AlertDescription>
            <span>
              批量导入要求每个账号绑定代理池中的非本机代理。当前无可用空闲名额，请先前往{' '}
              <Link to='/proxies' className='underline underline-offset-4'>
                代理池
              </Link>{' '}
              添加、启用代理或调大单代理绑定上限。
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      {running ? null : (
        <div className='space-y-4'>
          {egress && !noFreeProxy ? (
            <p className='text-xs text-muted-foreground tabular-nums'>
              当前代理池可用代理 {egress.pool_usable_proxies} 条 ·
              剩余空闲绑定名额 {egress.pool_free_slots} 个（单代理最多{' '}
              {egress.bind_limit}{' '}
              槽；同代理并发登录自动串行防撞，遇到不可达代理本轮自动避让）。
            </p>
          ) : null}
          <Textarea
            ref={textRef}
            className='h-44 font-mono text-[13px] leading-relaxed'
            spellCheck={false}
            autoComplete='off'
            autoCorrect='off'
            autoCapitalize='off'
            aria-label='账号列表'
            placeholder={
              'user1@example.com----密码----JBSWY3DPEHPK3PXP\nuser2@example.com----无2FA密码'
            }
            disabled={start.isPending}
            onChange={(e) => {
              if (problem) setProblem('')
              const checked = checkBatchText(e.target.value)
              setPastedCount(checked.ok ? checked.count : 0)
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit()
            }}
          />
          {problem ? (
            <p className='text-xs text-destructive'>{problem}</p>
          ) : null}
          {exceedsFreeSlots ? (
            <p className='text-xs text-[color:var(--status-warn)]'>
              已粘贴 {pastedCount} 个账号，但代理池仅剩 {freeSlots}{' '}
              个空闲绑定名额；超出部分（除已存在跳过的账号外）将因无空闲出口失败。
            </p>
          ) : null}

          <div className='flex flex-wrap items-end gap-x-6 gap-y-3'>
            <div className='grid gap-1.5'>
              <Label htmlFor='codex-login-prefix'>槽名前缀（可选）</Label>
              <Input
                id='codex-login-prefix'
                className='w-48'
                maxLength={32}
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder='槽名默认用邮箱'
              />
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='codex-batch-workspace-policy'>工作区偏好</Label>
              <Select
                value={effectivePolicy}
                onValueChange={(v) =>
                  setPolicyOverride(v as CodexWorkspacePolicy)
                }
              >
                <SelectTrigger
                  id='codex-batch-workspace-policy'
                  className='w-56'
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
            <label className='flex items-center gap-2 pb-2 text-sm'>
              <Checkbox
                checked={saveLogin}
                onCheckedChange={(v) => setSaveLogin(v === true)}
              />
              保存密码和 2FA，用于失效后自动重登
            </label>
          </div>
          {blockedBySecret ? (
            <p className='text-xs text-destructive'>
              服务端没有配置
              VM2API_DB_SECRET，不能加密保存密码。取消勾选后可以只导入。
            </p>
          ) : null}
          <div className='flex items-center gap-3'>
            <Button
              onClick={submit}
              loading={start.isPending}
              disabled={
                !configured || noFreeProxy || blockedBySecret || start.isPending
              }
            >
              登录并导入
            </Button>
            <span className='text-xs text-muted-foreground'>
              最多 100 个；Ctrl / ⌘ + Enter 提交
            </span>
          </div>
        </div>
      )}

      {batch ? (
        <div className='space-y-3 border-t pt-4'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <div className='space-y-0.5'>
              <p className='text-sm font-medium'>
                {running
                  ? '正在导入'
                  : batch.status === 'canceled'
                    ? '已停止'
                    : '本批完成'}
              </p>
              <p className='text-xs text-muted-foreground tabular-nums'>
                {batchSummary(batch)}
              </p>
            </div>
            <div className='flex flex-wrap gap-2'>
              {running ? (
                <Button
                  size='sm'
                  variant='outline'
                  loading={action.isPending}
                  onClick={() =>
                    action.mutate({
                      path: `${batch.id}/cancel`,
                      method: 'POST',
                    })
                  }
                >
                  停止
                </Button>
              ) : (
                <>
                  {hasRetryableRows(batch) ? (
                    <Button
                      size='sm'
                      loading={action.isPending}
                      onClick={() =>
                        action.mutate({
                          path: `${batch.id}/retry`,
                          method: 'POST',
                        })
                      }
                    >
                      重试未完成
                    </Button>
                  ) : null}
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => setConfirmClear(true)}
                  >
                    清除结果
                  </Button>
                </>
              )}
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className='w-12'>行</TableHead>
                <TableHead>邮箱</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>槽位</TableHead>
                <TableHead>说明</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batch.rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className='text-muted-foreground tabular-nums'>
                    {row.line}
                  </TableCell>
                  <TableCell className='font-mono text-xs'>
                    {row.email}
                  </TableCell>
                  <TableCell>
                    <StatusMark tone={rowTone(row.status, row.stage)} />
                  </TableCell>
                  <TableCell>
                    {row.vm_id ? (
                      <Link
                        to='/vm/$id'
                        params={{ id: row.vm_id }}
                        className='font-mono text-xs underline-offset-4 hover:underline'
                      >
                        {row.vm_id}
                      </Link>
                    ) : (
                      <span className='text-muted-foreground'>—</span>
                    )}
                  </TableCell>
                  <TableCell className='max-w-[28rem] text-xs text-muted-foreground'>
                    {[
                      codexLoginCodeText(row.error, row.detail),
                      row.status === 'created'
                        ? codexWorkspaceSummary(row.workspace)
                        : '',
                      codexLoginWarningText(row.warning),
                    ]
                      .filter(Boolean)
                      .join('；') || null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className='text-xs text-muted-foreground'>
            {running
              ? '批次在服务端运行，离开页面不影响。停止会中断正在进行的登录、取消远端任务并释放空槽与代理。'
              : `结果保留 30 分钟。失败行的密码只在服务端内存里留到过期，「重试未完成」不用重新粘贴。${
                  finishedRows.length ? '已导入的槽在虚拟机列表里。' : ''
                }`}
          </p>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title='清除这批结果？'
        desc='清除后不能再重试未完成的行，内存里的密码一并删掉。已导入的槽位不受影响。'
        confirmText='清除'
        handleConfirm={() => {
          setConfirmClear(false)
          if (batch) action.mutate({ path: batch.id, method: 'DELETE' })
        }}
      />
    </div>
  )
}
