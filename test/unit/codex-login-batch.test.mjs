import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodexLoginBatchManager, parseBatchText } from '../../src/lib/oauth/codex-login-batch.mjs'

const VALID_TOTP = 'JBSWY3DPEHPK3PXP'

function fakeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`
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
  freeSlots = 10,
  encryption = true,
  proxies = ['px-1', 'px-2', 'px-3'],
  maxConcurrency = 2,
} = {}) {
  const calls = { login: [], provision: [], discard: [], commit: [], enroll: [] }
  let seq = 0
  const manager = createCodexLoginBatchManager({
    readConfig: () => ({
      endpoint: 'http://127.0.0.1:8788',
      service_token: 'tok-test',
      workspace_policy: 'auto',
      max_concurrency: maxConcurrency,
    }),
    egressSummary: () => ({ pool_usable_proxies: freeSlots > 0 ? proxies.length : 0, pool_free_slots: freeSlots }),
    encryptionEnabled: () => encryption,
    ttlMs: 50,
    findExisting: ({ email, chatgptAccountId, excludeVmId }) => {
      if (existing[email] && existing[email] !== excludeVmId) return { vm_id: existing[email] }
      if (chatgptAccountId && accounts[chatgptAccountId] && accounts[chatgptAccountId] !== excludeVmId) {
        return { vm_id: accounts[chatgptAccountId] }
      }
      return null
    },
    provision: async ({ email, excludeProxyIds, busyProxyIds }) => {
      calls.provision.push({
        email,
        excluded: excludeProxyIds ? [...excludeProxyIds] : [],
        busy: busyProxyIds ? [...busyProxyIds] : [],
      })
      if (noProxy.has(email)) return { ok: false, error: 'no_free_proxy' }
      const available = proxies.filter((id) => !excludeProxyIds?.has(id))
      if (!available.length) return { ok: false, error: 'no_free_proxy' }
      const pick = available.find((id) => !busyProxyIds?.has(id)) || available[0]
      seq += 1
      return { ok: true, vm_id: `vm-${seq}`, proxy_id: pick, proxy_url: `socks5h://${pick}:x@h:1080` }
    },
    login: async ({ vmId, email, password, mfaSecret, proxyUrl, workspacePolicy, signal, onProgress }) => {
      calls.login.push({ vmId, email, password, mfaSecret, proxyUrl, workspacePolicy })
      const plan = loginPlan[email] || { ok: true }
      onProgress?.('verifying_password')
      if (plan.hang) {
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ ok: false, error: 'canceled' }), { once: true })
        })
      }
      if (typeof plan.decide === 'function') return plan.decide({ proxyUrl, email })
      if (!plan.ok) return { ok: false, error: plan.error || 'password_rejected', detail: plan.detail }
      const ws =
        plan.workspace !== undefined
          ? plan.workspace
          : {
              id: plan.accountId || `acct-${plan.as || email}`,
              kind: 'organization',
              name: 'Org',
              selection_reason: 'organization_preferred',
              candidate_count: 2,
              selection_missing: false,
            }
      return { ok: true, credential: credentialFor(plan.as || email, plan.accountId), workspace: ws }
    },
    discard: async (vmId) => {
      calls.discard.push(vmId)
    },
    commit: async ({ vmId, account }) => {
      calls.commit.push({ vmId, email: account.email, workspaceKind: account.workspace_kind || null })
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

test('batch text accepts 3-column TOTP and 2-column / blank no-MFA lines and validates Base32', () => {
  const ok = parseBatchText(
    `# header\nA@Example.com----p1----jbsw y3dp ehpk 3pxp\n\nb@example.com,p2\nc@example.com----p3----\nd@example.com,p4,otpauth://totp/x?secret=${VALID_TOTP}\n`,
  )
  assert.equal(ok.ok, true)
  assert.deepEqual(
    ok.entries.map((e) => [e.line, e.email, e.password, e.mfa_secret]),
    [
      [2, 'a@example.com', 'p1', VALID_TOTP],
      [4, 'b@example.com', 'p2', null],
      [5, 'c@example.com', 'p3', null],
      [6, 'd@example.com', 'p4', VALID_TOTP],
    ],
  )
  assert.deepEqual(parseBatchText(`a@example.com----SECRET----${VALID_TOTP}\nnot-an-email----SECRET2`), {
    ok: false,
    error: 'invalid_batch',
    line: 2,
  })
  assert.deepEqual(parseBatchText('a@example.com----pw----not-base32'), {
    ok: false,
    error: 'invalid_totp',
    line: 1,
  })
  assert.equal(parseBatchText('a@x.com,p\nA@x.com,p').error, 'duplicate_email')
  assert.equal(parseBatchText(' \n# only comments').error, 'empty_batch')
  const many = Array.from({ length: 101 }, (_, i) => `u${i}@x.com,p`).join('\n')
  assert.equal(parseBatchText(many).error, 'too_many_rows')
  assert.equal(parseBatchText(null).error, 'invalid_batch')
})

test('rows: known emails skip before login, failures delete empty slots, and missing workspace metadata warns', async () => {
  const { manager, calls } = harness({
    existing: { 'known@x.com': 'vm-old' },
    loginPlan: {
      'bad@x.com': { ok: false, error: 'password_rejected' },
      'swap@x.com': { ok: true, as: 'other@x.com' },
      'direct@x.com': {
        ok: true,
        workspace: {
          id: 'acct-direct@x.com',
          kind: null,
          name: null,
          selection_reason: null,
          candidate_count: null,
          selection_missing: true,
        },
      },
    },
  })
  const started = manager.start({
    text: `ok@x.com----PW-OK----${VALID_TOTP}\nknown@x.com----PW-K\nbad@x.com----PW-BAD\nswap@x.com----PW-S\ndirect@x.com----PW-D`,
    workspace_policy: 'prefer_organization',
  })
  assert.equal(started.ok, true)
  assert.equal(started.status, 202)
  assert.equal(started.batch.options.workspace_policy, 'prefer_organization')
  await manager.settled()
  const view = manager.current()
  assert.equal(view.status, 'done')
  const rows = byEmail(view)
  assert.equal(rows['ok@x.com'].status, 'created')
  assert.equal(rows['ok@x.com'].workspace.kind, 'organization')
  assert.equal(rows['direct@x.com'].status, 'created')
  assert.equal(rows['direct@x.com'].warning, 'workspace_metadata_missing')
  assert.deepEqual([rows['known@x.com'].status, rows['known@x.com'].vm_id], ['skipped', 'vm-old'])
  assert.deepEqual(
    [rows['bad@x.com'].status, rows['bad@x.com'].error, rows['bad@x.com'].vm_id],
    ['failed', 'password_rejected', null],
  )
  assert.deepEqual([rows['swap@x.com'].status, rows['swap@x.com'].error], ['failed', 'identity_mismatch'])
  assert.equal(calls.discard.length, 2)
  assert.equal(calls.login.find((c) => c.email === 'ok@x.com').workspacePolicy, 'prefer_organization')
  assert.equal(calls.login.find((c) => c.email === 'direct@x.com').mfaSecret, null)
  assert.ok(!JSON.stringify(view).includes('PW-'))
})

test('proxy_unreachable excludes the bad proxy for subsequent rows in the same pass', async () => {
  const { manager, calls } = harness({
    proxies: ['px-bad', 'px-good'],
    maxConcurrency: 1,
    loginPlan: {
      'first@x.com': {
        decide: ({ proxyUrl }) =>
          proxyUrl.includes('px-bad')
            ? { ok: false, error: 'proxy_unreachable' }
            : { ok: true, credential: credentialFor('first@x.com') },
      },
      'second@x.com': {
        decide: ({ proxyUrl }) =>
          proxyUrl.includes('px-bad')
            ? { ok: false, error: 'proxy_unreachable' }
            : { ok: true, credential: credentialFor('second@x.com') },
      },
    },
  })
  const started = manager.start({ text: 'first@x.com,p1\nsecond@x.com,p2' })
  assert.equal(started.ok, true)
  await manager.settled()
  const rows = byEmail(manager.current())
  assert.equal(rows['first@x.com'].status, 'failed')
  assert.equal(rows['first@x.com'].error, 'proxy_unreachable')
  assert.equal(rows['second@x.com'].status, 'created')
  assert.equal(rows['second@x.com'].proxy_id, 'px-good')
  assert.deepEqual(calls.provision[1].excluded, ['px-bad'])
})

test('start rejects local exit mode, unconfigured service, missing encryption, and empty proxy pool upfront', async () => {
  const local = harness().manager.start({ text: 'a@x.com,p', exit_mode: 'local' })
  assert.deepEqual([local.status, local.error], [400, 'local_exit_unsupported'])

  const noFree = harness({ freeSlots: 0 }).manager.start({ text: 'a@x.com,p' })
  assert.deepEqual([noFree.status, noFree.error], [409, 'no_free_proxy'])

  const noKey = harness({ encryption: false })
  assert.equal(noKey.manager.start({ text: 'a@x.com,p' }).error, 'encryption_required')
  const plain = noKey.manager.start({ text: 'a@x.com,p', save_login: false })
  assert.equal(plain.ok, true)
  await noKey.manager.settled()
  assert.equal(noKey.calls.enroll.length, 0)
  assert.equal(noKey.manager.current().rows[0].status, 'created')

  const unconfigured = createCodexLoginBatchManager({ readConfig: () => ({ endpoint: 'http://127.0.0.1:8788' }) })
  assert.equal(unconfigured.start({ text: 'a@x.com,p' }).error, 'login_service_unconfigured')
})

test('an import failure retries without a second login and cancel discards running slots', async () => {
  const { manager, calls } = harness({ commitFailures: { 'a@x.com': 1 } })
  const { batch } = manager.start({ text: 'a@x.com,p' })
  await manager.settled()
  assert.equal(manager.current().rows[0].status, 'import_failed')
  assert.equal(manager.retry(batch.id).ok, true)
  await manager.settled()
  assert.equal(manager.current().rows[0].status, 'created')
  assert.equal(calls.login.length, 1)
  assert.equal(calls.commit.length, 2)

  const plan = { 'a@x.com': { hang: true } }
  const c = harness({ loginPlan: plan })
  const started = c.manager.start({ text: 'a@x.com,p\nb@x.com,p' })
  await new Promise((r) => setTimeout(r, 15))
  c.manager.cancel(started.batch.id)
  await c.manager.settled()
  assert.equal(c.manager.current().status, 'canceled')
  assert.equal(byEmail(c.manager.current())['a@x.com'].status, 'pending')
  assert.ok(c.calls.discard.length >= 1)
})
