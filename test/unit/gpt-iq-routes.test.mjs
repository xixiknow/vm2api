import test from 'node:test'
import assert from 'node:assert/strict'
import { createGptIqRoutes } from '../../src/lib/admin/gpt-iq-routes.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'
import { createGptIqRuntime } from '../../src/lib/iq/gpt-iq-runtime.mjs'
import { createManxueBridge } from '../../src/lib/iq/manxue-bridge.mjs'

function memorySettings() {
  const map = new Map()
  return {
    get(key, fallback = null) {
      return map.has(key) ? structuredClone(map.get(key)) : fallback
    },
    set(key, value) {
      map.set(key, structuredClone(value))
      return value
    },
    has(key) {
      return map.has(key)
    },
    remove(key) {
      map.delete(key)
    },
    all() {
      return Object.fromEntries([...map.entries()].map(([k, v]) => [k, structuredClone(v)]))
    },
  }
}

function makeHarness() {
  const settings = memorySettings()
  const bridge = createManxueBridge({ sweepIntervalMs: 0 })
  const vms = {
    'vm-gpt': {
      id: 'vm-gpt',
      name: 'GPT One',
      platform: 'openai',
      family: 'codex',
      status: 'running',
      schedulable: true,
      has_token: true,
      proxy: { id: 'p1', url: 'socks5://1.2.3.4:1080', status: 'healthy', enabled: true },
    },
    'vm-claude': {
      id: 'vm-claude',
      name: 'Claude One',
      platform: 'anthropic',
      family: 'claude',
    },
  }
  const runtime = createGptIqRuntime({
    projectRoot: '/tmp/unused',
    bridge,
    getPublicBaseUrl: () => 'https://gw.example.com',
    settings: () => settings,
    lookupVm: (id) => vms[id] || null,
    listAllVms: () => Object.values(vms),
    createTest: async () => ({ ok: true, id: 'mx-route-1' }),
    pollTest: async () => ({
      ok: true,
      data: {
        benchmark: 'pelican',
        status: 'succeeded',
        result: { html: '<html><svg/></html>', duration_ms: 12000 },
        assessment: { quality: 'normal', label: '正常', reason: '正常' },
      },
    }),
    log: () => {},
  })
  const routes = createGptIqRoutes({
    runtime,
    json: (res, status, body) => {
      res.status = status
      res.body = body
      return res
    },
    readBody: async (req) => req.body,
    ok: (data) => ({ ok: true, data }),
  })
  return { runtime, routes, bridge }
}

async function callGlobal(routes, method, pathname, body) {
  const headers = {}
  const res = {
    setHeader(k, v) {
      headers[k] = v
    },
  }
  await routes.handleGlobal({ method, body }, res, new URL(`http://127.0.0.1${pathname}`))
  return { status: res.status, body: res.body, headers }
}

async function callSlot(routes, method, vmId, action = '', body = undefined) {
  const headers = {}
  const res = {
    setHeader(k, v) {
      headers[k] = v
    },
  }
  await routes.handleSlot({ method, body }, res, vmId, action)
  return { status: res.status, body: res.body, headers }
}

test('gpt-iq global and per-slot routes handle config, overrides, run, artifact, and non-codex rejection', async () => {
  const { routes, bridge } = makeHarness()

  const g1 = await callGlobal(routes, 'GET', '/api/panel/gpt-iq/config')
  assert.equal(g1.status, 200)
  assert.equal(g1.headers['Cache-Control'], 'no-store')
  assert.equal(g1.body.data.config.benchmark, 'pelican')
  assert.equal(g1.body.data.config.interval_min, 5)
  assert.equal(g1.body.data.callback_ready, true)

  const badCb = await callGlobal(routes, 'PUT', '/api/panel/gpt-iq/config', {
    callback_base_url: 'http://insecure.example.com',
  })
  assert.equal(badCb.status, 400)
  assert.equal(badCb.body.error.code, 'callback_base_url_https_required')

  const g2 = await callGlobal(routes, 'PUT', '/api/panel/gpt-iq/config', {
    enabled: true,
    benchmark: 'candy',
    interval_min: 5,
  })
  assert.equal(g2.status, 200)
  assert.equal(g2.body.data.config.enabled, true)
  assert.equal(g2.body.data.config.benchmark, 'candy')

  // Non-codex slot rejected
  const nonCodex = await callSlot(routes, 'PUT', 'vm-claude', '', { mode: 'enabled' })
  assert.equal(nonCodex.status, 400)
  assert.equal(nonCodex.body.error.code, 'vm_not_codex')

  // Per-slot mode & override
  const sPut = await callSlot(routes, 'PUT', 'vm-gpt', '', {
    mode: 'enabled',
    overrides: { benchmark: 'pelican', interval_min: 10 },
  })
  assert.equal(sPut.status, 200)
  assert.equal(sPut.body.data.effective.benchmark, 'pelican')
  assert.equal(sPut.body.data.effective.interval_min, 10)

  // Artifact missing before run
  const art0 = await callSlot(routes, 'GET', 'vm-gpt', 'artifact')
  assert.equal(art0.status, 404)

  // Trigger manual run -> wait briefly -> artifact available
  const run = await callSlot(routes, 'POST', 'vm-gpt', 'run')
  assert.equal(run.status, 202)
  await new Promise((r) => setTimeout(r, 25))
  const art1 = await callSlot(routes, 'GET', 'vm-gpt', 'artifact')
  assert.equal(art1.status, 200)
  assert.equal(art1.body.data.artifact.kind, 'html')

  const slots = await callGlobal(routes, 'GET', '/api/panel/gpt-iq/slots')
  assert.equal(slots.status, 200)
  assert.equal(slots.body.data.items.length, 1)
  assert.equal(slots.body.data.items[0].summary.status, 'normal')
  bridge.stop()
})

test('panel ACL restricts global gpt-iq to admin and allows tenant per-slot iq-check routes', () => {
  assert.equal(authorizePanelRoute('GET', '/api/panel/gpt-iq/config', 'admin').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/gpt-iq/config', 'user').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/gpt-iq/config', 'super').ok, false)

  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-1/iq-check', 'user').ok, true)
  assert.equal(authorizePanelRoute('PUT', '/api/panel/vms/vm-1/iq-check', 'user').ok, true)
  assert.equal(authorizePanelRoute('DELETE', '/api/panel/vms/vm-1/iq-check', 'user').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-1/iq-check/run', 'user').ok, true)
  assert.equal(authorizePanelRoute('DELETE', '/api/panel/vms/vm-1/iq-check/run', 'user').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-1/iq-check/unisolate', 'user').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-1/iq-check/artifact', 'user').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-1/iq-check/run', 'super').ok, false)
})
