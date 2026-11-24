/** Panel routes for GPT password login: roles, write-only secrets, no echo of submitted bodies. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { createCodexLoginRoutes } from '../../src/lib/admin/codex-login-routes.mjs'
import { createCodexLoginRuntime } from '../../src/lib/oauth/codex-login-runtime.mjs'
import { ok } from '../../src/lib/admin/panel-api.mjs'

const SECRET_PW = 'DO_NOT_EXPOSE_PASSWORD'
const SECRET_HEADER = 'DO_NOT_EXPOSE_HEADER'

test('codex-login panel routes', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-login-routes-'))
  const prevSecret = process.env.VM2API_DB_SECRET
  process.env.VM2API_DB_SECRET = 'routes-test-secret'
  const dataDir = path.join(tmp, 'data')
  fs.mkdirSync(dataDir)
  fs.mkdirSync(path.join(tmp, 'vms'))
  openDatabase({ dataDir })
  const runtime = createCodexLoginRuntime({ projectRoot: tmp, proxyPool: () => null, log: () => {} })
  t.after(() => {
    runtime.stop()
    closeDatabase()
    if (prevSecret === undefined) delete process.env.VM2API_DB_SECRET
    else process.env.VM2API_DB_SECRET = prevSecret
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

  assert.equal((await call(null, 'GET', svc)).status, 401)
  for (const role of ['user', 'super']) {
    assert.equal((await call({ panelUser: 'u', panelRole: role }, 'GET', svc)).status, 403, role)
    assert.equal(
      (await call({ panelUser: 'u', panelRole: role }, 'POST', '/api/panel/codex-login/batches')).status,
      403,
    )
  }
  assert.equal((await call({ apiKeyKind: 'managed' }, 'GET', svc)).status, 403)
  assert.equal((await call({ apiKeyKind: 'master' }, 'GET', svc)).status, 200)

  const empty = await call(admin, 'GET', svc)
  assert.equal(empty.status, 200)
  assert.equal(empty.headers['cache-control'], 'no-store')
  assert.equal(empty.body.data.configured, false)
  assert.equal(empty.body.data.encryption_enabled, true)

  const saved = await call(admin, 'PUT', svc, {
    body: { endpoint: 'http://login-svc:8080/relogin', headers: [{ name: 'X-Key', value: SECRET_HEADER }] },
  })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.data.headers, [{ name: 'X-Key', value: '', value_set: true }])
  assert.ok(!JSON.stringify(saved.body).includes(SECRET_HEADER))
  assert.equal(
    (await call(admin, 'PUT', svc, { body: { endpoint: 'http://example.com/x' } })).body.error.code,
    'endpoint_requires_https',
  )
  assert.ok(!JSON.stringify((await call(admin, 'GET', svc)).body).includes(SECRET_HEADER))

  const badLine = await call(admin, 'POST', '/api/panel/codex-login/batches', {
    body: { text: `a@x.com----${SECRET_PW}----T\nbroken ${SECRET_PW}` },
  })
  assert.equal(badLine.status, 400)
  assert.deepEqual([badLine.body.error.code, badLine.body.error.line], ['invalid_batch', 2])
  assert.ok(!JSON.stringify(badLine.body).includes(SECRET_PW))

  const invalidJson = await call(admin, 'POST', '/api/panel/codex-login/batches', { invalid: true })
  assert.deepEqual([invalidJson.status, invalidJson.body.error.code], [400, 'invalid_json'])
  assert.ok(!JSON.stringify(invalidJson.body).includes(SECRET_PW))

  assert.equal((await call(admin, 'GET', '/api/panel/codex-login/batches/current')).body.data, null)
  assert.equal((await call(admin, 'POST', '/api/panel/codex-login/batches/nope/retry')).status, 404)

  const profile = '/api/panel/codex-login/profiles/vm-001'
  assert.equal(
    (await call(admin, 'PUT', profile, { body: { email: 'a@x.com', password: 'x' } })).body.error.code,
    'vm_not_codex',
  )
  fs.writeFileSync(
    path.join(tmp, 'vms', 'vm-001.json'),
    JSON.stringify({ id: 'vm-001', name: 'gpt', platform: 'openai', family: 'codex' }),
  )
  const enrolled = await call(admin, 'PUT', profile, {
    body: { email: 'A@x.com', password: SECRET_PW, totp_secret: 'JBSW Y3DP' },
  })
  assert.equal(enrolled.status, 200)
  assert.deepEqual(
    [
      enrolled.body.data.email,
      enrolled.body.data.password_set,
      enrolled.body.data.totp_set,
      enrolled.body.data.vm_exists,
    ],
    ['a@x.com', true, true, true],
  )
  assert.ok(!JSON.stringify(enrolled.body).includes(SECRET_PW))
  const listed = await call(admin, 'GET', '/api/panel/codex-login/profiles')
  assert.equal(listed.body.data.items.length, 1)
  assert.equal(listed.body.data.items[0].relogin.state, 'idle')
  assert.ok(!JSON.stringify(listed.body).includes(SECRET_PW))
  assert.ok(!JSON.stringify(listed.body).includes('enc:v1:'))

  const paused = await call(admin, 'PUT', profile, { body: { auto_relogin: false } })
  assert.equal(paused.body.data.auto_relogin, false)
  assert.equal((await call(admin, 'PUT', profile, { body: { resume: true } })).body.data.auto_relogin, true)

  assert.equal(
    (await call(admin, 'POST', '/api/panel/codex-login/profiles/vm-404/relogin')).body.error.code,
    'profile_missing',
  )
  assert.equal((await call(admin, 'DELETE', profile)).status, 200)
  assert.equal((await call(admin, 'GET', profile)).status, 404)
  assert.equal((await call(admin, 'GET', '/api/panel/codex-login/nope')).status, 404)
})
