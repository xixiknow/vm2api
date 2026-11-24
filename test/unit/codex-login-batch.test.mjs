import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodexLoginBatchManager, parseBatchText } from '../../src/lib/oauth/codex-login-batch.mjs'

function fakeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
}

function credentialFor(email, accountId = `acct-${email}`) {
  return {
    access_token: fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
    refresh_token: `rt-${email}`,
    id_token: fakeJwt({ email, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
    expires_at: 1_900_000_000_000,
  }
}

function harness({
  existing = {},
  accounts = {},
  loginPlan = {},
  commitFailures = {},
  noProxy = new Set(),
  encryption = true,
} = {}) {
  const calls = { login: [], provision: [], discard: [], commit: [], enroll: [] }
  let seq = 0
  const manager = createCodexLoginBatchManager({
    readConfig: () => ({ endpoint: 'https://login.test/relogin', batch_concurrency: 2 }),
    encryptionEnabled: () => encryption,
    ttlMs: 50,
    findExisting: ({ email, chatgptAccountId, excludeVmId }) => {
      if (existing[email] && existing[email] !== excludeVmId) return { vm_id: existing[email] }
      if (chatgptAccountId && accounts[chatgptAccountId] && accounts[chatgptAccountId] !== excludeVmId) {
        return { vm_id: accounts[chatgptAccountId] }
      }
      return null
    },
    provision: async ({ email, exitMode }) => {
      calls.provision.push({ email, exitMode })
      if (noProxy.has(email)) return { ok: false, error: 'no_free_proxy' }
      seq += 1
      return { ok: true, vm_id: `vm-${seq}`, proxy_url: `socks5h://p${seq}:x@h:1080`, login_ip_differs: false }
    },
    login: async ({ email, password, mfaSecret, proxyUrl, signal }) => {
      calls.login.push({ email, password, mfaSecret, proxyUrl })
      const plan = loginPlan[email] || { ok: true }
      if (plan.hang) {
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ ok: false, error: 'canceled' }), { once: true })
        })
      }
      if (!plan.ok) return { ok: false, error: plan.error || 'login_rejected', detail: plan.detail }
      return { ok: true, credential: credentialFor(plan.as || email, plan.accountId) }
    },
    discard: async (vmId) => {
      calls.discard.push(vmId)
    },
    commit: async ({ vmId, account }) => {
      calls.commit.push({ vmId, email: account.email })
      if (commitFailures[account.email] > 0) {
        commitFailures[account.email] -= 1
        return { ok: false, error: 'import_failed' }
      }
      return { ok: true }
    },
    enroll: async ({ vmId, email, password, mfaSecret }) => {
      calls.enroll.push({ vmId, email, password, mfaSecret })
      return { ok: true }
    },
  })
  return { manager, calls }
}

const byEmail = (view) => Object.fromEntries(view.rows.map((row) => [row.email, row]))

test('batch text: both separators, comments, and errors that name only the line', () => {
  const ok = parseBatchText('# header\nA@Example.com----p1----abcd efgh\n\nb@example.com,p2,TOTP2\n')
  assert.equal(ok.ok, true)
  assert.deepEqual(
    ok.entries.map((e) => [e.line, e.email, e.password, e.mfa_secret]),
    [
      [2, 'a@example.com', 'p1', 'abcdefgh'],
      [4, 'b@example.com', 'p2', 'TOTP2'],
    ],
  )
  const bad = parseBatchText('a@example.com----SECRET-PW----t\nnot-an-email----SECRET-PW2----t')
  assert.deepEqual(bad, { ok: false, error: 'invalid_batch', line: 2 })
  assert.equal(parseBatchText('a@example.com----pw').line, 1)
  assert.equal(parseBatchText('a@example.com----pw----').line, 1)
  assert.equal(parseBatchText('a@x.com,p,t\nA@x.com,p,t').error, 'duplicate_email')
  assert.equal(parseBatchText(' \n# only comments').error, 'empty_batch')
  const many = Array.from({ length: 101 }, (_, i) => `u${i}@x.com,p,t`).join('\n')
  assert.equal(parseBatchText(many).error, 'too_many_rows')
  assert.equal(parseBatchText(null).error, 'invalid_batch')
})

test('rows: known emails skip before login, failures delete the empty slot', async () => {
  const { manager, calls } = harness({
    existing: { 'known@x.com': 'vm-old' },
    loginPlan: {
      'bad@x.com': { ok: false, error: 'login_rejected', detail: 'invalid_password' },
      'swap@x.com': { ok: true, as: 'other@x.com' },
    },
  })
  const started = manager.start({
    text: 'ok@x.com----PW-OK----T1\nknown@x.com----PW-K----T2\nbad@x.com----PW-BAD----T3\nswap@x.com----PW-S----T4',
    exit_mode: 'pool',
  })
  assert.equal(started.ok, true)
  assert.equal(started.status, 202)
  await manager.settled()
  const view = manager.current()
  assert.equal(view.status, 'done')
  const rows = byEmail(view)
  assert.equal(rows['ok@x.com'].status, 'created')
  assert.equal(rows['ok@x.com'].vm_id, 'vm-1')
  assert.deepEqual([rows['known@x.com'].status, rows['known@x.com'].vm_id], ['skipped', 'vm-old'])
  assert.deepEqual(
    [rows['bad@x.com'].status, rows['bad@x.com'].error, rows['bad@x.com'].detail, rows['bad@x.com'].vm_id],
    ['failed', 'login_rejected', 'invalid_password', null],
  )
  assert.deepEqual([rows['swap@x.com'].status, rows['swap@x.com'].error], ['failed', 'identity_mismatch'])
  assert.equal(rows['bad@x.com'].retryable, true)
  assert.equal(rows['ok@x.com'].retryable, false)

  assert.ok(!calls.login.some((c) => c.email === 'known@x.com'))
  assert.equal(calls.login.find((c) => c.email === 'ok@x.com').proxyUrl.startsWith('socks5h://'), true)
  assert.equal(calls.discard.length, 2)
  assert.deepEqual(
    calls.commit.map((c) => c.email),
    ['ok@x.com'],
  )
  assert.deepEqual(
    calls.enroll.map((c) => [c.vmId, c.email, c.password, c.mfaSecret]),
    [['vm-1', 'ok@x.com', 'PW-OK', 'T1']],
  )
  assert.ok(!JSON.stringify(view).includes('PW-'))
})

test('an account id already in another slot is skipped after login', async () => {
  const { manager, calls } = harness({
    accounts: { 'acct-dup': 'vm-9' },
    loginPlan: { 'a@x.com': { ok: true, accountId: 'acct-dup' } },
  })
  manager.start({ text: 'a@x.com,p,t' })
  await manager.settled()
  const row = manager.current().rows[0]
  assert.deepEqual([row.status, row.detail, row.vm_id], ['skipped', 'account_exists', 'vm-9'])
  assert.deepEqual(calls.discard, ['vm-1'])
  assert.equal(calls.commit.length, 0)
})

test('an import failure retries without a second login', async () => {
  const { manager, calls } = harness({ commitFailures: { 'a@x.com': 1 } })
  const { batch } = manager.start({ text: 'a@x.com,p,t' })
  await manager.settled()
  assert.equal(manager.current().rows[0].status, 'import_failed')
  assert.equal(manager.current().rows[0].vm_id, 'vm-1')
  const again = manager.retry(batch.id)
  assert.equal(again.ok, true)
  await manager.settled()
  assert.equal(manager.current().rows[0].status, 'created')
  assert.equal(calls.login.length, 1)
  assert.equal(calls.provision.length, 1)
  assert.equal(calls.commit.length, 2)
  assert.equal(calls.enroll.length, 1)
  assert.equal(manager.retry(batch.id).error, 'nothing_to_retry')
})

test('cancel aborts the login, deletes its slot and leaves rows pending for retry', async () => {
  const plan = { 'a@x.com': { hang: true } }
  const { manager, calls } = harness({ loginPlan: plan })
  const { batch } = manager.start({ text: 'a@x.com,p,t\nb@x.com,p,t\nc@x.com,p,t' })
  assert.equal(manager.start({ text: 'z@x.com,p,t' }).error, 'batch_running')
  assert.equal(manager.remove(batch.id).error, 'batch_running')
  await new Promise((resolve) => setTimeout(resolve, 10))
  manager.cancel(batch.id)
  await manager.settled()
  const view = manager.current()
  assert.equal(view.status, 'canceled')
  assert.equal(byEmail(view)['a@x.com'].status, 'pending')
  assert.equal(byEmail(view)['a@x.com'].vm_id, null)
  assert.ok(calls.discard.includes('vm-1'))

  plan['a@x.com'] = { ok: true }
  manager.retry(batch.id)
  await manager.settled()
  assert.ok(manager.current().rows.every((row) => row.status === 'created'))
})

test('start checks the service, encryption and exit before any login', async () => {
  const noKey = harness({ encryption: false })
  assert.equal(noKey.manager.start({ text: 'a@x.com,p,t' }).error, 'encryption_required')
  const plain = noKey.manager.start({ text: 'a@x.com,p,t', save_login: false, exit_mode: 'local' })
  assert.equal(plain.ok, true)
  assert.equal(plain.batch.options.exit_mode, 'local')
  await noKey.manager.settled()
  assert.equal(noKey.calls.enroll.length, 0)
  assert.equal(noKey.manager.current().rows[0].status, 'created')
  assert.equal(noKey.calls.provision[0].exitMode, 'local')

  const bad = harness().manager.start({ text: 'a@x.com,p' })
  assert.deepEqual([bad.status, bad.error, bad.line], [400, 'invalid_batch', 1])

  const unconfigured = createCodexLoginBatchManager({ readConfig: () => ({ endpoint: '' }) })
  assert.equal(unconfigured.start({ text: 'a@x.com,p,t' }).error, 'login_service_unconfigured')

  const pool = harness({ noProxy: new Set(['a@x.com']) })
  pool.manager.start({ text: 'a@x.com,p,t' })
  await pool.manager.settled()
  assert.deepEqual(
    [pool.manager.current().rows[0].status, pool.manager.current().rows[0].error],
    ['failed', 'no_free_proxy'],
  )
  assert.equal(pool.calls.login.length, 0)
})

test('a finished batch expires and can be removed', async () => {
  const { manager } = harness()
  const { batch } = manager.start({ text: 'a@x.com,p,t' })
  await manager.settled()
  assert.ok(manager.current())
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(manager.current(), null)

  const second = manager.start({ text: 'b@x.com,p,t' })
  await manager.settled()
  assert.equal(manager.remove(second.batch.id).ok, true)
  assert.equal(manager.current(), null)
  assert.equal(manager.cancel(batch.id).error, 'batch_not_found')
})
