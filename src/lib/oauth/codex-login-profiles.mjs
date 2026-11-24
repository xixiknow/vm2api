/**
 * Per-slot GPT login details (email + password + optional TOTP secret) for password re-login.
 *
 * One settings row per slot (`codex_login:<vmId>`), so no migration is needed. Secrets are
 * written only when VM2API_DB_SECRET is set (AES-256-GCM, see db/secure.mjs) and are read back
 * only for a login request. Panel views carry `*_set` flags, never values.
 */
import { decryptString, encryptString, encryptionEnabled } from '../db/secure.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'

export const PROFILE_PREFIX = 'codex_login:'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_SECRET = 4096

export const EMPTY_PROFILE_STATE = Object.freeze({
  last_probe_at: null,
  last_probe_result: null,
  next_probe_at: 0,
  auth_fail_streak: 0,
  last_relogin_at: null,
  last_relogin_trigger: null,
  last_relogin_result: null,
  last_relogin_error: null,
  last_relogin_detail: null,
  relogin_fail_streak: 0,
  cooldown_until: 0,
  auto_paused: null,
  login_ip_differs: false,
})

export function normalizeLoginEmail(raw) {
  const email = String(raw ?? '')
    .trim()
    .toLowerCase()
  return email.length <= 320 && EMAIL_RE.test(email) ? email : ''
}

/** Base32 secrets are often shown in groups of four; an otpauth:// URI is kept as-is. */
export function normalizeTotpSecret(raw) {
  const text = String(raw ?? '').trim()
  return /^otpauth:\/\//i.test(text) ? text : text.replace(/\s+/g, '')
}

function normalizeRecord(vmId, raw) {
  return {
    vm_id: vmId,
    email: normalizeLoginEmail(raw.email),
    password: typeof raw.password === 'string' && raw.password ? raw.password : null,
    totp: typeof raw.totp === 'string' && raw.totp ? raw.totp : null,
    auto_relogin: raw.auto_relogin !== false,
    created_at: raw.created_at || null,
    updated_at: raw.updated_at || null,
    state: { ...EMPTY_PROFILE_STATE, ...(raw.state && typeof raw.state === 'object' ? raw.state : {}) },
  }
}

function readable(value) {
  if (!value) return true
  try {
    decryptString(value)
    return true
  } catch {
    return false
  }
}

export function publicProfile(record) {
  if (!record) return null
  return {
    vm_id: record.vm_id,
    email: record.email,
    password_set: !!record.password,
    totp_set: !!record.totp,
    auto_relogin: record.auto_relogin,
    secret_unreadable: !readable(record.password) || !readable(record.totp),
    created_at: record.created_at,
    updated_at: record.updated_at,
    state: { ...record.state },
  }
}

export function createCodexLoginProfiles({ settings = () => new SettingsRepo(), now = () => Date.now() } = {}) {
  const repo = () => (typeof settings === 'function' ? settings() : settings)
  const keyOf = (vmId) => PROFILE_PREFIX + vmId
  const iso = () => new Date(now()).toISOString()

  function get(vmId) {
    const raw = repo().get(keyOf(vmId), null)
    return raw && typeof raw === 'object' ? normalizeRecord(vmId, raw) : null
  }

  function list() {
    const out = []
    for (const [key, raw] of Object.entries(repo().all() || {})) {
      if (!key.startsWith(PROFILE_PREFIX) || !raw || typeof raw !== 'object') continue
      out.push(normalizeRecord(key.slice(PROFILE_PREFIX.length), raw))
    }
    return out
  }

  function write(record) {
    repo().set(keyOf(record.vm_id), record)
    return record
  }

  /**
   * Create or update. Blank password / TOTP keeps the saved one; a new email drops both, so an
   * old password is never paired with another account. `totp_clear: true` removes the TOTP.
   */
  function save(vmId, input = {}) {
    const prev = get(vmId)
    const email = Object.hasOwn(input, 'email') ? normalizeLoginEmail(input.email) : prev?.email || ''
    if (!email) return { ok: false, error: 'invalid_email' }
    const passwordIn = input.password == null ? '' : String(input.password)
    const totpIn = normalizeTotpSecret(input.totp_secret ?? input.mfa_secret ?? '')
    if ((passwordIn || totpIn) && !encryptionEnabled()) return { ok: false, error: 'encryption_required' }
    if (passwordIn.length > MAX_SECRET) return { ok: false, error: 'invalid_password' }
    if (totpIn.length > MAX_SECRET) return { ok: false, error: 'invalid_totp' }
    const emailChanged = !!prev && prev.email !== email
    let password = prev && !emailChanged ? prev.password : null
    let totp = prev && !emailChanged ? prev.totp : null
    if (passwordIn) password = encryptString(passwordIn)
    if (input.totp_clear === true) totp = null
    if (totpIn) totp = encryptString(totpIn)
    if (!password) return { ok: false, error: 'password_required' }
    const state = prev && !emailChanged ? { ...prev.state } : { ...EMPTY_PROFILE_STATE }
    // New login details are the operator's fix: lift a pause and its failure count.
    if (passwordIn || totpIn || emailChanged) {
      state.auto_paused = null
      state.relogin_fail_streak = 0
      state.cooldown_until = 0
    }
    if (Object.hasOwn(input, 'login_ip_differs')) state.login_ip_differs = input.login_ip_differs === true
    const record = {
      vm_id: vmId,
      email,
      password,
      totp,
      auto_relogin: Object.hasOwn(input, 'auto_relogin') ? input.auto_relogin !== false : (prev?.auto_relogin ?? true),
      created_at: prev?.created_at || iso(),
      updated_at: iso(),
      state,
    }
    return { ok: true, profile: write(record) }
  }

  function setAutoRelogin(vmId, enabled) {
    const record = get(vmId)
    if (!record) return null
    record.auto_relogin = enabled === true
    if (record.auto_relogin) {
      record.state.auto_paused = null
      record.state.relogin_fail_streak = 0
      record.state.cooldown_until = 0
      record.state.next_probe_at = 0
    }
    record.updated_at = iso()
    return write(record)
  }

  function patchState(vmId, patch) {
    const record = get(vmId)
    if (!record) return null
    const next = typeof patch === 'function' ? patch({ ...record.state }) : { ...record.state, ...patch }
    record.state = { ...EMPTY_PROFILE_STATE, ...next }
    return write(record)
  }

  function remove(vmId) {
    repo().remove(keyOf(vmId))
  }

  function findByEmail(email) {
    const want = normalizeLoginEmail(email)
    return want ? list().find((record) => record.email === want) || null : null
  }

  /** Decrypted login details, for the login request only. */
  function secrets(vmId) {
    const record = get(vmId)
    if (!record?.password) return { ok: false, error: 'profile_missing' }
    try {
      return {
        ok: true,
        email: record.email,
        password: decryptString(record.password),
        mfa_secret: record.totp ? decryptString(record.totp) : '',
      }
    } catch {
      return { ok: false, error: 'secret_unreadable' }
    }
  }

  return { get, list, save, setAutoRelogin, patchState, remove, findByEmail, secrets }
}
