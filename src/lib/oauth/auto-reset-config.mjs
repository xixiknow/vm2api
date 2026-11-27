/**
 * Storage, schema validation and per-slot inheritance for automatic reset voucher redemption.
 *
 * Persisted in the existing `settings` key/value table (zero migrations, SQLite + PostgreSQL):
 *   - `auto_reset_config`   : global config (currently `codex`, extensible for `claude`)
 *   - `auto_reset:<vmId>`   : per-slot 3-state mode, rule overrides, runtime state & 7d rate samples
 *   - `auto_reset_events`   : bounded audit log of recent attempts / redemptions / pauses
 */

export const AUTO_RESET_CONFIG_KEY = 'auto_reset_config'
export const AUTO_RESET_SLOT_PREFIX = 'auto_reset:'
export const AUTO_RESET_EVENTS_KEY = 'auto_reset_events'

export const TRIGGER_MODES = Object.freeze(['upstream_limit', 'local_gate'])
export const SLOT_MODES = Object.freeze(['inherit', 'enabled', 'disabled'])

export const MAX_AUTO_RESET_EVENTS = 50
export const MAX_RATE_SAMPLES = 12
export const RATE_SAMPLE_MIN_GAP_MS = 10 * 60_000
export const CONSECUTIVE_FAILURE_PAUSE_THRESHOLD = 3

const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const RESET_DROP_THRESHOLD = 0.02

export const DEFAULT_CODEX_AUTO_RESET = Object.freeze({
  enabled: false,
  triggers: Object.freeze({
    seven_day: true,
    five_hour: false,
    other_window: true,
  }),
  trigger_mode: 'upstream_limit',
  prefer_voucher_over_credits: true,
  smart_expiry_rescue: true,
  min_reset_remaining_min: 30,
  cooldown_min: 10,
  max_per_day: 0,
  no_card_recheck_min: 30,
})

const CODEX_INT_LIMITS = Object.freeze({
  min_reset_remaining_min: { min: 0, max: 1440 },
  cooldown_min: { min: 1, max: 1440 },
  max_per_day: { min: 0, max: 50 },
  no_card_recheck_min: { min: 5, max: 1440 },
})

const CODEX_TRIGGER_KEYS = ['seven_day', 'five_hour', 'other_window']
const CODEX_OVERRIDE_KEYS = [
  'triggers',
  'trigger_mode',
  'prefer_voucher_over_credits',
  'smart_expiry_rescue',
  'min_reset_remaining_min',
  'cooldown_min',
  'max_per_day',
  'no_card_recheck_min',
]

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function clampInt(value, min, max, fallback) {
  if (value == null || value === '' || typeof value === 'boolean') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function strictInt(value, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < min || value > max) return null
  return value
}

/** Beijing calendar day (`YYYY-MM-DD`) for deterministic daily caps across host timezones. */
export function beijingDateKey(now = Date.now()) {
  const ms = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

export function normalizeCodexRule(raw = {}) {
  const src = isPlainObject(raw) ? raw : {}
  const tr = isPlainObject(src.triggers) ? src.triggers : {}
  return {
    enabled: src.enabled === true,
    triggers: {
      seven_day: typeof tr.seven_day === 'boolean' ? tr.seven_day : DEFAULT_CODEX_AUTO_RESET.triggers.seven_day,
      five_hour: typeof tr.five_hour === 'boolean' ? tr.five_hour : DEFAULT_CODEX_AUTO_RESET.triggers.five_hour,
      other_window:
        typeof tr.other_window === 'boolean' ? tr.other_window : DEFAULT_CODEX_AUTO_RESET.triggers.other_window,
    },
    trigger_mode: TRIGGER_MODES.includes(src.trigger_mode) ? src.trigger_mode : DEFAULT_CODEX_AUTO_RESET.trigger_mode,
    prefer_voucher_over_credits:
      typeof src.prefer_voucher_over_credits === 'boolean'
        ? src.prefer_voucher_over_credits
        : DEFAULT_CODEX_AUTO_RESET.prefer_voucher_over_credits,
    smart_expiry_rescue:
      typeof src.smart_expiry_rescue === 'boolean'
        ? src.smart_expiry_rescue
        : DEFAULT_CODEX_AUTO_RESET.smart_expiry_rescue,
    min_reset_remaining_min: clampInt(
      src.min_reset_remaining_min,
      CODEX_INT_LIMITS.min_reset_remaining_min.min,
      CODEX_INT_LIMITS.min_reset_remaining_min.max,
      DEFAULT_CODEX_AUTO_RESET.min_reset_remaining_min,
    ),
    cooldown_min: clampInt(
      src.cooldown_min,
      CODEX_INT_LIMITS.cooldown_min.min,
      CODEX_INT_LIMITS.cooldown_min.max,
      DEFAULT_CODEX_AUTO_RESET.cooldown_min,
    ),
    max_per_day: clampInt(
      src.max_per_day,
      CODEX_INT_LIMITS.max_per_day.min,
      CODEX_INT_LIMITS.max_per_day.max,
      DEFAULT_CODEX_AUTO_RESET.max_per_day,
    ),
    no_card_recheck_min: clampInt(
      src.no_card_recheck_min,
      CODEX_INT_LIMITS.no_card_recheck_min.min,
      CODEX_INT_LIMITS.no_card_recheck_min.max,
      DEFAULT_CODEX_AUTO_RESET.no_card_recheck_min,
    ),
  }
}

export function normalizeGlobalConfig(raw = {}) {
  const src = isPlainObject(raw) ? raw : {}
  return {
    codex: normalizeCodexRule(src.codex),
  }
}

export function validateCodexRulePatch(raw, { allowEnabled = true, allowNull = false } = {}) {
  if (!isPlainObject(raw)) return { ok: false, error: 'invalid_config' }
  const patch = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'enabled') {
      if (!allowEnabled) return { ok: false, error: 'invalid_field' }
      if (typeof value !== 'boolean') return { ok: false, error: 'invalid_enabled' }
      patch.enabled = value
      continue
    }
    if (!CODEX_OVERRIDE_KEYS.includes(key)) return { ok: false, error: 'invalid_field' }
    if (value === null) {
      if (!allowNull) return { ok: false, error: `invalid_${key}` }
      patch[key] = null
      continue
    }
    if (key === 'triggers') {
      if (!isPlainObject(value)) return { ok: false, error: 'invalid_triggers' }
      const tr = {}
      for (const [tk, tv] of Object.entries(value)) {
        if (!CODEX_TRIGGER_KEYS.includes(tk)) return { ok: false, error: 'invalid_triggers' }
        if (tv === null && allowNull) {
          tr[tk] = null
          continue
        }
        if (typeof tv !== 'boolean') return { ok: false, error: 'invalid_triggers' }
        tr[tk] = tv
      }
      patch.triggers = tr
      continue
    }
    if (key === 'trigger_mode') {
      if (!TRIGGER_MODES.includes(value)) return { ok: false, error: 'invalid_trigger_mode' }
      patch.trigger_mode = value
      continue
    }
    if (key === 'prefer_voucher_over_credits' || key === 'smart_expiry_rescue') {
      if (typeof value !== 'boolean') return { ok: false, error: `invalid_${key}` }
      patch[key] = value
      continue
    }
    const limits = CODEX_INT_LIMITS[key]
    const n = strictInt(value, limits.min, limits.max)
    if (n == null) return { ok: false, error: `invalid_${key}` }
    patch[key] = n
  }
  return { ok: true, patch }
}

function normalizeRateSamples(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      at: Number(item.at),
      u7: Number(item.u7),
      r7: item.r7 == null ? null : Number(item.r7),
    }))
    .filter(
      (item) =>
        Number.isFinite(item.at) &&
        item.at > 0 &&
        Number.isFinite(item.u7) &&
        item.u7 >= 0 &&
        item.u7 <= 1 &&
        (item.r7 == null || (Number.isFinite(item.r7) && item.r7 > 0)),
    )
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_RATE_SAMPLES)
}

export function normalizeSlotState(raw = {}, now = Date.now()) {
  const src = isPlainObject(raw) ? raw : {}
  const today = beijingDateKey(now)
  const storedDate = typeof src.daily_date === 'string' && src.daily_date ? src.daily_date : today
  const sameDay = storedDate === today
  return {
    auto_paused: src.auto_paused === true,
    paused_reason: typeof src.paused_reason === 'string' && src.paused_reason ? src.paused_reason : null,
    consecutive_failures: Math.max(0, Math.trunc(Number(src.consecutive_failures) || 0)),
    last_attempt_at: typeof src.last_attempt_at === 'string' && src.last_attempt_at ? src.last_attempt_at : null,
    last_reset_at: typeof src.last_reset_at === 'string' && src.last_reset_at ? src.last_reset_at : null,
    last_result: typeof src.last_result === 'string' && src.last_result ? src.last_result : null,
    last_trigger_window:
      typeof src.last_trigger_window === 'string' && src.last_trigger_window ? src.last_trigger_window : null,
    last_rescue: src.last_rescue === true,
    last_rescue_reason:
      typeof src.last_rescue_reason === 'string' && src.last_rescue_reason ? src.last_rescue_reason : null,
    last_error: typeof src.last_error === 'string' && src.last_error ? src.last_error : null,
    no_card_until: Math.max(0, Number(src.no_card_until) || 0),
    daily_date: today,
    daily_count: sameDay ? Math.max(0, Math.trunc(Number(src.daily_count) || 0)) : 0,
    rate_samples: normalizeRateSamples(src.rate_samples),
  }
}

export function normalizeSlotOverrides(raw = {}) {
  if (!isPlainObject(raw)) return {}
  const out = {}
  if (isPlainObject(raw.triggers)) {
    const tr = {}
    for (const k of CODEX_TRIGGER_KEYS) {
      if (typeof raw.triggers[k] === 'boolean') tr[k] = raw.triggers[k]
    }
    if (Object.keys(tr).length) out.triggers = tr
  }
  if (TRIGGER_MODES.includes(raw.trigger_mode)) out.trigger_mode = raw.trigger_mode
  if (typeof raw.prefer_voucher_over_credits === 'boolean') {
    out.prefer_voucher_over_credits = raw.prefer_voucher_over_credits
  }
  if (typeof raw.smart_expiry_rescue === 'boolean') {
    out.smart_expiry_rescue = raw.smart_expiry_rescue
  }
  for (const [key, limits] of Object.entries(CODEX_INT_LIMITS)) {
    const n = strictInt(raw[key], limits.min, limits.max)
    if (n != null) out[key] = n
  }
  return out
}

export function normalizeSlotRecord(vmId, raw = {}, now = Date.now()) {
  const src = isPlainObject(raw) ? raw : {}
  return {
    vm_id: String(vmId || src.vm_id || ''),
    mode: SLOT_MODES.includes(src.mode) ? src.mode : 'inherit',
    overrides: normalizeSlotOverrides(src.overrides),
    state: normalizeSlotState(src.state, now),
    updated_at: typeof src.updated_at === 'string' && src.updated_at ? src.updated_at : null,
  }
}

export function hasCustomOverrides(record) {
  if (!record) return false
  if (record.mode && record.mode !== 'inherit') return true
  const ov = record.overrides || {}
  return Object.keys(ov).length > 0
}

export function resolveEffectiveCodexPolicy(globalConfig, slotRecord) {
  const base = normalizeGlobalConfig(globalConfig).codex
  const mode = SLOT_MODES.includes(slotRecord?.mode) ? slotRecord.mode : 'inherit'
  const ov = normalizeSlotOverrides(slotRecord?.overrides)
  const enabled = mode === 'enabled' ? true : mode === 'disabled' ? false : base.enabled
  return {
    enabled,
    mode,
    triggers: {
      seven_day: typeof ov.triggers?.seven_day === 'boolean' ? ov.triggers.seven_day : base.triggers.seven_day,
      five_hour: typeof ov.triggers?.five_hour === 'boolean' ? ov.triggers.five_hour : base.triggers.five_hour,
      other_window:
        typeof ov.triggers?.other_window === 'boolean' ? ov.triggers.other_window : base.triggers.other_window,
    },
    trigger_mode: ov.trigger_mode ?? base.trigger_mode,
    prefer_voucher_over_credits: ov.prefer_voucher_over_credits ?? base.prefer_voucher_over_credits,
    smart_expiry_rescue: ov.smart_expiry_rescue ?? base.smart_expiry_rescue,
    min_reset_remaining_min: ov.min_reset_remaining_min ?? base.min_reset_remaining_min,
    cooldown_min: ov.cooldown_min ?? base.cooldown_min,
    max_per_day: ov.max_per_day ?? base.max_per_day,
    no_card_recheck_min: ov.no_card_recheck_min ?? base.no_card_recheck_min,
    has_overrides: hasCustomOverrides({ mode, overrides: ov }),
  }
}

function mergeOverrides(current, patch) {
  const next = { ...normalizeSlotOverrides(current) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key]
      continue
    }
    if (key === 'triggers') {
      const tr = { ...(next.triggers || {}) }
      for (const [tk, tv] of Object.entries(value)) {
        if (tv === null) delete tr[tk]
        else tr[tk] = tv
      }
      if (Object.keys(tr).length) next.triggers = tr
      else delete next.triggers
      continue
    }
    next[key] = value
  }
  return next
}

/** Public view of slot state (hides raw sampling ring buffer from lightweight APIs unless needed). */
export function publicSlotState(state) {
  const s = normalizeSlotState(state)
  return {
    auto_paused: s.auto_paused,
    paused_reason: s.paused_reason,
    consecutive_failures: s.consecutive_failures,
    last_attempt_at: s.last_attempt_at,
    last_reset_at: s.last_reset_at,
    last_result: s.last_result,
    last_trigger_window: s.last_trigger_window,
    last_rescue: s.last_rescue,
    last_rescue_reason: s.last_rescue_reason,
    last_error: s.last_error,
    no_card_until: s.no_card_until,
    daily_date: s.daily_date,
    daily_count: s.daily_count,
    rate_sample_count: s.rate_samples.length,
  }
}

/**
 * Append a new 7d usage observation to a slot's sample list.
 * Returns `{ changed, samples }` without mutating input.
 */
export function appendRateSample(samples, { u7, r7 = null, now = Date.now() }) {
  const pct = Number(u7)
  if (!Number.isFinite(pct) || pct < 0 || pct > 1) return { changed: false, samples: normalizeRateSamples(samples) }
  const r7Ms = r7 == null ? null : Number(r7)
  if (r7Ms != null && (!Number.isFinite(r7Ms) || r7Ms <= now)) {
    return { changed: false, samples: normalizeRateSamples(samples) }
  }
  const list = normalizeRateSamples(samples)
  const last = list[list.length - 1]
  // Window rolled over or reset credit cleared 7d: start a clean velocity trace.
  const windowRolled =
    last &&
    ((last.r7 != null && r7Ms != null && Math.abs(r7Ms - last.r7) > SEVEN_DAY_MS / 2) ||
      pct + RESET_DROP_THRESHOLD < last.u7)
  if (windowRolled) {
    return { changed: true, samples: [{ at: now, u7: pct, r7: r7Ms }] }
  }
  if (last) {
    const gap = now - last.at
    const delta = Math.abs(pct - last.u7)
    if (gap < RATE_SAMPLE_MIN_GAP_MS && delta < 0.02) {
      return { changed: false, samples: list }
    }
    if (delta < 0.001 && gap < 60 * 60_000) {
      return { changed: false, samples: list }
    }
  }
  return {
    changed: true,
    samples: [...list, { at: now, u7: pct, r7: r7Ms }].slice(-MAX_RATE_SAMPLES),
  }
}

export function createAutoResetStore({ settings, now = () => Date.now() } = {}) {
  const repo = () => (typeof settings === 'function' ? settings() : settings)
  const slotKey = (vmId) => `${AUTO_RESET_SLOT_PREFIX}${vmId}`

  function readConfig() {
    return normalizeGlobalConfig(repo().get(AUTO_RESET_CONFIG_KEY, null))
  }

  function saveConfigPatch(body) {
    if (!isPlainObject(body)) return { ok: false, error: 'invalid_config' }
    const current = readConfig()
    const codexInput = isPlainObject(body.codex) ? body.codex : null
    if (!codexInput) return { ok: false, error: 'invalid_config' }
    for (const key of Object.keys(body)) {
      if (key !== 'codex') return { ok: false, error: 'invalid_field' }
    }
    const validated = validateCodexRulePatch(codexInput, { allowEnabled: true, allowNull: false })
    if (!validated.ok) return validated
    const p = validated.patch
    const nextCodex = normalizeCodexRule({
      ...current.codex,
      ...p,
      triggers: p.triggers ? { ...current.codex.triggers, ...p.triggers } : current.codex.triggers,
    })
    const next = { ...current, codex: nextCodex }
    repo().set(AUTO_RESET_CONFIG_KEY, next)
    return { ok: true, config: next }
  }

  function getSlot(vmId) {
    const raw = repo().get(slotKey(vmId), null)
    return normalizeSlotRecord(vmId, raw || {}, now())
  }

  function listSlots() {
    const all = repo().all() || {}
    const out = []
    const t = now()
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(AUTO_RESET_SLOT_PREFIX)) continue
      const vmId = key.slice(AUTO_RESET_SLOT_PREFIX.length)
      if (!vmId) continue
      out.push(normalizeSlotRecord(vmId, value, t))
    }
    return out
  }

  function saveSlotPatch(vmId, body) {
    if (!isPlainObject(body)) return { ok: false, error: 'invalid_config' }
    const allowedTop = new Set(['mode', 'overrides', 'resume', 'clear_backoff'])
    for (const key of Object.keys(body)) {
      if (!allowedTop.has(key)) return { ok: false, error: 'invalid_field' }
    }
    const current = getSlot(vmId)
    let nextMode = current.mode
    if (Object.hasOwn(body, 'mode')) {
      if (!SLOT_MODES.includes(body.mode)) return { ok: false, error: 'invalid_mode' }
      nextMode = body.mode
    }
    let nextOverrides = current.overrides
    if (Object.hasOwn(body, 'overrides')) {
      if (body.overrides === null) {
        nextOverrides = {}
      } else {
        const validated = validateCodexRulePatch(body.overrides, { allowEnabled: false, allowNull: true })
        if (!validated.ok) return validated
        nextOverrides = mergeOverrides(current.overrides, validated.patch)
      }
    }
    const nextState = { ...current.state }
    if (body.resume === true) {
      nextState.auto_paused = false
      nextState.paused_reason = null
      nextState.consecutive_failures = 0
      nextState.no_card_until = 0
      nextState.last_error = null
    }
    if (body.clear_backoff === true) {
      nextState.no_card_until = 0
    }
    const next = {
      vm_id: String(vmId),
      mode: nextMode,
      overrides: nextOverrides,
      state: nextState,
      updated_at: new Date(now()).toISOString(),
    }
    repo().set(slotKey(vmId), next)
    return { ok: true, record: next }
  }

  function resetSlotOverride(vmId) {
    const current = getSlot(vmId)
    const next = {
      ...current,
      mode: 'inherit',
      overrides: {},
      updated_at: new Date(now()).toISOString(),
    }
    repo().set(slotKey(vmId), next)
    return { ok: true, record: next }
  }

  function patchSlotState(vmId, mutator) {
    const current = getSlot(vmId)
    const draft = { ...current.state, rate_samples: [...current.state.rate_samples] }
    const nextState = typeof mutator === 'function' ? mutator(draft) || draft : { ...draft, ...(mutator || {}) }
    const next = {
      ...current,
      state: normalizeSlotState(nextState, now()),
      updated_at: new Date(now()).toISOString(),
    }
    repo().set(slotKey(vmId), next)
    return next
  }

  function recordSevenDaySample(vmId, { u7, r7 = null, at = now() }) {
    const current = getSlot(vmId)
    const appended = appendRateSample(current.state.rate_samples, { u7, r7, now: at })
    if (!appended.changed) return false
    const next = {
      ...current,
      state: { ...current.state, rate_samples: appended.samples },
      updated_at: new Date(at).toISOString(),
    }
    repo().set(slotKey(vmId), next)
    return true
  }

  function removeSlot(vmId) {
    repo().remove(slotKey(vmId))
  }

  function listEvents() {
    const raw = repo().get(AUTO_RESET_EVENTS_KEY, [])
    return Array.isArray(raw) ? raw : []
  }

  function appendEvent(event) {
    const entry = {
      at: new Date(now()).toISOString(),
      ...event,
    }
    const next = [entry, ...listEvents()].slice(0, MAX_AUTO_RESET_EVENTS)
    repo().set(AUTO_RESET_EVENTS_KEY, next)
    return entry
  }

  return {
    readConfig,
    saveConfigPatch,
    getSlot,
    listSlots,
    saveSlotPatch,
    resetSlotOverride,
    patchSlotState,
    recordSevenDaySample,
    removeSlot,
    listEvents,
    appendEvent,
  }
}
