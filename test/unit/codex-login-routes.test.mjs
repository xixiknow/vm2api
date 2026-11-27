/** Panel routes for GPT password login (Callback v2): ACL, write-only secrets, batch pool check, single-slot login. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { createCodexLoginRoutes } from '../../src/lib/admin/codex-login-routes.mjs'
import { createCodexLoginRuntime } from '../../src/lib/oauth/codex-login-runtime.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { ok } from '../../src/lib/admin/panel-api.mjs'

const SECRET_PW = 'DO_NOT_EXPOSE_PASSWORD'
const SECRET_TOKEN = 'DO_NOT_EXPOSE_SERVICE_TOKEN'
const VALID_TOTP = 'JBSWY3DPEHPK3PXP'

function fakeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`
}

test('codex-login panel routes (Callback v2 service, batch proxy check, single-slot login, ACL)', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-login-routes-'))
  const prevSecret = process.env.VM2API_DB_SECRET
  const prevToken = process.env.VM2API_CODEX_AUTH_TOKEN
  process.env.VM2API_DB_SECRET = 'routes-test-secret'
  delete process.env.VM2API_CODEX_AUTH_TOKEN
  const dataDir = path.join(tmp, 'data')
  fs.mkdirSync(dataDir)
  fs.mkdirSync(path.join(tmp, 'vms'))
  openDatabase({ dataDir })

  const proxyPool = new ProxyPool({ dataDir })
  proxyPool.ensureLocal()

  const loginCalls = []
  const committedCalls = []
  const runtime = createCodexLoginRuntime({
    projectRoot: tmp,
    proxyPool: () => proxyPool,
    log: () => {},
    loginImpl: async (args) => {
      loginCalls.push(args)
      args.onProgress?.('selecting_workspace')
      return {
        ok: true,
        credential: {
          access_token: fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'ws_slot_1' } }),
          refresh_token: 'rt-slot-1',
          id_token: fakeJwt({ email: args.email, 'https://api.openai.com/auth': { chatgpt_account_id: 'ws_slot_1' } }),
          expires_at: 1_900_000_000_000,
        },
        workspace: {
          id: 'ws_slot_1',
          kind: 'organization',
          name: 'Slot Org',
          selection_reason: 'organization_preferred',
          candidate_count: 2,
          selection_missing: false,
        },
      }
    },
  })
  runtime.attachPanel({
    commitCodex: async ({ existing, account }) => {
      committedCalls.push({ vmId: existing.id, email: account.email, wsKind: account.workspace_kind })
      return { vm: { id: existing.id, email: account.email }, platform: 'openai' }
    },
    bringUpImportedVm: async () => ({ ok: true }),
    fillTimezoneFromExit: async () => ({ ok: true }),
  })

  t.after(() => {
    runtime.stop()
    closeDatabase()
    if (prevSecret === undefined) delete process.env.VM2API_DB_SECRET
    else process.env.VM2API_DB_SECRET = prevSecret
    if (prevToken === undefined) delete process.env.VM2API_CODEX_AUTH_TOKEN
    else process.env.VM2API_CODEX_AUTH_TOKEN = prevToken
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const readBody = async (req) => {
    if (req.__invalid) throw new Error(`Unexpected token in ${SECRET_PW}`)
    return req.__body ?? {}
  }
  const panelJson = (res, status, body) => {
    Object.assign(res, { status, body })
    return true
  }
  const routes = createCodexLoginRoutes({ runtime, json: panelJson, readBody, ok })

  async function call(identity, method, route, { body, invalid = false } = {}) {
    const res = {
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value
      },
    }
    const handler = createPanelHandler({
      cfg: { paths: { project: tmp } },
      routingConfig: {},
      requireAuth(req) {
        if (identity === null) {
          res.status = 401
          return false
        }
        Object.assign(req, identity)
        return true
      },
      json: panelJson,
      readBody,
      codexLogin: runtime,
      codexLoginRoutes: routes,
    })
    await handler({ method, __body: body, __invalid: invalid }, res, new URL(`http://localhost${route}`))
    return res
  }

  const admin = { panelUser: 'isolated-admin', panelRole: 'admin' }
  const svc = '/api/panel/codex-login/service'

  // ACL checks
  assert.equal((await call(null, 'GET', svc)).status, 401)
  for (const role of ['user', 'super']) {
    assert.equal((await call({ panelUser: 'u', panelRole: role }, 'GET', svc)).status, 403, role)
    assert.equal(
      (await call({ panelUser: 'u', panelRole: role }, 'POST', '/api/panel/codex-login/slots/vm-001/login')).status,
      403,
    )
  }
  assert.equal((await call({ apiKeyKind: 'managed' }, 'GET', svc)).status, 403)
  assert.equal((await call({ apiKeyKind: 'master' }, 'GET', svc)).status, 200)

  // Initial service config includes egress summary showing 0 non-local free slots even though px-local exists.
  const empty = await call(admin, 'GET', svc)
  assert.equal(empty.status, 200)
  assert.equal(empty.headers['cache-control'], 'no-store')
  assert.equal(empty.body.data.configured, false)
  assert.equal(empty.body.data.egress_summary.pool_free_slots, 0)
  assert.equal(empty.body.data.egress_summary.pool_usable_proxies, 0)

  // Save Callback v2 config with encrypted Bearer service_token.
  const saved = await call(admin, 'PUT', svc, {
    body: {
      endpoint: 'http://127.0.0.1:8788/v2/authenticate',
      service_token: SECRET_TOKEN,
      workspace_policy: 'prefer_organization',
      max_concurrency: 32,
    },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.data.endpoint, 'http://127.0.0.1:8788')
  assert.equal(saved.body.data.configured, true)
  assert.equal(saved.body.data.service_token_set, true)
  assert.equal(saved.body.data.max_concurrency, 32)
  assert.ok(!JSON.stringify(saved.body).includes(SECRET_TOKEN))
  assert.equal(
    (await call(admin, 'PUT', svc, { body: { endpoint: 'http://example.com:8788' } })).body.error.code,
    'endpoint_requires_https',
  )

  // Batch start blocked upfront when no non-local pool proxies are free, and rejects local mode.
  const localRejected = await call(admin, 'POST', '/api/panel/codex-login/batches', {
    body: { text: 'a@x.com----pw', exit_mode: 'local' },
  })
  assert.deepEqual([localRejected.status, localRejected.body.error.code], [400, 'local_exit_unsupported'])

  const noFreeProxy = await call(admin, 'POST', '/api/panel/codex-login/batches', {
    body: { text: `a@x.com----${SECRET_PW}` },
  })
  assert.deepEqual([noFreeProxy.status, noFreeProxy.body.error.code], [409, 'no_free_proxy'])
  assert.ok(!JSON.stringify(noFreeProxy.body).includes(SECRET_PW))

  // Import a real SOCKS5 proxy into the pool; allocateForVm({ excludeLocal: true }) never picks px-local.
  const imp = proxyPool.importLines('socks5://u:p@10.0.0.8:1080')
  assert.equal(imp.added, 1)
  const pxId = proxyPool.snapshot().proxies.find((p) => p.id !== 'px-local').id
  const afterProxy = await call(admin, 'GET', svc)
  assert.equal(afterProxy.body.data.egress_summary.pool_usable_proxies, 1)
  assert.equal(afterProxy.body.data.egress_summary.pool_free_slots, 5)
  const alloc = proxyPool.allocateForVm('vm-001', { excludeLocal: true })
  assert.equal(alloc.id, pxId)

  // Create a GPT slot bound to that SOCKS5 proxy and run single-slot password login.
  fs.writeFileSync(
    path.join(tmp, 'vms', 'vm-001.json'),
    JSON.stringify({
      id: 'vm-001',
      name: 'gpt',
      platform: 'openai',
      family: 'codex',
      proxy: { id: pxId, host: '10.0.0.8', port: 1080, scheme: 'socks5' },
    }),
  )

  const startedSlot = await call(admin, 'POST', '/api/panel/codex-login/slots/vm-001/login', {
    body: {
      email: 'Slot@Example.com',
      password: SECRET_PW,
      totp_secret: VALID_TOTP,
      save_login: true,
    },
  })
  assert.equal(startedSlot.status, 202)
  assert.ok(!JSON.stringify(startedSlot.body).includes(SECRET_PW))
  await runtime.slotLogin.settled('vm-001')

  const slotStatus = await call(admin, 'GET', '/api/panel/codex-login/slots/vm-001/login')
  assert.equal(slotStatus.status, 200)
  assert.equal(slotStatus.body.data.state, 'ok', JSON.stringify(slotStatus.body.data))
  assert.equal(slotStatus.body.data.workspace.id, 'ws_slot_1')
  assert.ok(!JSON.stringify(slotStatus.body).includes(SECRET_PW))
  assert.equal(loginCalls.length, 1)
  assert.equal(loginCalls[0].proxyUrl, 'socks5h://u:p@10.0.0.8:1080')

  // Verify real commitImportedCodexVm persisted whitelisted workspace metadata with zero temporary secrets.
  const persistedVm = JSON.parse(fs.readFileSync(path.join(tmp, 'vms', 'vm-001.json'), 'utf8'))
  assert.equal(persistedVm.codex.email, 'slot@example.com')
  assert.equal(persistedVm.codex.chatgpt_account_id, 'ws_slot_1')
  assert.equal(persistedVm.codex.workspace_kind, 'organization')
  assert.equal(persistedVm.codex.workspace_selection_reason, 'organization_preferred')
  assert.equal(persistedVm.codex.workspace_candidate_count, 2)
  assert.ok(!JSON.stringify(persistedVm).includes(SECRET_PW))
  assert.ok(!JSON.stringify(persistedVm).includes(VALID_TOTP))

  const persistedCreds = fs.readFileSync(path.join(tmp, 'vms', 'vm-001', 'codex-credentials.json'), 'utf8')
  assert.ok(!persistedCreds.includes(SECRET_PW))
  assert.ok(!persistedCreds.includes(VALID_TOTP))

  // Because save_login was true, the slot profile was automatically enrolled too.
  const prof = await call(admin, 'GET', '/api/panel/codex-login/profiles/vm-001')
  assert.equal(prof.status, 200)
  assert.equal(prof.body.data.email, 'slot@example.com')
  assert.equal(prof.body.data.password_set, true)
  assert.equal(prof.body.data.totp_set, true)
})
