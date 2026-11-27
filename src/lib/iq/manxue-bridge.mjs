/**
 * Ephemeral in-memory single-slot bridge for manxue.ai callback tests.
 *
 * manxue.ai posts to `{base_url}/responses` with `Authorization: Bearer {api_key}`
 * and does not support custom headers like `x-kin-vm`. For each IQ check task, we
 * mint a short-lived ticket `{ nonce, secret, vmId, allowedModel, maxUses, expiresAt }`
 * in memory (never written to disk or logs), pass
 *   base_url = `${callbackBaseUrl}/api/manxue-bridge/${nonce}`
 *   api_key  = secret
 * to manxue.ai, and revoke the ticket immediately when the task completes or cancels.
 *
 * When manxue.ai calls back `POST /api/manxue-bridge/:nonce/responses`, this handler
 * verifies the bearer secret with timing-safe comparison, enforces model binding and
 * usage limit, then streams the request through local loopback `POST /v1/responses`
 * pinned to `x-kin-vm: ticket.vmId`.
 */
import crypto from 'node:crypto'
import http from 'node:http'

export const BRIDGE_PATH_PREFIX = '/api/manxue-bridge/'
const BRIDGE_ROUTE_RE = /^\/api\/manxue-bridge\/([a-f0-9]{16,64})\/responses$/i
const DEFAULT_TTL_MS = 10 * 60_000
const DEFAULT_MAX_USES = 3
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_MAX_CAPTURED_BYTES = 512 * 1024

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8')
  const bufB = Buffer.from(String(b || ''), 'utf8')
  if (bufA.length === 0 || bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

function extractBearerToken(headers = {}) {
  const auth = String(headers.authorization || headers.Authorization || '').trim()
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim()
  const alt = String(headers['x-api-key'] || '').trim()
  return alt
}

function extractResponsesTextFromJson(body) {
  if (!body || typeof body !== 'object') return ''
  if (typeof body.output_text === 'string' && body.output_text) return body.output_text
  const out = Array.isArray(body.output) ? body.output : []
  const parts = []
  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : []
    for (const c of content) {
      if ((c?.type === 'output_text' || c?.type === 'text') && c.text) parts.push(String(c.text))
    }
  }
  return parts.join('')
}

export function createManxueBridge({
  now = () => Date.now(),
  sweepIntervalMs = 60_000,
  maxCapturedBytes = DEFAULT_MAX_CAPTURED_BYTES,
} = {}) {
  /** @type {Map<string, object>} */
  const tickets = new Map()
  let sweepTimer = null

  function pruneExpired() {
    const t = now()
    for (const [nonce, ticket] of tickets.entries()) {
      if (ticket.expiresAt <= t) tickets.delete(nonce)
    }
  }

  if (sweepIntervalMs > 0) {
    sweepTimer = setInterval(pruneExpired, sweepIntervalMs)
    sweepTimer.unref?.()
  }

  function mintTicket({ vmId, allowedModel = null, ttlMs = DEFAULT_TTL_MS, maxUses = DEFAULT_MAX_USES } = {}) {
    const cleanVmId = String(vmId || '').trim()
    if (!cleanVmId) throw new Error('vmId is required to mint bridge ticket')
    pruneExpired()
    const nonce = crypto.randomBytes(16).toString('hex')
    const secret = crypto.randomBytes(24).toString('hex')
    const expiresAt = now() + Math.max(30_000, Number(ttlMs) || DEFAULT_TTL_MS)
    const ticket = {
      nonce,
      secret,
      vmId: cleanVmId,
      allowedModel: allowedModel ? String(allowedModel).trim().toLowerCase() : null,
      expiresAt,
      remainingUses: Math.max(1, Math.trunc(Number(maxUses) || DEFAULT_MAX_USES)),
      uses: 0,
      capturedText: '',
    }
    tickets.set(nonce, ticket)
    return { nonce, secret, expiresAt }
  }

  function verifyAndConsume(nonce, rawToken, requestedModel = null) {
    const key = String(nonce || '')
      .trim()
      .toLowerCase()
    const ticket = tickets.get(key)
    if (!ticket) return { ok: false, status: 404, error: 'bridge_ticket_not_found' }
    if (ticket.expiresAt <= now()) {
      tickets.delete(key)
      return { ok: false, status: 404, error: 'bridge_ticket_expired' }
    }
    if (!safeEqual(rawToken, ticket.secret)) {
      return { ok: false, status: 401, error: 'bridge_unauthorized' }
    }
    if (ticket.remainingUses <= 0) {
      return { ok: false, status: 404, error: 'bridge_ticket_exhausted' }
    }
    if (ticket.allowedModel && requestedModel) {
      const reqModel = String(requestedModel).trim().toLowerCase()
      if (reqModel !== ticket.allowedModel) {
        return { ok: false, status: 400, error: 'bridge_model_mismatch' }
      }
    }
    ticket.remainingUses -= 1
    ticket.uses += 1
    return { ok: true, vmId: ticket.vmId, allowedModel: ticket.allowedModel, nonce: key }
  }

  function recordCapturedText(nonce, text) {
    const key = String(nonce || '')
      .trim()
      .toLowerCase()
    const ticket = tickets.get(key)
    if (!ticket || !text) return
    const str = String(text)
    if (Buffer.byteLength(str, 'utf8') > maxCapturedBytes) {
      ticket.capturedText = Buffer.from(str, 'utf8').subarray(0, maxCapturedBytes).toString('utf8')
    } else {
      ticket.capturedText = str
    }
  }

  function getCapturedText(nonce) {
    const key = String(nonce || '')
      .trim()
      .toLowerCase()
    return tickets.get(key)?.capturedText || ''
  }

  function revokeTicket(nonce) {
    if (!nonce) return
    tickets.delete(String(nonce).trim().toLowerCase())
  }

  function activeCount() {
    pruneExpired()
    return tickets.size
  }

  function stop() {
    if (sweepTimer) {
      clearInterval(sweepTimer)
      sweepTimer = null
    }
    tickets.clear()
  }

  return {
    mintTicket,
    verifyAndConsume,
    recordCapturedText,
    getCapturedText,
    revokeTicket,
    activeCount,
    stop,
  }
}

export function matchManxueBridgePath(pathname) {
  const m = BRIDGE_ROUTE_RE.exec(String(pathname || ''))
  return m ? m[1].toLowerCase() : null
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false
    const done = (err, buf) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve(buf)
    }
    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.length
      if (total > maxBytes) {
        done(Object.assign(new Error('payload_too_large'), { status: 413 }))
        req.destroy?.()
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => done(null, Buffer.concat(chunks)))
    req.on('error', (err) => done(err))
  })
}

function createOutputCapture(onComplete, maxBytes = DEFAULT_MAX_CAPTURED_BYTES) {
  let isSse = false
  let sseBuf = ''
  let deltaText = ''
  let completedText = ''
  const rawChunks = []
  let rawTotal = 0

  function parseSseBlock(block) {
    const lines = block.split(/\r?\n/)
    const dataLines = []
    for (const line of lines) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (!dataLines.length) return
    const payload = dataLines.join('\n').trim()
    if (!payload || payload === '[DONE]') return
    try {
      const ev = JSON.parse(payload)
      const type = String(ev?.type || '')
      if (type === 'response.output_text.delta') {
        const piece = String(ev.delta || ev.text || '')
        if (piece && deltaText.length < maxBytes) deltaText += piece
      } else if (type === 'response.completed' && ev.response) {
        const txt = extractResponsesTextFromJson(ev.response)
        if (txt) completedText = txt
      }
    } catch {}
  }

  return {
    setContentType(ctype) {
      isSse = /text\/event-stream/i.test(String(ctype || ''))
    },
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (isSse) {
        sseBuf += buf.toString('utf8')
        let idx
        while ((idx = sseBuf.indexOf('\n\n')) !== -1) {
          const block = sseBuf.slice(0, idx)
          sseBuf = sseBuf.slice(idx + 2)
          parseSseBlock(block)
        }
      } else if (rawTotal < maxBytes) {
        rawChunks.push(buf)
        rawTotal += buf.length
      }
    },
    finish() {
      if (isSse) {
        if (sseBuf.trim()) parseSseBlock(sseBuf)
        const text = deltaText || completedText
        if (text) onComplete(text)
        return
      }
      if (!rawChunks.length) return
      try {
        const parsed = JSON.parse(Buffer.concat(rawChunks).toString('utf8'))
        const text = extractResponsesTextFromJson(parsed)
        if (text) onComplete(text)
      } catch {}
    },
  }
}

/**
 * Create an HTTP request handler for `POST /api/manxue-bridge/:nonce/responses`.
 * Returns `true` if the path matched the bridge prefix (handled), `false` otherwise.
 */
export function createManxueBridgeHandler({
  bridge,
  getLoopbackBaseUrl,
  getMasterApiKey,
  json,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  requestImpl = http.request,
  timeoutMs = 280_000,
} = {}) {
  function sendErr(res, status, code) {
    try {
      if (!res.headersSent) res.setHeader('Cache-Control', 'no-store')
    } catch {}
    json(res, status, { error: { type: 'bridge_error', code, message: code } })
  }

  return async function handleManxueBridge(req, res, pathname) {
    if (!String(pathname || '').startsWith(BRIDGE_PATH_PREFIX)) return false
    const nonce = matchManxueBridgePath(pathname)
    if (!nonce || req.method !== 'POST') {
      sendErr(res, 404, 'bridge_not_found')
      return true
    }

    let rawBuf
    try {
      rawBuf = await readRawBody(req, maxBodyBytes)
    } catch (err) {
      sendErr(res, err?.status === 413 ? 413 : 400, err?.status === 413 ? 'payload_too_large' : 'invalid_body')
      return true
    }

    let parsedBody
    try {
      parsedBody = JSON.parse(rawBuf.toString('utf8'))
      if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
        sendErr(res, 400, 'invalid_json_object')
        return true
      }
    } catch {
      sendErr(res, 400, 'invalid_json')
      return true
    }

    const token = extractBearerToken(req.headers)
    const verified = bridge.verifyAndConsume(nonce, token, parsedBody.model)
    if (!verified.ok) {
      sendErr(res, verified.status || 401, verified.error || 'bridge_rejected')
      return true
    }

    const masterKey = String(typeof getMasterApiKey === 'function' ? getMasterApiKey() : getMasterApiKey || '').trim()
    const loopbackBase = String(
      typeof getLoopbackBaseUrl === 'function' ? getLoopbackBaseUrl() : getLoopbackBaseUrl || '',
    ).replace(/\/+$/, '')
    if (!masterKey || !loopbackBase) {
      sendErr(res, 503, 'bridge_gateway_unavailable')
      return true
    }

    let target
    try {
      target = new URL(`${loopbackBase}/v1/responses`)
    } catch {
      sendErr(res, 503, 'bridge_gateway_unavailable')
      return true
    }

    const capture = createOutputCapture((text) => bridge.recordCapturedText(nonce, text))

    await new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }

      const upstreamReq = requestImpl(
        {
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': rawBuf.byteLength,
            accept: req.headers.accept || 'text/event-stream, application/json',
            authorization: `Bearer ${masterKey}`,
            'x-api-key': masterKey,
            'x-kin-vm': verified.vmId,
            connection: 'close',
          },
          agent: false,
          timeout: timeoutMs,
        },
        (upRes) => {
          const status = Number(upRes.statusCode) || 502
          const ctype = upRes.headers?.['content-type'] || 'application/json; charset=utf-8'
          capture.setContentType(ctype)
          const outHeaders = {
            'content-type': ctype,
            'cache-control': 'no-store',
          }
          if (upRes.headers?.['x-request-id']) {
            outHeaders['x-request-id'] = upRes.headers['x-request-id']
          }
          if (!res.headersSent) res.writeHead(status, outHeaders)
          upRes.on('data', (chunk) => {
            capture.push(chunk)
            if (!res.writableEnded) res.write(chunk)
          })
          upRes.on('end', () => {
            capture.finish()
            if (!res.writableEnded) res.end()
            finish()
          })
          upRes.on('error', () => {
            capture.finish()
            if (!res.writableEnded) res.end()
            finish()
          })
        },
      )

      upstreamReq.on('timeout', () => {
        upstreamReq.destroy(new Error('bridge_upstream_timeout'))
      })

      upstreamReq.on('error', () => {
        if (!res.headersSent) sendErr(res, 502, 'bridge_upstream_failed')
        else if (!res.writableEnded) res.end()
        finish()
      })

      res.on('close', () => {
        if (!res.writableEnded) {
          upstreamReq.destroy()
          finish()
        }
      })

      upstreamReq.write(rawBuf)
      upstreamReq.end()
    })

    return true
  }
}
