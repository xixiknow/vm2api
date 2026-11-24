import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROFILE_PREFIX,
  createCodexLoginProfiles,
  normalizeTotpSecret,
  publicProfile,
} from '../../src/lib/oauth/codex-login-profiles.mjs'

function memorySettings() {
  const store = new Map()
  return {
    store,
    get: (key, fallback = null) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
    set: (key, value) => store.set(key, structuredClone(value)),
    remove: (key) => store.delete(key),
    all: () => Object.fromEntries([...store].map(([k, v]) => [k, structuredClone(v)])),
  }
}

function withDbSecret(t, value) {
  const prev = process.env.VM2API_DB_SECRET
  if (value == null) delete process.env.VM2API_DB_SECRET
  else process.env.VM2API_DB_SECRET = value
  t.after(() => {
    if (prev === undefined) delete process.env.VM2API_DB_SECRET
    else process.env.VM2API_DB_SECRET = prev
  })
}

test('login details are encrypted at rest and only flags reach the panel', (t) => {
  withDbSecret(t, 'profile-test-secret')
  const settings = memorySettings()
  const profiles = createCodexLoginProfiles({ settings, now: () => Date.UTC(2026, 10, 24) })
  const saved = profiles.save('vm-1', { email: ' User@Example.com ', password: 'PW-SECRET', totp_secret: 'abcd efgh' })
  assert.equal(saved.ok, true)
  const raw = settings.store.get(`${PROFILE_PREFIX}vm-1`)
  assert.equal(raw.email, 'user@example.com')
  assert.match(raw.password, /^enc:v1:/)
  assert.match(raw.totp, /^enc:v1:/)
  assert.ok(!JSON.stringify(raw).includes('PW-SECRET'))
  assert.deepEqual(profiles.secrets('vm-1'), {
    ok: true,
    email: 'user@example.com',
    password: 'PW-SECRET',
    mfa_secret: 'abcdefgh',
  })
  const view = publicProfile(profiles.get('vm-1'))
  assert.equal(view.password_set, true)
  assert.equal(view.totp_set, true)
  assert.equal(view.secret_unreadable, false)
  assert.equal(view.auto_relogin, true)
  assert.ok(!JSON.stringify(view).includes('enc:v1:'))
  assert.equal(profiles.findByEmail('USER@example.com').vm_id, 'vm-1')
  assert.equal(profiles.list().length, 1)
})

test('blank fields keep secrets, a new email drops them, and new secrets lift a pause', (t) => {
  withDbSecret(t, 'profile-test-secret')
  const profiles = createCodexLoginProfiles({ settings: memorySettings() })
  profiles.save('vm-1', { email: 'a@example.com', password: 'one', totp_secret: 'TOTP1' })
  profiles.patchState('vm-1', { auto_paused: 'too_many_failures', relogin_fail_streak: 3 })
  assert.equal(profiles.save('vm-1', { auto_relogin: false }).ok, true)
  assert.equal(profiles.secrets('vm-1').password, 'one')
  assert.equal(profiles.get('vm-1').auto_relogin, false)
  assert.equal(profiles.get('vm-1').state.auto_paused, 'too_many_failures')

  profiles.save('vm-1', { password: 'two' })
  assert.equal(profiles.secrets('vm-1').password, 'two')
  assert.equal(profiles.secrets('vm-1').mfa_secret, 'TOTP1')
  assert.equal(profiles.get('vm-1').state.auto_paused, null)
  assert.equal(profiles.get('vm-1').state.relogin_fail_streak, 0)

  assert.equal(profiles.save('vm-1', { email: 'b@example.com' }).error, 'password_required')
  assert.equal(profiles.save('vm-1', { email: 'b@example.com', password: 'three' }).ok, true)
  assert.equal(profiles.secrets('vm-1').mfa_secret, '')
  assert.equal(profiles.save('vm-1', { totp_secret: 'NEW' }).ok, true)
  assert.equal(profiles.save('vm-1', { totp_clear: true }).ok, true)
  assert.equal(profiles.get('vm-1').totp, null)
  assert.equal(profiles.save('vm-2', { email: 'not-an-email', password: 'x' }).error, 'invalid_email')
})

test('saving secrets requires a DB secret, and a rotated key reads as unreadable', (t) => {
  withDbSecret(t, null)
  const settings = memorySettings()
  const profiles = createCodexLoginProfiles({ settings })
  assert.equal(profiles.save('vm-1', { email: 'a@example.com', password: 'x' }).error, 'encryption_required')

  process.env.VM2API_DB_SECRET = 'first-key'
  assert.equal(profiles.save('vm-1', { email: 'a@example.com', password: 'x', totp_secret: 'y' }).ok, true)
  process.env.VM2API_DB_SECRET = 'second-key'
  assert.deepEqual(profiles.secrets('vm-1'), { ok: false, error: 'secret_unreadable' })
  assert.equal(publicProfile(profiles.get('vm-1')).secret_unreadable, true)
  assert.deepEqual(profiles.secrets('missing'), { ok: false, error: 'profile_missing' })

  profiles.setAutoRelogin('vm-1', false)
  assert.equal(profiles.get('vm-1').auto_relogin, false)
  profiles.remove('vm-1')
  assert.equal(profiles.get('vm-1'), null)
})

test('otpauth URIs are kept and base32 groups are joined', () => {
  assert.equal(normalizeTotpSecret(' JBSW Y3DP '), 'JBSWY3DP')
  assert.equal(normalizeTotpSecret('otpauth://totp/x?secret=ABC'), 'otpauth://totp/x?secret=ABC')
})
