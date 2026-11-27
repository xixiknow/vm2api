import test from 'node:test'
import assert from 'node:assert/strict'
import { createGptIqRuntime } from '../../src/lib/iq/gpt-iq-runtime.mjs'
import { createManxueBridge } from '../../src/lib/iq/manxue-bridge.mjs'
import { applyClearUnschedulable, applyUnschedulable, stateOfReason } from '../../src/lib/pool/schedule-state.mjs'

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

function makeCodexVm(id, over = {}) {
  return {
    id,
    name: `GPT ${id}`,
    platform: 'openai',
    family: 'codex',
    status: 'running',
    schedulable: true,
    has_token: true,
    has_refresh: true,
    proxy: { id: 'px-1', url: 'socks5://1.2.3.4:1080', status: 'healthy', enabled: true },
    utilization_5h: 0.2,
    utilization_7d: 0.3,
    ...over,
  }
}

test('schedule-state registers gpt_iq_degraded and iq_recovered cleanly', () => {
  const st = stateOfReason('gpt_iq_degraded')
  assert.equal(st?.state, 'unschedulable')
  assert.equal(st?.text, '测智降智隔离')

  const vm = makeCodexVm('vm-s')
  applyUnschedulable(vm, 'gpt_iq_degraded', { model: 'gpt-6-astra' })
  assert.equal(vm.schedulable, false)
  assert.equal(vm.schedule_disabled_reason, 'gpt_iq_degraded')
  assert.equal(vm.unschedulable.reason, 'gpt_iq_degraded')

  applyClearUnschedulable(vm, { by: 'iq_recovered' })
  assert.equal(vm.schedulable, true)
  assert.equal(vm.unschedulable, undefined)
})

test('runtime isolates degraded GPT slot, saves HTML preview, pauses scheduled checks, and allows manual re-test & unisolate', async () => {
  let clock = Date.parse('2026-11-27T02:00:00Z')
  const settings = memorySettings()
  const bridge = createManxueBridge({ now: () => clock, sweepIntervalMs: 0 })
  const vms = { 'vm-gpt-1': makeCodexVm('vm-gpt-1') }
  const isolatedCalls = []
  const clearedCalls = []
  let nextPollPayload = {
    benchmark: 'pelican',
    status: 'succeeded',
    result: { html: '<!doctype html><html><svg>degraded</svg></html>', duration_ms: 42000 },
    assessment: { quality: 'degraded', label: '疑似降智', reason: '动画退化', source: 'source_classifier:v1' },
  }

  const runtime = createGptIqRuntime({
    projectRoot: '/tmp/unused',
    bridge,
    getPublicBaseUrl: () => 'https://gw.example.com',
    settings: () => settings,
    lookupVm: (id) => vms[id] || null,
    listAllVms: () => Object.values(vms),
    getHold: () => null,
    markSlotUnschedulable: (id, reason, detail) => {
      isolatedCalls.push({ id, reason, detail })
      applyUnschedulable(vms[id], reason, detail, { now: clock })
      return vms[id]
    },
    clearSlotUnschedulable: (id, opts) => {
      clearedCalls.push({ id, opts })
      applyClearUnschedulable(vms[id], { by: opts.by, now: clock })
      return vms[id]
    },
    createTest: async (args) => {
      assert.match(args.baseUrl, /^https:\/\/gw\.example\.com\/api\/manxue-bridge\/[a-f0-9]+$/)
      assert.equal(args.benchmark, 'pelican')
      return { ok: true, id: 'mx-1', data: { id: 'mx-1', status: 'running' } }
    },
    pollTest: async () => ({ ok: true, data: nextPollPayload }),
    now: () => clock,
    random: () => 0,
    log: () => {},
  })

  // Enable global 5-minute check
  const saved = runtime.saveConfigPatch({ enabled: true, interval_min: 5 })
  assert.equal(saved.ok, true)

  // Manual run triggers degradation -> automatic isolation
  const res1 = await runtime.runNow('vm-gpt-1', { wait: true })
  assert.equal(res1.ok, true)
  assert.equal(res1.status, 'degraded')
  assert.equal(res1.isolated, true)
  assert.equal(isolatedCalls.length, 1)
  assert.equal(isolatedCalls[0].reason, 'gpt_iq_degraded')
  assert.equal(vms['vm-gpt-1'].schedulable, false)
  // Bridge ticket must be revoked immediately after completion
  assert.equal(bridge.activeCount(), 0)

  // Artifact saved for preview
  const artifact = runtime.getArtifact('vm-gpt-1')
  assert.equal(artifact?.kind, 'html')
  assert.match(artifact?.html || '', /degraded/)

  // Summary reflects isolated + 24h degraded count
  const summary = runtime.vmSummaryForPanel(vms['vm-gpt-1'])
  assert.equal(summary.isolated, true)
  assert.equal(summary.status, 'degraded')
  assert.equal(summary.has_artifact, true)
  assert.equal(summary.summary_24h.degraded, 1)

  // Scheduled tick skips isolated slot even after 10 minutes
  runtime.start()
  clock += 10 * 60_000
  const tickRes = runtime.tick()
  assert.equal(tickRes.enqueued, 0)

  // Manual re-test STILL works on isolated slot
  nextPollPayload = {
    benchmark: 'pelican',
    status: 'succeeded',
    result: { html: '<!doctype html><html><svg>healthy</svg></html>', duration_ms: 35000 },
    assessment: { quality: 'normal', label: '正常', reason: '恢复正常', source: 'source_classifier:v1' },
  }
  const res2 = await runtime.runNow('vm-gpt-1', { wait: true })
  assert.equal(res2.ok, true)
  assert.equal(res2.status, 'normal')
  assert.equal(res2.isolated, false)

  // Unisolate restores scheduling
  const uniso = runtime.unisolate('vm-gpt-1')
  assert.equal(uniso.ok, true)
  assert.equal(vms['vm-gpt-1'].schedulable, true)
  assert.equal(clearedCalls.length, 1)
  assert.equal(clearedCalls[0].opts.by, 'iq_recovered')

  runtime.stop()
  bridge.stop()
})

test('runtime does not isolate reference-only degradation unless isolate_on_reference is enabled', async () => {
  const clock = Date.parse('2026-11-27T02:00:00Z')
  const settings = memorySettings()
  const bridge = createManxueBridge({ now: () => clock, sweepIntervalMs: 0 })
  const vms = { 'vm-ref': makeCodexVm('vm-ref') }
  let isolated = 0

  const runtime = createGptIqRuntime({
    projectRoot: '/tmp/unused',
    bridge,
    getPublicBaseUrl: () => 'https://gw.example.com',
    settings: () => settings,
    lookupVm: (id) => vms[id] || null,
    listAllVms: () => Object.values(vms),
    getHold: () => null,
    markSlotUnschedulable: () => {
      isolated += 1
    },
    createTest: async () => ({ ok: true, id: 'mx-ref' }),
    pollTest: async () => ({
      ok: true,
      data: {
        benchmark: 'pelican',
        status: 'succeeded',
        result: { html: '<html>ref</html>' },
        assessment: {
          quality: 'degraded',
          label: '参考',
          reason: '分类器基于 gpt-6-astra 训练，无法保证其他模型测试的准确性。',
        },
      },
    }),
    now: () => clock,
    log: () => {},
  })

  runtime.saveConfigPatch({ model: 'gpt-6.2-astra', isolate_on_reference: false })
  const res = await runtime.runNow('vm-ref', { wait: true })
  assert.equal(res.ok, true)
  assert.equal(res.isolated, false)
  assert.equal(isolated, 0)
  bridge.stop()
})

test('runtime skips high-quota slots during scheduled tick and backs off globally on 429', async () => {
  let clock = Date.parse('2026-11-27T02:00:00Z')
  const settings = memorySettings()
  const bridge = createManxueBridge({ now: () => clock, sweepIntervalMs: 0 })
  const vms = {
    'vm-high': makeCodexVm('vm-high', { utilization_5h: 0.95 }),
    'vm-ok': makeCodexVm('vm-ok', { utilization_5h: 0.1 }),
  }
  let createdCount = 0

  const runtime = createGptIqRuntime({
    projectRoot: '/tmp/unused',
    bridge,
    getPublicBaseUrl: () => 'https://gw.example.com',
    settings: () => settings,
    lookupVm: (id) => vms[id] || null,
    listAllVms: () => Object.values(vms),
    getHold: () => null,
    createTest: async () => {
      createdCount += 1
      return { ok: false, status: 429, rateLimited: true, retryAfterMs: 30_000, error: 'rate_limited' }
    },
    now: () => clock,
    random: () => 0,
    log: () => {},
  })

  runtime.saveConfigPatch({ enabled: true, interval_min: 5, skip_quota_pct: 90, min_gap_sec: 0 })
  runtime.start()
  clock += 6 * 60_000
  const tick1 = runtime.tick()
  // Only vm-ok should be enqueued; vm-high is skipped for quota >= 90%
  assert.equal(tick1.enqueued, 1)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(createdCount, 1)

  // Global backoff recorded on 429
  assert.ok(runtime.listSlotSummaries().summary.global_backoff_until)
  runtime.stop()
  bridge.stop()
})
