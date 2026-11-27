/**
 * Leader-only coordinator for GPT (Codex) automatic reset voucher redemption.
 *
 * Triggered in two ways:
 * - Event-driven nudge (`noteCodexQuotaObserved` / `noteCodexQuotaExhausted`) with a short
 *   2s debounce so slots (including credit-bearing slots that hit 7d=100% without 429) recover quickly.
 * - Periodic 60s sweep as a safety net.
 *
 * Never spends a voucher without a fresh `queryOpenaiQuota` confirmation through the slot's exit,
 * enforces cooldown even when post-redeem readback fails, respects active hours and daily caps,
 * and auto-pauses after consecutive redemption failures.
 */
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { activeHoursOf, evaluateActiveHours } from '../pool/active-hours.mjs'
import { isLeftoverQuotaScheduleOff } from '../pool/availability.mjs'
import { clearOpenAIAccountHold, openAIAccountHold, wakeOpenAIWaiter } from '../pool/openai-account-runtime.mjs'
import { normalizeOpenAIQuotaPolicy } from '../pool/openai-quota-policy.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { proxyBlockedReason } from '../vm/proxy-policy.mjs'
import { getVm, listVms } from '../vm/vm-registry.mjs'
import {
  CONSECUTIVE_FAILURE_PAUSE_THRESHOLD,
  createAutoResetStore,
  publicSlotState,
  resolveEffectiveCodexPolicy,
} from './auto-reset-config.mjs'
import {
  detectCodexWindows,
  evaluateCodexAutoReset,
  inspectCodexResetCredits,
  previewCodexExpiryRescue,
} from './auto-reset-policy.mjs'
import { expiresAtToMs } from './oauth-credentials.mjs'
import { queryOpenaiQuota, resetOpenaiQuota } from './openai-quota.mjs'

const HARD_UNAVAILABLE_STATUS = new Set(['dead', 'error', 'disabled'])
const REVOKED_GRANT_RE =
  /invalid_grant|refresh_rejected|refresh token not found|oauth_revoked|token_revoked|invalidated oauth token/i
const QUERY_ERROR_BACKOFF_MS = 5 * 60_000
const NUDGE_DEBOUNCE_MS = 2_000
const MAX_NUDGED = 1000

let activeRuntime = null

/** Called after `persistCodexUsage` writes live headers: updates 7d velocity samples and nudges if saturated. */
export function noteCodexQuotaObserved(vm) {
  try {
    activeRuntime?.onQuotaObserved(vm)
  } catch {}
}

/** Called on GPT 429 / rate-limit hold: evaluates this slot promptly on the next debounced tick. */
export function noteCodexQuotaExhausted(vmId) {
  try {
    activeRuntime?.nudge(vmId)
  } catch {}
}

function parseIsoMs(value) {
  if (!value) return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
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

function slotSkipReason(vm, now) {
  if (!vm || !isCodexVm(vm)) return 'not_codex'
  if (proxyBlockedReason(vm.proxy)) return 'proxy_blocked'
  if (vm.schedulable === false && !isLeftoverQuotaScheduleOff(vm)) return 'schedule_disabled'
  const status = String(vm.status || '').toLowerCase()
  if (HARD_UNAVAILABLE_STATUS.has(status)) return 'slot_unavailable'
  if (!hasUsableCredential(vm, now)) return 'credential_unavailable'
  if (!evaluateActiveHours(activeHoursOf(vm), now, vm.timezone).active) return 'resting'
  return null
}

function recordSevenDaySampleFromVm(store, vm, now) {
  if (!vm?.id || !isCodexVm(vm)) return
  const det = detectCodexWindows(vm, { now })
  const w7 = det.byId['7d']
  if (!w7 || w7.used_ratio == null || !w7.live) return
  store.recordSevenDaySample(vm.id, { u7: w7.used_ratio, r7: w7.reset_ms, at: now })
}

export function createAutoResetRuntime({
  projectRoot,
  getRouting = () => ({}),
  settings = () => new SettingsRepo(),
  lookupVm = (id) => getVm(projectRoot, id),
  listAllVms = () => listVms(projectRoot),
  queryQuota = (args) => queryOpenaiQuota(args),
  resetQuota = (args) => resetOpenaiQuota(args),
  getHold = (id, t) => openAIAccountHold(id, t),
  clearHold = (id) => clearOpenAIAccountHold(id),
  wakeWaiter = (id) => wakeOpenAIWaiter(id),
  tickMs = 60_000,
  nudgeDebounceMs = NUDGE_DEBOUNCE_MS,
  maxPerTick = 5,
  concurrency = 2,
  now = () => Date.now(),
  log = (event) => console.log(JSON.stringify(event)),
} = {}) {
  const store = createAutoResetStore({ settings, now })
  const nudged = new Set()
  const inFlight = new Set()
  const lastSampleMem = new Map()
  let timer = null
  let debounceTimer = null
  let ticking = false
  let stopped = true

  const codexQuotaPolicy = () => normalizeOpenAIQuotaPolicy(getRouting()?.codex?.quota || {})

  function isSlotEligibleForTick(vm, globalCfg, t) {
    if (slotSkipReason(vm, t)) return null
    const record = store.getSlot(vm.id)
    const effective = resolveEffectiveCodexPolicy(globalCfg, record)
    if (!effective.enabled) return null
    if (record.state.auto_paused) return null
    if (inFlight.has(vm.id)) return null
    if (record.state.no_card_until > t) return null
    if (effective.max_per_day > 0 && record.state.daily_count >= effective.max_per_day) return null
    const cooldownMs = effective.cooldown_min * 60_000
    const lastTs = Math.max(parseIsoMs(record.state.last_reset_at), parseIsoMs(record.state.last_attempt_at))
    if (lastTs > 0 && t - lastTs < cooldownMs) return null
    return { record, effective }
  }

  async function processOne(vmId) {
    if (inFlight.has(vmId) || stopped) return { vm_id: vmId, action: 'skip', reason: 'busy_or_stopped' }
    inFlight.add(vmId)
    try {
      const t0 = now()
      const vm = lookupVm(vmId)
      const skip = slotSkipReason(vm, t0)
      if (skip) return { vm_id: vmId, action: 'skip', reason: skip }

      const globalCfg = store.readConfig()
      const record = store.getSlot(vmId)
      const effective = resolveEffectiveCodexPolicy(globalCfg, record)
      if (!effective.enabled) return { vm_id: vmId, action: 'skip', reason: 'disabled' }
      if (record.state.auto_paused) return { vm_id: vmId, action: 'skip', reason: 'auto_paused' }
      if (record.state.no_card_until > t0) return { vm_id: vmId, action: 'skip', reason: 'no_card_backoff' }
      if (effective.max_per_day > 0 && record.state.daily_count >= effective.max_per_day) {
        return { vm_id: vmId, action: 'skip', reason: 'daily_limit_reached' }
      }
      const cooldownMs = effective.cooldown_min * 60_000
      const lastTs = Math.max(parseIsoMs(record.state.last_reset_at), parseIsoMs(record.state.last_attempt_at))
      if (lastTs > 0 && t0 - lastTs < cooldownMs) {
        return { vm_id: vmId, action: 'skip', reason: 'cooldown' }
      }

      const policy = codexQuotaPolicy()
      const pre = evaluateCodexAutoReset({
        vm,
        effective,
        quotaPolicy: policy,
        hold: getHold(vmId, t0),
        rateSamples: record.state.rate_samples,
        now: t0,
        liveChecked: false,
      })
      if (pre.action === 'skip') return { vm_id: vmId, action: 'skip', reason: pre.reason }

      // Always confirm live quota, credits, and available vouchers through the slot's exit before spending.
      const queried = await queryQuota({ projectRoot, vmId, rotate: true, policy })
      const t1 = now()
      if (!queried?.ok) {
        const errCode = String(queried?.error || 'query_failed')
        store.patchSlotState(vmId, (st) => {
          st.last_result = 'query_failed'
          st.last_error = errCode
          st.no_card_until = t1 + QUERY_ERROR_BACKOFF_MS
          return st
        })
        return { vm_id: vmId, action: 'skip', reason: 'query_failed', error: errCode }
      }

      const freshVm = lookupVm(vmId) || vm
      recordSevenDaySampleFromVm(store, freshVm, t1)
      const freshRecord = store.getSlot(vmId)
      const available = Math.max(0, Math.trunc(Number(queried.reset_credits?.available_count) || 0))
      if (available <= 0) {
        store.patchSlotState(vmId, (st) => {
          st.last_result = 'no_cards'
          st.last_error = null
          st.no_card_until = t1 + effective.no_card_recheck_min * 60_000
          return st
        })
        return { vm_id: vmId, action: 'skip', reason: 'no_cards' }
      }

      const confirmed = evaluateCodexAutoReset({
        vm: freshVm,
        effective,
        quotaPolicy: policy,
        hold: getHold(vmId, t1),
        rateSamples: freshRecord.state.rate_samples,
        now: t1,
        liveChecked: true,
      })
      if (confirmed.action !== 'redeem') {
        store.patchSlotState(vmId, (st) => {
          st.last_result = confirmed.reason
          st.last_error = null
          if (pre.action === 'probe_for_rescue') {
            st.no_card_until = t1 + effective.no_card_recheck_min * 60_000
          }
          return st
        })
        return { vm_id: vmId, action: 'skip', reason: confirmed.reason }
      }

      const res = await resetQuota({ projectRoot, vmId, rotate: true, policy })
      const t2 = now()
      const isoNow = new Date(t2).toISOString()

      if (res?.ok) {
        const refreshedOk = res.warning !== 'reset_credit_cache_refresh_failed'
        store.patchSlotState(vmId, (st) => {
          st.last_attempt_at = isoNow
          st.last_reset_at = isoNow
          st.last_result = refreshedOk ? 'reset' : 'reset_refresh_failed'
          st.last_trigger_window = confirmed.trigger_window
          st.last_rescue = confirmed.rescue === true
          st.last_rescue_reason = confirmed.rescue_info?.reason || null
          st.last_error = refreshedOk ? null : res.warning
          st.consecutive_failures = 0
          st.no_card_until = 0
          st.daily_count = (st.daily_count || 0) + 1
          return st
        })
        if (getHold(vmId, t2)?.reason === 'rate_limited') {
          try {
            clearHold(vmId)
          } catch {}
        }
        try {
          wakeWaiter(vmId)
        } catch {}
        const event = {
          vm_id: vmId,
          vm_name: freshVm?.name || vmId,
          platform: 'codex',
          outcome: refreshedOk ? 'reset' : 'reset_refresh_failed',
          trigger_window: confirmed.trigger_window,
          rescue: confirmed.rescue === true,
          rescue_tier: confirmed.rescue_info?.tier ?? null,
          rescue_reason: confirmed.rescue_info?.reason ?? null,
          vouchers_before: available,
          windows_reset: Number(res.windows_reset) || 0,
          warning: res.warning || null,
        }
        store.appendEvent(event)
        log({ event: 'auto_reset_redeemed', ...event })
        return { vm_id: vmId, action: 'redeemed', ...event }
      }

      const errCode = String(res?.error || 'reset_failed')
      if (errCode === 'reset_in_progress') {
        return { vm_id: vmId, action: 'skip', reason: 'reset_in_progress' }
      }

      let paused = false
      store.patchSlotState(vmId, (st) => {
        st.last_attempt_at = isoNow
        st.last_result = 'failed'
        st.last_trigger_window = confirmed.trigger_window
        st.last_rescue = confirmed.rescue === true
        st.last_rescue_reason = confirmed.rescue_info?.reason || null
        st.last_error = errCode
        st.consecutive_failures = (st.consecutive_failures || 0) + 1
        if (st.consecutive_failures >= CONSECUTIVE_FAILURE_PAUSE_THRESHOLD) {
          st.auto_paused = true
          st.paused_reason = 'consecutive_failures'
          paused = true
        }
        return st
      })
      const failEvent = {
        vm_id: vmId,
        vm_name: freshVm?.name || vmId,
        platform: 'codex',
        outcome: paused ? 'paused' : 'failed',
        trigger_window: confirmed.trigger_window,
        rescue: confirmed.rescue === true,
        rescue_tier: confirmed.rescue_info?.tier ?? null,
        rescue_reason: confirmed.rescue_info?.reason ?? null,
        vouchers_before: available,
        error: errCode,
      }
      store.appendEvent(failEvent)
      log({ event: 'auto_reset_failed', ...failEvent })
      return { vm_id: vmId, action: 'failed', error: errCode, paused }
    } finally {
      inFlight.delete(vmId)
    }
  }

  async function tick() {
    if (ticking || stopped) return { skipped: ticking ? 'busy' : 'stopped', checked: 0, results: [] }
    ticking = true
    try {
      const t = now()
      const globalCfg = store.readConfig()
      const allVms = (listAllVms() || []).filter((vm) => vm?.id && isCodexVm(vm))
      const candidates = []
      for (const vm of allVms) {
        const live = lookupVm(vm.id) || vm
        const gate = isSlotEligibleForTick(live, globalCfg, t)
        if (!gate) continue
        candidates.push({ vmId: vm.id, nudged: nudged.has(vm.id) })
      }
      candidates.sort((a, b) => Number(b.nudged) - Number(a.nudged) || a.vmId.localeCompare(b.vmId))
      const batch = candidates.slice(0, maxPerTick)
      for (const item of batch) nudged.delete(item.vmId)
      const results = []
      let cursor = 0
      const worker = async () => {
        while (cursor < batch.length) {
          const next = batch[cursor++]
          results.push(await processOne(next.vmId))
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, worker))
      return { checked: batch.length, results }
    } finally {
      ticking = false
    }
  }

  function scheduleDebouncedTick() {
    if (stopped || debounceTimer) return
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      tick().catch((err) => log({ event: 'auto_reset_tick_failed', error: String(err?.code || 'tick') }))
    }, nudgeDebounceMs)
    debounceTimer.unref?.()
  }

  function nudge(vmId) {
    if (stopped || !vmId) return
    const id = String(vmId)
    if (nudged.size < MAX_NUDGED) nudged.add(id)
    scheduleDebouncedTick()
  }

  function onQuotaObserved(vm) {
    if (stopped || !vm?.id || !isCodexVm(vm)) return
    const t = now()
    const det = detectCodexWindows(vm, { quotaPolicy: codexQuotaPolicy(), triggerMode: 'local_gate', now: t })
    const w7 = det.byId['7d']
    if (w7 && w7.used_ratio != null && w7.live) {
      const prev = lastSampleMem.get(vm.id)
      const moved =
        !prev ||
        t - prev.at >= 10 * 60_000 ||
        Math.abs(w7.used_ratio - prev.u7) >= 0.02 ||
        (w7.reset_ms != null && prev.r7 != null && Math.abs(w7.reset_ms - prev.r7) > 3.5 * 24 * 3600_000)
      if (moved) {
        lastSampleMem.set(vm.id, { at: t, u7: w7.used_ratio, r7: w7.reset_ms })
        try {
          store.recordSevenDaySample(vm.id, { u7: w7.used_ratio, r7: w7.reset_ms, at: t })
        } catch {}
      }
    }
    if (det.activeLimited.length > 0 || det.explicitLimited) {
      nudge(vm.id)
    }
  }

  function slotView(vmId) {
    const vm = lookupVm(vmId)
    if (!vm) return null
    const t = now()
    const globalCfg = store.readConfig()
    const codex = isCodexVm(vm)
    const record = store.getSlot(vmId)
    const effective = resolveEffectiveCodexPolicy(globalCfg, record)
    const vouchers = codex ? inspectCodexResetCredits(vm.codex?.reset_credits ?? vm.reset_credits, t) : null
    const rescuePreview = codex
      ? previewCodexExpiryRescue({ vm, effective, rateSamples: record.state.rate_samples, now: t })
      : null
    return {
      vm_id: vm.id,
      vm_name: vm.name || vm.id,
      platform: codex ? 'codex' : 'claude',
      eligible: codex,
      ineligible_reason: codex ? null : 'codex_only',
      mode: record.mode,
      overrides: record.overrides,
      has_overrides: effective.has_overrides,
      effective,
      global_enabled: globalCfg.codex.enabled,
      global_defaults: globalCfg.codex,
      state: publicSlotState(record.state),
      voucher_summary: vouchers
        ? {
            known: vouchers.known,
            available_count: vouchers.available_count,
            earliest_expires_at: vouchers.earliest_expires_at,
            within_7d_count: vouchers.within_7d_count,
          }
        : null,
      rescue_preview: rescuePreview,
    }
  }

  function listSlotSummaries() {
    const t = now()
    const globalCfg = store.readConfig()
    const items = []
    let voucherSlots = 0
    let totalVouchers = 0
    let rescueCandidateSlots = 0
    let pausedSlots = 0
    let customSlots = 0
    for (const vm of listAllVms() || []) {
      if (!vm?.id || !isCodexVm(vm)) continue
      const view = slotView(vm.id)
      if (!view) continue
      const count = view.voucher_summary?.available_count || 0
      if (count > 0) {
        voucherSlots += 1
        totalVouchers += count
      }
      if (view.rescue_preview?.should_rescue) rescueCandidateSlots += 1
      if (view.state.auto_paused) pausedSlots += 1
      if (view.has_overrides) customSlots += 1
      items.push({
        vm_id: view.vm_id,
        vm_name: view.vm_name,
        mode: view.mode,
        has_overrides: view.has_overrides,
        effective: view.effective,
        state: view.state,
        voucher_summary: view.voucher_summary,
        rescue_preview: view.rescue_preview,
      })
    }
    return {
      items,
      summary: {
        global_enabled: globalCfg.codex.enabled,
        total_gpt_slots: items.length,
        voucher_slots: voucherSlots,
        total_vouchers: totalVouchers,
        rescue_candidate_slots: rescueCandidateSlots,
        paused_slots: pausedSlots,
        custom_slots: customSlots,
        generated_at: new Date(t).toISOString(),
      },
    }
  }

  const runtime = {
    store,
    tick,
    nudge,
    onQuotaObserved,
    slotView,
    listSlotSummaries,
    readConfig: () => store.readConfig(),
    saveConfigPatch: (patch) => store.saveConfigPatch(patch),
    saveSlotPatch: (vmId, patch) => store.saveSlotPatch(vmId, patch),
    resetSlotOverride: (vmId) => store.resetSlotOverride(vmId),
    listEvents: () => store.listEvents(),
    isCodexSlot: (vmId) => {
      const vm = lookupVm(vmId)
      return !!vm && isCodexVm(vm)
    },
    invalidateNoCardBackoff(vmId) {
      if (!vmId) return
      const cur = store.getSlot(vmId)
      if (cur.state.no_card_until > 0) {
        store.patchSlotState(vmId, (st) => {
          st.no_card_until = 0
          return st
        })
      }
    },
    onVmDeleted(vmId) {
      if (!vmId) return
      nudged.delete(String(vmId))
      lastSampleMem.delete(String(vmId))
      store.removeSlot(vmId)
    },
    start() {
      if (!stopped) return
      stopped = false
      activeRuntime = runtime
      timer = setInterval(() => {
        tick().catch((err) => log({ event: 'auto_reset_tick_failed', error: String(err?.code || 'tick') }))
      }, tickMs)
      timer.unref?.()
    },
    stop() {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      nudged.clear()
      if (activeRuntime === runtime) activeRuntime = null
    },
  }
  return runtime
}
