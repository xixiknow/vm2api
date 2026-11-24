/**
 * Credential watch for GPT slots enrolled for automatic re-login.
 *
 * Every minute a few due slots are probed with the ChatGPT model list (no paid generation)
 * through their own exit. An auth error first re-reads the credential file (the kernel may have
 * rotated the token), then refreshes once; only a rejected refresh, or a missing refresh token,
 * counts as an auth failure. After `fail_threshold` failures in a row the slot leaves the pool
 * (`oauth_invalid_grant`) and an automatic re-login is queued.
 */
import { normalizeGuardRules } from './codex-login-service.mjs'

let activeGuard = null

/** Called on a GPT 401: probe this slot on the next tick instead of waiting for its schedule. */
export function noteCodexAuthFailure(vmId) {
  activeGuard?.nudge(vmId)
}

/**
 * One probe. Returns { result: 'ok' | 'auth_failed' | 'forbidden' | 'transient', error? }.
 * `forbidden` = a freshly refreshed token is still refused: an account or region problem that a
 * re-login cannot fix.
 */
export async function probeCodexCredential({
  vm,
  readAccounts,
  proxyUrlFor,
  isLocalExit,
  fetchCatalog,
  refresh,
  persist,
}) {
  const first = readAccounts(vm.id)[0] || {}
  if (!first.access_token && !first.refresh_token) return { result: 'auth_failed', error: 'no_credential' }
  let proxyUrl
  try {
    proxyUrl = proxyUrlFor(vm) || ''
  } catch {
    return { result: 'transient', error: 'exit_unavailable' }
  }
  const direct = isLocalExit(vm)
  if (!proxyUrl && !direct) return { result: 'transient', error: 'proxy_required' }
  const check = (accessToken, accountId) => fetchCatalog({ accessToken, accountId, proxyUrl, direct })
  const verdict = (probe) =>
    probe.ok
      ? { result: 'ok' }
      : probe.error === 'upstream_auth'
        ? null
        : { result: 'transient', error: probe.error || 'probe_failed' }

  if (first.access_token) {
    const settled = verdict(await check(first.access_token, first.chatgpt_account_id))
    if (settled) return settled
  }
  const latest = readAccounts(vm.id)[0] || {}
  if (latest.access_token && latest.access_token !== first.access_token) {
    const settled = verdict(await check(latest.access_token, latest.chatgpt_account_id))
    if (settled) return settled
  }
  if (!latest.refresh_token) return { result: 'auth_failed', error: 'no_refresh_token' }
  const tok = await refresh({ refreshToken: latest.refresh_token, proxyUrl })
  if (!tok?.ok) {
    return tok?.error === 'refresh_rejected'
      ? { result: 'auth_failed', error: 'refresh_rejected' }
      : { result: 'transient', error: tok?.error || 'refresh_failed' }
  }
  persist(vm.id, {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || latest.refresh_token,
    id_token: tok.id_token || latest.id_token,
    expires_at: tok.expires_at || latest.expires_at,
  })
  const after = await check(tok.access_token, latest.chatgpt_account_id)
  if (after.ok) return { result: 'ok' }
  return after.error === 'upstream_auth'
    ? { result: 'forbidden', error: 'upstream_forbidden' }
    : { result: 'transient', error: after.error || 'probe_failed' }
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./codex-login-profiles.mjs').createCodexLoginProfiles>} deps.profiles
 * @param {ReturnType<import('./codex-relogin.mjs').createCodexReloginService>} deps.relogin
 * @param {() => object} deps.readConfig
 * @param {(vmId: string) => object|null} deps.getVm
 * @param {(vm: object) => boolean} deps.isCodexVm
 * @param {(vm: object) => Promise<{result: string, error?: string}>} deps.probe
 * @param {(vmId: string) => void} deps.markDead
 */
export function createCodexLoginGuard({
  profiles,
  relogin,
  readConfig,
  getVm,
  isCodexVm,
  probe,
  markDead,
  tickMs = 60_000,
  maxPerTick = 5,
  concurrency = 2,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  let timer = null
  let ticking = false
  const nudged = new Set()

  async function checkOne(profile, rules) {
    const vmId = profile.vm_id
    let verdict
    try {
      verdict = await probe(getVm(vmId))
    } catch {
      verdict = { result: 'transient', error: 'probe_failed' }
    }
    const t = now()
    let dead = false
    profiles.patchState(vmId, (state) => {
      state.last_probe_at = new Date(t).toISOString()
      state.last_probe_result = verdict.result === 'ok' ? 'ok' : verdict.error || verdict.result
      if (verdict.result === 'ok') {
        state.auth_fail_streak = 0
        state.next_probe_at = t + rules.probe_interval_min * 60_000
        return state
      }
      state.next_probe_at = t + rules.recheck_interval_min * 60_000
      if (verdict.result === 'auth_failed') {
        state.auth_fail_streak = (state.auth_fail_streak || 0) + 1
        dead = state.auth_fail_streak >= rules.fail_threshold
      }
      return state
    })
    if (!dead) return { vm_id: vmId, result: verdict.result }
    try {
      markDead(vmId)
    } catch {}
    const queued = relogin.request(vmId, { trigger: 'auto' })
    log({ event: 'codex_login_guard_dead', vm_id: vmId, relogin: queued.ok ? 'queued' : queued.error })
    return { vm_id: vmId, result: verdict.result, relogin: queued.ok ? 'queued' : queued.error }
  }

  async function tick() {
    if (ticking) return { skipped: 'busy' }
    ticking = true
    try {
      const cfg = readConfig() || {}
      if (!cfg.guard_enabled || !cfg.endpoint) return { probed: 0, results: [] }
      const rules = normalizeGuardRules(cfg.guard)
      const t = now()
      const due = profiles
        .list()
        .filter((p) => p.auto_relogin && p.password && !p.state.auto_paused)
        .filter((p) => nudged.has(p.vm_id) || (p.state.next_probe_at || 0) <= t)
        .filter((p) => {
          const vm = getVm(p.vm_id)
          return vm && isCodexVm(vm) && relogin.status(p.vm_id).state === 'idle'
        })
        .sort(
          (a, b) =>
            Number(nudged.has(b.vm_id)) - Number(nudged.has(a.vm_id)) ||
            (a.state.next_probe_at || 0) - (b.state.next_probe_at || 0),
        )
        .slice(0, maxPerTick)
      for (const p of due) nudged.delete(p.vm_id)
      const results = []
      let next = 0
      const worker = async () => {
        while (next < due.length) results.push(await checkOne(due[next++], rules))
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker))
      return { probed: due.length, results }
    } finally {
      ticking = false
    }
  }

  const api = {
    tick,
    start() {
      if (timer) return
      activeGuard = api
      timer = setInterval(() => {
        tick().catch((err) => log({ event: 'codex_login_guard_tick_failed', error: String(err?.code || 'tick') }))
      }, tickMs)
      timer.unref?.()
    },
    stop() {
      clearInterval(timer)
      timer = null
      if (activeGuard === api) activeGuard = null
    },
    nudge(vmId) {
      if (nudged.size < 1000 && vmId) nudged.add(String(vmId))
    },
  }
  return api
}
