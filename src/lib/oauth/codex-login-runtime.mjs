/**
 * Production wiring for GPT password login: login profiles, the batch first import, password
 * re-login and the credential guard, bound to the slot registry, proxy pool and Codex kernel.
 *
 * Server boot creates one runtime. The panel handler attaches its slot helpers (credential
 * commit, bring-up, timezone) because those live in panel-routes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { encryptionEnabled } from '../db/secure.mjs'
import { fetchChatgptModelCatalog, refreshCodexAccessToken } from '../protocol/codex-models.mjs'
import { ensureCodexKernel, stopCodexKernel } from '../transport/codex-kernel-supervisor.mjs'
import { readCodexAccounts, upsertCodexAccount } from '../vm/codex-slot.mjs'
import { egressEnabled, ensureProxyEgress, isLocalEgressProxy } from '../vm/egress.mjs'
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
import { createCodexLoginProfiles, publicProfile } from './codex-login-profiles.mjs'
import { loginWithService, normalizeGuardRules, readServiceConfig } from './codex-login-service.mjs'
import { createCodexReloginService } from './codex-relogin.mjs'

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
} = {}) {
  let panel = null
  const pool = () => proxyPool()
  const vmFile = (id) => path.join(projectRoot, 'vms', `${id}.json`)
  const dataDir = () => String(process.env.KIN_DATA_DIR || '').trim() || path.join(projectRoot, 'data')
  const readConfig = () => readServiceConfig(settings())
  const profiles = createCodexLoginProfiles({ settings })
  const login = ({ email, password, mfaSecret, proxyUrl, signal }) =>
    loginWithService({ config: readConfig(), email, password, mfaSecret, proxyUrl, signal })
  const lookupVm = (id) => getVm(projectRoot, id)

  /** The slot's own exit as a URL the login service can dial; empty means the host route. */
  function slotExit(vm) {
    const url = String(hostProxyUrlForVm(vm) || '')
      .trim()
      .replace(/^socks5:\/\//i, 'socks5h://')
    return { proxy_url: url, login_ip_differs: !url }
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
      pool().unbindVm(vmId)
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

  async function provision({ email, exitMode, namePrefix }) {
    const historic = historicIds() || []
    const id = `vm-${padVm(nextNumericIndex([...listVms(projectRoot), ...historic]))}`
    const name = (namePrefix ? `${namePrefix} ${email}` : email).slice(0, 80)
    const parsed = parseVmPackage({
      type: VM_PACKAGE_TYPE,
      version: VM_PACKAGE_VERSION,
      vm: { id, platform: 'openai', family: 'codex', name },
      proxy: exitMode === 'local' ? { kind: 'local' } : null,
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
    if (exitMode === 'local') {
      try {
        await panel?.fillTimezoneFromExit?.(vmId)
      } catch {}
    } else {
      const allocated = pool().allocateForVm(vmId)
      if (!allocated) {
        await discard(vmId)
        return { ok: false, error: 'no_free_proxy' }
      }
      const bound = pool().getProxyForVm(vmId)
      bindVmProxy(projectRoot, vmId, bound)
      try {
        if (egressEnabled()) await ensureProxyEgress(projectRoot, bound)
      } catch {}
      try {
        await syncVmTimezoneFromProxy(projectRoot, pool(), vmId, { proxyId: allocated.id || null })
      } catch {}
    }
    let exit
    try {
      exit = slotExit(lookupVm(vmId))
    } catch {
      await discard(vmId)
      return { ok: false, error: 'exit_unavailable' }
    }
    return { ok: true, vm_id: vmId, proxy_url: exit.proxy_url, login_ip_differs: exit.login_ip_differs }
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
        await panel.commitCodex({ vmPath: file, existing, account })
        return { ok: true }
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

  function enroll({ vmId, email, password, mfaSecret, loginIpDiffers }) {
    const saved = profiles.save(vmId, {
      email,
      password,
      totp_secret: mfaSecret,
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
    log,
  })
  const guard = createCodexLoginGuard({
    profiles,
    relogin,
    readConfig,
    getVm: lookupVm,
    isCodexVm,
    probe,
    markDead: (vmId) => markUnschedulable(projectRoot, vmId, 'oauth_invalid_grant', { source: 'codex_login_guard' }),
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
    guard,
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
    },
    onVmDeleted(vmId) {
      profiles.remove(vmId)
    },
  }
}
