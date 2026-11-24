/**
 * Batch first import: one new GPT slot per `email----password----totp` line.
 *
 * Per row: skip a known email → create an empty slot with its exit → log in through the login
 * service with that exit → check the JWT identity → skip a known account id → write the tokens
 * → save the login details. A failed login deletes the empty slot again.
 *
 * Everything here is in memory. A row that ends `created` / `skipped` drops its secrets at once;
 * failed rows keep them for "retry unfinished" until the batch expires (30 min after it ends).
 * A restart loses the batch; slots already created stay.
 */
import crypto from 'node:crypto'
import { codexAccountFromLogin } from './codex-login-service.mjs'
import { normalizeLoginEmail, normalizeTotpSecret } from './codex-login-profiles.mjs'

export const MAX_BATCH_ROWS = 100
const MAX_SECRET = 4096
const RETRYABLE = new Set(['failed', 'import_failed', 'pending'])

/**
 * `email----password----totp`, or comma separated, one account per line. Blank lines and `#`
 * comments are skipped. Any bad line rejects the whole batch; errors name the line, never its text.
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
    if (parts.length !== 3) return bad
    const email = normalizeLoginEmail(parts[0])
    const password = parts[1]
    const mfaSecret = normalizeTotpSecret(parts[2])
    if (!email || !password || !mfaSecret || password.length > MAX_SECRET || mfaSecret.length > MAX_SECRET) return bad
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

/**
 * @param {object} deps
 * @param {() => {endpoint: string, batch_concurrency: number}} deps.readConfig
 * @param {(o: {email, password, mfaSecret, proxyUrl, signal}) => Promise<object>} deps.login
 * @param {(o: {email, chatgptAccountId?, excludeVmId?}) => ({vm_id: string}|null)} deps.findExisting
 * @param {(o: {email, exitMode, namePrefix}) => Promise<{ok, vm_id?, proxy_url?, login_ip_differs?, error?}>} deps.provision
 * @param {(vmId: string) => Promise<void>|void} deps.discard
 * @param {(o: {vmId, account}) => Promise<{ok, error?}>} deps.commit
 * @param {(o: {vmId, email, password, mfaSecret, loginIpDiffers}) => Promise<{ok, error?}>|{ok, error?}} deps.enroll
 */
export function createCodexLoginBatchManager({
  readConfig,
  login,
  findExisting,
  provision,
  discard,
  commit,
  enroll,
  encryptionEnabled = () => false,
  ttlMs = 30 * 60_000,
  now = () => Date.now(),
  randomId = () => crypto.randomUUID(),
  log = () => {},
} = {}) {
  let batch = null
  // Slot creation picks ids and exits from shared state: one at a time.
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
        vm_id: row.vm_id,
        error: row.error,
        detail: row.detail,
        warning: row.warning,
        retryable: !!row.secret && RETRYABLE.has(row.status),
      })),
    }
  }

  function settle(row, status, { error = null, detail = null, vmId = row.vm_id, keepSecret = false } = {}) {
    row.status = status
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
    if (!row.account && !row.committed) {
      row.status = 'checking'
      row.error = null
      row.detail = null
      const known = findExisting({ email: row.email })
      if (known) return settle(row, 'skipped', { detail: 'email_exists', vmId: known.vm_id })
      if (b.canceled) return settle(row, 'pending', { keepSecret: true })

      row.status = 'provisioning'
      const slot = await provisionOnce({ email: row.email, exitMode: opts.exit_mode, namePrefix: opts.name_prefix })
      if (!slot?.ok) return settle(row, 'failed', { error: slot?.error || 'slot_create_failed', keepSecret: true })
      row.vm_id = slot.vm_id
      row.login_ip_differs = slot.login_ip_differs === true
      row.warning = row.login_ip_differs ? 'login_ip_differs' : null
      if (b.canceled) {
        await dropSlot(row)
        return settle(row, 'pending', { keepSecret: true, vmId: null })
      }

      row.status = 'logging_in'
      const ac = new AbortController()
      row.abort = ac
      let result
      try {
        result = await login({
          email: row.email,
          password: row.secret.password,
          mfaSecret: row.secret.mfa_secret,
          proxyUrl: slot.proxy_url || '',
          signal: ac.signal,
        })
      } finally {
        row.abort = null
      }
      if (!result?.ok) {
        await dropSlot(row)
        if (b.canceled && result?.error === 'canceled') return settle(row, 'pending', { keepSecret: true, vmId: null })
        const detail = result?.detail || (result?.status ? `http_${result.status}` : null)
        return settle(row, 'failed', { error: result?.error || 'login_failed', detail, keepSecret: true, vmId: null })
      }
      const made = codexAccountFromLogin(result.credential)
      if (!made.ok || made.email !== row.email) {
        await dropSlot(row)
        const error = made.ok ? 'identity_mismatch' : made.error
        return settle(row, 'failed', { error, keepSecret: true, vmId: null })
      }
      const dup = findExisting({ email: row.email, chatgptAccountId: made.chatgpt_account_id, excludeVmId: row.vm_id })
      if (dup) {
        await dropSlot(row)
        return settle(row, 'skipped', { detail: 'account_exists', vmId: dup.vm_id })
      }
      row.account = made.account
    }

    row.status = 'importing'
    if (!row.committed) {
      const done = await commit({ vmId: row.vm_id, account: row.account })
      if (!done?.ok) return settle(row, 'import_failed', { error: done?.error || 'import_failed', keepSecret: true })
      row.committed = true
      if (done.warning) row.warning = done.warning
    }
    if (opts.save_login && !row.enrolled) {
      const saved = await enroll({
        vmId: row.vm_id,
        email: row.email,
        password: row.secret.password,
        mfaSecret: row.secret.mfa_secret,
        loginIpDiffers: row.login_ip_differs === true,
      })
      if (!saved?.ok) return settle(row, 'import_failed', { error: saved?.error || 'enroll_failed', keepSecret: true })
      row.enrolled = true
    }
    settle(row, 'created')
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
    const queue = b.rows.filter((row) => row.status === 'pending')
    const width = Math.min(8, Math.max(1, Number(readConfig()?.batch_concurrency) || 1), Math.max(1, queue.length))
    const worker = async () => {
      while (!b.canceled) {
        const row = queue.shift()
        if (!row) return
        try {
          await processRow(b, row)
        } catch (err) {
          log({ event: 'codex_login_row_failed', error: String(err?.code || err?.name || 'internal_error') })
          settle(row, row.committed ? 'import_failed' : 'failed', { error: 'internal_error', keepSecret: true })
        }
      }
    }
    b.done = Promise.all(Array.from({ length: width }, worker)).then(() => finish(b))
  }

  function start(body = {}) {
    if (live()?.status === 'running') return { ok: false, status: 409, error: 'batch_running' }
    const parsed = parseBatchText(body.text)
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error, line: parsed.line }
    const options = {
      exit_mode: body.exit_mode === 'local' ? 'local' : 'pool',
      save_login: body.save_login !== false,
      name_prefix: cleanPrefix(body.name_prefix),
    }
    if (!readConfig()?.endpoint) return { ok: false, status: 409, error: 'login_service_unconfigured' }
    if (options.save_login && !encryptionEnabled()) return { ok: false, status: 409, error: 'encryption_required' }
    wipe(batch)
    batch = {
      id: randomId(),
      status: 'running',
      created_at: iso(),
      finished_at: null,
      expires_at: null,
      options,
      canceled: false,
      expiry: null,
      done: null,
      rows: parsed.entries.map((entry) => ({
        id: randomId(),
        line: entry.line,
        email: entry.email,
        status: 'pending',
        vm_id: null,
        error: null,
        detail: null,
        warning: null,
        login_ip_differs: false,
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
    let count = 0
    for (const row of b.rows) {
      if (!row.secret || !RETRYABLE.has(row.status)) continue
      row.status = 'pending'
      row.error = null
      row.detail = null
      count++
    }
    if (!count) return { ok: false, status: 409, error: 'nothing_to_retry' }
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
