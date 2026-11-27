import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodexLoginQueue } from '../../src/lib/oauth/codex-login-queue.mjs'

function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('enforces global cap and prioritizes manual/slot login ahead of auto relogin and batch', async () => {
  const queue = createCodexLoginQueue({ getMaxConcurrency: () => 1 })
  const gate = deferred()
  const order = []

  const first = queue.run({ priority: 'batch' }, async () => {
    order.push('first')
    await gate.promise
    return { ok: true }
  })
  const b1 = queue.run({ priority: 'batch' }, async () => {
    order.push('batch')
    return { ok: true }
  })
  const a1 = queue.run({ priority: 'auto_relogin' }, async () => {
    order.push('auto')
    return { ok: true }
  })
  const m1 = queue.run({ priority: 'manual_relogin' }, async () => {
    order.push('manual')
    return { ok: true }
  })

  assert.equal(queue.snapshot().active, 1)
  assert.equal(queue.snapshot().queued, 3)
  gate.resolve()
  await Promise.all([first, b1, a1, m1])
  assert.deepEqual(order, ['first', 'manual', 'auto', 'batch'])
  assert.equal(queue.snapshot().active, 0)
  assert.equal(queue.snapshot().queued, 0)
})

test('serializes same proxy resourceKey while letting other proxies run in parallel without head-of-line blocking', async () => {
  const queue = createCodexLoginQueue({ getMaxConcurrency: () => 2 })
  const g1 = deferred()
  const started = []

  const t1 = queue.run({ priority: 'batch', resourceKey: 'proxy:px-1' }, async () => {
    started.push('t1-px1')
    await g1.promise
    return { ok: true }
  })
  const t2SameProxy = queue.run({ priority: 'batch', resourceKey: 'proxy:px-1' }, async () => {
    started.push('t2-px1')
    return { ok: true }
  })
  const t3OtherProxy = queue.run({ priority: 'batch', resourceKey: 'proxy:px-2' }, async () => {
    started.push('t3-px2')
    return { ok: true }
  })

  await new Promise((r) => setTimeout(r, 10))
  // t3 on px-2 bypassed queued t2 on busy px-1.
  assert.deepEqual(started, ['t1-px1', 't3-px2'])
  assert.equal(queue.snapshot().active, 1)
  assert.equal(queue.snapshot().queued, 1)
  g1.resolve()
  await Promise.all([t1, t2SameProxy, t3OtherProxy])
  assert.deepEqual(started, ['t1-px1', 't3-px2', 't2-px1'])
})

test('canceling a queued waiter removes it immediately without leaking permits', async () => {
  const queue = createCodexLoginQueue({ getMaxConcurrency: () => 1 })
  const g = deferred()
  const ac = new AbortController()

  const active = queue.run({ priority: 'batch' }, async () => {
    await g.promise
    return { ok: true }
  })
  const canceled = queue.run({ priority: 'batch', signal: ac.signal }, async () => {
    assert.fail('canceled waiter must not run')
  })
  assert.equal(queue.snapshot().queued, 1)
  ac.abort()
  assert.deepEqual(await canceled, { ok: false, error: 'canceled' })
  assert.equal(queue.snapshot().queued, 0)
  g.resolve()
  await active
  assert.equal(queue.snapshot().active, 0)
})

test('runWithBackoff pauses and retries capacity_exceeded with a fresh callback invocation', async () => {
  const queue = createCodexLoginQueue({ getMaxConcurrency: () => 2 })
  let attempts = 0
  const outcome = await queue.runWithBackoff({ priority: 'batch', maxCapacityRetries: 2 }, async () => {
    attempts++
    if (attempts === 1) return { ok: false, error: 'capacity_exceeded', retryAfterMs: 25 }
    return { ok: true, attempt: attempts }
  })
  assert.deepEqual(outcome, { ok: true, attempt: 2 })
  assert.equal(attempts, 2)
  queue.stop()
})
