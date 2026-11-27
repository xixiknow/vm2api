/**
 * Password re-login for one GPT slot (Callback v2).
 *
 * Uses the shared global login queue (manual > auto > batch) with per-proxy anti-collision.
 * By default locks `expected_account_id` to the slot's saved `chatgpt_account_id` so re-login
 * never silently switches workspaces; an explicit manual `allowWorkspaceReselect: true` opens a
 * fresh auto-selection session when the saved workspace is gone (`workspace_not_found`).
 */
import { createCodexLoginQueue } from './codex-login-queue.mjs'
import { codexAccountFromLogin, isServiceConfigured, normalizeGuardRules } from './codex-login-service.mjs'

/** Terminal/non-retryable errors where automatic retries must stop immediately. */
const IMMEDIATE_PAUSE_ERRORS = new Set([
  'password_rejected',
  'mfa_secret_required',
  'mfa_failed',
  'workspace_not_found',
  'auth_material_unavailable',
  'interaction_required',
  'unsupported_auth_state',
  'invalid_totp',
  'proxy_required',
  'unauthorized',
])

/**
 * @param {object} deps
 * @param {ReturnType<import('./codex-login-profiles.mjs').createCodexLoginProfiles>} deps.profiles
 * @param {() => object} deps.readConfig
 * @param {(o: object) => Promise<object>} deps.login
 * @param {(vmId: string) => object|null} deps.getVm
 * @param {(vm: object) => boolean} deps.isCodexVm
 * @param {(vm: object) => {ok?: boolean, proxy_id?: string|null, proxy_url?: string, error?: string, login_ip_differs?: boolean}} deps.slotExit
 * @param {(o: {vmId, account}) => Promise<{ok, error?}>} deps.commit
 * @param {(vmId: string) => Promise<void>} deps.restartKernel
 * @param {(o: {email?, chatgptAccountId?, excludeVmId?}) => ({vm_id: string}|null)} [deps.findExisting]
 * @param {ReturnType<import('./codex-login-queue.mjs').createCodexLoginQueue>} [deps.queue]
 * @param {(vmId: string) => boolean} [deps.isSlotBusy]
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
  findExisting = () => null,
  queue = null,
  isSlotBusy = () => false,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const loginQueue =
    queue ||
    createCodexLoginQueue({
      getMaxConcurrency: () => readConfig()?.max_concurrency || 4,
      now,
      log,
    })

  const tasks = new Map()
  let stopped = false

  function status(vmId) {
    const task = tasks.get(vmId)
    return task
      ? {
          state: task.status,
          stage: task.stage,
          trigger: task.trigger,
          started_at: task.started_at,
        }
      : { state: 'idle' }
  }

  function resolveExitInfo(vm) {
    try {
      const raw = slotExit(vm)
      if (!raw || raw.ok === false) {
        return { ok: false, error: raw?.error || 'proxy_unavailable' }
      }
      const proxyUrl = String(raw.proxy_url || '').trim()
      if (!proxyUrl) return { ok: false, error: 'proxy_required' }
      return {
        ok: true,
        proxy_id: raw.proxy_id || vm?.proxy?.id || null,
        proxy_url: proxyUrl,
        login_ip_differs: raw.login_ip_differs === true,
      }
    } catch (err) {
      return { ok: false, error: err?.code || 'exit_unavailable' }
    }
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
        state.relogin_fail_streak = (state.relogin_fail_streak || 0) + 1
        state.cooldown_until = t + rules.relogin_cooldown_min * 60_000
        if (IMMEDIATE_PAUSE_ERRORS.has(outcome.error)) {
          state.auto_paused = outcome.error
        } else if (state.relogin_fail_streak >= rules.max_relogin_failures) {
          state.auto_paused = 'too_many_failures'
        }
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
    const exit = resolveExitInfo(vm)
    if (!exit.ok) return { ok: false, error: exit.error }

    const knownId = String(vm.codex?.chatgpt_account_id || '').trim()
    const expectedAccountId = task.allowWorkspaceReselect ? null : knownId || null
    const resourceKey = exit.proxy_id ? `proxy:${exit.proxy_id}` : null
    const priority = task.trigger === 'manual' ? 'manual_relogin' : 'auto_relogin'

    const result = await loginQueue.runWithBackoff({ priority, resourceKey, signal: task.abort.signal }, async () => {
      if (stopped || task.abort.signal.aborted) return { ok: false, error: 'canceled' }
      const freshVm = getVm(vmId)
      if (!freshVm || !isCodexVm(freshVm)) return { ok: false, error: 'vm_not_found' }
      const freshExit = resolveExitInfo(freshVm)
      if (!freshExit.ok) return { ok: false, error: freshExit.error }
      task.status = 'running'
      task.stage = null
      task.started_at = new Date(now()).toISOString()
      return login({
        vmId,
        email: secrets.email,
        password: secrets.password,
        mfaSecret: secrets.mfa_secret || null,
        proxyUrl: freshExit.proxy_url,
        expectedAccountId,
        workspacePolicy: readConfig()?.workspace_policy || 'auto',
        signal: task.abort.signal,
        onProgress: (stage) => {
          task.stage = stage
        },
      })
    })

    if (!result?.ok) {
      const detail = result?.detail || (result?.status ? `http_${result.status}` : null)
      return { ok: false, error: result?.error || 'login_failed', detail }
    }
    const made = codexAccountFromLogin(result.credential, { workspace: result.workspace || null })
    if (!made.ok) return { ok: false, error: made.error }
    if (made.email !== secrets.email) return { ok: false, error: 'identity_mismatch' }
    const currentKnownId = String(getVm(vmId)?.codex?.chatgpt_account_id || '').trim()
    if (
      !task.allowWorkspaceReselect &&
      currentKnownId &&
      made.chatgpt_account_id &&
      currentKnownId !== made.chatgpt_account_id
    ) {
      return { ok: false, error: 'identity_mismatch' }
    }
    if (task.allowWorkspaceReselect && made.chatgpt_account_id) {
      const dup = findExisting({ chatgptAccountId: made.chatgpt_account_id, excludeVmId: vmId })
      if (dup) return { ok: false, error: 'account_exists' }
    }
    const done = await commit({ vmId, account: made.account })
    if (!done?.ok) return { ok: false, error: done?.error || 'import_failed' }
    try {
      await restartKernel(vmId)
    } catch (err) {
      // Tokens are persisted; a kernel that failed to restart picks them up on next start.
      log({ event: 'codex_relogin_kernel_restart_failed', vm_id: vmId, error: String(err?.code || 'restart_failed') })
    }
    return { ok: true, login_ip_differs: exit.login_ip_differs === true }
  }

  async function runTask(task) {
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

  /** Queue a re-login. `auto` respects the slot's switch, pause and cooldown; `manual` does not. */
  function request(vmId, { trigger = 'manual', allowWorkspaceReselect = false } = {}) {
    if (stopped) return { ok: false, status: 503, error: 'shutting_down' }
    if (tasks.has(vmId)) return { ok: true, status: 202, task: status(vmId), already: true }
    if (isSlotBusy(vmId)) return { ok: false, status: 409, error: 'slot_login_running' }
    const profile = profiles.get(vmId)
    if (!profile?.password) return { ok: false, status: 404, error: 'profile_missing' }
    const vm = getVm(vmId)
    if (!vm || !isCodexVm(vm)) return { ok: false, status: 404, error: 'vm_not_found' }
    if (!isServiceConfigured(readConfig())) return { ok: false, status: 409, error: 'login_service_unconfigured' }
    const normalizedTrigger = trigger === 'auto' ? 'auto' : 'manual'
    if (normalizedTrigger === 'auto') {
      if (!profile.auto_relogin) return { ok: false, status: 409, error: 'auto_relogin_off' }
      if (profile.state.auto_paused) return { ok: false, status: 409, error: 'auto_paused' }
      if ((profile.state.cooldown_until || 0) > now()) return { ok: false, status: 409, error: 'cooldown' }
    }
    const task = {
      vmId,
      trigger: normalizedTrigger,
      allowWorkspaceReselect: normalizedTrigger === 'manual' && allowWorkspaceReselect === true,
      status: 'queued',
      stage: null,
      started_at: null,
      abort: new AbortController(),
      done: null,
    }
    tasks.set(vmId, task)
    task.done = runTask(task).finally(() => {
      tasks.delete(vmId)
    })
    return { ok: true, status: 202, task: status(vmId) }
  }

  function stop() {
    stopped = true
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
