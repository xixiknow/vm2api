/**
 * Password re-login for one GPT slot. The saved email / password / TOTP go to the login service
 * together with the slot's own exit; the new tokens replace the old ones only when the JWT
 * identity still matches the slot. Manual and automatic triggers share one queue: one task per
 * slot, a few slots at a time. Every outcome lands in the slot's login profile state.
 */
import { codexAccountFromLogin, normalizeGuardRules } from './codex-login-service.mjs'

/**
 * @param {object} deps
 * @param {ReturnType<import('./codex-login-profiles.mjs').createCodexLoginProfiles>} deps.profiles
 * @param {() => object} deps.readConfig login service config (normalized)
 * @param {(o: {email, password, mfaSecret, proxyUrl, signal}) => Promise<object>} deps.login
 * @param {(vmId: string) => object|null} deps.getVm
 * @param {(vm: object) => boolean} deps.isCodexVm
 * @param {(vm: object) => {proxy_url: string, login_ip_differs: boolean}} deps.slotExit
 * @param {(o: {vmId, account}) => Promise<{ok, error?}>} deps.commit
 * @param {(vmId: string) => Promise<void>} deps.restartKernel
 */
export function createCodexReloginService({
  profiles,
  readConfig,
  login,
  getVm,
  isCodexVm,
  slotExit,
  commit,
  restartKernel,
  concurrency = 2,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const tasks = new Map()
  const queue = []
  let active = 0
  let stopped = false

  function status(vmId) {
    const task = tasks.get(vmId)
    return task ? { state: task.status, trigger: task.trigger, started_at: task.started_at } : { state: 'idle' }
  }

  function record(vmId, trigger, outcome) {
    const rules = normalizeGuardRules(readConfig()?.guard)
    const t = now()
    profiles.patchState(vmId, (state) => {
      state.last_relogin_at = new Date(t).toISOString()
      state.last_relogin_trigger = trigger
      if (outcome.ok) {
        state.last_relogin_result = 'ok'
        state.last_relogin_error = null
        state.last_relogin_detail = null
        state.relogin_fail_streak = 0
        state.auth_fail_streak = 0
        state.cooldown_until = 0
        state.auto_paused = null
        state.next_probe_at = t + rules.probe_interval_min * 60_000
        state.login_ip_differs = outcome.login_ip_differs === true
        return state
      }
      state.last_relogin_result = outcome.error === 'canceled' ? 'canceled' : 'failed'
      state.last_relogin_error = outcome.error
      state.last_relogin_detail = outcome.detail || null
      if (outcome.error !== 'canceled') {
        // Repeated wrong passwords look like an attack upstream: stop after a few.
        state.relogin_fail_streak = (state.relogin_fail_streak || 0) + 1
        state.cooldown_until = t + rules.relogin_cooldown_min * 60_000
        if (state.relogin_fail_streak >= rules.max_relogin_failures) state.auto_paused = 'too_many_failures'
      }
      return state
    })
  }

  async function attempt(task) {
    const vmId = task.vmId
    const secrets = profiles.secrets(vmId)
    if (!secrets.ok) return { ok: false, error: secrets.error }
    const vm = getVm(vmId)
    if (!vm || !isCodexVm(vm)) return { ok: false, error: 'vm_not_found' }
    let exit
    try {
      exit = slotExit(vm)
    } catch {
      return { ok: false, error: 'exit_unavailable' }
    }
    const ac = new AbortController()
    task.abort = ac
    let result
    try {
      result = await login({
        email: secrets.email,
        password: secrets.password,
        mfaSecret: secrets.mfa_secret,
        proxyUrl: exit.proxy_url || '',
        signal: ac.signal,
      })
    } finally {
      task.abort = null
    }
    if (!result?.ok) {
      const detail = result?.detail || (result?.status ? `http_${result.status}` : null)
      return { ok: false, error: result?.error || 'login_failed', detail }
    }
    const made = codexAccountFromLogin(result.credential)
    if (!made.ok) return { ok: false, error: made.error }
    if (made.email !== secrets.email) return { ok: false, error: 'identity_mismatch' }
    const knownId = String(getVm(vmId)?.codex?.chatgpt_account_id || '').trim()
    if (knownId && made.chatgpt_account_id && knownId !== made.chatgpt_account_id) {
      return { ok: false, error: 'identity_mismatch' }
    }
    const done = await commit({ vmId, account: made.account })
    if (!done?.ok) return { ok: false, error: done?.error || 'import_failed' }
    try {
      await restartKernel(vmId)
    } catch (err) {
      // The tokens are on disk; a kernel that failed to restart picks them up on next start.
      log({ event: 'codex_relogin_kernel_restart_failed', vm_id: vmId, error: String(err?.code || 'restart_failed') })
    }
    return { ok: true, login_ip_differs: exit.login_ip_differs === true }
  }

  async function run(task) {
    task.status = 'running'
    task.started_at = new Date(now()).toISOString()
    let outcome
    try {
      outcome = await attempt(task)
    } catch (err) {
      log({ event: 'codex_relogin_failed', vm_id: task.vmId, error: String(err?.code || err?.name || 'internal') })
      outcome = { ok: false, error: 'internal_error' }
    }
    if (!stopped) record(task.vmId, task.trigger, outcome)
    log({
      event: 'codex_relogin',
      vm_id: task.vmId,
      trigger: task.trigger,
      ok: outcome.ok,
      error: outcome.error || null,
    })
    return outcome
  }

  function pump() {
    while (!stopped && active < concurrency && queue.length) {
      const task = queue.shift()
      active++
      task.done = run(task).finally(() => {
        active--
        tasks.delete(task.vmId)
        pump()
      })
    }
  }

  /** Queue a re-login. `auto` respects the slot's switch, pause and cooldown; `manual` does not. */
  function request(vmId, { trigger = 'manual' } = {}) {
    if (stopped) return { ok: false, status: 503, error: 'shutting_down' }
    if (tasks.has(vmId)) return { ok: true, status: 202, task: status(vmId), already: true }
    const profile = profiles.get(vmId)
    if (!profile?.password) return { ok: false, status: 404, error: 'profile_missing' }
    const vm = getVm(vmId)
    if (!vm || !isCodexVm(vm)) return { ok: false, status: 404, error: 'vm_not_found' }
    if (!readConfig()?.endpoint) return { ok: false, status: 409, error: 'login_service_unconfigured' }
    if (trigger === 'auto') {
      if (!profile.auto_relogin) return { ok: false, status: 409, error: 'auto_relogin_off' }
      if (profile.state.auto_paused) return { ok: false, status: 409, error: 'auto_paused' }
      if ((profile.state.cooldown_until || 0) > now()) return { ok: false, status: 409, error: 'cooldown' }
    }
    const task = { vmId, trigger: trigger === 'auto' ? 'auto' : 'manual', status: 'queued', started_at: null }
    tasks.set(vmId, task)
    queue.push(task)
    pump()
    return { ok: true, status: 202, task: status(vmId) }
  }

  function stop() {
    stopped = true
    queue.length = 0
    for (const task of tasks.values()) task.abort?.abort()
  }

  return {
    request,
    status,
    stop,
    /** Resolves when the slot's current task ends (tests). */
    settled: (vmId) => tasks.get(vmId)?.done || Promise.resolve(),
  }
}
