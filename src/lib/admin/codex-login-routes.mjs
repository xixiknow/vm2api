/**
 * /api/panel/codex-login/* — GPT password login (Callback v2):
 *   - Service config & health check (`/service`, `/service/check`)
 *   - Batch import (`/batches`, `/batches/current`, `/batches/:id/{cancel,retry}`)
 *   - Single-slot password login (`/slots/:vmId/login`, `/slots/:vmId/login/cancel`)
 *   - Per-slot saved profiles & manual re-login (`/profiles`, `/profiles/:vmId`, `/profiles/:vmId/relogin`)
 *
 * Auth and ACL are enforced by the panel handler before this runs; every route here is admin-only.
 * Bodies may carry passwords, TOTP secrets, and Bearer tokens: parse errors never quote input,
 * and responses never echo submitted secrets.
 */
import { applyServicePatch, publicServiceConfig } from '../oauth/codex-login-service.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'

const PREFIX = '/api/panel/codex-login'
const BATCH_RE = /^\/api\/panel\/codex-login\/batches\/([A-Za-z0-9-]{1,64})(?:\/(cancel|retry))?$/
const PROFILE_RE = /^\/api\/panel\/codex-login\/profiles\/([A-Za-z0-9_-]{1,128})(?:\/(relogin))?$/
const SLOT_LOGIN_RE = /^\/api\/panel\/codex-login\/slots\/([A-Za-z0-9_-]{1,128})\/login(?:\/(cancel))?$/

const MESSAGES = {
  invalid_json: '请求体不是合法 JSON',
  invalid_batch: '格式不对：需要 邮箱----密码 或 邮箱----密码----2FA密钥',
  duplicate_email: '邮箱和前面重复',
  empty_batch: '没有可导入的账号',
  too_many_rows: '一次最多 100 个账号',
  batch_running: '已有批次在运行',
  batch_not_found: '批次不存在或已过期',
  nothing_to_retry: '没有可重试的行',
  local_exit_unsupported: '批量导入仅支持代理池分配出口',
  no_free_proxy: '代理池没有空闲出口，请先在代理池添加或启用代理',
  proxy_required: '该槽未绑定可用代理出口',
  proxy_unavailable: '该槽绑定的代理不可用，请先检查或更换代理',
  proxy_changed: '认证期间槽位代理发生变化，已取消换票',
  invalid_proxy: '槽位代理格式无效',
  login_service_unconfigured: '还没有配置认证服务地址或服务密钥',
  login_service_token_unreadable: '认证服务密钥无法解密，请重新填写',
  invalid_service_token: '服务密钥不合法',
  invalid_workspace_policy: '工作区偏好设置无效',
  encryption_required: '保存密码需要先配置 VM2API_DB_SECRET',
  invalid_endpoint: '认证服务地址无效',
  endpoint_requires_https: '公网认证服务必须用 HTTPS',
  invalid_vm_id: '槽位 ID 无效',
  vm_not_found: '槽位不存在',
  vm_not_codex: '只有 GPT 槽可以使用密码登录',
  profile_missing: '这个槽还没有登记密码登录',
  slot_login_running: '该槽正在执行登录或重登，请稍候',
  invalid_email: '邮箱无效',
  password_required: '需要填写密码',
  invalid_password: '密码过长',
  invalid_totp: '2FA 密钥无效（需要 16–128 位 Base32 密钥或 otpauth:// 链接）',
  auto_relogin_off: '自动重登已关闭',
  auto_paused: '自动重登已暂停',
  cooldown: '重登冷却中',
  shutting_down: '服务正在停止',
  account_exists: '该账号或工作区已在其他槽位',
  login_service_unreachable: '连不上认证服务',
  engine_not_ready: '认证服务引擎未就绪',
  not_found: '接口不存在',
}

export function createCodexLoginRoutes({ runtime, json, readBody, ok }) {
  function send(res, status, body) {
    try {
      if (!res.headersSent) res.setHeader?.('Cache-Control', 'no-store')
    } catch {}
    return json(res, status, body)
  }

  function fail(res, status, code, extra = {}) {
    return send(res, status, { ok: false, error: { code, message: MESSAGES[code] || code, ...extra } })
  }

  async function readObject(req, max) {
    try {
      const body = await readBody(req, max)
      return body && typeof body === 'object' && !Array.isArray(body) ? body : null
    } catch {
      return null
    }
  }

  async function readOptionalObject(req, max) {
    try {
      const body = await readBody(req, max)
      return body && typeof body === 'object' && !Array.isArray(body) ? body : {}
    } catch {
      return {}
    }
  }

  function serviceView(config = runtime.readConfig()) {
    return publicServiceConfig(config, {
      queue: typeof runtime.queueSnapshot === 'function' ? runtime.queueSnapshot() : null,
      egress_summary: typeof runtime.egressSummary === 'function' ? runtime.egressSummary() : null,
    })
  }

  async function profileRoute(req, res, vmId, action) {
    if (!isValidVmId(vmId)) return fail(res, 400, 'invalid_vm_id')
    if (req.method === 'GET' && !action) {
      const view = runtime.profileView(vmId)
      return view ? send(res, 200, ok(view)) : fail(res, 404, 'profile_missing')
    }
    if (req.method === 'PUT' && !action) {
      if (!runtime.isCodexSlot(vmId)) return fail(res, 404, 'vm_not_codex')
      const body = await readObject(req, 32 * 1024)
      if (!body) return fail(res, 400, 'invalid_json')
      const input = {}
      for (const key of ['email', 'password', 'totp_secret', 'totp_clear', 'auto_relogin']) {
        if (Object.hasOwn(body, key)) input[key] = body[key]
      }
      const saved = runtime.profiles.save(vmId, input)
      if (!saved.ok) return fail(res, saved.error === 'encryption_required' ? 409 : 400, saved.error)
      if (body.resume === true) runtime.profiles.setAutoRelogin(vmId, true)
      return send(res, 200, ok(runtime.profileView(vmId)))
    }
    if (req.method === 'DELETE' && !action) {
      runtime.profiles.remove(vmId)
      return send(res, 200, ok({ deleted: vmId }))
    }
    if (req.method === 'POST' && action === 'relogin') {
      const body = await readOptionalObject(req, 4 * 1024)
      const queued = runtime.relogin.request(vmId, {
        trigger: 'manual',
        allowWorkspaceReselect: body.allow_workspace_reselect === true,
      })
      if (!queued.ok) return fail(res, queued.status || 409, queued.error)
      return send(res, 202, ok(runtime.profileView(vmId)))
    }
    return fail(res, 404, 'not_found')
  }

  async function slotLoginRoute(req, res, vmId, action) {
    if (!isValidVmId(vmId)) return fail(res, 400, 'invalid_vm_id')
    if (req.method === 'GET' && !action) {
      return send(res, 200, ok(runtime.slotLogin.status(vmId)))
    }
    if (req.method === 'POST' && !action) {
      const body = await readObject(req, 32 * 1024)
      if (!body) return fail(res, 400, 'invalid_json')
      const started = runtime.slotLogin.start(vmId, body)
      if (!started.ok) return fail(res, started.status || 400, started.error)
      return send(res, started.status || 202, ok(started.task))
    }
    if (req.method === 'POST' && action === 'cancel') {
      const canceled = runtime.slotLogin.cancel(vmId)
      return send(res, canceled.status || 200, ok(canceled.task))
    }
    return fail(res, 404, 'not_found')
  }

  async function handle(req, res, url) {
    const p = url.pathname
    const m = req.method
    if (p === `${PREFIX}/service`) {
      if (m === 'GET') return send(res, 200, ok(serviceView()))
      if (m === 'PUT') {
        const body = await readObject(req, 32 * 1024)
        if (!body) return fail(res, 400, 'invalid_json')
        const saved = applyServicePatch(runtime.settings(), body)
        if (!saved.ok) return fail(res, 400, saved.error)
        return send(res, 200, ok(serviceView(saved.config)))
      }
    }
    if (p === `${PREFIX}/service/check` && m === 'POST') {
      const result = await runtime.checkServiceHealth()
      return send(res, 200, ok(result))
    }
    if (p === `${PREFIX}/batches` && m === 'POST') {
      const body = await readObject(req, 256 * 1024)
      if (!body) return fail(res, 400, 'invalid_json')
      const started = runtime.batch.start(body)
      if (!started.ok) {
        const extra = started.line
          ? { line: started.line, message: `第 ${started.line} 行：${MESSAGES[started.error] || started.error}` }
          : {}
        return fail(res, started.status, started.error, extra)
      }
      return send(res, started.status, ok(started.batch))
    }
    if (p === `${PREFIX}/batches/current` && m === 'GET') return send(res, 200, ok(runtime.batch.current()))
    const batchMatch = BATCH_RE.exec(p)
    if (batchMatch && batchMatch[1] !== 'current') {
      const [, id, action] = batchMatch
      let result = null
      if (m === 'POST' && action === 'cancel') result = runtime.batch.cancel(id)
      else if (m === 'POST' && action === 'retry') result = runtime.batch.retry(id)
      else if (m === 'DELETE' && !action) result = runtime.batch.remove(id)
      if (result) {
        if (!result.ok) return fail(res, result.status, result.error)
        return send(res, result.status, ok(result.batch || null))
      }
    }
    const slotMatch = SLOT_LOGIN_RE.exec(p)
    if (slotMatch && runtime.slotLogin) return slotLoginRoute(req, res, slotMatch[1], slotMatch[2])
    if (p === `${PREFIX}/profiles` && m === 'GET') return send(res, 200, ok({ items: runtime.listProfiles() }))
    const profileMatch = PROFILE_RE.exec(p)
    if (profileMatch) return profileRoute(req, res, profileMatch[1], profileMatch[2])
    return fail(res, 404, 'not_found')
  }

  return { handle }
}
