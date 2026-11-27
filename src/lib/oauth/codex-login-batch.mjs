/**
 * Batch first import: one new GPT slot per `email----password----totp` (or `email----password`) line.
 *
 * Proxy pool only (no local exit):
 *   - Pre-checks proxy pool free capacity before starting a batch
 *   - Rows wait in the shared global login queue BEFORE provisioning a slot or creating an OAuth session
 *   - Pool allocation excludes `px-local`, avoids proxies that returned `proxy_unreachable` earlier in
 *     the same pass, and coordinates per-proxy anti-collision via the global queue
 *   - Failed, skipped, or canceled rows immediately discard their empty slot and unbind the proxy
 */
import crypto from 'node:crypto'
import { createCodexLoginQueue } from './codex-login-queue.mjs'
import {
  WORKSPACE_POLICIES,
  codexAccountFromLogin,
  isServiceConfigured,
  normalizeV2MfaSecret,
} from './codex-login-service.mjs'
import { normalizeLoginEmail } from './codex-login-profiles.mjs'

export const MAX_BATCH_ROWS = 100
const MAX_SECRET = 4096
const RETRYABLE = new Set(['failed', 'import_failed', 'pending'])
const WORKSPACE_POLICY_SET = new Set(WORKSPACE_POLICIES)

/**
 * `email----password----totp`, `email----password`, or comma-separated (optional 3rd column for
 * accounts without MFA). Blank lines and `#` comments are skipped. Any bad line rejects the whole
 * batch; errors name only the line number, never its text.
 */
export function parseBatchText(text) {
  if (typeof text !== 'string') return { ok: false, error: 'invalid_batch', line: 0 }
  const entries = []
  const seen = new Set()
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const parts = (line.includes('----') ? line.split('----') : line.split(',')).map((part) => part.trim())
    const bad = { ok: false, error: 'invalid_batch', line: i + 1 }
    if (parts.length !== 2 && parts.length !== 3) return bad
    const email = normalizeLoginEmail(parts[0])
    const password = parts[1]
    if (!email || !password || password.length > MAX_SECRET) return bad
    const rawMfa = parts.length === 3 ? parts[2] : ''
    let mfaSecret = null
    if (rawMfa) {
      if (rawMfa.length > MAX_SECRET) return { ok: false, error: 'invalid_totp', line: i + 1 }
      const checkedMfa = normalizeV2MfaSecret(rawMfa)
      if (!checkedMfa.ok) return { ok: false, error: 'invalid_totp', line: i + 1 }
      mfaSecret = checkedMfa.value
    }
    if (seen.has(email)) return { ok: false, error: 'duplicate_email', line: i + 1 }
    seen.add(email)
    entries.push({ line: i + 1, email, password, mfa_secret: mfaSecret })
  }
  if (!entries.length) return { ok: false, error: 'empty_batch', line: 0 }
  if (entries.length > MAX_BATCH_ROWS) return { ok: false, error: 'too_many_rows', line: 0 }
  return { ok: true, entries }
}

function cleanPrefix(raw) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 32)
}

function busyProxyIdsFrom(queue) {
  const out = new Set()
  for (const key of queue.busyResources()) {
    if (key.startsWith('proxy:')) out.add(key.slice('proxy:'.length))
  }
  return out
}

function publicWorkspace(ws) {
  if (!ws || typeof ws !== 'object') return null
  return {
    id: ws.id || null,
    kind: ws.kind || null,
    name: ws.name || null,
    selection_reason: ws.selection_reason || null,
    candidate_count: Number.isInteger(ws.candidate_count) ? ws.candidate_count : null,
    selection_missing: ws.selection_missing === true,
  }
}

/**
 * @param {object} deps
 * @param {() => object} deps.readConfig
 * @param {(o: object) => Promise<object>} deps.login
 * @param {(o: {email, chatgptAccountId?, excludeVmId?}) => ({vm_id: string}|null)} deps.findExisting
 * @param {(o: {email, namePrefix, excludeProxyIds?, busyProxyIds?}) => Promise<object>} deps.provision
 * @param {(vmId: string) => Promise<void>|void} deps.discard
 * @param {(o: {vmId, account}) => Promise<{ok, error?, warning?}>} deps.commit
 * @param {(o: {vmId, email, password, mfaSecret, loginIpDiffers?}) => Promise<{ok, error?}>|{ok, error?}} deps.enroll
 * @param {() => {pool_free_slots: number, pool_usable_proxies?: number}} [deps.egressSummary]
 * @param {ReturnType<import('./codex-login-queue.mjs').createCodexLoginQueue>} [deps.queue]
 */
export function createCodexLoginBatchManager({
  readConfig,
  login,
  findExisting,
  provision,
  discard,
  commit,
  enroll,
  egressSummary = () => ({ pool_usable_proxies: 1, pool_free_slots: MAX_BATCH_ROWS }),
  queue = null,
  encryptionEnabled = () => false,
  ttlMs = 30 * 60_000,
  now = () => Date.now(),
  randomId = () => crypto.randomUUID(),
  log = () => {},
} = {}) {
  const loginQueue =
    queue ||
    createCodexLoginQueue({
      getMaxConcurrency: () => readConfig()?.max_concurrency || 4,
      now,
      log,
    })

  let batch = null
  // Slot creation picks ids and proxies from shared state: one at a time.
  let provisionChain = Promise.resolve()

  const iso = () => new Date(now()).toISOString()

  function wipe(b) {
    if (!b) return
    clearTimeout(b.expiry)
    for (const row of b.rows) {
      row.abort?.abort()
      row.secret = null
      row.account = null
    }
  }

  function live() {
    if (batch && batch.status !== 'running' && batch.expires_at && now() >= batch.expires_at) {
      wipe(batch)
      batch = null
    }
    return batch
  }

  function view(b) {
    if (!b) return null
    const counts = { total: b.rows.length }
    for (const row of b.rows) counts[row.status] = (counts[row.status] || 0) + 1
    return {
      id: b.id,
      status: b.status,
      created_at: b.created_at,
      finished_at: b.finished_at,
      expires_at: b.expires_at ? new Date(b.expires_at).toISOString() : null,
      options: { ...b.options },
      counts,
      rows: b.rows.map((row) => ({
        id: row.id,
        line: row.line,
        email: row.email,
        status: row.status,
        stage: row.stage,
        vm_id: row.vm_id,
        proxy_id: row.proxy_id,
        workspace: publicWorkspace(row.workspace),
        error: row.error,
        detail: row.detail,
        warning: row.warning,
        retryable: !!row.secret && RETRYABLE.has(row.status),
      })),
    }
  }

  function settle(row, status, { error = null, detail = null, vmId = row.vm_id, keepSecret = false } = {}) {
    row.status = status
    row.stage = null
    row.error = error
    row.detail = detail
    row.vm_id = vmId
    if (!keepSecret) {
      row.secret = null
      row.account = null
    }
  }

  async function dropSlot(row) {
    const vmId = row.vm_id
    row.vm_id = null
    row.proxy_id = null
    if (!vmId) return
    try {
      await discard(vmId)
    } catch (err) {
      log({ event: 'codex_login_discard_failed', vm_id: vmId, error: String(err?.code || 'discard_failed') })
    }
  }

  function provisionOnce(args) {
    const run = provisionChain.then(() => provision(args))
    provisionChain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  async function processRow(b, row) {
    const opts = b.options
    const ac = new AbortController()
    row.abort = ac

    try {
      if (!row.account && !row.committed) {
        if (b.canceled || ac.signal.aborted) return settle(row, 'pending', { keepSecret: true })

        // Wait for a global queue permit BEFORE provisioning a slot or creating an OAuth session.
        let permit = await loginQueue.acquire({ priority: 'batch', signal: ac.signal })
        if (!permit) return settle(row, 'pending', { keepSecret: true })

        let result = null
        try {
          row.status = 'checking'
          row.stage = null
          row.error = null
          row.detail = null
          const known = findExisting({ email: row.email })
          if (known) return settle(row, 'skipped', { detail: 'email_exists', vmId: known.vm_id })
          if (b.canceled || ac.signal.aborted) return settle(row, 'pending', { keepSecret: true })

          row.status = 'provisioning'
          const slot = await provisionOnce({
            email: row.email,
            namePrefix: opts.name_prefix,
            excludeProxyIds: b.badProxyIds,
            busyProxyIds: busyProxyIdsFrom(loginQueue),
          })
          if (!slot?.ok) {
            return settle(row, 'failed', { error: slot?.error || 'slot_create_failed', keepSecret: true })
          }
          row.vm_id = slot.vm_id
          row.proxy_id = slot.proxy_id || null
          if (b.canceled || ac.signal.aborted) {
            await dropSlot(row)
            return settle(row, 'pending', { keepSecret: true, vmId: null })
          }

          // Enforce per-proxy anti-collision without holding a global permit idle while waiting.
          const resourceKey = row.proxy_id ? `proxy:${row.proxy_id}` : null
          if (resourceKey && !permit.claimResource(resourceKey)) {
            permit.release()
            permit = null
            row.status = 'pending'
            permit = await loginQueue.acquire({ priority: 'batch', resourceKey, signal: ac.signal })
            if (!permit) {
              await dropSlot(row)
              return settle(row, 'pending', { keepSecret: true, vmId: null })
            }
          }

          // Execute Callback v2 login with bounded retries on 429 capacity_exceeded (new OAuth session per retry).
          const maxCapacityRetries = 2
          for (let attempt = 0; attempt <= maxCapacityRetries; attempt++) {
            if (b.canceled || ac.signal.aborted) {
              result = { ok: false, error: 'canceled' }
              break
            }
            row.status = 'logging_in'
            row.stage = null
            result = await login({
              vmId: row.vm_id,
              email: row.email,
              password: row.secret.password,
              mfaSecret: row.secret.mfa_secret,
              proxyUrl: slot.proxy_url || '',
              workspacePolicy: opts.workspace_policy,
              expectedAccountId: null,
              signal: ac.signal,
              onProgress: (stage) => {
                row.stage = stage
              },
            })
            if (result?.ok) break
            if (b.canceled || ac.signal.aborted) break
            if (result?.error === 'capacity_exceeded') {
              loginQueue.noteBackoff(result.retryAfterMs || 15_000)
              if (attempt < maxCapacityRetries) {
                permit.release()
                permit = null
                row.status = 'pending'
                row.stage = null
                permit = await loginQueue.acquire({ priority: 'batch', resourceKey, signal: ac.signal })
                if (!permit) {
                  result = { ok: false, error: 'canceled' }
                  break
                }
                continue
              }
            } else if (result?.error === 'engine_not_ready' || result?.error === 'service_stopping') {
              loginQueue.noteBackoff(result.retryAfterMs || 10_000)
            }
            break
          }
        } finally {
          permit?.release()
        }

        if (!result?.ok) {
          const failedProxyId = row.proxy_id
          if (result?.error === 'proxy_unreachable' && failedProxyId) {
            b.badProxyIds.add(failedProxyId)
          }
          await dropSlot(row)
          if (b.canceled && result?.error === 'canceled') {
            return settle(row, 'pending', { keepSecret: true, vmId: null })
          }
          const detail = result?.detail || (result?.status ? `http_${result.status}` : null)
          return settle(row, 'failed', {
            error: result?.error || 'login_failed',
            detail,
            keepSecret: true,
            vmId: null,
          })
        }

        const made = codexAccountFromLogin(result.credential, { workspace: result.workspace || null })
        if (!made.ok || made.email !== row.email) {
          await dropSlot(row)
          const error = made.ok ? 'identity_mismatch' : made.error
          return settle(row, 'failed', { error, keepSecret: true, vmId: null })
        }
        const dup = findExisting({
          email: row.email,
          chatgptAccountId: made.chatgpt_account_id,
          excludeVmId: row.vm_id,
        })
        if (dup) {
          await dropSlot(row)
          return settle(row, 'skipped', { detail: 'account_exists', vmId: dup.vm_id })
        }
        row.account = made.account
        row.workspace = made.workspace || result.workspace || null
        row.warning = row.workspace?.selection_missing ? 'workspace_metadata_missing' : null
      }

      row.status = 'importing'
      row.stage = null
      if (!row.committed) {
        const done = await commit({ vmId: row.vm_id, account: row.account })
        if (!done?.ok) return settle(row, 'import_failed', { error: done?.error || 'import_failed', keepSecret: true })
        row.committed = true
        if (done.warning && !row.warning) row.warning = done.warning
      }
      if (opts.save_login && !row.enrolled) {
        const saved = await enroll({
          vmId: row.vm_id,
          email: row.email,
          password: row.secret.password,
          mfaSecret: row.secret.mfa_secret,
          loginIpDiffers: false,
        })
        if (!saved?.ok) {
          return settle(row, 'import_failed', { error: saved?.error || 'enroll_failed', keepSecret: true })
        }
        row.enrolled = true
      }
      settle(row, 'created')
    } finally {
      row.abort = null
    }
  }

  function finish(b) {
    b.status = b.canceled ? 'canceled' : 'done'
    b.finished_at = iso()
    b.expires_at = now() + ttlMs
    clearTimeout(b.expiry)
    b.expiry = setTimeout(() => {
      if (batch === b) {
        wipe(b)
        batch = null
      }
    }, ttlMs)
    b.expiry.unref?.()
  }

  function run(b) {
    clearTimeout(b.expiry)
    b.status = 'running'
    b.canceled = false
    b.finished_at = null
    b.expires_at = null
    b.badProxyIds = new Set()
    const pendingRows = b.rows.filter((row) => row.status === 'pending')
    const jobs = pendingRows.map(async (row) => {
      try {
        await processRow(b, row)
      } catch (err) {
        log({ event: 'codex_login_row_failed', error: String(err?.code || err?.name || 'internal_error') })
        if (!row.committed) await dropSlot(row)
        settle(row, row.committed ? 'import_failed' : 'failed', {
          error: 'internal_error',
          keepSecret: true,
          vmId: row.committed ? row.vm_id : null,
        })
      }
    })
    b.done = Promise.all(jobs).then(() => finish(b))
  }

  function start(body = {}) {
    if (live()?.status === 'running') return { ok: false, status: 409, error: 'batch_running' }
    if (body.exit_mode === 'local') return { ok: false, status: 400, error: 'local_exit_unsupported' }
    const cfg = readConfig() || {}
    let workspacePolicy = cfg.workspace_policy || 'auto'
    if (body.workspace_policy != null && String(body.workspace_policy).trim() !== '') {
      const requestedPolicy = String(body.workspace_policy).trim()
      if (!WORKSPACE_POLICY_SET.has(requestedPolicy)) {
        return { ok: false, status: 400, error: 'invalid_workspace_policy' }
      }
      workspacePolicy = requestedPolicy
    }
    const parsed = parseBatchText(body.text)
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error, line: parsed.line }
    const options = {
      save_login: body.save_login !== false,
      name_prefix: cleanPrefix(body.name_prefix),
      workspace_policy: workspacePolicy,
    }
    if (!isServiceConfigured(cfg)) return { ok: false, status: 409, error: 'login_service_unconfigured' }
    if (options.save_login && !encryptionEnabled()) return { ok: false, status: 409, error: 'encryption_required' }
    const summary = egressSummary() || {}
    if (Number(summary.pool_free_slots ?? 0) <= 0) {
      return { ok: false, status: 409, error: 'no_free_proxy' }
    }
    wipe(batch)
    batch = {
      id: randomId(),
      status: 'running',
      created_at: iso(),
      finished_at: null,
      expires_at: null,
      options,
      canceled: false,
      badProxyIds: new Set(),
      expiry: null,
      done: null,
      rows: parsed.entries.map((entry) => ({
        id: randomId(),
        line: entry.line,
        email: entry.email,
        status: 'pending',
        stage: null,
        vm_id: null,
        proxy_id: null,
        workspace: null,
        error: null,
        detail: null,
        warning: null,
        secret: { password: entry.password, mfa_secret: entry.mfa_secret },
        account: null,
        committed: false,
        enrolled: false,
        abort: null,
      })),
    }
    run(batch)
    return { ok: true, status: 202, batch: view(batch) }
  }

  function byId(id) {
    const b = live()
    return b && b.id === id ? b : null
  }

  function cancel(id) {
    const b = byId(id)
    if (!b) return { ok: false, status: 404, error: 'batch_not_found' }
    if (b.status === 'running') {
      b.canceled = true
      for (const row of b.rows) row.abort?.abort()
    }
    return { ok: true, status: 200, batch: view(b) }
  }

  function retry(id) {
    const b = byId(id)
    if (!b) return { ok: false, status: 404, error: 'batch_not_found' }
    if (b.status === 'running') return { ok: false, status: 409, error: 'batch_running' }
    const cfg = readConfig() || {}
    if (!isServiceConfigured(cfg)) return { ok: false, status: 409, error: 'login_service_unconfigured' }
    let count = 0
    let needsProxy = false
    for (const row of b.rows) {
      if (!row.secret || !RETRYABLE.has(row.status)) continue
      if (!row.account && !row.committed) needsProxy = true
      count++
    }
    if (!count) return { ok: false, status: 409, error: 'nothing_to_retry' }
    if (needsProxy && Number(egressSummary()?.pool_free_slots ?? 0) <= 0) {
      return { ok: false, status: 409, error: 'no_free_proxy' }
    }
    for (const row of b.rows) {
      if (!row.secret || !RETRYABLE.has(row.status)) continue
      row.status = 'pending'
      row.stage = null
      row.error = null
      row.detail = null
    }
    run(b)
    return { ok: true, status: 202, batch: view(b) }
  }

  function remove(id) {
    const b = byId(id)
    if (!b) return { ok: false, status: 404, error: 'batch_not_found' }
    if (b.status === 'running') return { ok: false, status: 409, error: 'batch_running' }
    wipe(b)
    batch = null
    return { ok: true, status: 200 }
  }

  function stop() {
    if (!batch) return
    batch.canceled = true
    wipe(batch)
  }

  return {
    start,
    current: () => view(live()),
    cancel,
    retry,
    remove,
    stop,
    /** Resolves when the running pass ends (tests). */
    settled: () => batch?.done || Promise.resolve(),
  }
}
