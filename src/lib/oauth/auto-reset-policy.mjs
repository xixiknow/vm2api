/**
 * Pure decision engine for GPT (Codex) automatic reset voucher redemption.
 *
 * Key design choices:
 * - Inspects raw Codex windows WITHOUT applying `waiveWindowCaps`, so a slot with
 *   spendable Codex credits can still detect `7d >= 100%` and prefer spending a reset
 *   voucher over draining paid credits when `prefer_voucher_over_credits` is enabled.
 * - Dynamic expiry rescue (`smart_expiry_rescue`): no hardcoded hour threshold. Computes
 *   whether expiring vouchers can still be absorbed by natural 7d caps (or a later 5h cap)
 *   before expiry using voucher `expires_at`, 5h fill duration, 7d burn velocity (current
 *   window + recent samples + previous closed window), active hours ratio, and 5h/7d resets.
 */
import { activeHoursOf } from '../pool/active-hours.mjs'
import { normalizeOpenAIQuotaPolicy } from '../pool/openai-quota-policy.mjs'
import { buildCodexUsageView, extraToCodexSnapshot, hasSpendableCodexCredits } from '../protocol/codex-usage.mjs'

export const HOUR_MS = 60 * 60 * 1000
export const FIVE_HOUR_MS = 5 * HOUR_MS
export const SEVEN_DAY_MS = 7 * 24 * HOUR_MS

export const TIER1_EXPIRY_BUFFER_MS = 15 * 60_000
export const MIN_5H_FILL_MS = 30 * 60_000
export const MIN_7D_ELAPSED_MS = 6 * HOUR_MS
export const MIN_SAMPLE_SPAN_MS = 2 * HOUR_MS
export const VELOCITY_HEADROOM = 1.2

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function num(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function parseMs(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  const ms = Date.parse(String(value))
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

function minutesOf(value) {
  const m = TIME_RE.exec(String(value || '').trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** Daily active fraction (0..1] derived from `vm.policy.active_hours`. */
export function activeHoursRatio(activeHours) {
  if (!activeHours || typeof activeHours !== 'object') return 1
  const start = minutesOf(activeHours.start)
  const end = minutesOf(activeHours.end)
  if (start == null || end == null || start === end) return 1
  const spanMin = end > start ? end - start : 1440 - start + end
  const days = Array.isArray(activeHours.days) && activeHours.days.length ? activeHours.days.length : 7
  return Math.max(1 / 24, Math.min(1, (spanMin / 1440) * (days / 7)))
}

/** Parse cached or live `reset_credits` into sorted future voucher expiries. */
export function inspectCodexResetCredits(resetCredits, now = Date.now()) {
  if (!resetCredits || typeof resetCredits !== 'object') {
    return {
      known: false,
      available_count: 0,
      vouchers: [],
      earliest_expires_at: null,
      earliest_expires_ms: null,
      within_7d_count: 0,
      fetched_at_ms: null,
    }
  }
  const available = Math.max(0, Math.trunc(Number(resetCredits.available_count) || 0))
  const rawList = Array.isArray(resetCredits.credits) ? resetCredits.credits : []
  const vouchers = rawList
    .map((row) => {
      const ms = parseMs(row?.expires_at ?? row?.expiresAt)
      return ms && ms > now ? { expires_ms: ms, expires_at: new Date(ms).toISOString() } : null
    })
    .filter(Boolean)
    .sort((a, b) => a.expires_ms - b.expires_ms)
  const earliest = vouchers[0] || null
  const within7d = vouchers.filter((v) => v.expires_ms - now <= SEVEN_DAY_MS).length
  return {
    known: true,
    available_count: available,
    vouchers,
    earliest_expires_at: earliest?.expires_at || null,
    earliest_expires_ms: earliest?.expires_ms || null,
    within_7d_count: within7d,
    fetched_at_ms: parseMs(resetCredits.fetched_at),
  }
}

/**
 * Extract raw Codex rate-limit windows from a VM record or summary.
 * Intentionally ignores `waiveWindowCaps` so spendable Codex credits never hide a full 7d/5h window.
 */
export function extractRawCodexWindows(vm, now = Date.now()) {
  const extra = vm?.codex?.extra || vm?.codex_extra || null
  const view =
    extra && Object.keys(extra).length > 0
      ? buildCodexUsageView(extraToCodexSnapshot(extra))
      : vm?.codex?.usage || vm?.codex_usage || null
  const rawList = Array.isArray(view?.windows) ? view.windows : []
  const windows = []
  for (const row of rawList) {
    if (!row?.id) continue
    const usedPercent = num(row.used_percent)
    const resetMs = parseMs(row.reset_at)
    const live = resetMs == null ? usedPercent != null : resetMs > now
    windows.push({
      id: String(row.id),
      used_percent: usedPercent,
      used_ratio: usedPercent == null ? null : Math.max(0, Math.min(1, usedPercent / 100)),
      reset_ms: resetMs,
      reset_at: resetMs ? new Date(resetMs).toISOString() : null,
      remaining_ms: resetMs && resetMs > now ? resetMs - now : null,
      window_minutes: num(row.window_minutes),
      live,
    })
  }
  return windows
}

function windowKind(id) {
  if (id === '7d') return 'seven_day'
  if (id === '5h') return 'five_hour'
  return 'other_window'
}

function limitPercentFor(id, policy) {
  if (id === '5h') return (policy.limit_5h ?? 1) * 100
  if (id === '7d') return (policy.limit_7d ?? 1) * 100
  return 100
}

/**
 * Detect saturated Codex windows without masking them behind spendable credits.
 */
export function detectCodexWindows(
  vm,
  { quotaPolicy = null, hold = null, triggerMode = 'upstream_limit', now = Date.now() } = {},
) {
  const policy = normalizeOpenAIQuotaPolicy(quotaPolicy || {})
  const windows = extractRawCodexWindows(vm, now)
  const limitedUntilMs = parseMs(vm?.codex?.extra?.codex_limited_until ?? vm?.codex_limited_until)
  const explicitLimited = (limitedUntilMs != null && limitedUntilMs > now) || hold?.reason === 'rate_limited'
  const upstreamLimited = []
  const gateLimited = []
  for (const win of windows) {
    if (!win.live || win.used_percent == null) continue
    if (win.used_percent >= 100) {
      upstreamLimited.push(win)
      gateLimited.push(win)
      continue
    }
    if (triggerMode === 'local_gate') {
      const gatePct = limitPercentFor(win.id, policy)
      if (win.used_percent >= gatePct) gateLimited.push(win)
    }
  }
  const activeLimited = triggerMode === 'local_gate' ? gateLimited : upstreamLimited
  const byId = Object.fromEntries(windows.map((w) => [w.id, w]))
  return {
    windows,
    byId,
    upstreamLimited,
    activeLimited,
    explicitLimited,
    limitedUntilMs: limitedUntilMs && limitedUntilMs > now ? limitedUntilMs : null,
    anyUpstreamLimited: upstreamLimited.length > 0 || explicitLimited,
    hasSpendableCredits: hasSpendableCodexCredits(vm, now),
  }
}

/**
 * Estimate 7d consumption velocity in **wall-clock fraction per hour**.
 * Combines:
 *   1. Current 7d window cumulative pace (`u7 / elapsed`, requires >= 6h elapsed)
 *   2. Recent active sample delta (`du7 / dt * activeRatio`, requires >= 2h span)
 *   3. Previous closed 7d window pace (cold-start fallback only)
 */
export function estimateSevenDayBurnRate({
  u7 = null,
  reset7dMs = null,
  rateSamples = [],
  windowHistory = null,
  activeHours = null,
  now = Date.now(),
} = {}) {
  const activeRatio = activeHoursRatio(activeHours)
  let winRate = null
  let recentRate = null
  let prevRate = null

  if (u7 != null && Number.isFinite(u7) && u7 > 0 && reset7dMs != null && reset7dMs > now) {
    const elapsedMs = Math.max(0, now - (reset7dMs - SEVEN_DAY_MS))
    if (elapsedMs >= MIN_7D_ELAPSED_MS) {
      winRate = u7 / (elapsedMs / HOUR_MS)
    }
  }

  if (u7 != null && Number.isFinite(u7) && Array.isArray(rateSamples) && rateSamples.length > 0) {
    const valid = rateSamples.filter((s) => {
      if (!s || !Number.isFinite(s.at) || !Number.isFinite(s.u7)) return false
      if (s.at >= now) return false
      if (reset7dMs != null && s.r7 != null && Math.abs(reset7dMs - s.r7) > SEVEN_DAY_MS / 2) return false
      return true
    })
    // Pick the oldest valid sample inside the same 7d window (up to 48h back) with enough span.
    const cutoff = now - 48 * HOUR_MS
    const anchor = valid.find((s) => s.at >= cutoff && now - s.at >= MIN_SAMPLE_SPAN_MS) || valid[0]
    if (anchor && now - anchor.at >= MIN_SAMPLE_SPAN_MS && u7 > anchor.u7) {
      const rawPerHour = (u7 - anchor.u7) / ((now - anchor.at) / HOUR_MS)
      // If the sample span is < 24h it mostly reflects active hours, so scale by daily active ratio.
      const spanScale = now - anchor.at < 24 * HOUR_MS ? activeRatio : 1
      recentRate = rawPerHour * spanScale
    }
  }

  let ratePerHour = null
  let source = 'none'
  if (winRate != null || recentRate != null) {
    if (recentRate != null && (winRate == null || recentRate >= winRate)) {
      ratePerHour = recentRate
      source = 'recent'
    } else {
      ratePerHour = winRate
      source = 'window'
    }
  } else {
    const prev = windowHistory?.['7d']?.prev
    const startMs = parseMs(prev?.start)
    const endMs = parseMs(prev?.end)
    const prevUsed = num(prev?.used_ratio)
    if (startMs && endMs && endMs > startMs && prevUsed != null && prevUsed > 0) {
      prevRate = prevUsed / ((endMs - startMs) / HOUR_MS)
      ratePerHour = prevRate
      source = 'prev'
    }
  }

  const adjustedRatePerHour = ratePerHour != null ? ratePerHour * VELOCITY_HEADROOM : null
  const remaining7d = u7 != null && Number.isFinite(u7) ? Math.max(0, 1 - u7) : null
  const estimatedHoursToFill7d =
    adjustedRatePerHour != null && adjustedRatePerHour > 0 && remaining7d != null
      ? remaining7d / adjustedRatePerHour
      : null

  return {
    rate_per_hour: ratePerHour,
    rate_per_day_pct: ratePerHour != null ? Math.round(ratePerHour * 24 * 1000) / 10 : null,
    adjusted_rate_per_hour: adjustedRatePerHour,
    source,
    active_ratio: activeRatio,
    estimated_hours_to_fill_7d: estimatedHoursToFill7d != null ? Math.round(estimatedHoursToFill7d * 10) / 10 : null,
  }
}

/**
 * Maximum number of 7d-full voucher consumptions achievable before `deadlineMs`,
 * given traffic is blocked until `resumeAtMs` (typically `R5` when 5h is full, or `now` in preview).
 */
function maxSevenDayUsesBefore({ deadlineMs, resumeAtMs, u7, reset7dMs, adjustedRatePerHour }) {
  if (!(adjustedRatePerHour > 0) || !(deadlineMs > resumeAtMs)) return 0
  const curUsed = Math.max(0, Math.min(1, u7 ?? 0))
  const curEnd = reset7dMs != null && reset7dMs > resumeAtMs ? Math.min(deadlineMs, reset7dMs) : deadlineMs
  const curHours = Math.max(0, (curEnd - resumeAtMs) / HOUR_MS)
  const curTotal = curUsed + adjustedRatePerHour * curHours
  const curUses = curTotal >= 1 ? Math.floor(curTotal) : 0

  let nextUses = 0
  if (reset7dMs != null && deadlineMs > reset7dMs) {
    const nextStart = Math.max(resumeAtMs, reset7dMs)
    const nextHours = Math.max(0, (deadlineMs - nextStart) / HOUR_MS)
    nextUses = Math.floor(adjustedRatePerHour * nextHours)
  }
  return curUses + nextUses
}

/**
 * 3-tier dynamic expiry rescue evaluation (zero hardcoded hour thresholds).
 *
 * When `fiveHourCapActive` is true (5h is currently 100%), decides whether to rescue right now.
 * When `fiveHourCapActive` is false (preview mode for UI), estimates whether the next 5h cap
 * would rescue the soonest-expiring voucher.
 */
export function evaluateDynamicExpiryRescue({
  vm,
  detection = null,
  resetCredits = null,
  rateSamples = [],
  minRemainingMin = 30,
  now = Date.now(),
  fiveHourCapActive = true,
} = {}) {
  const det = detection || detectCodexWindows(vm, { now })
  const info = inspectCodexResetCredits(resetCredits ?? vm?.codex?.reset_credits ?? vm?.reset_credits, now)
  const w5 = det.byId['5h'] || null
  const w7 = det.byId['7d'] || null
  const activeHours = activeHoursOf(vm)
  const burn = estimateSevenDayBurnRate({
    u7: w7?.used_ratio ?? null,
    reset7dMs: w7?.reset_ms ?? null,
    rateSamples,
    windowHistory: vm?.codex?.window_history ?? null,
    activeHours,
    now,
  })

  const base = {
    should_rescue: false,
    needs_probe: false,
    tier: null,
    reason: 'no_expiring_voucher',
    available_count: info.available_count,
    earliest_expires_at: info.earliest_expires_at,
    earliest_remaining_hours:
      info.earliest_expires_ms != null ? Math.round(((info.earliest_expires_ms - now) / HOUR_MS) * 10) / 10 : null,
    vouchers_within_7d: info.within_7d_count,
    max_7d_uses_before_expiry: null,
    burn,
  }

  if (!info.known) {
    return { ...base, needs_probe: fiveHourCapActive, reason: 'voucher_unknown' }
  }
  if (info.available_count <= 0 || info.vouchers.length === 0) {
    return { ...base, reason: info.available_count > 0 ? 'expiry_unknown' : 'no_cards' }
  }

  const earliestMs = info.earliest_expires_ms
  const reset5Ms = w5?.reset_ms && w5.reset_ms > now ? w5.reset_ms : null
  const rem5Ms = reset5Ms != null ? reset5Ms - now : null
  const minRemMs = Math.max(0, Number(minRemainingMin) || 0) * 60_000

  // Tier 1: voucher expires before (or within 15m of) this 5h window's natural reset.
  if (reset5Ms != null && earliestMs <= reset5Ms + TIER1_EXPIRY_BUFFER_MS) {
    return {
      ...base,
      should_rescue: true,
      tier: 1,
      reason: 'expiring_before_5h_reset',
      max_7d_uses_before_expiry: 0,
    }
  }

  // Tier 2: voucher expires before the next 5h cap given current 5h fill velocity.
  if (fiveHourCapActive && reset5Ms != null && rem5Ms != null) {
    const fill5Ms = Math.min(FIVE_HOUR_MS, Math.max(MIN_5H_FILL_MS, FIVE_HOUR_MS - rem5Ms))
    if (earliestMs <= reset5Ms + fill5Ms) {
      if (rem5Ms < minRemMs) {
        return { ...base, tier: 2, reason: 'reset_soon' }
      }
      return {
        ...base,
        should_rescue: true,
        tier: 2,
        reason: 'expiring_before_next_5h_cap',
        max_7d_uses_before_expiry: 0,
      }
    }
  }

  // Tier 3: within a 7-day horizon, check whether real 7d burn velocity can absorb every
  // expiring voucher prefix before its expiry deadline.
  const within7d = info.vouchers.filter((v) => v.expires_ms - now <= SEVEN_DAY_MS)
  if (within7d.length === 0) {
    return { ...base, reason: 'expiry_beyond_7d' }
  }
  if (burn.adjusted_rate_per_hour == null || !(burn.adjusted_rate_per_hour > 0)) {
    return { ...base, reason: 'insufficient_velocity_data' }
  }

  const resumeAtMs = fiveHourCapActive && reset5Ms != null ? reset5Ms : now
  let worstMaxUses = null
  for (let i = 0; i < within7d.length; i += 1) {
    const needed = i + 1
    const maxUses = maxSevenDayUsesBefore({
      deadlineMs: within7d[i].expires_ms,
      resumeAtMs,
      u7: w7?.used_ratio ?? 0,
      reset7dMs: w7?.reset_ms ?? null,
      adjustedRatePerHour: burn.adjusted_rate_per_hour,
    })
    if (worstMaxUses == null) worstMaxUses = maxUses
    if (maxUses < needed) {
      if (fiveHourCapActive && rem5Ms != null && rem5Ms < minRemMs) {
        return { ...base, tier: 3, reason: 'reset_soon', max_7d_uses_before_expiry: maxUses }
      }
      return {
        ...base,
        should_rescue: true,
        tier: 3,
        reason: needed > 1 ? 'surplus_vouchers_before_7d_fill' : 'expiring_before_7d_fill',
        max_7d_uses_before_expiry: maxUses,
      }
    }
  }

  return {
    ...base,
    reason: '7d_can_absorb_vouchers',
    max_7d_uses_before_expiry: worstMaxUses,
  }
}

/**
 * Full decision for a single Codex slot (used both for cheap local pre-check and live post-query confirm).
 */
export function evaluateCodexAutoReset({
  vm,
  effective,
  quotaPolicy = null,
  hold = null,
  rateSamples = [],
  now = Date.now(),
  liveChecked = false,
} = {}) {
  if (!effective?.enabled) {
    return { action: 'skip', reason: 'disabled', trigger_window: null, rescue: false, rescue_info: null }
  }
  const det = detectCodexWindows(vm, {
    quotaPolicy,
    hold,
    triggerMode: effective.trigger_mode,
    now,
  })
  if (!det.activeLimited.length && !det.explicitLimited) {
    return { action: 'skip', reason: 'not_limited', trigger_window: null, rescue: false, rescue_info: null }
  }
  if (!effective.prefer_voucher_over_credits && det.hasSpendableCredits) {
    return { action: 'skip', reason: 'spendable_credits', trigger_window: null, rescue: false, rescue_info: null }
  }

  const minRemMs = Math.max(0, Number(effective.min_reset_remaining_min) || 0) * 60_000

  // 1. Check regular enabled trigger windows (prefer 7d > other > 5h).
  const priority = (w) => (w.id === '7d' ? 0 : w.id === '5h' ? 2 : 1)
  const enabledLimited = det.activeLimited
    .filter((w) => effective.triggers?.[windowKind(w.id)] === true)
    .sort((a, b) => priority(a) - priority(b))

  if (enabledLimited.length > 0) {
    // Pass if ANY enabled limited window still has >= min_reset_remaining_min (or has no reset clock).
    const worthy = enabledLimited.find((w) => w.remaining_ms == null || w.remaining_ms >= minRemMs)
    if (worthy) {
      return {
        action: liveChecked ? 'redeem' : 'probe_and_redeem',
        reason: `quota_${worthy.id}_limited`,
        trigger_window: worthy.id,
        rescue: false,
        rescue_info: null,
      }
    }
    // All enabled limited windows are about to reset naturally. Still allow Tier 1 rescue if enabled!
    if (effective.smart_expiry_rescue) {
      const rescueInfo = evaluateDynamicExpiryRescue({
        vm,
        detection: det,
        rateSamples,
        minRemainingMin: effective.min_reset_remaining_min,
        now,
        fiveHourCapActive: det.byId['5h']?.used_percent >= 100 && det.byId['5h']?.live,
      })
      if (rescueInfo.should_rescue && rescueInfo.tier === 1) {
        return {
          action: liveChecked ? 'redeem' : 'probe_and_redeem',
          reason: rescueInfo.reason,
          trigger_window: enabledLimited[0].id,
          rescue: true,
          rescue_info: rescueInfo,
        }
      }
    }
    return {
      action: 'skip',
      reason: 'reset_soon',
      trigger_window: enabledLimited[0].id,
      rescue: false,
      rescue_info: null,
    }
  }

  // 2. Fallback when upstream returned explicit 429 without parsed window headers.
  if (det.explicitLimited && !det.activeLimited.length && effective.triggers?.seven_day) {
    const rem = det.limitedUntilMs ? det.limitedUntilMs - now : null
    if (rem != null && rem < minRemMs) {
      return { action: 'skip', reason: 'reset_soon', trigger_window: 'rate_limit', rescue: false, rescue_info: null }
    }
    return {
      action: liveChecked ? 'redeem' : 'probe_and_redeem',
      reason: 'upstream_rate_limited',
      trigger_window: 'rate_limit',
      rescue: false,
      rescue_info: null,
    }
  }

  // 3. Regular windows did not trigger (typically 5h=100% while 5h trigger is off): run dynamic expiry rescue.
  const w5 = det.byId['5h']
  const fiveHourUpstreamFull = !!(w5 && w5.live && w5.used_percent != null && w5.used_percent >= 100)
  if (effective.smart_expiry_rescue && fiveHourUpstreamFull) {
    const rescueInfo = evaluateDynamicExpiryRescue({
      vm,
      detection: det,
      rateSamples,
      minRemainingMin: effective.min_reset_remaining_min,
      now,
      fiveHourCapActive: true,
    })
    if (rescueInfo.should_rescue) {
      return {
        action: liveChecked ? 'redeem' : 'probe_and_redeem',
        reason: rescueInfo.reason,
        trigger_window: '5h',
        rescue: true,
        rescue_info: rescueInfo,
      }
    }
    if (!liveChecked && rescueInfo.needs_probe) {
      return {
        action: 'probe_for_rescue',
        reason: rescueInfo.reason,
        trigger_window: '5h',
        rescue: false,
        rescue_info: rescueInfo,
      }
    }
    return {
      action: 'skip',
      reason: rescueInfo.reason || 'window_not_enabled',
      trigger_window: '5h',
      rescue: false,
      rescue_info: rescueInfo,
    }
  }

  return {
    action: 'skip',
    reason: 'window_not_enabled',
    trigger_window: det.activeLimited[0]?.id || null,
    rescue: false,
    rescue_info: null,
  }
}

/** UI preview helper: shows current dynamic rescue assessment even before 5h hits 100%. */
export function previewCodexExpiryRescue({ vm, effective, rateSamples = [], now = Date.now() } = {}) {
  const det = detectCodexWindows(vm, { now })
  const w5 = det.byId['5h']
  const fiveHourFull = !!(w5 && w5.live && w5.used_percent != null && w5.used_percent >= 100)
  return evaluateDynamicExpiryRescue({
    vm,
    detection: det,
    rateSamples,
    minRemainingMin: effective?.min_reset_remaining_min ?? 30,
    now,
    fiveHourCapActive: fiveHourFull,
  })
}
