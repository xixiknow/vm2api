import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAutoResetRuntime } from '../../src/lib/oauth/auto-reset-runtime.mjs'
import { resetOpenaiQuota } from '../../src/lib/oauth/openai-quota.mjs'

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

const BASE_NOW = Date.parse('2026-11-26T04:00:00Z')
const HOUR_MS = 3_600_000

function codexVmFixture(id, overrides = {}) {
  return {
    id,
    name: `GPT ${id}`,
    platform: 'openai',
    family: 'codex',
    status: 'running',
    schedulable: true,
    has_token: true,
    has_refresh: true,
    proxy: { id: 'px-1', host: '127.0.0.1', port: 1080 },
    policy: {},
    codex: {
      extra: {
        codex_primary_used_percent: 100,
        codex_primary_window_minutes: 10080,
        codex_primary_reset_at: new Date(BASE_NOW + 4 * 24 * HOUR_MS).toISOString(),
        codex_secondary_used_percent: 50,
        codex_secondary_window_minutes: 300,
        codex_secondary_reset_at: new Date(BASE_NOW + 3 * HOUR_MS).toISOString(),
      },
      credits: {
        has_credits: true,
        unlimited: false,
        balance: '500',
        fetched_at: new Date(BASE_NOW - 60_000).toISOString(),
      },
      reset_credits: {
        available_count: 2,
        credits: [{ expires_at: new Date(BASE_NOW + 15 * 24 * HOUR_MS).toISOString() }],
        fetched_at: new Date(BASE_NOW - 60_000).toISOString(),
      },
    },
    ...overrides,
  }
}

test('7d full (even with spendable credits) queries live, redeems voucher, clears rate_limited hold, wakes waiters, and logs event', async () => {
  const settings = memorySettings()
  let clock = BASE_NOW
  const vm = codexVmFixture('vm-01')
  const holds = new Map([['vm-01', { until: clock + 60_000, reason: 'rate_limited' }]])
  const woken = []
  let queryCalls = 0
  let resetCalls = 0

  const runtime = createAutoResetRuntime({
    projectRoot: '/tmp/unused',
    settings: () => settings,
    lookupVm: (id) => (id === 'vm-01' ? vm : null),
    listAllVms: () => [vm],
    queryQuota: async () => {
      queryCalls += 1
      return { ok: true, reset_credits: vm.codex.reset_credits }
    },
    resetQuota: async () => {
      resetCalls += 1
      vm.codex.extra.codex_primary_used_percent = 0
      vm.codex.reset_credits.available_count = 1
      return { ok: true, windows_reset: 1 }
    },
    getHold: (id) => holds.get(id) || null,
    clearHold: (id) => holds.delete(id),
    wakeWaiter: (id) => woken.push(id),
    now: () => clock,
    log: () => {},
  })

  runtime.saveConfigPatch({ codex: { enabled: true } })
  runtime.start()
  try {
    const out = await runtime.tick()
    assert.equal(out.checked, 1)
    assert.equal(queryCalls, 1)
    assert.equal(resetCalls, 1)
    assert.equal(holds.has('vm-01'), false)
    assert.deepEqual(woken, ['vm-01'])

    const slot = runtime.store.getSlot('vm-01')
    assert.equal(slot.state.daily_count, 1)
    assert.equal(slot.state.last_result, 'reset')
    assert.equal(slot.state.last_trigger_window, '7d')
    assert.equal(slot.state.consecutive_failures, 0)

    const events = runtime.listEvents()
    assert.equal(events.length, 1)
    assert.equal(events[0].outcome, 'reset')
    assert.equal(events[0].vm_id, 'vm-01')
  } finally {
    runtime.stop()
  }
})

test('redeem with reset_credit_cache_refresh_failed still enforces cooldown so a stale 100% snapshot never double-spends', async () => {
  const settings = memorySettings()
  let clock = BASE_NOW
  const vm = codexVmFixture('vm-02')
  let resetCalls = 0

  const runtime = createAutoResetRuntime({
    projectRoot: '/tmp/unused',
    settings: () => settings,
    lookupVm: () => vm,
    listAllVms: () => [vm],
    queryQuota: async () => ({ ok: true, reset_credits: vm.codex.reset_credits }),
    resetQuota: async () => {
      resetCalls += 1
      // Simulate readback failure: vm.codex.extra stays at 100%!
      return { ok: true, warning: 'reset_credit_cache_refresh_failed', windows_reset: 1 }
    },
    getHold: () => null,
    clearHold: () => {},
    wakeWaiter: () => {},
    now: () => clock,
    log: () => {},
  })

  runtime.saveConfigPatch({ codex: { enabled: true, cooldown_min: 10 } })
  runtime.start()
  try {
    await runtime.tick()
    assert.equal(resetCalls, 1)
    assert.equal(runtime.store.getSlot('vm-02').state.last_result, 'reset_refresh_failed')

    // 5 minutes later (still inside 10 min cooldown): must NOT spend a second voucher!
    clock += 5 * 60_000
    await runtime.tick()
    assert.equal(resetCalls, 1)
  } finally {
    runtime.stop()
  }
})

test('zero vouchers triggers no_card backoff, lifted immediately by invalidateNoCardBackoff', async () => {
  const settings = memorySettings()
  let clock = BASE_NOW
  const vm = codexVmFixture('vm-03')
  vm.codex.reset_credits = { available_count: 0, credits: [], fetched_at: new Date(clock).toISOString() }
  let queryCalls = 0

  const runtime = createAutoResetRuntime({
    projectRoot: '/tmp/unused',
    settings: () => settings,
    lookupVm: () => vm,
    listAllVms: () => [vm],
    queryQuota: async () => {
      queryCalls += 1
      return { ok: true, reset_credits: vm.codex.reset_credits }
    },
    resetQuota: async () => ({ ok: true }),
    getHold: () => null,
    clearHold: () => {},
    wakeWaiter: () => {},
    now: () => clock,
    log: () => {},
  })

  runtime.saveConfigPatch({ codex: { enabled: true, no_card_recheck_min: 30 } })
  runtime.start()
  try {
    await runtime.tick()
    assert.equal(queryCalls, 1)
    assert.equal(runtime.store.getSlot('vm-03').state.last_result, 'no_cards')

    // 10 minutes later: skipped without hitting upstream
    clock += 10 * 60_000
    await runtime.tick()
    assert.equal(queryCalls, 1)

    // Manual refresh invalidates backoff immediately
    runtime.invalidateNoCardBackoff('vm-03')
    await runtime.tick()
    assert.equal(queryCalls, 2)
  } finally {
    runtime.stop()
  }
})

test('3 consecutive redeem failures auto-pause slot until manually resumed; max_per_day and resting slots are skipped', async () => {
  const settings = memorySettings()
  let clock = BASE_NOW
  const vm = codexVmFixture('vm-04')
  let resetCalls = 0

  const runtime = createAutoResetRuntime({
    projectRoot: '/tmp/unused',
    settings: () => settings,
    lookupVm: () => vm,
    listAllVms: () => [vm],
    queryQuota: async () => ({ ok: true, reset_credits: vm.codex.reset_credits }),
    resetQuota: async () => {
      resetCalls += 1
      return { ok: false, error: 'upstream_error', status: 502 }
    },
    getHold: () => null,
    clearHold: () => {},
    wakeWaiter: () => {},
    now: () => clock,
    log: () => {},
  })

  runtime.saveConfigPatch({ codex: { enabled: true, cooldown_min: 1 } })
  runtime.start()
  try {
    await runtime.tick()
    clock += 2 * 60_000
    await runtime.tick()
    clock += 2 * 60_000
    await runtime.tick()
    assert.equal(resetCalls, 3)
    assert.equal(runtime.store.getSlot('vm-04').state.auto_paused, true)
    assert.equal(runtime.store.getSlot('vm-04').state.paused_reason, 'consecutive_failures')

    // Next tick does nothing while paused
    clock += 5 * 60_000
    await runtime.tick()
    assert.equal(resetCalls, 3)

    // Resume lifts pause
    runtime.saveSlotPatch('vm-04', { resume: true })
    assert.equal(runtime.store.getSlot('vm-04').state.auto_paused, false)

    // Resting active_hours (UTC 04:00 is outside 09:00-17:00 UTC) skips cleanly
    vm.policy = { active_hours: { start: '09:00', end: '17:00', timezone: 'UTC' } }
    await runtime.tick()
    assert.equal(resetCalls, 3)

    // Back inside active hours, but max_per_day already reached -> skips cleanly
    vm.policy = {}
    runtime.saveSlotPatch('vm-04', { overrides: { max_per_day: 1 } })
    runtime.store.patchSlotState('vm-04', (st) => {
      st.daily_count = 1
      return st
    })
    await runtime.tick()
    assert.equal(resetCalls, 3)
  } finally {
    runtime.stop()
  }
})

test('resetOpenaiQuota enforces per-slot single-flight lock to prevent concurrent manual+auto double-spend', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-autoreset-lock-'))
  try {
    fs.mkdirSync(path.join(dir, 'vms', 'vm-lock', 'cli-home', '.codex'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'vms', 'vm-lock.json'),
      JSON.stringify({
        id: 'vm-lock',
        platform: 'openai',
        family: 'codex',
        proxy: { kind: 'local' },
        codex: { access_token: 'tok-a', chatgpt_account_id: 'acct-1' },
      }),
    )
    let releaseFirst
    const gate = new Promise((resolve) => {
      releaseFirst = resolve
    })
    let consumeCalls = 0
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/consume')) {
        consumeCalls += 1
        await gate
        return { status: 200, json: async () => ({ code: 'ok', windows_reset: 1 }) }
      }
      return { status: 200, json: async () => ({ rate_limit: {}, rate_limit_reset_credits: { available_count: 1 } }) }
    }

    const first = resetOpenaiQuota({ projectRoot: dir, vmId: 'vm-lock', fetchImpl })
    // Allow first call to enter consume()
    await new Promise((r) => setTimeout(r, 20))
    const second = await resetOpenaiQuota({ projectRoot: dir, vmId: 'vm-lock', fetchImpl })
    assert.equal(second.ok, false)
    assert.equal(second.error, 'reset_in_progress')
    assert.equal(second.status, 409)

    releaseFirst()
    const firstResult = await first
    assert.equal(firstResult.ok, true)
    assert.equal(consumeCalls, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
