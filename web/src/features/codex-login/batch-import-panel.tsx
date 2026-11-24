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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ChoiceTiles } from '@/components/choice-tiles'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { StatusMark } from '@/components/status-mark'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  batchSummary,
  batchTextProblem,
  checkBatchText,
  codexLoginCodeText,
  codexLoginErrorText,
  codexLoginWarningText,
  hasRetryableRows,
  rowTone,
} from './batch-text'
import {
  CODEX_LOGIN_BASE,
  codexLoginBatchQueryOptions,
  codexLoginServiceQueryOptions,
} from './queries'
import type { CodexLoginBatch } from './types'

type ExitMode = 'pool' | 'local'

const EXIT_CHOICES: { value: ExitMode; title: string; detail: string }[] = [
  {
    value: 'pool',
    title: '代理池自动分配',
    detail: '每个账号分一个空闲 SOCKS5，登录和推理走同一个出口。',
  },
  {
    value: 'local',
    title: '本机出口',
    detail: '走这台机器的网络。没有部署代理时，登录服务会用它自己的 IP。',
  },
]

/** 导入页「批量登录导入」：每行一个账号，服务端逐个登录、建槽、导入。 */
export function CodexLoginBatchPanel() {
  const qc = useQueryClient()
  const service = useQuery(codexLoginServiceQueryOptions())
  const batchQuery = useQuery(codexLoginBatchQueryOptions())
  // 输入框不进 React 状态：密码只在 DOM 里，提交后立刻清掉。
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [problem, setProblem] = useState('')
  const [exitMode, setExitMode] = useState<ExitMode>('pool')
  const [saveLogin, setSaveLogin] = useState(true)
  const [prefix, setPrefix] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)

  const batch = batchQuery.data ?? null
  const running = batch?.status === 'running'
  const configured = !!service.data?.configured
  const encryption = service.data?.encryption_enabled !== false
  const blockedBySecret = saveLogin && !encryption

  // Polling stops when the batch ends: that is the moment new slots exist.
  const wasRunning = useRef(false)
  useEffect(() => {
    if (running) {
      wasRunning.current = true
      return
    }
    if (!wasRunning.current) return
    wasRunning.current = false
    void qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
  }, [running, qc])

  const store = (data: CodexLoginBatch | null) =>
    qc.setQueryData(codexLoginBatchQueryOptions().queryKey, data)
  const refreshSlots = () =>
    qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })

  const start = useMutation({
    gcTime: 0,
    mutationFn: () =>
      api<CodexLoginBatch>(`${CODEX_LOGIN_BASE}/batches`, {
        method: 'POST',
        body: JSON.stringify({
          text: textRef.current?.value || '',
          exit_mode: exitMode,
          save_login: saveLogin,
          name_prefix: prefix.trim(),
        }),
      }),
    onSuccess: (data) => {
      if (textRef.current) textRef.current.value = ''
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
      await refreshSlots()
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
        <code className='font-mono'>邮箱----密码----2FA密钥</code>
        （也可用逗号分隔）。2FA 填长期密钥，不是六位验证码。每个账号建一个新 GPT
        槽，先分配出口，再通过登录服务登录拿令牌。已在某个槽里的账号会跳过。
      </p>

      {service.isSuccess && !configured ? (
        <Alert>
          <AlertTitle>还没有配置登录服务</AlertTitle>
          <AlertDescription>
            <span>
              密码登录交给外部登录服务完成。先在{' '}
              <Link
                to='/settings/$tab'
                params={{ tab: 'gptlogin' }}
                className='underline underline-offset-4'
              >
                设置 → GPT 登录
              </Link>{' '}
              填好服务地址。
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      {running ? null : (
        <div className='space-y-4'>
          <Textarea
            ref={textRef}
            className='h-44 font-mono text-[13px] leading-relaxed'
            spellCheck={false}
            autoComplete='off'
            autoCorrect='off'
            autoCapitalize='off'
            aria-label='账号列表'
            placeholder={'user@example.com----密码----JBSWY3DPEHPK3PXP'}
            disabled={start.isPending}
            onChange={() => problem && setProblem('')}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit()
            }}
          />
          {problem ? (
            <p className='text-xs text-destructive'>{problem}</p>
          ) : null}
          <ChoiceTiles
            label='出口'
            value={exitMode}
            onChange={setExitMode}
            choices={EXIT_CHOICES}
          />
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
              disabled={!configured || blockedBySecret || start.isPending}
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
                    <StatusMark tone={rowTone(row.status)} />
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
              ? '批次在服务端运行，离开页面不影响。停止会中断正在进行的登录并删掉它的空槽。'
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
