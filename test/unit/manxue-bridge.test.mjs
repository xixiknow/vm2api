import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  createManxueBridge,
  createManxueBridgeHandler,
  matchManxueBridgePath,
} from '../../src/lib/iq/manxue-bridge.mjs'

function makeReq({ method = 'POST', headers = {}, body = '{}' }) {
  const req = new EventEmitter()
  req.method = method
  req.headers = headers
  queueMicrotask(() => {
    req.emit('data', Buffer.from(body, 'utf8'))
    req.emit('end')
  })
  return req
}

function makeRes() {
  const res = new EventEmitter()
  res.headersSent = false
  res.writableEnded = false
  res.statusCode = 200
  res.headers = {}
  res.chunks = []
  res.setHeader = (k, v) => {
    res.headers[k.toLowerCase()] = v
  }
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status
    res.headersSent = true
    for (const [k, v] of Object.entries(headers)) res.headers[k.toLowerCase()] = v
  }
  res.write = (chunk) => {
    res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return true
  }
  res.end = (chunk) => {
    if (chunk) res.write(chunk)
    res.writableEnded = true
  }
  return res
}

test('createManxueBridge enforces secret, model, expiry, use limit, and revocation', () => {
  let clock = 1_000_000
  const bridge = createManxueBridge({ now: () => clock, sweepIntervalMs: 0 })
  const ticket = bridge.mintTicket({ vmId: 'vm-gpt-1', allowedModel: 'gpt-6-astra', ttlMs: 60_000, maxUses: 2 })

  assert.equal(matchManxueBridgePath(`/api/manxue-bridge/${ticket.nonce}/responses`), ticket.nonce)
  assert.equal(matchManxueBridgePath('/api/manxue-bridge/short/responses'), null)

  // Wrong secret
  assert.equal(bridge.verifyAndConsume(ticket.nonce, 'wrong-secret', 'gpt-6-astra').status, 401)
  // Wrong model
  assert.equal(bridge.verifyAndConsume(ticket.nonce, ticket.secret, 'gpt-4o').status, 400)
  // Valid uses (2 allowed)
  const u1 = bridge.verifyAndConsume(ticket.nonce, ticket.secret, 'GPT-6-ASTRA')
  assert.equal(u1.ok, true)
  assert.equal(u1.vmId, 'vm-gpt-1')
  const u2 = bridge.verifyAndConsume(ticket.nonce, ticket.secret, 'gpt-6-astra')
  assert.equal(u2.ok, true)
  // Exhausted
  assert.equal(bridge.verifyAndConsume(ticket.nonce, ticket.secret, 'gpt-6-astra').status, 404)

  // Expiry check
  const t2 = bridge.mintTicket({ vmId: 'vm-gpt-2', allowedModel: 'gpt-6-astra', ttlMs: 30_000, maxUses: 2 })
  clock += 31_000
  assert.equal(bridge.verifyAndConsume(t2.nonce, t2.secret, 'gpt-6-astra').error, 'bridge_ticket_expired')

  // Revocation
  const t3 = bridge.mintTicket({ vmId: 'vm-gpt-3', ttlMs: 60_000, maxUses: 2 })
  bridge.revokeTicket(t3.nonce)
  assert.equal(bridge.verifyAndConsume(t3.nonce, t3.secret).status, 404)
  bridge.stop()
})

test('createManxueBridgeHandler pins x-kin-vm, streams SSE back, and captures fallback output', async () => {
  const bridge = createManxueBridge({ sweepIntervalMs: 0 })
  const ticket = bridge.mintTicket({ vmId: 'vm-pin-7', allowedModel: 'gpt-6-astra', maxUses: 1 })
  let capturedUpstreamOpts = null

  const handler = createManxueBridgeHandler({
    bridge,
    getLoopbackBaseUrl: () => 'http://127.0.0.1:8787',
    getMasterApiKey: () => 'master-secret',
    json: (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    },
    requestImpl: (opts, onResponse) => {
      capturedUpstreamOpts = opts
      const upReq = new EventEmitter()
      upReq.write = () => {}
      upReq.destroy = () => {}
      upReq.end = () => {
        const upRes = new EventEmitter()
        upRes.statusCode = 200
        upRes.headers = { 'content-type': 'text/event-stream; charset=utf-8' }
        onResponse(upRes)
        upRes.emit('data', Buffer.from('data: {"type":"response.output_text.delta","delta":"<html>"}\n\n'))
        upRes.emit('data', Buffer.from('data: {"type":"response.output_text.delta","delta":"<svg/></html>"}\n\n'))
        upRes.emit('end')
      }
      return upReq
    },
  })

  const req = makeReq({
    method: 'POST',
    headers: { authorization: `Bearer ${ticket.secret}`, accept: 'text/event-stream' },
    body: JSON.stringify({ model: 'gpt-6-astra', input: 'draw pelican', stream: true }),
  })
  const res = makeRes()

  const handled = await handler(req, res, `/api/manxue-bridge/${ticket.nonce}/responses`)
  assert.equal(handled, true)
  assert.equal(res.statusCode, 200)
  assert.equal(capturedUpstreamOpts.headers['x-kin-vm'], 'vm-pin-7')
  assert.equal(capturedUpstreamOpts.headers.authorization, 'Bearer master-secret')
  assert.equal(bridge.getCapturedText(ticket.nonce), '<html><svg/></html>')

  // Replay with same ticket fails (maxUses: 1 exhausted)
  const req2 = makeReq({
    method: 'POST',
    headers: { authorization: `Bearer ${ticket.secret}` },
    body: JSON.stringify({ model: 'gpt-6-astra', input: 'replay' }),
  })
  const res2 = makeRes()
  await handler(req2, res2, `/api/manxue-bridge/${ticket.nonce}/responses`)
  assert.equal(res2.statusCode, 404)
  bridge.stop()
})
