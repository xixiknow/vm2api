/**
 * Leader-only coordinator for GPT (Codex) IQ / degradation checks via manxue.ai bridge.
 *
 * Key behaviours:
 * - Pure bridge/callback mode (`pelican` | `candy` | `creative`), no local HTML generation.
 * - Default 5-minute interval per GPT slot, staggered deterministically across slots.
 * - Bounded concurrency + minimum submit gap + global 429/503 Retry-After backoff.
 * - On confirmed degradation (reaching `isolate_threshold`), calls
 *   `markUnschedulable(projectRoot, vmId, 'gpt_iq_degraded', detail)` so the slot is
 *   immediately removed from the production pool.
 * - Isolated slots pause scheduled checks to avoid burning tokens, while still allowing
 *   manual re-checks (pinned `x-kin-vm` bypasses `schedulable=false`) and one-click unisolate.
 */
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { expiresAtToMs } from '../oauth/oauth-credentials.mjs'
import { activeHoursOf, evaluateActiveHours } from '../pool/active-hours.mjs'
import { isLeftoverQuotaScheduleOff } from '../pool/availability.mjs'
import { openAIAccountHold } from '../pool/openai-account-runtime.mjs'
import { extractCodexWindows, extraToCodexSnapshot } from '../protocol/codex-usage.mjs'
import { proxyBlockedReason } from '../vm/proxy-policy.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { clearUnschedulable, getVm, listVms, markUnschedulable } from '../vm/vm-registry.mjs'
import {
  buildVmIqSummary,
  createGptIqStore,
  MAX_IQ_HISTORY,
  recordBucketPoint,
  resolveEffectiveIqPolicy,
  rollupBuckets24h,
} from './gpt-iq-config.mjs'
import {
  cancelManxueTest,
  createManxueTest,
  normalizeManxueResult,
  pollManxueTest,
  validatePublicCallbackBaseUrl,
} from './manxue-client.mjs'

const HARD_UNAVAILABLE_STATUS = new Set(['dead', 'error', 'disabled'])
const REVOKED_GRANT_RE =
  /invalid_grant|refresh_rejected|refresh token not found|oauth_revoked|token_revoked|invalidated oauth token/i
const IQ_ISOLATED_REASON = 'gpt_iq_degraded'
const ERROR_BACKOFF_BASE_MS = 60_000
const ERROR_BACKOFF_MAX_MS = 15 * 60_000
const RATE_LIMIT_DEFAULT_BACKOFF_MS = 30_000

function parseIsoMs(value) {
  if (!value) return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

function stableHash(str) {
  let h = 2166136261
  const s = String(str || '')
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function hasUsableCredential(vm, now) {
  const hasToken =
    vm.has_token !== undefined
      ? Boolean(vm.has_token)
      : Boolean(vm.codex?.has_access || vm.codex?.has_refresh || vm.codex?.access_token || vm.codex?.refresh_token)
  if (!hasToken) return false
  const hasRefresh = Boolean(vm.has_refresh ?? vm.codex?.has_refresh ?? vm.codex?.refresh_token)
  const expMs = expiresAtToMs(vm.expires_at || vm.codex?.expires_at)
  if (expMs && expMs <= now && !hasRefresh) return false
  const grantErr = String(vm.refresh_error || vm.codex?.refresh_error || vm.schedule_disabled_reason || '')
  if (REVOKED_GRANT_RE.test(grantErr)) return false
  return true
}

function maxCodexQuotaPct(vm) {
  const pcts = []
  const pushRatio = (v) => {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) pcts.push(n <= 1 ? n * 100 : n)
  }
  if (vm?.utilization_5h != null) pushRatio(vm.utilization_5h)
  if (vm?.utilization_7d != null) pushRatio(vm.utilization_7d)
  const extra = vm?.codex?.extra || vm?.codex_extra
  if (extra && typeof extra === 'object') {
    for (const w of extractCodexWindows(extraToCodexSnapshot(extra))) {
      const used = Number(w?.used_percent)
      if (Number.isFinite(used) && used >= 0) pcts.push(used)
    }
  }
  const usageWindows = vm?.codex_usage?.windows
  if (Array.isArray(usageWindows)) {
    for (const w of usageWindows) {
      const used = Number(w?.used_percent)
      if (Number.isFinite(used) && used >= 0) pcts.push(used)
    }
  }
  return pcts.length ? Math.max(...pcts) : null
}

function isIqIsolated(vm) {
  return vm?.unschedulable?.reason === IQ_ISOLATED_REASON || vm?.schedule_disabled_reason === IQ_ISOLATED_REASON
}

function manualPreflightError(vm, now) {
  if (!vm) return 'vm_not_found'
  if (!isCodexVm(vm)) return 'vm_not_codex'
  if (proxyBlockedReason(vm.proxy)) return 'proxy_blocked'
  if (!hasUsableCredential(vm, now)) return 'credential_unavailable'
  const status = String(vm.status || '').toLowerCase()
  if (HARD_UNAVAILABLE_STATUS.has(status)) return 'slot_unavailable'
  return null
}

function scheduledSkipReason(vm, effective, record, hold, now) {
  const preflight = manualPreflightError(vm, now)
  if (preflight) return preflight
  if (isIqIsolated(vm)) return 'iq_isolated'
  if (effective.skip_unschedulable) {
    if (vm.schedulable === false && !isLeftoverQuotaScheduleOff(vm)) return 'schedule_disabled'
    if (!evaluateActiveHours(activeHoursOf(vm), now, vm.timezone).active) return 'resting'
  }
  if (effective.skip_quota_pct > 0) {
    if (hold) return 'rate_limited'
    const limitedUntil = Date.parse(vm?.codex_limited_until || '')
    if (Number.isFinite(limitedUntil) && limitedUntil > now) return 'rate_limited'
    const maxPct = maxCodexQuotaPct(vm)
    if (maxPct != null && maxPct >= effective.skip_quota_pct) return 'quota_high'
  }
  if (record.state.backoff_until > now) return 'backoff'
  return null
}

export function createGptIqRuntime({
  projectRoot,
  bridge,
  getPublicBaseUrl = () => process.env.PUBLIC_BASE_URL || '',
  settings = () => new SettingsRepo(),
  lookupVm = (id) => getVm(projectRoot, id),
  listAllVms = () => listVms(projectRoot),
  getHold = (id, t) => openAIAccountHold(id, t),
  markSlotUnschedulable = (id, reason, detail) => markUnschedulable(projectRoot, id, reason, detail),
  clearSlotUnschedulable = (id, opts) => clearUnschedulable(projectRoot, id, opts),
  createTest = (args) => createManxueTest(args),
  pollTest = (args) => pollManxueTest(args),
  cancelTest = (args) => cancelManxueTest(args),
  tickMs = 15_000,
  now = () => Date.now(),
  random = () => Math.random(),
  log = (event) => console.log(JSON.stringify(event)),
} = {}) {
  const store = createGptIqStore({ settings, now })
  /** @type {Map<string, { ac: AbortController, nonce: string | null, testId: string | null, startedAt: number, trigger: string, promise: Promise<any> }>} */
  const activeRuns = new Map()
  /** @type {Array<{ vmId: string, trigger: 'scheduled' | 'manual', enqueuedAt: number, resolve?: (v: any) => void }>} */
  const queue = []
  const queuedIds = new Set()
  /** @type {Map<string, object>} */
  const summaryCache = new Map()
  let timer = null
  let pumpTimer = null
  let stopped = true
  let startedAt = now()
  let globalBackoffUntil = 0
  let lastSubmitAt = 0

  function detectedCallbackBaseUrl() {
    const raw = typeof getPublicBaseUrl === 'function' ? getPublicBaseUrl() : getPublicBaseUrl
    const checked = validatePublicCallbackBaseUrl(raw, { allowEmpty: false })
    return checked.ok ? checked.url : ''
  }

  function resolveCallbackBaseUrl(globalCfg = store.readConfig()) {
    const configured = String(globalCfg.callback_base_url || '').trim()
    if (configured) return validatePublicCallbackBaseUrl(configured, { allowEmpty: false })
    const detected = detectedCallbackBaseUrl()
    if (detected) return { ok: true, url: detected }
    return { ok: false, error: 'callback_base_url_required' }
  }

  function computeDueAtMs(vmId, record, effective) {
    const intervalMs = effective.interval_min * 60_000
    const explicitNext = parseIsoMs(record.state.next_run_at)
    if (explicitNext > 0) return explicitNext
    const lastMs = parseIsoMs(record.state.last_checked_at)
    if (lastMs > 0) return lastMs + intervalMs
    const staggerSpan = Math.min(intervalMs, 5 * 60_000)
    const offset = staggerSpan > 0 ? stableHash(vmId) % staggerSpan : 0
    return startedAt + offset
  }

  function computeSummaryForVm(vm, globalCfg = store.readConfig(), t = now()) {
    if (!vm || !isCodexVm(vm)) return null
    const record = store.getSlot(vm.id)
    const effective = resolveEffectiveIqPolicy(globalCfg, record)
    const isolated = isIqIsolated(vm)
    const running = activeRuns.has(vm.id)
    const nextRunAt =
      effective.enabled && !isolated ? new Date(computeDueAtMs(vm.id, record, effective)).toISOString() : null
    return buildVmIqSummary(record, effective, { running, isolated, nextRunAt, now: t })
  }

  function refreshSummaryCache(vmId = null) {
    const globalCfg = store.readConfig()
    const t = now()
    if (vmId) {
      const vm = lookupVm(vmId)
      const summary = computeSummaryForVm(vm, globalCfg, t)
      if (summary) summaryCache.set(vmId, summary)
      else summaryCache.delete(vmId)
      return summary
    }
    summaryCache.clear()
    for (const vm of listAllVms() || []) {
      if (!vm?.id || !isCodexVm(vm)) continue
      const summary = computeSummaryForVm(vm, globalCfg, t)
      if (summary) summaryCache.set(vm.id, summary)
    }
    return null
  }

  function vmSummaryForPanel(vm) {
    const id = typeof vm === 'string' ? vm : vm?.id
    if (!id) return null
    if (typeof vm === 'object' && vm && !isCodexVm(vm)) return null
    const cached = summaryCache.get(id)
    if (cached) {
      const liveIsolated = typeof vm === 'object' && vm ? isIqIsolated(vm) : cached.isolated
      if (cached.isolated !== liveIsolated || cached.running !== activeRuns.has(id)) {
        return refreshSummaryCache(id)
      }
      return cached
    }
    return refreshSummaryCache(id)
  }

  function schedulePump(delayMs) {
    if (stopped || pumpTimer) return
    const wait = Math.max(50, Math.min(delayMs, 60_000))
    pumpTimer = setTimeout(() => {
      pumpTimer = null
      pumpQueue()
    }, wait)
    pumpTimer.unref?.()
  }

  async function executeOne(vmId, { trigger = 'scheduled' } = {}) {
    const t0 = now()
    const globalCfg = store.readConfig()
    const vm = lookupVm(vmId)
    const preflight = manualPreflightError(vm, t0)
    if (preflight) return { ok: false, vm_id: vmId, skipped: true, reason: preflight }

    const record = store.getSlot(vmId)
    const effective = resolveEffectiveIqPolicy(globalCfg, record)
    if (trigger === 'scheduled') {
      const skip = scheduledSkipReason(vm, effective, record, getHold(vmId, t0), t0)
      if (skip) return { ok: false, vm_id: vmId, skipped: true, reason: skip }
    }

    const cbRes = resolveCallbackBaseUrl(globalCfg)
    if (!cbRes.ok) {
      return { ok: false, vm_id: vmId, error: cbRes.error }
    }
    if (!bridge) {
      return { ok: false, vm_id: vmId, error: 'bridge_unavailable' }
    }

    const ac = new AbortController()
    const timeoutMs = effective.timeout_sec * 1000
    const ticket = bridge.mintTicket({
      vmId,
      allowedModel: effective.model,
      ttlMs: Math.max(10 * 60_000, timeoutMs + 60_000),
      maxUses: 3,
    })

    const runEntry = {
      ac,
      nonce: ticket.nonce,
      testId: null,
      startedAt: t0,
      trigger,
      promise: null,
    }
    activeRuns.set(vmId, runEntry)
    refreshSummaryCache(vmId)

    const bridgeBaseUrl = `${cbRes.url}/api/manxue-bridge/${ticket.nonce}`
    let createdId = null

    try {
      lastSubmitAt = now()
      const created = await createTest({
        apiBaseUrl: globalCfg.api_base_url,
        benchmark: effective.benchmark,
        baseUrl: bridgeBaseUrl,
        apiKey: ticket.secret,
        model: effective.model,
        reasoningEffort: effective.reasoning_effort,
        serviceTier: effective.service_tier,
        idempotencyKey: `vm2api-${vmId}-${t0}`,
        signal: ac.signal,
      })

      if (!created?.ok) {
        const tErr = now()
        const isoErr = new Date(tErr).toISOString()
        const errCode = created?.aborted ? 'cancelled' : String(created?.error || 'manxue_create_failed')
        if (created?.rateLimited) {
          const waitMs = (created.retryAfterMs || RATE_LIMIT_DEFAULT_BACKOFF_MS) + Math.round(random() * 2_000)
          globalBackoffUntil = Math.max(globalBackoffUntil, tErr + waitMs)
          store.patchSlotState(vmId, (st) => {
            st.last_error = errCode
            st.backoff_until = tErr + waitMs
            st.next_run_at = new Date(tErr + waitMs).toISOString()
            return st
          })
          store.appendEvent({
            vm_id: vmId,
            vm_name: vm.name || vmId,
            outcome: 'rate_limited',
            benchmark: effective.benchmark,
            model: effective.model,
            trigger,
            error: errCode,
          })
          return { ok: false, vm_id: vmId, rate_limited: true, error: errCode }
        }
        if (created?.aborted) {
          return { ok: false, vm_id: vmId, cancelled: true, error: 'cancelled' }
        }
        recordErrorOutcome(vm, effective, {
          t: tErr,
          iso: isoErr,
          trigger,
          error: errCode,
          durationMs: tErr - t0,
        })
        return { ok: false, vm_id: vmId, error: errCode }
      }

      createdId = created.id
      runEntry.testId = createdId

      const polled = await pollTest({
        apiBaseUrl: globalCfg.api_base_url,
        testId: createdId,
        timeoutMs,
        signal: ac.signal,
      })

      const tDone = now()
      const isoDone = new Date(tDone).toISOString()
      const fallbackOutput = bridge.getCapturedText(ticket.nonce)

      if (!polled?.ok) {
        if (polled?.aborted) {
          return { ok: false, vm_id: vmId, cancelled: true, error: 'cancelled' }
        }
        const errCode = String(polled?.error || 'manxue_poll_failed')
        if (polled?.rateLimited) {
          const waitMs = (polled.retryAfterMs || RATE_LIMIT_DEFAULT_BACKOFF_MS) + Math.round(random() * 2_000)
          globalBackoffUntil = Math.max(globalBackoffUntil, tDone + waitMs)
        }
        recordErrorOutcome(vm, effective, {
          t: tDone,
          iso: isoDone,
          trigger,
          error: errCode,
          durationMs: tDone - t0,
        })
        return { ok: false, vm_id: vmId, error: errCode }
      }

      const normalized = normalizeManxueResult(effective.benchmark, polled.data, { fallbackOutput })
      const durationMs = normalized.duration_ms ?? Math.max(0, tDone - t0)

      if (normalized.artifact) {
        store.saveArtifact(vmId, {
          checked_at: isoDone,
          benchmark: normalized.benchmark,
          model: effective.model,
          reasoning_effort: effective.reasoning_effort,
          status: normalized.status,
          raw_status: normalized.raw_status,
          reference_only: normalized.reference_only,
          label: normalized.label,
          reason: normalized.reason,
          source: normalized.source,
          duration_ms: durationMs,
          input_tokens: normalized.input_tokens,
          output_tokens: normalized.output_tokens,
          reasoning_tokens: normalized.reasoning_tokens,
          ...normalized.artifact,
        })
      }

      let isolatedNow = false
      let nextConsecDegraded = 0
      const latestRecord = store.getSlot(vmId)
      if (normalized.status === 'degraded') {
        nextConsecDegraded = (latestRecord.state.consecutive_degraded || 0) + 1
        const shouldIsolate =
          effective.auto_isolate_on_degraded &&
          nextConsecDegraded >= effective.isolate_threshold &&
          (!normalized.reference_only || effective.isolate_on_reference)
        if (shouldIsolate) {
          try {
            markSlotUnschedulable(vmId, IQ_ISOLATED_REASON, {
              benchmark: normalized.benchmark,
              model: effective.model,
              label: normalized.label,
              reason: normalized.reason,
              checked_at: isoDone,
            })
            isolatedNow = true
          } catch (err) {
            log({ event: 'gpt_iq_isolate_failed', vm_id: vmId, error: String(err?.message || err) })
          }
        }
      }

      const nextRunIso = new Date(tDone + effective.interval_min * 60_000).toISOString()

      store.patchSlotState(vmId, (st) => {
        st.last_checked_at = isoDone
        st.next_run_at = nextRunIso
        st.last_status = normalized.status
        st.last_raw_status = normalized.raw_status
        st.last_reference_only = normalized.reference_only
        st.last_benchmark = normalized.benchmark
        st.last_model = effective.model
        st.last_reasoning_effort = effective.reasoning_effort
        st.last_label = normalized.label
        st.last_reason = normalized.reason
        st.last_source = normalized.source
        st.last_duration_ms = durationMs
        st.last_input_tokens = normalized.input_tokens
        st.last_output_tokens = normalized.output_tokens
        st.last_reasoning_tokens = normalized.reasoning_tokens
        st.last_error = normalized.error
        if (normalized.artifact) st.has_artifact = true
        if (normalized.status === 'degraded') {
          st.consecutive_degraded = nextConsecDegraded
          st.consecutive_errors = 0
          st.backoff_until = 0
          if (isolatedNow) st.isolated_at = isoDone
        } else if (normalized.status === 'normal') {
          st.consecutive_degraded = 0
          st.consecutive_errors = 0
          st.backoff_until = 0
        } else if (normalized.status === 'error') {
          st.consecutive_errors = (st.consecutive_errors || 0) + 1
          const bo = Math.min(ERROR_BACKOFF_MAX_MS, ERROR_BACKOFF_BASE_MS * 2 ** Math.min(4, st.consecutive_errors - 1))
          st.backoff_until = tDone + bo
        } else {
          st.consecutive_errors = 0
          st.backoff_until = 0
        }
        st.history = [
          {
            at: isoDone,
            status: normalized.status,
            raw_status: normalized.raw_status,
            reference_only: normalized.reference_only,
            benchmark: normalized.benchmark,
            model: effective.model,
            reasoning_effort: effective.reasoning_effort,
            label: normalized.label,
            reason: normalized.reason,
            duration_ms: durationMs,
            input_tokens: normalized.input_tokens,
            output_tokens: normalized.output_tokens,
            reasoning_tokens: normalized.reasoning_tokens,
            error: normalized.error,
            trigger,
            isolated: isolatedNow,
          },
          ...st.history,
        ].slice(0, MAX_IQ_HISTORY)
        st.buckets_24h = recordBucketPoint(st.buckets_24h, { atMs: tDone, status: normalized.status }, tDone)
        return st
      })

      const eventPayload = {
        vm_id: vmId,
        vm_name: vm.name || vmId,
        outcome: isolatedNow ? 'isolated' : normalized.status,
        benchmark: normalized.benchmark,
        model: effective.model,
        reasoning_effort: effective.reasoning_effort,
        label: normalized.label,
        reason: normalized.reason,
        reference_only: normalized.reference_only,
        duration_ms: durationMs,
        trigger,
        isolated: isolatedNow,
        error: normalized.error,
      }
      store.appendEvent(eventPayload)
      log({ event: 'gpt_iq_checked', ...eventPayload })

      return {
        ok: true,
        vm_id: vmId,
        status: normalized.status,
        isolated: isolatedNow,
        result: normalized,
      }
    } finally {
      bridge.revokeTicket(ticket.nonce)
      activeRuns.delete(vmId)
      refreshSummaryCache(vmId)
      if (!stopped) pumpQueue()
    }
  }

  function recordErrorOutcome(vm, effective, { t, iso, trigger, error, durationMs }) {
    store.patchSlotState(vm.id, (st) => {
      st.last_checked_at = iso
      st.last_status = 'error'
      st.last_raw_status = 'error'
      st.last_reference_only = false
      st.last_benchmark = effective.benchmark
      st.last_model = effective.model
      st.last_reasoning_effort = effective.reasoning_effort
      st.last_label = '检测异常'
      st.last_reason = error
      st.last_duration_ms = durationMs
      st.last_error = error
      st.consecutive_errors = (st.consecutive_errors || 0) + 1
      const bo = Math.min(ERROR_BACKOFF_MAX_MS, ERROR_BACKOFF_BASE_MS * 2 ** Math.min(4, st.consecutive_errors - 1))
      st.backoff_until = t + bo
      st.next_run_at = new Date(Math.max(t + effective.interval_min * 60_000, t + bo)).toISOString()
      st.history = [
        {
          at: iso,
          status: 'error',
          raw_status: 'error',
          reference_only: false,
          benchmark: effective.benchmark,
          model: effective.model,
          reasoning_effort: effective.reasoning_effort,
          label: '检测异常',
          reason: error,
          duration_ms: durationMs,
          input_tokens: null,
          output_tokens: null,
          reasoning_tokens: null,
          error,
          trigger,
          isolated: false,
        },
        ...st.history,
      ].slice(0, MAX_IQ_HISTORY)
      st.buckets_24h = recordBucketPoint(st.buckets_24h, { atMs: t, status: 'error' }, t)
      return st
    })
    store.appendEvent({
      vm_id: vm.id,
      vm_name: vm.name || vm.id,
      outcome: 'error',
      benchmark: effective.benchmark,
      model: effective.model,
      reasoning_effort: effective.reasoning_effort,
      duration_ms: durationMs,
      trigger,
      error,
    })
  }

  function pumpQueue() {
    if (stopped || queue.length === 0) return
    const globalCfg = store.readConfig()
    const concurrency = Math.max(1, globalCfg.concurrency || 2)
    const minGapMs = Math.max(0, (globalCfg.min_gap_sec || 0) * 1000)

    while (activeRuns.size < concurrency && queue.length > 0) {
      const t = now()
      const nextItem = queue[0]
      if (nextItem.trigger === 'scheduled' && t < globalBackoffUntil) {
        schedulePump(globalBackoffUntil - t)
        return
      }
      if (minGapMs > 0 && lastSubmitAt > 0 && t - lastSubmitAt < minGapMs) {
        schedulePump(minGapMs - (t - lastSubmitAt))
        return
      }
      const item = queue.shift()
      queuedIds.delete(item.vmId)
      if (activeRuns.has(item.vmId)) {
        item.resolve?.({ ok: false, vm_id: item.vmId, error: 'iq_check_in_progress' })
        continue
      }
      lastSubmitAt = t
      const p = executeOne(item.vmId, { trigger: item.trigger })
        .then((res) => {
          item.resolve?.(res)
          return res
        })
        .catch((err) => {
          const out = { ok: false, vm_id: item.vmId, error: String(err?.message || err) }
          item.resolve?.(out)
          return out
        })
      const active = activeRuns.get(item.vmId)
      if (active) active.promise = p
    }
  }

  function tick() {
    if (stopped) return { skipped: 'stopped', enqueued: 0 }
    const t = now()
    const globalCfg = store.readConfig()
    const cbRes = resolveCallbackBaseUrl(globalCfg)
    if (!cbRes.ok) return { skipped: cbRes.error, enqueued: 0 }

    const allVms = (listAllVms() || []).filter((vm) => vm?.id && isCodexVm(vm))
    const due = []
    for (const vm of allVms) {
      if (activeRuns.has(vm.id) || queuedIds.has(vm.id)) continue
      const record = store.getSlot(vm.id)
      const effective = resolveEffectiveIqPolicy(globalCfg, record)
      if (!effective.enabled) continue
      const skip = scheduledSkipReason(vm, effective, record, getHold(vm.id, t), t)
      if (skip) continue
      const dueAt = computeDueAtMs(vm.id, record, effective)
      if (dueAt <= t) due.push({ vmId: vm.id, dueAt })
    }
    due.sort((a, b) => a.dueAt - b.dueAt)
    for (const item of due) {
      queuedIds.add(item.vmId)
      queue.push({ vmId: item.vmId, trigger: 'scheduled', enqueuedAt: t })
    }
    pumpQueue()
    return { enqueued: due.length, active: activeRuns.size, queued: queue.length }
  }

  function runNow(vmId, { wait = false } = {}) {
    const t = now()
    const vm = lookupVm(vmId)
    const preflight = manualPreflightError(vm, t)
    if (preflight) return { ok: false, error: preflight }
    if (activeRuns.has(vmId) || queuedIds.has(vmId)) {
      return { ok: false, error: 'iq_check_in_progress' }
    }
    const cbRes = resolveCallbackBaseUrl(store.readConfig())
    if (!cbRes.ok) return { ok: false, error: cbRes.error }

    // Manual runs execute immediately even if background scheduler is paused (or in tests).
    const promise = executeOne(vmId, { trigger: 'manual' })
    const entry = activeRuns.get(vmId)
    if (entry) entry.promise = promise
    if (wait) return promise
    return { ok: true, accepted: true, running: true, vm_id: vmId, promise }
  }

  async function cancel(vmId) {
    const idx = queue.findIndex((item) => item.vmId === vmId)
    if (idx >= 0) {
      const [removed] = queue.splice(idx, 1)
      queuedIds.delete(vmId)
      removed.resolve?.({ ok: false, vm_id: vmId, cancelled: true, error: 'cancelled' })
      return { ok: true, cancelled: true }
    }
    const active = activeRuns.get(vmId)
    if (!active) return { ok: false, error: 'not_running' }
    active.ac.abort()
    if (active.nonce) bridge?.revokeTicket?.(active.nonce)
    if (active.testId) {
      await cancelTest({ apiBaseUrl: store.readConfig().api_base_url, testId: active.testId }).catch(() => {})
    }
    return { ok: true, cancelled: true }
  }

  function unisolate(vmId) {
    const vm = lookupVm(vmId)
    if (!vm) return { ok: false, error: 'vm_not_found' }
    if (!isCodexVm(vm)) return { ok: false, error: 'vm_not_codex' }
    const t = now()
    const iso = new Date(t).toISOString()
    const globalCfg = store.readConfig()
    const record = store.getSlot(vmId)
    const effective = resolveEffectiveIqPolicy(globalCfg, record)
    const cleared = clearSlotUnschedulable(vmId, { by: 'iq_recovered', only: [IQ_ISOLATED_REASON] })
    store.patchSlotState(vmId, (st) => {
      st.isolated_at = null
      st.consecutive_degraded = 0
      st.backoff_until = 0
      st.next_run_at = new Date(t + effective.interval_min * 60_000).toISOString()
      return st
    })
    store.appendEvent({
      vm_id: vmId,
      vm_name: vm.name || vmId,
      outcome: 'recovered',
      reason: '操作员解除测智降智隔离',
      at: iso,
    })
    refreshSummaryCache(vmId)
    return { ok: true, cleared: Boolean(cleared), view: slotView(vmId) }
  }

  function slotView(vmId) {
    const vm = lookupVm(vmId)
    if (!vm) return null
    const t = now()
    const globalCfg = store.readConfig()
    const eligible = isCodexVm(vm)
    const record = store.getSlot(vmId)
    const effective = resolveEffectiveIqPolicy(globalCfg, record)
    const isolated = isIqIsolated(vm)
    const running = activeRuns.has(vmId)
    const rollup = rollupBuckets24h(record.state.buckets_24h, t)
    const skip = eligible ? scheduledSkipReason(vm, effective, record, getHold(vmId, t), t) : 'not_codex'
    const nextRunAt =
      eligible && effective.enabled && !isolated
        ? new Date(computeDueAtMs(vmId, record, effective)).toISOString()
        : null
    return {
      vm_id: vmId,
      vm_name: vm.name || vmId,
      eligible,
      mode: record.mode,
      overrides: record.overrides,
      has_overrides: effective.has_overrides,
      effective,
      global_defaults: globalCfg,
      running,
      isolated,
      skip_reason: skip,
      next_run_at: nextRunAt,
      state: {
        ...record.state,
        buckets_24h: rollup,
      },
      summary: eligible ? buildVmIqSummary(record, effective, { running, isolated, nextRunAt, now: t }) : null,
      updated_at: record.updated_at,
    }
  }

  function listSlotSummaries() {
    const t = now()
    const globalCfg = store.readConfig()
    const allCodex = (listAllVms() || []).filter((vm) => vm?.id && isCodexVm(vm))
    let enabledCount = 0
    let customCount = 0
    let runningCount = 0
    let isolatedCount = 0
    let normal24h = 0
    let degraded24h = 0
    let error24h = 0

    const items = allCodex.map((vm) => {
      const record = store.getSlot(vm.id)
      const effective = resolveEffectiveIqPolicy(globalCfg, record)
      const isolated = isIqIsolated(vm)
      const running = activeRuns.has(vm.id)
      const nextRunAt =
        effective.enabled && !isolated ? new Date(computeDueAtMs(vm.id, record, effective)).toISOString() : null
      const summary = buildVmIqSummary(record, effective, { running, isolated, nextRunAt, now: t })
      if (effective.enabled) enabledCount += 1
      if (effective.has_overrides) customCount += 1
      if (running) runningCount += 1
      if (isolated) isolatedCount += 1
      normal24h += summary.summary_24h.normal
      degraded24h += summary.summary_24h.degraded
      error24h += summary.summary_24h.error
      return {
        vm_id: vm.id,
        vm_name: vm.name || vm.id,
        email: vm.email || vm.codex?.email || null,
        plan: vm.chatgpt_plan_type || vm.codex?.plan_type || null,
        schedulable: vm.schedulable !== false,
        isolated,
        skip_reason: scheduledSkipReason(vm, effective, record, getHold(vm.id, t), t),
        mode: record.mode,
        has_overrides: effective.has_overrides,
        effective,
        summary,
      }
    })

    return {
      items,
      summary: {
        total_codex_slots: items.length,
        enabled_slots: enabledCount,
        custom_slots: customCount,
        running_slots: runningCount,
        isolated_slots: isolatedCount,
        normal_24h: normal24h,
        degraded_24h: degraded24h,
        error_24h: error24h,
        global_backoff_until: globalBackoffUntil > t ? new Date(globalBackoffUntil).toISOString() : null,
      },
    }
  }

  function readConfig() {
    return store.readConfig()
  }

  function saveConfigPatch(body) {
    const res = store.saveConfigPatch(body)
    if (res.ok) refreshSummaryCache()
    return res
  }

  function saveSlotPatch(vmId, body) {
    const res = store.saveSlotPatch(vmId, body)
    if (res.ok) refreshSummaryCache(vmId)
    return res
  }

  function resetSlotOverride(vmId) {
    const res = store.resetSlotOverride(vmId)
    if (res.ok) refreshSummaryCache(vmId)
    return res
  }

  function getArtifact(vmId) {
    return store.getArtifact(vmId)
  }

  function listEvents() {
    return store.listEvents()
  }

  function onVmDeleted(vmId) {
    void cancel(vmId)
    store.removeSlot(vmId)
    summaryCache.delete(vmId)
  }

  function start() {
    if (!stopped) return
    stopped = false
    startedAt = now()
    refreshSummaryCache()
    timer = setInterval(
      () => {
        try {
          tick()
        } catch (err) {
          log({ event: 'gpt_iq_tick_error', error: String(err?.message || err) })
        }
      },
      Math.max(5_000, Number(tickMs) || 15_000),
    )
    timer.unref?.()
  }

  function stop() {
    stopped = true
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    if (pumpTimer) {
      clearTimeout(pumpTimer)
      pumpTimer = null
    }
    for (const [vmId, active] of activeRuns.entries()) {
      try {
        active.ac.abort()
      } catch {}
      if (active.nonce) bridge?.revokeTicket?.(active.nonce)
      activeRuns.delete(vmId)
    }
    while (queue.length > 0) {
      const item = queue.shift()
      queuedIds.delete(item.vmId)
      item.resolve?.({ ok: false, vm_id: item.vmId, cancelled: true, error: 'stopped' })
    }
  }

  return {
    start,
    stop,
    tick,
    readConfig,
    saveConfigPatch,
    detectedCallbackBaseUrl,
    resolveCallbackBaseUrl,
    slotView,
    saveSlotPatch,
    resetSlotOverride,
    getArtifact,
    listSlotSummaries,
    listEvents,
    vmSummaryForPanel,
    refreshSummaryCache,
    runNow,
    cancel,
    unisolate,
    onVmDeleted,
  }
}
