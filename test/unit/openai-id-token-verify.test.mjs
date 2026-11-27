import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import {
  OPENAI_OIDC_CLIENT_ID,
  OPENAI_OIDC_ISSUER,
  resetOpenAiJwksCache,
  verifyOpenAiIdToken,
} from '../../src/lib/oauth/openai-id-token-verify.mjs'

function signJwt({ header, payload, privateKey, alg }) {
  const h = Buffer.from(JSON.stringify({ alg, typ: 'JWT', ...header })).toString('base64url')
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const input = Buffer.from(`${h}.${p}`, 'ascii')
  const sig =
    alg === 'ES256'
      ? crypto.sign('sha256', input, { key: privateKey, dsaEncoding: 'ieee-p1363' })
      : crypto.sign('sha256', input, privateKey)
  return `${h}.${p}.${sig.toString('base64url')}`
}

function makeRsaKey(kid = 'rsa-1') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }
  return { jwk, privateKey }
}

function makeEcKey(kid = 'ec-1') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'ES256' }
  return { jwk, privateKey }
}

function oidcFetch(keysProvider, { jwksUri = `${OPENAI_OIDC_ISSUER}/oauth/jwks`, issuer = OPENAI_OIDC_ISSUER } = {}) {
  const counts = { discovery: 0, jwks: 0 }
  const fetchImpl = async (url) => {
    if (url.endsWith('/.well-known/openid-configuration')) {
      counts.discovery++
      return { status: 200, body: Readable.from([JSON.stringify({ issuer, jwks_uri: jwksUri })]) }
    }
    if (url === jwksUri) {
      counts.jwks++
      const keys = typeof keysProvider === 'function' ? keysProvider() : keysProvider
      return { status: 200, body: Readable.from([JSON.stringify({ keys })]) }
    }
    return { status: 404, body: Readable.from(['{}']) }
  }
  return { fetchImpl, counts }
}

function validClaims(overrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    iss: OPENAI_OIDC_ISSUER,
    aud: OPENAI_OIDC_CLIENT_ID,
    sub: 'user-sub-1',
    iat: nowSec - 10,
    exp: nowSec + 3600,
    email: 'User@Example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: 'ws_org_1' },
    ...overrides,
  }
}

test('verifies RS256 and ES256 ID tokens against discovery + JWKS and validates identity claims', async (t) => {
  t.after(resetOpenAiJwksCache)
  const rsa = makeRsaKey('rsa-k1')
  const ec = makeEcKey('ec-k1')
  const oidc = oidcFetch([rsa.jwk, ec.jwk])

  const rsaToken = signJwt({
    alg: 'RS256',
    header: { kid: 'rsa-k1' },
    payload: validClaims(),
    privateKey: rsa.privateKey,
  })
  const okRsa = await verifyOpenAiIdToken({
    idToken: rsaToken,
    expectedEmail: 'user@example.com',
    expectedAccountId: 'ws_org_1',
    fetchImpl: oidc.fetchImpl,
  })
  assert.equal(okRsa.ok, true)
  assert.equal(okRsa.email, 'user@example.com')
  assert.equal(okRsa.chatgpt_account_id, 'ws_org_1')

  const ecToken = signJwt({
    alg: 'ES256',
    header: { kid: 'ec-k1' },
    payload: validClaims({
      email: undefined,
      'https://api.openai.com/profile': { email: 'ec@example.com' },
      'https://api.openai.com/auth': { chatgpt_account_id: 'ws_personal_2' },
    }),
    privateKey: ec.privateKey,
  })
  const okEc = await verifyOpenAiIdToken({
    idToken: ecToken,
    expectedEmail: 'EC@example.com',
    expectedAccountId: null,
    fetchImpl: oidc.fetchImpl,
  })
  assert.equal(okEc.ok, true)
  assert.equal(okEc.email, 'ec@example.com')
  assert.equal(okEc.chatgpt_account_id, 'ws_personal_2')
  // Second verification hit the JWKS cache without re-fetching discovery/JWKS.
  assert.equal(oidc.counts.discovery, 1)
  assert.equal(oidc.counts.jwks, 1)
})

test('refreshes cached JWKS once when encountering a rotated kid', async (t) => {
  t.after(resetOpenAiJwksCache)
  const firstKey = makeRsaKey('kid-old')
  const rotatedKey = makeRsaKey('kid-new')
  let activeKeys = [firstKey.jwk]
  const oidc = oidcFetch(() => activeKeys)

  const tok1 = signJwt({
    alg: 'RS256',
    header: { kid: 'kid-old' },
    payload: validClaims(),
    privateKey: firstKey.privateKey,
  })
  assert.equal(
    (await verifyOpenAiIdToken({ idToken: tok1, expectedEmail: 'user@example.com', fetchImpl: oidc.fetchImpl })).ok,
    true,
  )
  activeKeys = [rotatedKey.jwk]
  const tok2 = signJwt({
    alg: 'RS256',
    header: { kid: 'kid-new' },
    payload: validClaims(),
    privateKey: rotatedKey.privateKey,
  })
  const res2 = await verifyOpenAiIdToken({
    idToken: tok2,
    expectedEmail: 'user@example.com',
    fetchImpl: oidc.fetchImpl,
  })
  assert.equal(res2.ok, true)
  assert.equal(oidc.counts.jwks, 2)
})

test('rejects tampered signatures, expired/invalid claims, bad jwks_uri, and email/workspace mismatches', async (t) => {
  t.after(resetOpenAiJwksCache)
  const rsa = makeRsaKey('rsa-check')
  const otherRsa = makeRsaKey('rsa-check')
  const oidc = oidcFetch([rsa.jwk])

  const good = signJwt({
    alg: 'RS256',
    header: { kid: 'rsa-check' },
    payload: validClaims(),
    privateKey: rsa.privateKey,
  })
  const tampered = `${good.split('.')[0]}.${Buffer.from(JSON.stringify(validClaims({ email: 'evil@x.com' }))).toString('base64url')}.${good.split('.')[2]}`
  assert.equal(
    (
      await verifyOpenAiIdToken({
        idToken: tampered,
        expectedEmail: 'evil@x.com',
        fetchImpl: oidc.fetchImpl,
        cacheTtlMs: 0,
      })
    ).error,
    'token_verification_failed',
  )

  const wrongSig = signJwt({
    alg: 'RS256',
    header: { kid: 'rsa-check' },
    payload: validClaims(),
    privateKey: otherRsa.privateKey,
  })
  assert.equal(
    (
      await verifyOpenAiIdToken({
        idToken: wrongSig,
        expectedEmail: 'user@example.com',
        fetchImpl: oidc.fetchImpl,
        cacheTtlMs: 0,
      })
    ).error,
    'token_verification_failed',
  )

  const expired = signJwt({
    alg: 'RS256',
    header: { kid: 'rsa-check' },
    payload: validClaims({ exp: Math.floor(Date.now() / 1000) - 60 }),
    privateKey: rsa.privateKey,
  })
  assert.equal(
    (
      await verifyOpenAiIdToken({
        idToken: expired,
        expectedEmail: 'user@example.com',
        fetchImpl: oidc.fetchImpl,
        cacheTtlMs: 0,
      })
    ).error,
    'token_verification_failed',
  )

  const badAud = signJwt({
    alg: 'RS256',
    header: { kid: 'rsa-check' },
    payload: validClaims({ aud: 'wrong-client' }),
    privateKey: rsa.privateKey,
  })
  assert.equal(
    (
      await verifyOpenAiIdToken({
        idToken: badAud,
        expectedEmail: 'user@example.com',
        fetchImpl: oidc.fetchImpl,
        cacheTtlMs: 0,
      })
    ).error,
    'token_verification_failed',
  )

  const badJwksOrigin = oidcFetch([rsa.jwk], { jwksUri: 'https://evil.example.com/jwks.json' })
  assert.equal(
    (
      await verifyOpenAiIdToken({
        idToken: good,
        expectedEmail: 'user@example.com',
        fetchImpl: badJwksOrigin.fetchImpl,
        cacheTtlMs: 0,
      })
    ).error,
    'token_verification_failed',
  )

  assert.equal(
    (
      await verifyOpenAiIdToken({
        idToken: good,
        expectedEmail: 'other@example.com',
        fetchImpl: oidc.fetchImpl,
        cacheTtlMs: 0,
      })
    ).error,
    'identity_mismatch',
  )
  assert.equal(
    (
      await verifyOpenAiIdToken({
        idToken: good,
        expectedEmail: 'user@example.com',
        expectedAccountId: 'ws_other',
        fetchImpl: oidc.fetchImpl,
        cacheTtlMs: 0,
      })
    ).error,
    'identity_mismatch',
  )
})
