/**
 * /api/panel/codex-login/* — GPT password login: service config, batch import, per-slot login
 * profiles and manual re-login. Auth and ACL are enforced by the panel handler before this
 * runs; every route here is admin-only by the panel's default deny.
 *
 * Bodies may carry passwords and TOTP secrets: parse errors are reported without the parser's
 * message (it can quote the input), and responses never echo submitted secrets.
 */
import { applyServicePatch, publicServiceConfig } from '../oauth/codex-login-service.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'

const PREFIX = '/api/panel/codex-login'
const BATCH_RE = /^\/api\/panel\/codex-login\/batches\/([A-Za-z0-9-]{1,64})(?:\/(cancel|retry))?$/
const PROFILE_RE = /^\/api\/panel\/codex-login\/profiles\/([A-Za-z0-9_-]{1,128})(?:\/(relogin))?$/

const MESSAGES = {
  invalid_json: '请求体不是合法 JSON',
  invalid_batch: '格式不对：需要 邮箱----密码----2FA密钥',
  duplicate_email: '邮箱和前面重复',
  empty_batch: '没有可导入的账号',
  too_many_rows: '一次最多 100 个账号',
  batch_running: '已有批次在运行',
  batch_not_found: '批次不存在或已过期',
  nothing_to_retry: '没有可重试的行',
  login_service_unconfigured: '还没有配置登录服务',
  encryption_required: '保存密码需要先配置 VM2API_DB_SECRET',
  invalid_endpoint: '登录服务地址无效',
  endpoint_requires_https: '公网登录服务必须用 HTTPS',
  invalid_headers: '请求头格式不对',
  invalid_header_name: '请求头名称不合法或不允许自定义',
  invalid_header_value: '请求头的值不合法',
  duplicate_header: '请求头重复',
  header_value_required: '新请求头需要填写值',
  invalid_vm_id: '槽位 ID 无效',
  vm_not_found: '槽位不存在',
  vm_not_codex: '只有 GPT 槽可以登记密码登录',
  profile_missing: '这个槽还没有登记密码登录',
  invalid_email: '邮箱无效',
  password_required: '需要填写密码',
  invalid_password: '密码过长',
  invalid_totp: '2FA 密钥无效',
  auto_relogin_off: '自动重登已关闭',
  auto_paused: '自动重登已暂停',
  cooldown: '重登冷却中',
  shutting_down: '服务正在停止',
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
      const queued = runtime.relogin.request(vmId, { trigger: 'manual' })
      if (!queued.ok) return fail(res, queued.status || 409, queued.error)
      return send(res, 202, ok(runtime.profileView(vmId)))
    }
    return fail(res, 404, 'not_found')
  }

  async function handle(req, res, url) {
    const p = url.pathname
    const m = req.method
    if (p === `${PREFIX}/service`) {
      if (m === 'GET') return send(res, 200, ok(publicServiceConfig(runtime.readConfig())))
      if (m === 'PUT') {
        const body = await readObject(req, 32 * 1024)
        if (!body) return fail(res, 400, 'invalid_json')
        const saved = applyServicePatch(runtime.settings(), body)
        if (!saved.ok) return fail(res, 400, saved.error)
        return send(res, 200, ok(publicServiceConfig(saved.config)))
      }
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
    if (p === `${PREFIX}/profiles` && m === 'GET') return send(res, 200, ok({ items: runtime.listProfiles() }))
    const profileMatch = PROFILE_RE.exec(p)
    if (profileMatch) return profileRoute(req, res, profileMatch[1], profileMatch[2])
    return fail(res, 404, 'not_found')
  }

  return { handle }
}
