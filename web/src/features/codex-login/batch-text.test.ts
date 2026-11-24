import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import {
  batchSummary,
  batchTextProblem,
  checkBatchText,
  codexLoginCodeText,
  codexLoginErrorText,
  hasRetryableRows,
  rowTone,
} from './batch-text'
import { profileTone } from './profile-tone'
import type { CodexLoginBatch, CodexLoginProfile } from './types'

describe('checkBatchText', () => {
  it('accepts both separators, skips blanks and comments', () => {
    expect(
      checkBatchText('# list\nA@x.com----p1----ABCD EFGH\n\nb@x.com,p2,T2\n')
    ).toEqual({ ok: true, count: 2 })
  })

  it('reports the line, never its content', () => {
    const bad = checkBatchText('a@x.com----SECRET----t\nbroken SECRET')
    expect(bad).toEqual({ ok: false, line: 2, reason: 'format' })
    expect(batchTextProblem(bad)).toBe(
      '第 2 行格式不对：需要 邮箱----密码----2FA密钥'
    )
    expect(batchTextProblem(bad)).not.toContain('SECRET')
  })

  it('rejects missing fields, duplicates, empty and oversized batches', () => {
    expect(checkBatchText('a@x.com----pw----').ok).toBe(false)
    expect(checkBatchText('a@x.com,p,t\nA@x.com,p,t')).toEqual({
      ok: false,
      line: 2,
      reason: 'duplicate',
    })
    expect(checkBatchText(' \n# only')).toEqual({
      ok: false,
      line: 0,
      reason: 'empty',
    })
    const many = Array.from({ length: 101 }, (_, i) => `u${i}@x.com,p,t`).join(
      '\n'
    )
    expect(batchTextProblem(checkBatchText(many))).toBe('一次最多 100 个账号')
  })
})

describe('labels', () => {
  it('maps row status to a tone', () => {
    expect(rowTone('created')).toMatchObject({ text: '已导入', cls: 'ok' })
    expect(rowTone('import_failed')).toMatchObject({ cls: 'bad' })
    expect(rowTone('logging_in')).toMatchObject({ cls: 'warn' })
  })

  it('explains codes with their detail', () => {
    expect(codexLoginCodeText('login_rejected', 'invalid_password')).toBe(
      '登录被拒（invalid_password）'
    )
    expect(codexLoginCodeText('login_service_http', 'http_502')).toBe(
      '登录服务返回错误（HTTP 502）'
    )
    expect(codexLoginCodeText(null, 'email_exists')).toBe('邮箱已在其他槽位')
    expect(codexLoginCodeText(null, null)).toBe('')
  })

  it('keeps the server line message for batch errors', () => {
    const lineError = new ApiError('第 3 行：格式不对', 400, 'invalid_batch')
    expect(codexLoginErrorText(lineError)).toBe('第 3 行：格式不对')
    const coded = new ApiError('x', 409, 'encryption_required')
    expect(codexLoginErrorText(coded)).toBe(
      '保存密码需要先配置 VM2API_DB_SECRET'
    )
  })

  it('summarizes a batch', () => {
    const batch = {
      status: 'done',
      counts: { total: 4, created: 1, skipped: 1, failed: 1, pending: 1 },
      rows: [{ retryable: true }],
    } as unknown as CodexLoginBatch
    expect(batchSummary(batch)).toBe(
      '共 4 · 导入 1 · 已存在 1 · 失败 1 · 未开始 1'
    )
    expect(hasRetryableRows(batch)).toBe(true)
    expect(batchSummary(null)).toBe('')
  })
})

describe('profileTone', () => {
  const base: CodexLoginProfile = {
    vm_id: 'vm-1',
    email: 'a@x.com',
    password_set: true,
    totp_set: true,
    auto_relogin: true,
    secret_unreadable: false,
    created_at: null,
    updated_at: null,
    vm_name: null,
    vm_exists: true,
    relogin: { state: 'idle' },
    state: {
      last_probe_at: null,
      last_probe_result: null,
      next_probe_at: 0,
      auth_fail_streak: 0,
      last_relogin_at: null,
      last_relogin_trigger: null,
      last_relogin_result: null,
      last_relogin_error: null,
      last_relogin_detail: null,
      relogin_fail_streak: 0,
      cooldown_until: 0,
      auto_paused: null,
      login_ip_differs: false,
    },
  }

  it('puts running and broken states first', () => {
    expect(profileTone({ ...base, relogin: { state: 'running' } }).text).toBe(
      '重登中'
    )
    expect(
      profileTone({ ...base, state: { ...base.state, auto_paused: 'x' } }).text
    ).toBe('自动重登已暂停')
    expect(profileTone({ ...base, auto_relogin: false }).cls).toBe('off')
    expect(
      profileTone({
        ...base,
        state: { ...base.state, last_probe_result: 'ok' },
      }).cls
    ).toBe('ok')
    expect(profileTone(base).text).toBe('待巡检')
  })
})
