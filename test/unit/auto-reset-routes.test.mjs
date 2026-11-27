import test from 'node:test'
import assert from 'node:assert/strict'
import { createAutoResetRoutes } from '../../src/lib/admin/auto-reset-routes.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'
import { createAutoResetRuntime } from '../../src/lib/oauth/auto-reset-runtime.mjs'

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
  const vms = {
    'vm-gpt': {
      id: 'vm-gpt',
      name: 'GPT One',
      platform: 'openai',
      family: 'codex',
      codex: { reset_credits: { available_count: 2, credits: [] } },
    },
    'vm-claude': {
      id: 'vm-claude',
      name: 'Claude One',
      platform: 'anthropic',
      family: 'claude',
    },
  }
  const runtime = createAutoResetRuntime({
    projectRoot: '/tmp/unused',
    settings: () => settings,
    lookupVm: (id) => vms[id] || null,
    listAllVms: () => Object.values(vms),
    log: () => {},
  })
  const routes = createAutoResetRoutes({
    runtime,
    json: (res, status, body) => {
      res.status = status
      res.body = body
      return res
    },
    readBody: async (req) => req.body,
    ok: (data) => ({ ok: true, data }),
  })
  return { runtime, routes }
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

async function callSlot(routes, method, vmId, body) {
  const headers = {}
  const res = {
    setHeader(k, v) {
      headers[k] = v
    },
  }
  await routes.handleSlot({ method, body }, res, vmId)
  return { status: res.status, body: res.body, headers }
}

test('auto-reset global and per-slot routes support CRUD, validation, and no-store header', async () => {
  const { routes } = makeHarness()

  const g1 = await callGlobal(routes, 'GET', '/api/panel/auto-reset/config')
  assert.equal(g1.status, 200)
  assert.equal(g1.headers['Cache-Control'], 'no-store')
  assert.equal(g1.body.data.config.codex.enabled, false)
  assert.equal(g1.body.data.summary.total_gpt_slots, 1)
  assert.equal(g1.body.data.summary.total_vouchers, 2)

  const g2 = await callGlobal(routes, 'PUT', '/api/panel/auto-reset/config', {
    codex: { enabled: true, triggers: { five_hour: true }, max_per_day: 2 },
  })
  assert.equal(g2.status, 200)
  assert.equal(g2.body.data.config.codex.enabled, true)
  assert.equal(g2.body.data.config.codex.triggers.five_hour, true)

  const badGlobal = await callGlobal(routes, 'PUT', '/api/panel/auto-reset/config', {
    codex: { cooldown_min: 0 },
  })
  assert.equal(badGlobal.status, 400)
  assert.equal(badGlobal.body.error.code, 'invalid_cooldown_min')

  // Slot GET/PUT/DELETE for Codex slot
  const s1 = await callSlot(routes, 'GET', 'vm-gpt')
  assert.equal(s1.status, 200)
  assert.equal(s1.body.data.eligible, true)
  assert.equal(s1.body.data.effective.enabled, true)

  const s2 = await callSlot(routes, 'PUT', 'vm-gpt', {
    mode: 'disabled',
    overrides: { prefer_voucher_over_credits: false, min_reset_remaining_min: 45 },
  })
  assert.equal(s2.status, 200)
  assert.equal(s2.body.data.mode, 'disabled')
  assert.equal(s2.body.data.effective.enabled, false)
  assert.equal(s2.body.data.effective.prefer_voucher_over_credits, false)
  assert.equal(s2.body.data.effective.min_reset_remaining_min, 45)

  const s3 = await callSlot(routes, 'DELETE', 'vm-gpt')
  assert.equal(s3.status, 200)
  assert.equal(s3.body.data.mode, 'inherit')
  assert.equal(s3.body.data.has_overrides, false)

  // Non-Codex slot returns eligible: false on GET and 400 on PUT
  const claudeGet = await callSlot(routes, 'GET', 'vm-claude')
  assert.equal(claudeGet.status, 200)
  assert.equal(claudeGet.body.data.eligible, false)
  const claudePut = await callSlot(routes, 'PUT', 'vm-claude', { mode: 'enabled' })
  assert.equal(claudePut.status, 400)
  assert.equal(claudePut.body.error.code, 'vm_not_codex')

  // Slots summary and events list
  const slots = await callGlobal(routes, 'GET', '/api/panel/auto-reset/slots')
  assert.equal(slots.status, 200)
  assert.equal(slots.body.data.items.length, 1)
  const events = await callGlobal(routes, 'GET', '/api/panel/auto-reset/events')
  assert.equal(events.status, 200)
  assert.deepEqual(events.body.data.items, [])
})

test('panel ACL denies tenant on global /api/panel/auto-reset/* and allows per-slot /api/panel/vms/:id/auto-reset', () => {
  assert.equal(authorizePanelRoute('GET', '/api/panel/auto-reset/config', 'admin').ok, true)
  assert.equal(authorizePanelRoute('PUT', '/api/panel/auto-reset/config', 'admin').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/auto-reset/config', 'user').ok, false)
  assert.equal(authorizePanelRoute('PUT', '/api/panel/auto-reset/config', 'user').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/auto-reset/slots', 'user').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/auto-reset/events', 'user').ok, false)

  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-gpt/auto-reset', 'user').ok, true)
  assert.equal(authorizePanelRoute('PUT', '/api/panel/vms/vm-gpt/auto-reset', 'user').ok, true)
  assert.equal(authorizePanelRoute('DELETE', '/api/panel/vms/vm-gpt/auto-reset', 'user').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-gpt/auto-reset', 'user').ok, false)
})
