import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodexLoginProfiles } from '../../src/lib/oauth/codex-login-profiles.mjs'
import { createCodexReloginService } from '../../src/lib/oauth/codex-relogin.mjs'

function fakeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`
}

function credentialFor(email, accountId) {
  const auth = { 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }
  return { access_token: fakeJwt(auth), refresh_token: `rt-${email}`, id_token: fakeJwt({ email, ...auth }) }
}

function memorySettings() {
  const store = new Map()
  return {
    get: (key, fallback = null) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
    set: (key, value) => store.set(key, structuredClone(value)),
    remove: (key) => store.delete(key),
    all: () => Object.fromEntries([...store].map(([k, v]) => [k, structuredClone(v)])),
  }
}

function setup(
  t,
  {
    plan = [],
    vm = { id: 'vm-1', platform: 'openai', codex: { chatgpt_account_id: 'acct-1' }, proxy: { id: 'px-1' } },
    config,
    findExisting = () => null,
    isSlotBusy = () => false,
  } = {},
) {
  const prev = process.env.VM2API_DB_SECRET
  process.env.VM2API_DB_SECRET = 'relogin-test-secret'
  t.after(() => {
    if (prev === undefined) delete process.env.VM2API_DB_SECRET
    else process.env.VM2API_DB_SECRET = prev
  })
  let clock = Date.UTC(2026, 10, 24, 12)
  const profiles = createCodexLoginProfiles({ settings: memorySettings(), now: () => clock })
  profiles.save('vm-1', { email: 'a@x.com', password: 'PW', totp_secret: 'JBSWY3DPEHPK3PXP' })
  const calls = { login: [], commit: [], restart: [] }
  const vms = { 'vm-1': vm }
  const service = createCodexReloginService({
    profiles,
    readConfig: () =>
      config || {
        endpoint: 'http://127.0.0.1:8788',
        service_token: 'tok-test',
        workspace_policy: 'auto',
        max_concurrency: 2,
        guard: { relogin_cooldown_min: 30, max_relogin_failures: 3 },
      },
    login: async (args) => {
      calls.login.push(args)
      args.onProgress?.('verifying_password')
      const step = plan.length ? plan.shift() : { ok: true }
      if (step.hang) {
        return new Promise((resolve) =>
          args.signal.addEventListener('abort', () => resolve({ ok: false, error: 'canceled' })),
        )
      }
      if (!step.ok) return { ok: false, error: step.error || 'auth_worker_failed', detail: step.detail }
      return {
        ok: true,
        credential: credentialFor(step.email || 'a@x.com', step.accountId || 'acct-1'),
        workspace: {
          id: step.accountId || 'acct-1',
          kind: 'organization',
          name: 'Org',
          selection_reason: args.expectedAccountId ? 'explicit_id' : 'organization_preferred',
          candidate_count: 2,
          selection_missing: false,
        },
      }
    },
    getVm: (id) => vms[id] || null,
    isCodexVm: (v) => v?.platform === 'openai',
    slotExit: () => ({ ok: true, proxy_id: 'px-1', proxy_url: 'socks5h://u:p@h:1', login_ip_differs: false }),
    commit: async ({ vmId, account }) => {
      calls.commit.push({ vmId, email: account.email, accountId: account.chatgpt_account_id })
      return { ok: true }
    },
    restartKernel: async (vmId) => {
      calls.restart.push(vmId)
    },
    findExisting,
    isSlotBusy,
    now: () => clock,
  })
  return { profiles, service, calls, vms, advance: (ms) => (clock += ms) }
}

test('relogin locks expectedAccountId by default, replaces tokens, and restarts kernel', async (t) => {
  const { profiles, service, calls } = setup(t)
  profiles.patchState('vm-1', { relogin_fail_streak: 2, auth_fail_streak: 2 })
  const queued = service.request('vm-1')
  assert.equal(queued.ok, true)
  assert.equal(queued.status, 202)
  assert.equal(service.request('vm-1').already, true)
  await service.settled('vm-1')
  assert.equal(calls.login.length, 1)
  assert.equal(calls.login[0].expectedAccountId, 'acct-1')
  assert.equal(calls.login[0].proxyUrl, 'socks5h://u:p@h:1')
  assert.deepEqual(calls.commit, [{ vmId: 'vm-1', email: 'a@x.com', accountId: 'acct-1' }])
  assert.deepEqual(calls.restart, ['vm-1'])
  const state = profiles.get('vm-1').state
  assert.equal(state.last_relogin_result, 'ok')
  assert.equal(state.relogin_fail_streak, 0)
  assert.deepEqual(service.status('vm-1'), { state: 'idle' })
})

test('workspace_not_found pauses auto-relogin immediately; manual allowWorkspaceReselect opens auto-selection', async (t) => {
  const { profiles, service, calls } = setup(t, {
    plan: [
      { ok: false, error: 'workspace_not_found' },
      { ok: true, accountId: 'acct-new-2' },
    ],
  })
  service.request('vm-1', { trigger: 'auto' })
  await service.settled('vm-1')
  assert.equal(profiles.get('vm-1').state.last_relogin_error, 'workspace_not_found')
  assert.equal(profiles.get('vm-1').state.auto_paused, 'workspace_not_found')
  assert.equal(service.request('vm-1', { trigger: 'auto' }).error, 'auto_paused')

  // Manual reselect passes expectedAccountId: null and accepts the new workspace ID.
  service.request('vm-1', { trigger: 'manual', allowWorkspaceReselect: true })
  await service.settled('vm-1')
  assert.equal(calls.login[1].expectedAccountId, null)
  assert.deepEqual(calls.commit, [{ vmId: 'vm-1', email: 'a@x.com', accountId: 'acct-new-2' }])
  assert.equal(profiles.get('vm-1').state.auto_paused, null)
})

test('password_rejected pauses immediately while auth_worker_failed uses normal streak and cooldown', async (t) => {
  const pw = setup(t, { plan: [{ ok: false, error: 'password_rejected' }] })
  pw.service.request('vm-1', { trigger: 'auto' })
  await pw.service.settled('vm-1')
  assert.equal(pw.profiles.get('vm-1').state.auto_paused, 'password_rejected')

  const worker = setup(t, {
    plan: [
      { ok: false, error: 'auth_worker_failed' },
      { ok: false, error: 'auth_worker_failed' },
      { ok: false, error: 'auth_worker_failed' },
    ],
  })
  worker.service.request('vm-1', { trigger: 'auto' })
  await worker.service.settled('vm-1')
  assert.equal(worker.profiles.get('vm-1').state.auto_paused, null)
  assert.equal(worker.service.request('vm-1', { trigger: 'auto' }).error, 'cooldown')
  worker.advance(31 * 60_000)
  worker.service.request('vm-1', { trigger: 'auto' })
  await worker.service.settled('vm-1')
  worker.service.request('vm-1')
  await worker.service.settled('vm-1')
  assert.equal(worker.profiles.get('vm-1').state.auto_paused, 'too_many_failures')
})

test('blocks relogin when slotLogin is busy, service lacks token, or reselected workspace collides with another slot', async (t) => {
  const busy = setup(t, { isSlotBusy: () => true })
  assert.equal(busy.service.request('vm-1').error, 'slot_login_running')

  const noToken = setup(t, { config: { endpoint: 'http://127.0.0.1:8788' } })
  assert.equal(noToken.service.request('vm-1').error, 'login_service_unconfigured')

  const dup = setup(t, {
    plan: [{ ok: true, accountId: 'acct-taken' }],
    findExisting: ({ chatgptAccountId }) => (chatgptAccountId === 'acct-taken' ? { vm_id: 'vm-other' } : null),
  })
  dup.service.request('vm-1', { trigger: 'manual', allowWorkspaceReselect: true })
  await dup.service.settled('vm-1')
  assert.equal(dup.calls.commit.length, 0)
  assert.equal(dup.profiles.get('vm-1').state.last_relogin_error, 'account_exists')
})
