import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import {
  batchSummary,
  batchTextProblem,
  checkBatchText,
  codexLoginCodeText,
  codexLoginErrorText,
  codexWorkspaceSummary,
  hasRetryableRows,
  rowTone,
} from './batch-text'
import { profileTone } from './profile-tone'
import type { CodexLoginBatch, CodexLoginProfile } from './types'

describe('checkBatchText', () => {
  it('accepts 3-column TOTP and 2-column / blank no-MFA lines, skips blanks and comments', () => {
    expect(
      checkBatchText(
        '# list\nA@x.com----p1----JBSW Y3DP EHPK 3PXP\n\nb@x.com,p2\nc@x.com----p3----\nd@x.com,p4,otpauth://totp/x?secret=JBSWY3DPEHPK3PXP\n'
      )
    ).toEqual({ ok: true, count: 4 })
  })

  it('reports only the line number, never its content', () => {
    const bad = checkBatchText('a@x.com----SECRET\nbroken SECRET')
    expect(bad).toEqual({ ok: false, line: 2, reason: 'format' })
    expect(batchTextProblem(bad)).toBe(
      '第 2 行格式不对：需要 邮箱----密码 或 邮箱----密码----2FA密钥'
    )
    expect(batchTextProblem(bad)).not.toContain('SECRET')
  })

  it('rejects invalid TOTP, duplicates, empty and oversized batches', () => {
    expect(checkBatchText('a@x.com----pw----bad-totp')).toEqual({
      ok: false,
      line: 1,
      reason: 'invalid_totp',
    })
    expect(checkBatchText('a@x.com,p\nA@x.com,p')).toEqual({
      ok: false,
      line: 2,
      reason: 'duplicate',
    })
    expect(checkBatchText(' \n# only')).toEqual({
      ok: false,
      line: 0,
      reason: 'empty',
    })
    const many = Array.from({ length: 101 }, (_, i) => `u${i}@x.com,p`).join(
      '\n'
    )
    expect(batchTextProblem(checkBatchText(many))).toBe('一次最多 100 个账号')
  })
})

describe('labels', () => {
  it('maps row status and live Callback v2 stages to tones', () => {
    expect(rowTone('created')).toMatchObject({ text: '已导入', cls: 'ok' })
    expect(rowTone('import_failed')).toMatchObject({ cls: 'bad' })
    expect(rowTone('logging_in')).toMatchObject({ text: '登录中', cls: 'warn' })
    expect(rowTone('logging_in', 'verifying_mfa')).toMatchObject({
      text: '验证 2FA',
      cls: 'warn',
    })
  })

  it('explains Callback v2 error codes and workspace summaries', () => {
    expect(codexLoginCodeText('password_rejected')).toBe('账号或密码错误')
    expect(codexLoginCodeText('workspace_not_found')).toBe(
      '原工作区已失效或不在候选列表'
    )
    expect(codexLoginCodeText('no_free_proxy')).toBe(
      '代理池没有空闲出口，请先添加或启用代理'
    )
    expect(codexLoginCodeText(null, 'email_exists')).toBe('邮箱已在其他槽位')
    expect(codexLoginCodeText(null, null)).toBe('')

    expect(
      codexWorkspaceSummary({
        id: 'ws_1',
        kind: 'organization',
        name: 'Team A',
        selection_reason: 'organization_preferred',
        candidate_count: 2,
        selection_missing: false,
      })
    ).toBe('组织 · Team A · 优先组织 · 2 候选')

    expect(
      codexWorkspaceSummary({
        id: 'ws_2',
        kind: null,
        name: null,
        selection_reason: null,
        candidate_count: null,
        selection_missing: true,
      })
    ).toBe('未返回选择元数据')
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

  it('shows live relogin stage, queued state, and workspace_not_found pause', () => {
    expect(profileTone({ ...base, relogin: { state: 'queued' } }).text).toBe(
      '排队重登'
    )
    expect(
      profileTone({
        ...base,
        relogin: { state: 'running', stage: 'selecting_workspace' },
      }).text
    ).toBe('重登中 · 选择工作区')
    expect(
      profileTone({
        ...base,
        state: { ...base.state, auto_paused: 'workspace_not_found' },
      }).text
    ).toBe('原工作区失效')
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
