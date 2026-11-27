/**
 * /api/panel/auto-reset/* (admin-only global config, slot summaries & audit log)
 * and /api/panel/vms/:id/auto-reset (per-slot personalized override; admin or slot owner).
 *
 * Auth, ACL and per-slot tenant ownership (`denyIfUserMissesVm`) are enforced by `panel-routes.mjs`
 * before these handlers execute.
 */
import { isValidVmId } from '../vm/vm-file.mjs'

const PREFIX = '/api/panel/auto-reset'

const MESSAGES = {
  invalid_json: '请求体不是合法 JSON',
  invalid_config: '配置格式无效',
  invalid_field: '包含不支持的配置字段',
  invalid_enabled: '开关字段必须为布尔值',
  invalid_mode: '模式仅支持 inherit、enabled、disabled',
  invalid_triggers: '触发窗口配置无效',
  invalid_trigger_mode: '触发门槛仅支持 upstream_limit 或 local_gate',
  invalid_prefer_voucher_over_credits: '积分优先级字段必须为布尔值',
  invalid_smart_expiry_rescue: '临期智能抢救字段必须为布尔值',
  invalid_min_reset_remaining_min: '距自然重置最小剩余时间须为 0–1440 的整数（分钟）',
  invalid_cooldown_min: '单槽冷却时间须为 1–1440 的整数（分钟）',
  invalid_max_per_day: '单槽每日上限须为 0–50 的整数',
  invalid_no_card_recheck_min: '无券重查退避须为 5–1440 的整数（分钟）',
  invalid_vm_id: '槽位 ID 无效',
  vm_not_found: '槽位不存在',
  vm_not_codex: '当前仅 GPT（Codex）槽位支持自动使用重置券',
  not_found: '接口不存在',
}

export function createAutoResetRoutes({ runtime, json, readBody, ok }) {
  function send(res, status, body) {
    try {
      if (!res.headersSent) res.setHeader?.('Cache-Control', 'no-store')
    } catch {}
    return json(res, status, body)
  }

  function fail(res, status, code, extra = {}) {
    return send(res, status, { ok: false, error: { code, message: MESSAGES[code] || code, ...extra } })
  }

  async function readObject(req, max = 32 * 1024) {
    try {
      const body = await readBody(req, max)
      return body && typeof body === 'object' && !Array.isArray(body) ? body : null
    } catch {
      return null
    }
  }

  async function handleGlobal(req, res, url) {
    const p = url.pathname
    const m = req.method
    if (p === `${PREFIX}/config`) {
      if (m === 'GET') {
        const { summary } = runtime.listSlotSummaries()
        return send(res, 200, ok({ config: runtime.readConfig(), summary }))
      }
      if (m === 'PUT') {
        const body = await readObject(req)
        if (!body) return fail(res, 400, 'invalid_json')
        const saved = runtime.saveConfigPatch(body)
        if (!saved.ok) return fail(res, 400, saved.error)
        const { summary } = runtime.listSlotSummaries()
        return send(res, 200, ok({ config: saved.config, summary }))
      }
    }
    if (p === `${PREFIX}/slots` && m === 'GET') {
      return send(res, 200, ok(runtime.listSlotSummaries()))
    }
    if (p === `${PREFIX}/events` && m === 'GET') {
      return send(res, 200, ok({ items: runtime.listEvents() }))
    }
    return fail(res, 404, 'not_found')
  }

  async function handleSlot(req, res, vmId) {
    if (!isValidVmId(vmId)) return fail(res, 400, 'invalid_vm_id')
    const m = req.method
    if (m === 'GET') {
      const view = runtime.slotView(vmId)
      return view ? send(res, 200, ok(view)) : fail(res, 404, 'vm_not_found')
    }
    if (m === 'PUT') {
      const view = runtime.slotView(vmId)
      if (!view) return fail(res, 404, 'vm_not_found')
      if (!view.eligible) return fail(res, 400, 'vm_not_codex')
      const body = await readObject(req)
      if (!body) return fail(res, 400, 'invalid_json')
      const saved = runtime.saveSlotPatch(vmId, body)
      if (!saved.ok) return fail(res, 400, saved.error)
      return send(res, 200, ok(runtime.slotView(vmId)))
    }
    if (m === 'DELETE') {
      const view = runtime.slotView(vmId)
      if (!view) return fail(res, 404, 'vm_not_found')
      if (!view.eligible) return fail(res, 400, 'vm_not_codex')
      runtime.resetSlotOverride(vmId)
      return send(res, 200, ok(runtime.slotView(vmId)))
    }
    return fail(res, 404, 'not_found')
  }

  return { handleGlobal, handleSlot }
}
