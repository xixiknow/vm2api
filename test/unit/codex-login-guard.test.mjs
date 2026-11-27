import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodexLoginProfiles } from '../../src/lib/oauth/codex-login-profiles.mjs'
import { createCodexLoginGuard, probeCodexCredential } from '../../src/lib/oauth/codex-login-guard.mjs'

function memorySettings() {
  const store = new Map()
  return {
    get: (key, fallback = null) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
    set: (key, value) => store.set(key, structuredClone(value)),
    remove: (key) => store.delete(key),
    all: () => Object.fromEntries([...store].map(([k, v]) => [k, structuredClone(v)])),
  }
}

function probeWith({ files, catalog, refresh, proxy = 'socks5h://u:p@h:1', direct = false }) {
  const persisted = []
  const fetched = []
  const run = () =>
    probeCodexCredential({
      vm: { id: 'vm-1' },
      readAccounts: () => [files.shift() ?? files.last],
      proxyUrlFor: () => proxy,
      isLocalExit: () => direct,
      fetchCatalog: async (args) => {
        fetched.push(args)
        return catalog(args)
      },
      refresh: refresh || (async () => ({ ok: false, error: 'refresh_rejected' })),
      persist: (vmId, patch) => persisted.push({ vmId, patch }),
    })
  return { run, persisted, fetched }
}

function accountFiles(...rows) {
  const files = [...rows]
  files.last = rows.at(-1)
  return files
}

test('probe: a live token is ok without any refresh', async () => {
  const p = probeWith({
    files: accountFiles({ access_token: 'at', refresh_token: 'rt' }),
    catalog: async () => ({ ok: true }),
  })
  assert.deepEqual(await p.run(), { result: 'ok' })
  assert.equal(p.fetched[0].proxyUrl, 'socks5h://u:p@h:1')
  assert.equal(p.persisted.length, 0)
})

test('probe: adopts a token the kernel rotated before refreshing', async () => {
  const p = probeWith({
    files: accountFiles({ access_token: 'old', refresh_token: 'rt' }, { access_token: 'new', refresh_token: 'rt2' }),
    catalog: async ({ accessToken }) => (accessToken === 'new' ? { ok: true } : { ok: false, error: 'upstream_auth' }),
    refresh: async () => {
      throw new Error('must not refresh')
    },
  })
  assert.deepEqual(await p.run(), { result: 'ok' })
})

test('probe: refreshes once, persists, and classifies what is left', async () => {
  const ok = probeWith({
    files: accountFiles({ access_token: 'old', refresh_token: 'rt', id_token: 'id' }),
    catalog: async ({ accessToken }) =>
      accessToken === 'fresh' ? { ok: true } : { ok: false, error: 'upstream_auth' },
    refresh: async () => ({ ok: true, access_token: 'fresh', refresh_token: 'rt2', expires_at: 5 }),
  })
  assert.deepEqual(await ok.run(), { result: 'ok' })
  assert.deepEqual(ok.persisted, [
    { vmId: 'vm-1', patch: { access_token: 'fresh', refresh_token: 'rt2', id_token: 'id', expires_at: 5 } },
  ])

  const forbidden = probeWith({
    files: accountFiles({ access_token: 'old', refresh_token: 'rt' }),
    catalog: async () => ({ ok: false, error: 'upstream_auth' }),
    refresh: async () => ({ ok: true, access_token: 'fresh' }),
  })
  assert.deepEqual(await forbidden.run(), { result: 'forbidden', error: 'upstream_forbidden' })

  const rejected = probeWith({
    files: accountFiles({ access_token: 'old', refresh_token: 'rt' }),
    catalog: async () => ({ ok: false, error: 'upstream_auth' }),
  })
  assert.deepEqual(await rejected.run(), { result: 'auth_failed', error: 'refresh_rejected' })

  const flaky = probeWith({
    files: accountFiles({ access_token: 'old', refresh_token: 'rt' }),
    catalog: async () => ({ ok: false, error: 'upstream_auth' }),
    refresh: async () => ({ ok: false, error: 'timeout' }),
  })
  assert.deepEqual(await flaky.run(), { result: 'transient', error: 'timeout' })

  const noRefresh = probeWith({
    files: accountFiles({ access_token: 'old' }),
    catalog: async () => ({ ok: false, error: 'upstream_auth' }),
  })
  assert.deepEqual(await noRefresh.run(), { result: 'auth_failed', error: 'no_refresh_token' })
})

test('probe: network errors and a missing exit are transient', async () => {
  const net = probeWith({
    files: accountFiles({ access_token: 'a' }),
    catalog: async () => ({ ok: false, error: 'timeout' }),
  })
  assert.deepEqual(await net.run(), { result: 'transient', error: 'timeout' })
  const noExit = probeWith({
    files: accountFiles({ access_token: 'a' }),
    catalog: async () => ({ ok: true }),
    proxy: '',
  })
  assert.deepEqual(await noExit.run(), { result: 'transient', error: 'proxy_required' })
  const local = probeWith({
    files: accountFiles({ access_token: 'a' }),
    catalog: async () => ({ ok: true }),
    proxy: '',
    direct: true,
  })
  assert.deepEqual(await local.run(), { result: 'ok' })
  assert.equal(local.fetched[0].direct, true)
  const empty = probeWith({ files: accountFiles({}), catalog: async () => ({ ok: true }) })
  assert.deepEqual(await empty.run(), { result: 'auth_failed', error: 'no_credential' })
})

function guardSetup(t, { verdicts = {}, config } = {}) {
  const prev = process.env.VM2API_DB_SECRET
  process.env.VM2API_DB_SECRET = 'guard-test-secret'
  t.after(() => {
    if (prev === undefined) delete process.env.VM2API_DB_SECRET
    else process.env.VM2API_DB_SECRET = prev
  })
  let clock = Date.UTC(2026, 10, 24)
  const profiles = createCodexLoginProfiles({ settings: memorySettings(), now: () => clock })
  const vms = {}
  for (const id of ['vm-1', 'vm-2', 'vm-3']) {
    vms[id] = { id, platform: 'openai' }
    profiles.save(id, { email: `${id}@x.com`, password: 'PW' })
  }
  const calls = { probe: [], dead: [], relogin: [] }
  const guard = createCodexLoginGuard({
    profiles,
    relogin: {
      status: () => ({ state: 'idle' }),
      request: (vmId, opts) => {
        calls.relogin.push({ vmId, ...opts })
        return { ok: true }
      },
    },
    readConfig: () =>
      config || {
        endpoint: 'http://127.0.0.1:8788',
        service_token: 'tok-guard',
        guard_enabled: true,
        guard: { fail_threshold: 2 },
      },
    getVm: (id) => vms[id] || null,
    isCodexVm: (vm) => vm.platform === 'openai',
    probe: async (vm) => {
      calls.probe.push(vm.id)
      const list = verdicts[vm.id]
      return (Array.isArray(list) ? list.shift() : list) || { result: 'ok' }
    },
    markDead: (vmId) => calls.dead.push(vmId),
    maxPerTick: 2,
    now: () => clock,
  })
  return { profiles, guard, calls, vms, advance: (ms) => (clock += ms) }
}

test('guard: consecutive auth failures take the slot out and queue an automatic re-login', async (t) => {
  const { profiles, guard, calls, advance } = guardSetup(t, {
    verdicts: {
      'vm-1': [
        { result: 'auth_failed', error: 'refresh_rejected' },
        { result: 'auth_failed', error: 'refresh_rejected' },
      ],
    },
  })
  const first = await guard.tick()
  assert.equal(first.probed, 2)
  assert.deepEqual(calls.dead, [])
  const state = profiles.get('vm-1').state
  assert.deepEqual([state.auth_fail_streak, state.last_probe_result], [1, 'refresh_rejected'])
  assert.equal(state.next_probe_at, Date.UTC(2026, 10, 24) + 5 * 60_000)
  assert.equal(profiles.get('vm-2').state.next_probe_at, Date.UTC(2026, 10, 24) + 30 * 60_000)

  await guard.tick()
  assert.deepEqual(calls.probe, ['vm-1', 'vm-2', 'vm-3'])
  advance(5 * 60_000)
  await guard.tick()
  assert.deepEqual(calls.dead, ['vm-1'])
  assert.deepEqual(calls.relogin, [{ vmId: 'vm-1', trigger: 'auto' }])
})

test('guard: nudged slots go first; paused, off and non-GPT slots are skipped', async (t) => {
  const { profiles, guard, calls, vms, advance } = guardSetup(t)
  await guard.tick()
  await guard.tick()
  calls.probe.length = 0
  guard.nudge('vm-3')
  const nudged = await guard.tick()
  assert.equal(nudged.probed, 1)
  assert.deepEqual(calls.probe, ['vm-3'])

  advance(31 * 60_000)
  calls.probe.length = 0
  profiles.patchState('vm-1', { auto_paused: 'too_many_failures' })
  profiles.setAutoRelogin('vm-2', false)
  vms['vm-3'].platform = 'anthropic'
  assert.equal((await guard.tick()).probed, 0)
  assert.deepEqual(calls.probe, [])
})

test('guard: off when the guard or the service is not configured (including missing token)', async (t) => {
  const off = guardSetup(t, {
    config: { endpoint: 'http://127.0.0.1:8788', service_token: 'tok', guard_enabled: false },
  })
  assert.equal((await off.guard.tick()).probed, 0)
  const noService = guardSetup(t, { config: { endpoint: '', guard_enabled: true } })
  assert.equal((await noService.guard.tick()).probed, 0)
  const noToken = guardSetup(t, { config: { endpoint: 'http://127.0.0.1:8788', guard_enabled: true } })
  assert.equal((await noToken.guard.tick()).probed, 0)
})
