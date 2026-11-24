import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodexLoginProfiles } from '../../src/lib/oauth/codex-login-profiles.mjs'
import { createCodexReloginService } from '../../src/lib/oauth/codex-relogin.mjs'

function fakeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
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
  { plan = [], vm = { id: 'vm-1', platform: 'openai', codex: { chatgpt_account_id: 'acct-1' } }, config } = {},
) {
  const prev = process.env.VM2API_DB_SECRET
  process.env.VM2API_DB_SECRET = 'relogin-test-secret'
  t.after(() => {
    if (prev === undefined) delete process.env.VM2API_DB_SECRET
    else process.env.VM2API_DB_SECRET = prev
  })
  let clock = Date.UTC(2026, 10, 24, 12)
  const profiles = createCodexLoginProfiles({ settings: memorySettings(), now: () => clock })
  profiles.save('vm-1', { email: 'a@x.com', password: 'PW', totp_secret: 'TOTP' })
  const calls = { login: [], commit: [], restart: [] }
  const vms = { 'vm-1': vm }
  const service = createCodexReloginService({
    profiles,
    readConfig: () =>
      config || { endpoint: 'https://login.test', guard: { relogin_cooldown_min: 30, max_relogin_failures: 3 } },
    login: async (args) => {
      calls.login.push(args)
      const step = plan.length ? plan.shift() : { ok: true }
      if (step.hang) {
        return new Promise((resolve) =>
          args.signal.addEventListener('abort', () => resolve({ ok: false, error: 'canceled' })),
        )
      }
      if (!step.ok) return { ok: false, error: step.error || 'login_rejected', detail: step.detail }
      return { ok: true, credential: credentialFor(step.email || 'a@x.com', step.accountId || 'acct-1') }
    },
    getVm: (id) => vms[id] || null,
    isCodexVm: (v) => v?.platform === 'openai',
    slotExit: () => ({ proxy_url: 'socks5h://u:p@h:1', login_ip_differs: false }),
    commit: async ({ vmId, account }) => {
      calls.commit.push({ vmId, email: account.email })
      return { ok: true }
    },
    restartKernel: async (vmId) => {
      calls.restart.push(vmId)
    },
    now: () => clock,
  })
  return { profiles, service, calls, vms, advance: (ms) => (clock += ms) }
}

test('a matching login replaces the tokens, restarts the kernel and resets the state', async (t) => {
  const { profiles, service, calls } = setup(t)
  profiles.patchState('vm-1', { relogin_fail_streak: 2, auth_fail_streak: 2 })
  const queued = service.request('vm-1')
  assert.deepEqual([queued.ok, queued.status, queued.task.state], [true, 202, 'running'])
  assert.equal(service.request('vm-1').already, true)
  await service.settled('vm-1')
  assert.equal(calls.login.length, 1)
  assert.deepEqual(
    [calls.login[0].email, calls.login[0].password, calls.login[0].mfaSecret, calls.login[0].proxyUrl],
    ['a@x.com', 'PW', 'TOTP', 'socks5h://u:p@h:1'],
  )
  assert.deepEqual(calls.commit, [{ vmId: 'vm-1', email: 'a@x.com' }])
  assert.deepEqual(calls.restart, ['vm-1'])
  const state = profiles.get('vm-1').state
  assert.equal(state.last_relogin_result, 'ok')
  assert.equal(state.last_relogin_trigger, 'manual')
  assert.equal(state.relogin_fail_streak, 0)
  assert.equal(state.auth_fail_streak, 0)
  assert.ok(state.next_probe_at > 0)
  assert.deepEqual(service.status('vm-1'), { state: 'idle' })
})

test('a different account never overwrites the slot', async (t) => {
  for (const step of [
    { ok: true, email: 'b@x.com' },
    { ok: true, accountId: 'acct-other' },
  ]) {
    const { profiles, service, calls } = setup(t, { plan: [step] })
    service.request('vm-1')
    await service.settled('vm-1')
    assert.equal(calls.commit.length, 0)
    assert.equal(profiles.get('vm-1').state.last_relogin_error, 'identity_mismatch')
    assert.equal(profiles.get('vm-1').state.relogin_fail_streak, 1)
  }
})

test('failures cool down, then pause automatic re-login; manual still runs', async (t) => {
  const { profiles, service, advance } = setup(t, {
    plan: [
      { ok: false, detail: 'invalid_password' },
      { ok: false, detail: 'invalid_password' },
      { ok: false, detail: 'invalid_password' },
    ],
  })
  service.request('vm-1', { trigger: 'auto' })
  await service.settled('vm-1')
  let state = profiles.get('vm-1').state
  assert.deepEqual([state.last_relogin_result, state.last_relogin_detail], ['failed', 'invalid_password'])
  assert.equal(service.request('vm-1', { trigger: 'auto' }).error, 'cooldown')
  advance(31 * 60_000)
  service.request('vm-1', { trigger: 'auto' })
  await service.settled('vm-1')
  service.request('vm-1')
  await service.settled('vm-1')
  state = profiles.get('vm-1').state
  assert.equal(state.relogin_fail_streak, 3)
  assert.equal(state.auto_paused, 'too_many_failures')
  advance(31 * 60_000)
  assert.equal(service.request('vm-1', { trigger: 'auto' }).error, 'auto_paused')

  profiles.setAutoRelogin('vm-1', false)
  profiles.patchState('vm-1', { auto_paused: null })
  assert.equal(service.request('vm-1', { trigger: 'auto' }).error, 'auto_relogin_off')
  service.request('vm-1')
  await service.settled('vm-1')
  assert.equal(profiles.get('vm-1').state.last_relogin_result, 'ok')
  assert.equal(profiles.get('vm-1').state.auto_paused, null)
})

test('requests are refused without a profile, a GPT slot, a service or a readable secret', (t) => {
  const { profiles, service, vms } = setup(t)
  assert.equal(service.request('vm-x').error, 'profile_missing')
  vms['vm-1'] = { id: 'vm-1', platform: 'anthropic' }
  assert.equal(service.request('vm-1').error, 'vm_not_found')
  const off = setup(t, { config: { endpoint: '' } })
  assert.equal(off.service.request('vm-1').error, 'login_service_unconfigured')
  profiles.remove('vm-1')
  assert.equal(service.request('vm-1').error, 'profile_missing')
})

test('a rotated DB key is reported instead of logging in', async (t) => {
  const { profiles, service, calls } = setup(t)
  process.env.VM2API_DB_SECRET = 'another-key'
  service.request('vm-1')
  await service.settled('vm-1')
  assert.equal(calls.login.length, 0)
  assert.equal(profiles.get('vm-1').state.last_relogin_error, 'secret_unreadable')
})

test('stop aborts a running login without recording it', async (t) => {
  const { profiles, service, calls } = setup(t, { plan: [{ hang: true }] })
  service.request('vm-1')
  const done = service.settled('vm-1')
  service.stop()
  await done
  assert.equal(calls.commit.length, 0)
  assert.equal(profiles.get('vm-1').state.last_relogin_result, null)
  assert.equal(service.request('vm-1').error, 'shutting_down')
})
