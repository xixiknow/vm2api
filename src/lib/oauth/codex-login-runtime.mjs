/**
 * Production wiring for GPT password login (Callback v2):
 *   - Unified global concurrency & per-proxy anti-collision queue
 *   - Batch first import (proxy pool only, bad-proxy avoidance, capacity pre-check)
 *   - Single-slot password login (onboard step 3, slot import card, reauth dialog)
 *   - Password re-login and credential guard
 *
 * Server boot creates one runtime. The panel handler attaches its slot helpers (credential
 * commit, bring-up, timezone) because those live in panel-routes.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { encryptionEnabled } from '../db/secure.mjs'
import { fetchChatgptModelCatalog, refreshCodexAccessToken } from '../protocol/codex-models.mjs'
import { ensureCodexKernel, stopCodexKernel } from '../transport/codex-kernel-supervisor.mjs'
import { readCodexAccounts, upsertCodexAccount } from '../vm/codex-slot.mjs'
import { egressEnabled, ensureProxyEgress, isLocalEgressProxy } from '../vm/egress.mjs'
import { resolveImportProxy, resolveSlotOAuthProxy } from '../vm/proxy-resolve.mjs'
import { syncVmTimezoneFromProxy } from '../vm/proxy-timezone.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { destroySlot, slotExec } from '../vm/slot-runtime.mjs'
import { removeVmFromDb } from '../vm/vm-db-sync.mjs'
import { invalidateVmSlotReadCache, withVmLock } from '../vm/vm-file.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { VM_PACKAGE_TYPE, VM_PACKAGE_VERSION, commitVmPackage, parseVmPackage } from '../vm/vm-package.mjs'
import { bindVmProxy, getVm, listVms, markUnschedulable } from '../vm/vm-registry.mjs'
import { nextNumericIndex, padVm } from '../vm/vm-runtime.mjs'
import { createCodexLoginBatchManager } from './codex-login-batch.mjs'
import { createCodexLoginGuard, probeCodexCredential } from './codex-login-guard.mjs'
import { createCodexLoginProfiles, normalizeLoginEmail, publicProfile } from './codex-login-profiles.mjs'
import { createCodexLoginQueue } from './codex-login-queue.mjs'
import {
  WORKSPACE_POLICIES,
  checkServiceHealth,
  codexAccountFromLogin,
  isServiceConfigured,
  loginWithService,
  normalizeGuardRules,
  normalizeV2MfaSecret,
  readServiceConfig,
} from './codex-login-service.mjs'
import { createCodexReloginService } from './codex-relogin.mjs'

const SLOT_LOGIN_TTL_MS = 5 * 60_000
const MAX_PASSWORD_LEN = 4096
const WORKSPACE_POLICY_SET = new Set(WORKSPACE_POLICIES)

/**
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {() => object} opts.proxyPool current ProxyPool
 * @param {() => object} opts.getRouting current routing config
 * @param {() => Array<{id: string}>} [opts.historicIds] ids that usage rows still hold (never reused)
 */
export function createCodexLoginRuntime({
  projectRoot,
  proxyPool,
  getRouting = () => ({}),
  historicIds = () => [],
  settings = () => new SettingsRepo(),
  log = (event) => console.log(JSON.stringify(event)),
  loginImpl = loginWithService,
} = {}) {
  let panel = null
  const pool = () => proxyPool()
  const vmFile = (id) => path.join(projectRoot, 'vms', `${id}.json`)
  const dataDir = () => String(process.env.KIN_DATA_DIR || '').trim() || path.join(projectRoot, 'data')
  const readConfig = () => readServiceConfig(settings())
  const profiles = createCodexLoginProfiles({ settings })
  const lookupVm = (id) => getVm(projectRoot, id)

  const loginQueue = createCodexLoginQueue({
    getMaxConcurrency: () => readConfig().max_concurrency,
    log,
  })

  /**
   * Resolve the slot's live proxy URL through the same resolver that OAuth exchange uses,
   * guaranteeing identical exit URLs and enforcing pool enabled/health/IPv6 checks.
   */
  function slotExit(vm) {
    if (!vm) return { ok: false, error: 'vm_not_found' }
    const resolved = resolveImportProxy({ vm, proxyPool: pool() })
    if (!resolved.ok) {
      return { ok: false, error: resolved.reason || 'proxy_unavailable' }
    }
    const proxyUrl = String(resolved.proxyUrl || '')
      .trim()
      .replace(/^socks5:\/\//i, 'socks5h://')
    if (!proxyUrl) {
      return { ok: false, error: 'proxy_required' }
    }
    const liveProxy = vm.id && typeof pool()?.getProxyForVm === 'function' ? pool().getProxyForVm(vm.id) : null
    return {
      ok: true,
      proxy_id: liveProxy?.id || vm.proxy?.id || null,
      proxy_url: proxyUrl,
      login_ip_differs: false,
    }
  }

  /** Re-resolve the slot's live exit right before Callback v2 token exchange to catch mid-login drift. */
  function resolveCurrentExitFor(vmId) {
    if (!vmId) return null
    return () => {
      const vm = lookupVm(vmId)
      if (!vm) {
        const err = new Error('vm_not_found')
        err.code = 'vm_not_found'
        throw err
      }
      return resolveSlotOAuthProxy(vm, pool())
    }
  }

  function login({
    vmId = null,
    email,
    password,
    mfaSecret = null,
    proxyUrl,
    expectedAccountId = null,
    workspacePolicy = null,
    signal = null,
    onProgress = null,
  }) {
    const vm = vmId ? lookupVm(vmId) : null
    const installationId = vm?.device_id || vm?.codex?.installation_id || null
    return loginImpl({
      config: readConfig(),
      vmId,
      installationId,
      email,
      password,
      mfaSecret,
      proxyUrl,
      expectedAccountId,
      workspacePolicy,
      resolveCurrentExit: resolveCurrentExitFor(vmId),
      signal,
      onProgress,
    })
  }

  function egressSummary() {
    const p = pool()
    if (p && typeof p.codexEgressSummary === 'function') {
      return p.codexEgressSummary()
    }
    return { pool_usable_proxies: 0, pool_free_slots: 0, bind_limit: 5 }
  }

  function findExisting({ email, chatgptAccountId = null, excludeVmId = null }) {
    const want = String(email || '').toLowerCase()
    for (const vm of listVms(projectRoot)) {
      if (!isCodexVm(vm) || vm.id === excludeVmId) continue
      const codex = vm.codex || {}
      if (want && String(codex.email || '').toLowerCase() === want) return { vm_id: vm.id }
      if (chatgptAccountId && codex.chatgpt_account_id === chatgptAccountId) return { vm_id: vm.id }
    }
    const profile = want ? profiles.findByEmail(want) : null
    if (profile && profile.vm_id !== excludeVmId && lookupVm(profile.vm_id)) return { vm_id: profile.vm_id }
    return null
  }

  /** Delete a slot this feature created, only while it still holds no credential. */
  async function discard(vmId) {
    const vm = lookupVm(vmId)
    if (!vm || !isCodexVm(vm)) return
    if (readCodexAccounts(projectRoot, vmId).some((row) => row.access_token || row.refresh_token)) return
    try {
      await destroySlot(vm)
    } catch {}
    try {
      pool()?.unbindVm?.(vmId)
    } catch {}
    try {
      fs.rmSync(path.join(projectRoot, 'vms', vmId), { recursive: true, force: true })
    } catch {}
    try {
      fs.unlinkSync(vmFile(vmId))
    } catch {}
    invalidateVmSlotReadCache(projectRoot, vmId)
    try {
      removeVmFromDb(vmId)
    } catch {}
    profiles.remove(vmId)
  }

  /** Batch slot provisioning: proxy pool only (never `px-local`), skipping bad proxies and preferring idle ones. */
  async function provision({ email, namePrefix, excludeProxyIds = null, busyProxyIds = null }) {
    const historic = historicIds() || []
    const id = `vm-${padVm(nextNumericIndex([...listVms(projectRoot), ...historic]))}`
    const name = (namePrefix ? `${namePrefix} ${email}` : email).slice(0, 80)
    const parsed = parseVmPackage({
      type: VM_PACKAGE_TYPE,
      version: VM_PACKAGE_VERSION,
      vm: { id, platform: 'openai', family: 'codex', name },
      proxy: null,
    })
    if (!parsed.ok) return { ok: false, error: 'slot_create_failed' }
    let created
    try {
      created = await commitVmPackage({
        projectRoot,
        parsed,
        mode: 'create',
        owner: { role: 'admin', userId: null },
        proxyPool: pool(),
        occupied: historic,
      })
    } catch {
      return { ok: false, error: 'slot_create_failed' }
    }
    if (!created?.ok) return { ok: false, error: 'slot_create_failed' }
    const vmId = created.vm.id
    const allocated = pool()?.allocateForVm?.(vmId, {
      excludeLocal: true,
      excludeProxyIds,
      busyProxyIds,
    })
    if (!allocated) {
      await discard(vmId)
      return { ok: false, error: 'no_free_proxy' }
    }
    const bound = pool()?.getProxyForVm?.(vmId)
    if (!bound) {
      await discard(vmId)
      return { ok: false, error: 'exit_unavailable' }
    }
    bindVmProxy(projectRoot, vmId, bound)
    try {
      if (egressEnabled()) await ensureProxyEgress(projectRoot, bound)
    } catch {}
    try {
      await syncVmTimezoneFromProxy(projectRoot, pool(), vmId, { proxyId: allocated.id || null })
    } catch {}
    const exit = slotExit(lookupVm(vmId))
    if (!exit.ok) {
      await discard(vmId)
      return { ok: false, error: exit.error || 'exit_unavailable' }
    }
    return {
      ok: true,
      vm_id: vmId,
      proxy_id: bound.id || exit.proxy_id || null,
      proxy_url: exit.proxy_url,
      login_ip_differs: false,
    }
  }

  async function commit({ vmId, account }) {
    if (!panel?.commitCodex) return { ok: false, error: 'panel_not_ready' }
    const file = vmFile(vmId)
    return withVmLock(file, async () => {
      if (!fs.existsSync(file)) return { ok: false, error: 'vm_not_found' }
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'))
      existing.id = existing.id || vmId
      if (!isCodexVm(existing)) return { ok: false, error: 'vm_not_codex' }
      try {
        const result = await panel.commitCodex({ vmPath: file, existing, account })
        return { ok: true, result: result || null }
      } catch (err) {
        log({ event: 'codex_login_commit_failed', vm_id: vmId, error: String(err?.code || err?.name || 'commit') })
        return { ok: false, error: 'import_failed' }
      }
    })
  }

  /** First import: commit, then start the slot and probe it like a package import. */
  async function commitNew(args) {
    const done = await commit(args)
    if (!done.ok) return done
    try {
      const brought = await panel?.bringUpImportedVm?.(args.vmId)
      if (brought?.start_error) return { ok: true, warning: 'start_failed' }
    } catch {
      return { ok: true, warning: 'start_failed' }
    }
    return { ok: true }
  }

  function enroll({ vmId, email, password, mfaSecret, loginIpDiffers = false }) {
    const saved = profiles.save(vmId, {
      email,
      password,
      totp_secret: mfaSecret || '',
      auto_relogin: true,
      login_ip_differs: loginIpDiffers,
    })
    if (!saved.ok) return saved
    const rules = normalizeGuardRules(readConfig().guard)
    profiles.patchState(vmId, { next_probe_at: Date.now() + rules.probe_interval_min * 60_000 })
    return { ok: true }
  }

  async function restartKernel(vmId) {
    stopCodexKernel(vmId)
    const vm = lookupVm(vmId)
    if (vm && isCodexVm(vm)) await ensureCodexKernel(slotExec(projectRoot, vm), { timeoutMs: 8000 })
  }

  // Single-slot password login tasks (shared by Onboard Step 3, Slot Import Card, and Reauth Dialog).
  const slotLoginTasks = new Map()
  let slotLoginStopped = false

  function publicSlotTask(task) {
    if (!task) return { state: 'idle' }
    return {
      id: task.id,
      vm_id: task.vmId,
      state: task.state,
      stage: task.stage,
      email: task.email,
      workspace: task.workspace,
      error: task.error,
      detail: task.detail,
      warning: task.warning,
      started_at: task.started_at,
      finished_at: task.finished_at,
      commit_result: task.commit_result,
    }
  }

  function isSlotLoginBusy(vmId) {
    const task = slotLoginTasks.get(vmId)
    return !!task && (task.state === 'queued' || task.state === 'running')
  }

  function getSlotLoginStatus(vmId) {
    const task = slotLoginTasks.get(vmId)
    if (!task) return { state: 'idle' }
    if (task.expiresAt && Date.now() >= task.expiresAt) {
      clearTimeout(task.expiryTimer)
      slotLoginTasks.delete(vmId)
      return { state: 'idle' }
    }
    return publicSlotTask(task)
  }

  function scheduleSlotTaskExpiry(task) {
    task.expiresAt = Date.now() + SLOT_LOGIN_TTL_MS
    clearTimeout(task.expiryTimer)
    task.expiryTimer = setTimeout(() => {
      if (slotLoginTasks.get(task.vmId) === task) slotLoginTasks.delete(task.vmId)
    }, SLOT_LOGIN_TTL_MS)
    task.expiryTimer.unref?.()
  }

  const probe = (vm) =>
    probeCodexCredential({
      vm,
      readAccounts: (id) => readCodexAccounts(projectRoot, id),
      proxyUrlFor: (target) => hostProxyUrlForVm(target),
      isLocalExit: (target) => isLocalEgressProxy(target?.proxy),
      fetchCatalog: ({ accessToken, accountId, proxyUrl, direct }) =>
        fetchChatgptModelCatalog({
          accessToken,
          accountId,
          proxyUrl,
          direct,
          configuredCatalogVersion: getRouting()?.codex?.catalog_client_version || 'auto',
          catalogVersionCachePath: path.join(dataDir(), 'codex-catalog-client.json'),
        }),
      refresh: ({ refreshToken, proxyUrl }) => refreshCodexAccessToken({ refreshToken, proxyUrl }),
      persist: (id, patch) => upsertCodexAccount(projectRoot, id, patch),
    })

  const relogin = createCodexReloginService({
    profiles,
    readConfig,
    login,
    getVm: lookupVm,
    isCodexVm,
    slotExit,
    commit,
    restartKernel,
    findExisting,
    queue: loginQueue,
    isSlotBusy: isSlotLoginBusy,
    log,
  })

  const slotLogin = {
    start(vmId, body = {}) {
      if (slotLoginStopped) return { ok: false, status: 503, error: 'shutting_down' }
      const vm = lookupVm(vmId)
      if (!vm || !isCodexVm(vm)) return { ok: false, status: 404, error: 'vm_not_codex' }
      if (isSlotLoginBusy(vmId) || relogin.status(vmId).state !== 'idle') {
        return { ok: false, status: 409, error: 'slot_login_running' }
      }
      const cfg = readConfig()
      if (!isServiceConfigured(cfg)) return { ok: false, status: 409, error: 'login_service_unconfigured' }

      const email = normalizeLoginEmail(body.email)
      if (!email) return { ok: false, status: 400, error: 'invalid_email' }
      const password = body.password == null ? '' : String(body.password)
      if (!password) return { ok: false, status: 400, error: 'password_required' }
      if (password.length > MAX_PASSWORD_LEN) return { ok: false, status: 400, error: 'invalid_password' }
      const mfaChecked = normalizeV2MfaSecret(body.totp_secret ?? body.mfa_secret ?? null)
      if (!mfaChecked.ok) return { ok: false, status: 400, error: mfaChecked.error }

      let workspacePolicy = cfg.workspace_policy || 'auto'
      if (body.workspace_policy != null && String(body.workspace_policy).trim() !== '') {
        const reqPolicy = String(body.workspace_policy).trim()
        if (!WORKSPACE_POLICY_SET.has(reqPolicy)) return { ok: false, status: 400, error: 'invalid_workspace_policy' }
        workspacePolicy = reqPolicy
      }

      const saveLogin = body.save_login === true
      if (saveLogin && !encryptionEnabled()) return { ok: false, status: 409, error: 'encryption_required' }

      const exit = slotExit(vm)
      if (!exit.ok) return { ok: false, status: 409, error: exit.error || 'proxy_required' }

      const prev = slotLoginTasks.get(vmId)
      if (prev) clearTimeout(prev.expiryTimer)

      const allowWorkspaceReselect = body.allow_workspace_reselect === true
      const existingEmail = String(vm.codex?.email || '')
        .trim()
        .toLowerCase()
      const existingAccountId = String(vm.codex?.chatgpt_account_id || '').trim()
      const expectedAccountId =
        !allowWorkspaceReselect && existingAccountId && existingEmail === email ? existingAccountId : null
      const wasRunning = vm.status === 'running'

      const task = {
        id: crypto.randomUUID(),
        vmId,
        email,
        state: 'queued',
        stage: null,
        workspace: null,
        error: null,
        detail: null,
        warning: null,
        started_at: null,
        finished_at: null,
        commit_result: null,
        abort: new AbortController(),
        expiryTimer: null,
        expiresAt: 0,
        done: null,
      }
      slotLoginTasks.set(vmId, task)

      // Secrets live only in this local closure and are cleared in `finally`.
      let secretPassword = password
      let secretMfa = mfaChecked.value

      const finishTask = (state, patch = {}) => {
        task.state = state
        task.stage = null
        task.finished_at = new Date().toISOString()
        Object.assign(task, patch)
        scheduleSlotTaskExpiry(task)
      }

      task.done = (async () => {
        try {
          const resourceKey = exit.proxy_id ? `proxy:${exit.proxy_id}` : null
          const result = await loginQueue.runWithBackoff(
            { priority: 'slot_login', resourceKey, signal: task.abort.signal },
            async () => {
              if (slotLoginStopped || task.abort.signal.aborted) return { ok: false, error: 'canceled' }
              const freshVm = lookupVm(vmId)
              if (!freshVm || !isCodexVm(freshVm)) return { ok: false, error: 'vm_not_found' }
              const freshExit = slotExit(freshVm)
              if (!freshExit.ok) return { ok: false, error: freshExit.error }
              task.state = 'running'
              task.stage = null
              task.started_at = new Date().toISOString()
              return login({
                vmId,
                email,
                password: secretPassword,
                mfaSecret: secretMfa,
                proxyUrl: freshExit.proxy_url,
                expectedAccountId,
                workspacePolicy,
                signal: task.abort.signal,
                onProgress: (stage) => {
                  task.stage = stage
                },
              })
            },
          )

          if (!result?.ok) {
            const errCode = result?.error || 'login_failed'
            const detail = result?.detail || (result?.status ? `http_${result.status}` : null)
            finishTask(errCode === 'canceled' ? 'canceled' : 'failed', { error: errCode, detail })
            return
          }

          const made = codexAccountFromLogin(result.credential, { workspace: result.workspace || null })
          if (!made.ok || made.email !== email) {
            finishTask('failed', { error: made.ok ? 'identity_mismatch' : made.error })
            return
          }
          const dup = findExisting({ email, chatgptAccountId: made.chatgpt_account_id, excludeVmId: vmId })
          if (dup) {
            finishTask('failed', { error: 'account_exists', detail: dup.vm_id })
            return
          }

          const committed = await commit({ vmId, account: made.account })
          if (!committed?.ok) {
            finishTask('failed', { error: committed?.error || 'import_failed' })
            return
          }

          let warning = made.workspace?.selection_missing ? 'workspace_metadata_missing' : null
          if (saveLogin) {
            const enrolled = enroll({
              vmId,
              email,
              password: secretPassword,
              mfaSecret: secretMfa,
              loginIpDiffers: false,
            })
            if (!enrolled?.ok && !warning) warning = enrolled?.error || 'enroll_failed'
          }

          if (wasRunning) {
            try {
              await restartKernel(vmId)
            } catch (err) {
              log({
                event: 'codex_slot_login_kernel_restart_failed',
                vm_id: vmId,
                error: String(err?.code || 'restart_failed'),
              })
            }
          }

          finishTask('ok', {
            workspace: made.workspace || result.workspace || null,
            warning,
            commit_result: committed.result || null,
          })
        } catch (err) {
          log({
            event: 'codex_slot_login_failed',
            vm_id: vmId,
            error: String(err?.code || err?.name || 'internal_error'),
          })
          finishTask('failed', { error: 'internal_error' })
        } finally {
          secretPassword = ''
          secretMfa = null
        }
      })()

      return { ok: true, status: 202, task: publicSlotTask(task) }
    },
    status: getSlotLoginStatus,
    cancel(vmId) {
      const task = slotLoginTasks.get(vmId)
      if (!task || (task.state !== 'queued' && task.state !== 'running')) {
        return { ok: true, status: 200, task: getSlotLoginStatus(vmId) }
      }
      task.abort.abort()
      return { ok: true, status: 200, task: publicSlotTask(task) }
    },
    isBusy: isSlotLoginBusy,
    settled: (vmId) => slotLoginTasks.get(vmId)?.done || Promise.resolve(),
    stop() {
      slotLoginStopped = true
      for (const task of slotLoginTasks.values()) {
        clearTimeout(task.expiryTimer)
        task.abort?.abort()
      }
    },
  }

  const guard = createCodexLoginGuard({
    profiles,
    relogin,
    readConfig,
    getVm: lookupVm,
    isCodexVm,
    probe,
    markDead: (vmId) => markUnschedulable(projectRoot, vmId, 'oauth_invalid_grant', { source: 'codex_login_guard' }),
    isSlotBusy: isSlotLoginBusy,
    log,
  })
  const batch = createCodexLoginBatchManager({
    readConfig,
    login,
    findExisting,
    provision,
    discard,
    commit: commitNew,
    enroll,
    egressSummary,
    queue: loginQueue,
    encryptionEnabled,
    log,
  })

  function profileView(vmId) {
    const record = profiles.get(vmId)
    if (!record) return null
    const vm = lookupVm(vmId)
    return {
      ...publicProfile(record),
      vm_name: vm?.name || null,
      vm_exists: !!vm,
      relogin: relogin.status(vmId),
    }
  }

  return {
    settings,
    readConfig,
    profiles,
    batch,
    relogin,
    slotLogin,
    guard,
    queueSnapshot: () => loginQueue.snapshot(),
    egressSummary,
    checkServiceHealth: (opts) => checkServiceHealth(readConfig(), opts),
    profileView,
    listProfiles: () =>
      profiles
        .list()
        .map((record) => profileView(record.vm_id))
        .filter(Boolean),
    isCodexSlot: (vmId) => {
      const vm = lookupVm(vmId)
      return !!vm && isCodexVm(vm)
    },
    attachPanel(hooks) {
      panel = hooks || null
    },
    start() {
      guard.start()
    },
    stop() {
      guard.stop()
      batch.stop()
      relogin.stop()
      slotLogin.stop()
      loginQueue.stop()
    },
    onVmDeleted(vmId) {
      slotLogin.cancel(vmId)
      profiles.remove(vmId)
    },
  }
}
