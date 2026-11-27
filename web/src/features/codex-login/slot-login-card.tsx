import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtAgo } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { StatusMark } from '@/components/status-mark'
import {
  codexAuthStageText,
  codexLoginCodeText,
  codexLoginErrorText,
} from './batch-text'
import { profileTone } from './profile-tone'
import {
  CODEX_LOGIN_BASE,
  codexLoginProfilesQueryOptions,
  codexLoginServiceQueryOptions,
} from './queries'
import type { CodexLoginProfile } from './types'

function ProfileForm({
  vmId,
  profile,
  encryption,
  onDone,
}: {
  vmId: string
  profile: CodexLoginProfile | null
  encryption: boolean
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [email, setEmail] = useState(profile?.email || '')
  const [auto, setAuto] = useState(profile?.auto_relogin ?? true)
  const [clearTotp, setClearTotp] = useState(false)
  // 密码与 2FA 不进 React 状态，保存成功后清空。
  const passwordRef = useRef<HTMLInputElement>(null)
  const totpRef = useRef<HTMLInputElement>(null)

  const save = useMutation({
    gcTime: 0,
    mutationFn: () =>
      api<CodexLoginProfile>(
        `${CODEX_LOGIN_BASE}/profiles/${encodeURIComponent(vmId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            email,
            password: passwordRef.current?.value || '',
            totp_secret: totpRef.current?.value || '',
            totp_clear: clearTotp,
            auto_relogin: auto,
          }),
        }
      ),
    onSuccess: async () => {
      if (passwordRef.current) passwordRef.current.value = ''
      if (totpRef.current) totpRef.current.value = ''
      toast.success('已保存登录资料')
      await qc.invalidateQueries({
        queryKey: codexLoginProfilesQueryOptions().queryKey,
      })
      onDone()
    },
    onError: (error) => toast.error(codexLoginErrorText(error)),
  })

  return (
    <form
      className='space-y-3'
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <div className='grid gap-1.5'>
        <Label htmlFor={`codex-login-email-${vmId}`}>邮箱</Label>
        <Input
          id={`codex-login-email-${vmId}`}
          type='email'
          autoComplete='off'
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className='grid gap-1.5'>
        <Label htmlFor={`codex-login-password-${vmId}`}>密码</Label>
        <Input
          id={`codex-login-password-${vmId}`}
          ref={passwordRef}
          type='password'
          autoComplete='new-password'
          placeholder={
            profile?.password_set ? '已保存，留空不改（换邮箱须重填）' : ''
          }
        />
      </div>
      <div className='grid gap-1.5'>
        <Label htmlFor={`codex-login-totp-${vmId}`}>2FA 长期密钥</Label>
        <Input
          id={`codex-login-totp-${vmId}`}
          ref={totpRef}
          type='password'
          autoComplete='off'
          spellCheck={false}
          placeholder={
            profile?.totp_set ? '已保存，留空不改' : '可选，不是六位验证码'
          }
        />
      </div>
      <div className='flex flex-wrap gap-x-6 gap-y-2 text-sm'>
        {profile?.totp_set ? (
          <label className='flex items-center gap-2'>
            <Checkbox
              checked={clearTotp}
              onCheckedChange={(v) => setClearTotp(v === true)}
            />
            清除已保存的 2FA
          </label>
        ) : null}
        <label className='flex items-center gap-2'>
          <Checkbox
            checked={auto}
            onCheckedChange={(v) => setAuto(v === true)}
          />
          失效后自动重登
        </label>
      </div>
      {encryption ? null : (
        <p className='text-xs text-destructive'>
          服务端没有配置 VM2API_DB_SECRET，不能保存密码。
        </p>
      )}
      <div className='flex gap-2'>
        <Button
          type='submit'
          size='sm'
          loading={save.isPending}
          disabled={!encryption}
        >
          保存
        </Button>
        {profile ? (
          <Button type='button' size='sm' variant='ghost' onClick={onDone}>
            取消
          </Button>
        ) : null}
      </div>
    </form>
  )
}

/** 槽位详情「账号」页（GPT 槽，admin）：保存账号密码，失效时自动重新登录。 */
export function CodexLoginSlotCard({ vmId }: { vmId: string }) {
  const qc = useQueryClient()
  const profiles = useQuery(codexLoginProfilesQueryOptions())
  const service = useQuery(codexLoginServiceQueryOptions())
  const [editing, setEditing] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const profile = profiles.data?.items.find((p) => p.vm_id === vmId) ?? null
  const encryption = service.data?.encryption_enabled !== false
  const refresh = () =>
    qc.invalidateQueries({
      queryKey: codexLoginProfilesQueryOptions().queryKey,
    })

  const act = useMutation({
    mutationFn: ({
      path = '',
      method,
      body,
    }: {
      path?: string
      method: string
      body?: unknown
    }) =>
      api(`${CODEX_LOGIN_BASE}/profiles/${encodeURIComponent(vmId)}${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    onSuccess: async (_data, vars) => {
      if (vars.path === '/relogin') toast.success('已开始重登')
      await refresh()
    },
    onError: (error) => toast.error(codexLoginErrorText(error)),
  })

  if (profiles.isLoading) return null
  const state = profile?.state

  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>密码登录</CardTitle>
        <p className='text-xs text-muted-foreground'>
          保存这个 GPT 账号的邮箱、密码和
          2FA。凭证失效时经本槽出口自动重新登录。
        </p>
      </CardHeader>
      <CardContent className='space-y-3 pt-0'>
        {service.isSuccess && !service.data.configured ? (
          <p className='text-xs text-muted-foreground'>
            还没有配置登录服务，先在{' '}
            <Link
              to='/settings/$tab'
              params={{ tab: 'gptlogin' }}
              className='underline underline-offset-4'
            >
              设置 → GPT 登录
            </Link>{' '}
            填好。
          </p>
        ) : null}
        {!profile || editing ? (
          <ProfileForm
            key={profile?.updated_at || 'new'}
            vmId={vmId}
            profile={profile}
            encryption={encryption}
            onDone={() => setEditing(false)}
          />
        ) : (
          <>
            <div className='grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 text-sm'>
              <span className='text-muted-foreground'>邮箱</span>
              <span className='font-mono text-xs'>{profile.email}</span>
              <span className='text-muted-foreground'>状态</span>
              <span>
                <StatusMark tone={profileTone(profile)} />
              </span>
              <span className='text-muted-foreground'>2FA</span>
              <span>{profile.totp_set ? '已保存' : '未设置'}</span>
              <span className='text-muted-foreground'>最近重登</span>
              <span className='text-xs text-muted-foreground'>
                {state?.last_relogin_at
                  ? `${fmtAgo(state.last_relogin_at)} · ${
                      state.last_relogin_result === 'ok'
                        ? '成功'
                        : codexLoginCodeText(
                            state.last_relogin_error,
                            state.last_relogin_detail
                          )
                    }`
                  : '—'}
              </span>
              <span className='text-muted-foreground'>自动重登</span>
              <span>
                <Switch
                  checked={profile.auto_relogin}
                  aria-label='失效后自动重登'
                  disabled={act.isPending}
                  onCheckedChange={(v) =>
                    act.mutate({
                      method: 'PUT',
                      body: v ? { resume: true } : { auto_relogin: false },
                    })
                  }
                />
              </span>
            </div>
            {state?.login_ip_differs ? (
              <p className='text-xs text-muted-foreground'>
                该槽走本机出口，登录服务会用它自己的 IP 登录。
              </p>
            ) : null}
            {profile.secret_unreadable ? (
              <p className='text-xs text-destructive'>
                保存的密码无法解密（数据库密钥变了），请点「修改」重新填写。
              </p>
            ) : null}
            <div className='flex flex-wrap gap-2'>
              <Button
                size='sm'
                loading={profile.relogin.state !== 'idle'}
                disabled={
                  act.isPending ||
                  profile.relogin.state !== 'idle' ||
                  profile.secret_unreadable
                }
                onClick={() => act.mutate({ path: '/relogin', method: 'POST' })}
              >
                {profile.relogin.state === 'queued'
                  ? '排队重登'
                  : profile.relogin.state !== 'idle'
                    ? profile.relogin.stage
                      ? `重登中 · ${codexAuthStageText(profile.relogin.stage)}`
                      : '重登中'
                    : '立即重登'}
              </Button>
              {state?.auto_paused === 'workspace_not_found' ||
              state?.last_relogin_error === 'workspace_not_found' ? (
                <Button
                  size='sm'
                  variant='outline'
                  disabled={
                    act.isPending ||
                    profile.relogin.state !== 'idle' ||
                    profile.secret_unreadable
                  }
                  onClick={() =>
                    act.mutate({
                      path: '/relogin',
                      method: 'POST',
                      body: { allow_workspace_reselect: true },
                    })
                  }
                >
                  自动重选工作区并重登
                </Button>
              ) : null}
              {state?.auto_paused && profile.auto_relogin ? (
                <Button
                  size='sm'
                  variant='outline'
                  disabled={act.isPending}
                  onClick={() =>
                    act.mutate({ method: 'PUT', body: { resume: true } })
                  }
                >
                  恢复自动重登
                </Button>
              ) : null}
              <Button
                size='sm'
                variant='outline'
                onClick={() => setEditing(true)}
              >
                修改
              </Button>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => setConfirmRemove(true)}
              >
                删除
              </Button>
            </div>
          </>
        )}
        <ConfirmDialog
          open={confirmRemove}
          onOpenChange={setConfirmRemove}
          title='删除登录资料？'
          desc='删掉保存的邮箱、密码和 2FA，之后不再巡检和自动重登。现有凭证不受影响。'
          confirmText='删除'
          destructive
          handleConfirm={() => {
            setConfirmRemove(false)
            act.mutate({ method: 'DELETE' })
          }}
        />
      </CardContent>
    </Card>
  )
}
