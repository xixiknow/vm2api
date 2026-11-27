/**
 * Unified global concurrency queue for all Codex Callback v2 login entries
 * (single-slot password login, manual relogin, auto relogin, and batch import).
 *
 * Features:
 *   - Single dynamic concurrency cap (`1..512`), shared across every login caller
 *   - Priority ordering: manual / single-slot (0) > auto relogin (1) > batch (2), FIFO within tier
 *   - Per-proxy anti-collision (`resourceKey`): at most 1 active login per proxy at a time;
 *     scans past head entries whose proxy is busy so other proxies run at full parallelism
 *   - Cancellation while queued immediately removes the waiter without leaking a permit
 *   - Global 429 / 503 Retry-After pacing gate + bounded retries for `capacity_exceeded`
 *     (each retry invokes the caller callback fresh so a brand-new OAuth session is created)
 */

export const LOGIN_PRIORITY = Object.freeze({
  slot_login: 0,
  manual_relogin: 0,
  auto_relogin: 1,
  batch: 2,
})

function normalizePriority(priority) {
  if (typeof priority === 'number' && Number.isFinite(priority)) return priority
  return LOGIN_PRIORITY[priority] ?? LOGIN_PRIORITY.batch
}

function clampConcurrency(value, fallback = 4) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(512, Math.max(1, Math.round(n)))
}

export function createCodexLoginQueue({ getMaxConcurrency = () => 4, now = () => Date.now(), log = () => {} } = {}) {
  const waiters = []
  const activeResources = new Set()
  let active = 0
  let seq = 0
  let pausedUntil = 0
  let backoffTimer = null
  let stopped = false

  function maxConcurrency() {
    return clampConcurrency(typeof getMaxConcurrency === 'function' ? getMaxConcurrency() : getMaxConcurrency, 4)
  }

  function scheduleWake() {
    clearTimeout(backoffTimer)
    backoffTimer = null
    if (stopped || !waiters.length) return
    const waitMs = pausedUntil - now()
    if (waitMs > 0) {
      backoffTimer = setTimeout(() => {
        backoffTimer = null
        pump()
      }, waitMs)
      backoffTimer.unref?.()
    }
  }

  function noteBackoff(ms) {
    const duration = Math.min(300_000, Math.max(1_000, Number(ms) || 15_000))
    const until = now() + duration
    if (until > pausedUntil) {
      pausedUntil = until
      log({ event: 'codex_login_queue_backoff', retry_after_ms: duration })
    }
    scheduleWake()
  }

  function releasePermit(resourceKey) {
    active = Math.max(0, active - 1)
    if (resourceKey) activeResources.delete(resourceKey)
    pump()
  }

  function pump() {
    if (stopped) return
    if (pausedUntil > now()) {
      scheduleWake()
      return
    }
    const limit = maxConcurrency()
    while (active < limit && waiters.length) {
      const idx = waiters.findIndex((w) => !w.resourceKey || !activeResources.has(w.resourceKey))
      if (idx < 0) break
      const waiter = waiters.splice(idx, 1)[0]
      waiter.cleanup()
      if (waiter.signal?.aborted) {
        waiter.resolve(null)
        continue
      }
      active++
      if (waiter.resourceKey) activeResources.add(waiter.resourceKey)
      let released = false
      let currentKey = waiter.resourceKey || null
      waiter.resolve({
        /**
         * Claim a proxy resource key after acquiring a bare global permit (used by batch rows
         * that allocate a proxy after reaching the front of the queue).
         * Returns false if that resource is already held by another active task.
         */
        claimResource(nextKey) {
          if (!nextKey || currentKey === nextKey) return true
          if (activeResources.has(nextKey)) return false
          if (currentKey) activeResources.delete(currentKey)
          currentKey = nextKey
          activeResources.add(nextKey)
          return true
        },
        release() {
          if (released) return
          released = true
          releasePermit(currentKey)
        },
      })
    }
  }

  function insertWaiter(entry) {
    let pos = waiters.length
    for (let i = 0; i < waiters.length; i++) {
      if (
        entry.priority < waiters[i].priority ||
        (entry.priority === waiters[i].priority && entry.seq < waiters[i].seq)
      ) {
        pos = i
        break
      }
    }
    waiters.splice(pos, 0, entry)
  }

  function acquire({ priority = 'batch', resourceKey = null, signal = null } = {}) {
    if (stopped) return Promise.resolve(null)
    if (signal?.aborted) return Promise.resolve(null)
    const key = resourceKey ? String(resourceKey) : null
    return new Promise((resolve) => {
      const entry = {
        seq: ++seq,
        priority: normalizePriority(priority),
        resourceKey: key,
        signal,
        resolve,
        cleanup: () => {},
      }
      const onAbort = () => {
        const idx = waiters.indexOf(entry)
        if (idx >= 0) {
          waiters.splice(idx, 1)
          entry.cleanup()
          resolve(null)
        }
      }
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
        entry.cleanup = () => signal.removeEventListener('abort', onAbort)
      }
      insertWaiter(entry)
      pump()
    })
  }

  /**
   * Run `fn(permit)` once a global slot (and optional `resourceKey`) is acquired.
   * Always releases the permit in `finally`.
   */
  async function run({ priority = 'batch', resourceKey = null, signal = null } = {}, fn) {
    const permit = await acquire({ priority, resourceKey, signal })
    if (!permit) {
      return { ok: false, error: stopped ? 'shutting_down' : 'canceled' }
    }
    try {
      return await fn(permit)
    } finally {
      permit.release()
    }
  }

  /**
   * Run an authentication attempt with bounded retries on `capacity_exceeded` (429).
   * Notes global backoff on 429 / 503; each retry calls `attemptFn` fresh so a brand-new
   * OAuth session (task_id / state / verifier) is created after the backoff window.
   */
  async function runWithBackoff(
    { priority = 'batch', resourceKey = null, signal = null, maxCapacityRetries = 2 } = {},
    attemptFn,
  ) {
    for (let attempt = 0; attempt <= maxCapacityRetries; attempt++) {
      const outcome = await run({ priority, resourceKey, signal }, attemptFn)
      if (outcome?.ok) return outcome
      if (signal?.aborted || stopped) return { ok: false, error: stopped ? 'shutting_down' : 'canceled' }
      if (outcome?.error === 'capacity_exceeded') {
        noteBackoff(outcome.retryAfterMs || 15_000)
        if (attempt < maxCapacityRetries) continue
      } else if (outcome?.error === 'engine_not_ready' || outcome?.error === 'service_stopping') {
        noteBackoff(outcome.retryAfterMs || 10_000)
      }
      return outcome
    }
    return { ok: false, error: 'capacity_exceeded' }
  }

  function busyResources() {
    return new Set(activeResources)
  }

  function snapshot() {
    const t = now()
    return {
      active,
      queued: waiters.length,
      max_concurrency: maxConcurrency(),
      paused_until: pausedUntil > t ? new Date(pausedUntil).toISOString() : null,
    }
  }

  function stop() {
    stopped = true
    clearTimeout(backoffTimer)
    backoffTimer = null
    while (waiters.length) {
      const w = waiters.shift()
      w.cleanup()
      w.resolve(null)
    }
  }

  return {
    acquire,
    run,
    runWithBackoff,
    noteBackoff,
    busyResources,
    snapshot,
    stop,
  }
}
