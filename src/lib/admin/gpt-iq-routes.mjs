/**
 * /api/panel/gpt-iq/* (admin-only global config, slot summaries & audit log)
 * and /api/panel/vms/:id/iq-check* (per-slot config, manual run/cancel, unisolate & preview artifact).
 *
 * Auth, ACL and per-slot tenant ownership (`denyIfUserMissesVm`) are enforced by `panel-routes.mjs`
 * before these handlers execute.
 */
import { isValidVmId } from '../vm/vm-file.mjs'

const PREFIX = '/api/panel/gpt-iq'

const MESSAGES = {
  invalid_json: '请求体不是合法 JSON',
  invalid_config: '配置格式无效',
  invalid_field: '包含不支持的配置字段',
  invalid_enabled: '总开关字段必须为布尔值',
  invalid_auto_isolate_on_degraded: '降智自动隔离字段必须为布尔值',
  invalid_isolate_on_reference: '参考结果隔离字段必须为布尔值',
  invalid_skip_unschedulable: '跳过非调度槽字段必须为布尔值',
  invalid_api_base_url: '满血 API 地址必须是合法的 http/https URL',
  invalid_callback_base_url: '回调基础地址格式无效',
  callback_base_url_required: '桥接模式需要公网 HTTPS 回调地址（请先配置回调地址或 PUBLIC_BASE_URL）',
  callback_base_url_https_required: '满血 API 仅支持 HTTPS 公网回调地址',
  callback_base_url_not_public: '回调地址必须是公网域名或公网 IP（不能是 localhost 或内网地址）',
  invalid_benchmark: '检测模式仅支持 pelican、candy、creative',
  invalid_model: '模型 ID 不能为空且不超过 200 字符',
  invalid_reasoning_effort: '所选检测模式不支持该推理强度',
  invalid_service_tier: '服务档位仅支持默认、priority 或 ultrafast',
  invalid_interval_min: '检测间隔须为 1–1440 的整数（分钟）',
  invalid_concurrency: '并发上限须为 1–10 的整数',
  invalid_min_gap_sec: '提交最小间隔须为 0–300 的整数（秒）',
  invalid_timeout_sec: '单次超时须为 60–600 的整数（秒）',
  invalid_isolate_threshold: '连续降智隔离阈值须为 1–5 的整数',
  invalid_skip_quota_pct: '配额跳过阈值须为 0–100 的整数（%）',
  invalid_mode: '单槽模式仅支持 inherit、enabled、disabled',
  invalid_vm_id: '槽位 ID 无效',
  vm_not_found: '槽位不存在',
  vm_not_codex: '仅 GPT（Codex）账号支持测智',
  proxy_blocked: '该槽未绑定可用 SOCKS5 代理，无法执行测智',
  credential_unavailable: '该槽缺少有效 GPT OAuth 凭证或凭证已吊销',
  slot_unavailable: '该槽当前不可用',
  iq_check_in_progress: '该槽正在测智中，请稍候或先取消当前任务',
  not_running: '该槽当前没有运行中的测智任务',
  artifact_not_found: '暂无可预览的测智结果',
  not_found: '接口不存在',
}

export function createGptIqRoutes({ runtime, json, readBody, ok }) {
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
        const config = runtime.readConfig()
        const { summary } = runtime.listSlotSummaries()
        const resolvedCb = runtime.resolveCallbackBaseUrl(config)
        return send(
          res,
          200,
          ok({
            config,
            summary,
            detected_callback_base_url: runtime.detectedCallbackBaseUrl(),
            effective_callback_base_url: resolvedCb.ok ? resolvedCb.url : '',
            callback_ready: resolvedCb.ok,
          }),
        )
      }
      if (m === 'PUT') {
        const body = await readObject(req)
        if (!body) return fail(res, 400, 'invalid_json')
        const saved = runtime.saveConfigPatch(body)
        if (!saved.ok) return fail(res, 400, saved.error)
        const { summary } = runtime.listSlotSummaries()
        const resolvedCb = runtime.resolveCallbackBaseUrl(saved.config)
        return send(
          res,
          200,
          ok({
            config: saved.config,
            summary,
            detected_callback_base_url: runtime.detectedCallbackBaseUrl(),
            effective_callback_base_url: resolvedCb.ok ? resolvedCb.url : '',
            callback_ready: resolvedCb.ok,
          }),
        )
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

  async function handleSlot(req, res, vmId, action = '') {
    if (!isValidVmId(vmId)) return fail(res, 400, 'invalid_vm_id')
    const m = req.method

    if (!action) {
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

    if (action === 'run') {
      if (m === 'POST') {
        const started = runtime.runNow(vmId)
        if (!started.ok) {
          const status = started.error === 'vm_not_found' ? 404 : started.error === 'iq_check_in_progress' ? 409 : 400
          return fail(res, status, started.error)
        }
        return send(
          res,
          202,
          ok({
            vm_id: vmId,
            accepted: true,
            running: true,
            view: runtime.slotView(vmId),
          }),
        )
      }
      if (m === 'DELETE') {
        const cancelled = await runtime.cancel(vmId)
        if (!cancelled.ok) return fail(res, 404, cancelled.error)
        return send(res, 200, ok({ vm_id: vmId, cancelled: true, view: runtime.slotView(vmId) }))
      }
      return fail(res, 404, 'not_found')
    }

    if (action === 'unisolate' && m === 'POST') {
      const result = runtime.unisolate(vmId)
      if (!result.ok) {
        return fail(res, result.error === 'vm_not_found' ? 404 : 400, result.error)
      }
      return send(res, 200, ok(result.view))
    }

    if (action === 'artifact' && m === 'GET') {
      const view = runtime.slotView(vmId)
      if (!view) return fail(res, 404, 'vm_not_found')
      if (!view.eligible) return fail(res, 400, 'vm_not_codex')
      const artifact = runtime.getArtifact(vmId)
      if (!artifact) return fail(res, 404, 'artifact_not_found')
      return send(res, 200, ok({ vm_id: vmId, vm_name: view.vm_name, artifact }))
    }

    return fail(res, 404, 'not_found')
  }

  return { handleGlobal, handleSlot }
}
