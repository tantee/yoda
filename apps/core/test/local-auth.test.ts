import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODE_ALPHABET, normaliseCode, passwordIssue } from '@yoda/shared'
import type { FastifyRequest } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp, trustProxy, type AppDeps } from '../src/app.js'
import type { Db } from '../src/db/client.js'
import { isLocalhostHost, isLocalhostUrl, lockoutMs, totpRequired, UnknownUserGuard } from '../src/local/break-glass.js'
import { newRecoveryCode, newSetupToken, recoveryCodeHash, sameBytes, setupTokenHash } from '../src/local/codes.js'
import { finishTestSignIn, recoveryRedirectUri, startTestSignIn } from '../src/local/oidc-change.js'
import { ARGON2_PARAMS, hashPassword, verifyPassword } from '../src/local/password.js'
import { COOKIE_NAME, COOKIE_PATH, csrfFor, parseCookies, setSessionCookie, clearSessionCookie } from '../src/local/session.js'
import { readTokenFile, setupTokenBanner, setupTokenFile, writeTokenFile } from '../src/local/setup-token.js'
import { newTotpSecret, totpCodeAt, totpUri, verifyTotp } from '../src/local/totp.js'
import { masterKey } from '../src/settings/crypto.js'
import type { SettingsStore } from '../src/settings/store.js'
import { startFakeOidc, type FakeOidc } from './fake-oidc.js'
import { testConfig } from './helpers.js'
import { localJwks } from './jwt.js'

// Break-glass and setup building blocks without a database (the database flows are in setup-recovery.test.ts).

const MK = masterKey(Buffer.alloc(32, 0x31))
const OTHER = masterKey(Buffer.alloc(32, 0x32))

describe('setup token and recovery codes', () => {
  it('a setup token is 5 groups of 4 from the 32-symbol alphabet (100 bits), all different', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newSetupToken()))
    expect(tokens.size).toBe(200)
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/)
      for (const c of t.replace(/-/g, '')) expect(CODE_ALPHABET).toContain(c)
    }
    expect(CODE_ALPHABET).toHaveLength(32)
    for (const c of '01IO') expect(CODE_ALPHABET).not.toContain(c)
  })

  it('compares tokens case- and dash-insensitively, by SHA-256 only', () => {
    const t = 'ABCD-EFGH-JKLM-NPQR-STUV'
    expect(normaliseCode(' abcd efgh-jklm npqr-stuv ')).toBe('ABCDEFGHJKLMNPQRSTUV')
    expect(sameBytes(setupTokenHash(t), setupTokenHash('abcdefghjklmnpqrstuv'))).toBe(true)
    expect(sameBytes(setupTokenHash(t), setupTokenHash('ABCD-EFGH-JKLM-NPQR-STUW'))).toBe(false)
    expect(setupTokenHash(t)).toHaveLength(32)
    expect(setupTokenHash(t).toString('hex')).not.toContain(Buffer.from(t).toString('hex'))
    expect(sameBytes(null, setupTokenHash(t))).toBe(false)
  })

  it('a recovery code is 16 symbols (80 bits), stored as an HMAC under a master-key-derived key (R2)', () => {
    const code = newRecoveryCode()
    expect(code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/)
    const h = recoveryCodeHash(MK, code)
    expect(h).toHaveLength(32)
    expect(sameBytes(h, recoveryCodeHash(MK, code.toLowerCase().replace(/-/g, ' ')))).toBe(true)
    // Another master key gives another hash: a dump alone cannot be checked against guesses.
    expect(sameBytes(h, recoveryCodeHash(OTHER, code))).toBe(false)
    expect(sameBytes(h, recoveryCodeHash(MK, newRecoveryCode()))).toBe(false)
  })
})

describe('break-glass password (argon2id, R1)', () => {
  it('hashes with m = 64 MiB, t = 3, p = 1 and verifies', async () => {
    const hash = await hashPassword('correct horse battery staple 42')
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/)
    expect(ARGON2_PARAMS).toMatchObject({ memoryCost: 65536, timeCost: 3, parallelism: 1 })
    expect(await verifyPassword(hash, 'correct horse battery staple 42')).toBe(true)
    expect(await verifyPassword(hash, 'correct horse battery staple 43')).toBe(false)
    expect(await verifyPassword('not-a-phc-string', 'x')).toBe(false)
  })

  it('an unknown username still runs a full argon2id verify (same cost), and never passes', async () => {
    const hash = await hashPassword('correct horse battery staple 42')
    await verifyPassword(null, 'warm up the dummy hash')
    const time = async (fn: () => Promise<unknown>) => {
      const t0 = performance.now()
      await fn()
      return performance.now() - t0
    }
    const known = await time(() => verifyPassword(hash, 'wrong password here!'))
    const unknown = await time(() => verifyPassword(null, 'correct horse battery staple 42'))
    expect(await verifyPassword(null, 'yoda-break-glass-dummy-password')).toBe(false)
    // Both are a 64 MiB argon2 verify: the same order of magnitude, never a fast path.
    expect(unknown).toBeGreaterThan(known / 4)
    expect(unknown).toBeGreaterThan(10)
  })

  it('refuses short, simple and username-bearing passwords', () => {
    expect(passwordIssue('admin', 'short')).toBe('too_short')
    expect(passwordIssue('admin', 'aaaaaaaaaaaaaaaaaaa')).toBe('too_simple')
    expect(passwordIssue('admin', 'my-Admin-password-2026')).toBe('contains_username')
    expect(passwordIssue('admin', 'river-copper-lantern-71')).toBeNull()
  })
})

describe('TOTP (otpauth, R6)', () => {
  const secret = newTotpSecret()
  const t0 = Date.UTC(2026, 10, 26, 3, 0, 15)

  it('accepts the current code and one step of drift, and reports the step', () => {
    const step = Math.floor(t0 / 30_000)
    expect(verifyTotp(secret, totpCodeAt(secret, t0), { now: t0 })).toBe(step)
    expect(verifyTotp(secret, totpCodeAt(secret, t0 - 30_000), { now: t0 })).toBe(step - 1)
    expect(verifyTotp(secret, totpCodeAt(secret, t0 + 30_000), { now: t0 })).toBe(step + 1)
    expect(verifyTotp(secret, totpCodeAt(secret, t0 - 90_000), { now: t0 })).toBeNull()
    expect(verifyTotp(secret, '000000', { now: t0 })).toBeNull()
    expect(verifyTotp(newTotpSecret(), totpCodeAt(secret, t0), { now: t0 })).toBeNull()
  })

  it('refuses a code of the step already used, or an earlier one (replay)', () => {
    const step = Math.floor(t0 / 30_000)
    expect(verifyTotp(secret, totpCodeAt(secret, t0), { now: t0, after: step })).toBeNull()
    expect(verifyTotp(secret, totpCodeAt(secret, t0 - 30_000), { now: t0, after: step - 1 })).toBeNull()
    expect(verifyTotp(secret, totpCodeAt(secret, t0), { now: t0, after: step - 1 })).toBe(step)
  })

  it('builds the otpauth URI for the QR code', () => {
    const uri = totpUri(secret, 'admin')
    expect(uri).toMatch(/^otpauth:\/\/totp\/Yoda:admin\?/)
    expect(uri).toContain(`secret=${secret}`)
    expect(uri).toContain('issuer=Yoda')
  })
})

describe('lockout and localhost', () => {
  it('backs off exponentially after 5 failures, capped at an hour', () => {
    expect([1, 4].map(lockoutMs)).toEqual([0, 0])
    expect(lockoutMs(5)).toBe(60_000)
    expect(lockoutMs(6)).toBe(120_000)
    expect(lockoutMs(8)).toBe(480_000)
    expect(lockoutMs(30)).toBe(3_600_000)
  })

  it('locks unknown usernames like real ones', () => {
    const g = new UnknownUserGuard()
    for (let i = 0; i < 4; i++) g.fail('ghost', 1000)
    expect(g.lockedFor('ghost', 1000)).toBe(0)
    g.fail('ghost', 1000)
    expect(g.lockedFor('ghost', 1000)).toBe(60_000)
    expect(g.lockedFor('ghost', 61_001)).toBe(0)
    expect(g.lockedFor('other', 1000)).toBe(0)
  })

  it('treats only localhost, 127/8 and ::1 as localhost (D3); a missing URL is not', () => {
    for (const u of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'http://portal.localhost']) expect(isLocalhostUrl(u), u).toBe(true)
    for (const u of ['https://portal.example.org', 'http://192.168.1.10:3000', 'http://localhost.example.org', 'nonsense', '', undefined, null]) expect(isLocalhostUrl(u), String(u)).toBe(false)
    expect(isLocalhostHost('localhost')).toBe(true)
    expect(isLocalhostHost('[::1]')).toBe(true)
    expect(isLocalhostHost(null)).toBe(false)
    expect(isLocalhostHost('portal.example.org')).toBe(false)
  })

  it('TOTP is optional only when the saved public URL AND the request host are both localhost (fail closed)', () => {
    const store = (source: 'env' | 'db' | 'default' | 'unset', value?: string) => ({ info: () => ({ source, value }) }) as unknown as SettingsStore
    expect(totpRequired(store('env', 'http://localhost:3000'), 'localhost')).toBe(false)
    expect(totpRequired(store('db', 'http://127.0.0.1:3000'), '127.0.0.1')).toBe(false)
    // A localhost URL reached at another host name, a remote URL reached at localhost (tunnel), no request host.
    expect(totpRequired(store('env', 'http://localhost:3000'), 'portal.example.org')).toBe(true)
    expect(totpRequired(store('env', 'https://portal.example.org'), 'localhost')).toBe(true)
    expect(totpRequired(store('env', 'http://localhost:3000'), null)).toBe(true)
    // The registry default (http://localhost:3000) is not a choice: unset counts as not localhost.
    expect(totpRequired(store('default', 'http://localhost:3000'), 'localhost')).toBe(true)
    expect(totpRequired(store('unset'), 'localhost')).toBe(true)
  })
})

describe('session cookies and CSRF', () => {
  const reply = () => {
    const headers: Record<string, string> = {}
    return { headers, header: (k: string, v: string) => ((headers[k] = v), undefined) } as never as { headers: Record<string, string>; header(k: string, v: string): void }
  }

  it('the recovery cookie is HttpOnly, SameSite=Strict, scoped to /api/recovery, 1 h, Secure over HTTPS', () => {
    const r = reply()
    setSessionCookie(r as never, 'recovery', 'cookie-value', true)
    expect(r.headers['set-cookie']).toBe('yoda_bg=cookie-value; Path=/api/recovery; Max-Age=3600; HttpOnly; SameSite=Strict; Secure')
    expect(r.headers['cache-control']).toBe('no-store')
    const plain = reply()
    setSessionCookie(plain as never, 'recovery', 'cookie-value', false)
    expect(plain.headers['set-cookie']).not.toContain('Secure')
    const setup = reply()
    setSessionCookie(setup as never, 'setup', 'v', true)
    expect(setup.headers['set-cookie']).toMatch(/^yoda_setup=v; Path=\/api\/setup; Max-Age=86400; HttpOnly; SameSite=Strict; Secure$/)
    const cleared = reply()
    clearSessionCookie(cleared as never, 'recovery', true)
    expect(cleared.headers['set-cookie']).toContain('Max-Age=0')
    expect(COOKIE_NAME).toEqual({ setup: 'yoda_setup', recovery: 'yoda_bg' })
    expect(COOKIE_PATH).toEqual({ setup: '/api/setup', recovery: '/api/recovery' })
  })

  it('parses cookies (first wins) and derives a CSRF token that only the cookie holder can compute', () => {
    expect(parseCookies('a=1; yoda_bg=xyz; a=2')).toEqual({ a: '1', yoda_bg: 'xyz' })
    expect(parseCookies(undefined)).toEqual({})
    expect(csrfFor('cookie-a')).toBe(csrfFor('cookie-a'))
    expect(csrfFor('cookie-a')).not.toBe(csrfFor('cookie-b'))
    expect(csrfFor('cookie-a')).not.toContain('cookie-a')
  })

  it('trusts X-Forwarded-* from an internal first hop, and only as many hops as configured', () => {
    const one = trustProxy(1)
    expect(one('172.18.0.5', 0)).toBe(true)
    expect(one('127.0.0.1', 0)).toBe(true)
    expect(one('203.0.113.9', 0)).toBe(false)
    expect(one('10.0.0.2', 1)).toBe(false)
    const two = trustProxy(2)
    expect(two('172.18.0.5', 0)).toBe(true)
    expect(two('203.0.113.9', 0)).toBe(false)
    expect(two('10.0.0.2', 1)).toBe(true)
    expect(two('10.0.0.3', 2)).toBe(false)
  })

  async function ipApp(hops?: number) {
    const app = await buildApp({ config: { ...testConfig(), ...(hops ? { trustedProxyHops: hops } : {}) }, db: {} as Db, jwks: localJwks, bus: {}, storage: {}, ai: {}, jobs: {}, gitlab: null } as unknown as AppDeps)
    const seen: { ip: string; protocol: string }[] = []
    app.get('/__ip', { config: { public: true, setupMode: true } }, async (request: FastifyRequest) => {
      seen.push({ ip: request.ip, protocol: request.protocol })
      return {}
    })
    return { app, seen }
  }

  it('one hop (default): takes the address the portal appended, not one the client wrote', async () => {
    const { app, seen } = await ipApp()
    await app.inject({ url: '/__ip', headers: { 'x-forwarded-for': '6.6.6.6, 192.168.10.20', 'x-forwarded-proto': 'https' } })
    await app.inject({ url: '/__ip', remoteAddress: '203.0.113.9', headers: { 'x-forwarded-for': '6.6.6.6' } })
    expect(seen).toEqual([{ ip: '192.168.10.20', protocol: 'https' }, { ip: '203.0.113.9', protocol: 'http' }])
    await app.close()
  })

  it('two hops (reverse proxy in front of the portal): the address the reverse proxy saw; anything further left is ignored', async () => {
    const { app, seen } = await ipApp(2)
    // client wrote 6.6.6.6 and 7.7.7.7; the reverse proxy appended the client 198.51.100.7; the portal appended the proxy 10.0.0.2.
    await app.inject({ url: '/__ip', headers: { 'x-forwarded-for': '6.6.6.6, 7.7.7.7, 198.51.100.7, 10.0.0.2' } })
    // Without the reverse proxy entry (a direct hit on the portal), the client's own entry is still not enough to spoof.
    await app.inject({ url: '/__ip', headers: { 'x-forwarded-for': '10.0.0.2' } })
    await app.inject({ url: '/__ip', remoteAddress: '203.0.113.9', headers: { 'x-forwarded-for': '6.6.6.6, 10.0.0.2' } })
    expect(seen.map((s) => s.ip)).toEqual(['198.51.100.7', '10.0.0.2', '203.0.113.9'])
    await app.close()
  })

  it('a break-glass cookie is no bearer token: portal routes stay 401', async () => {
    const app = await buildApp({ config: testConfig(), db: {} as Db, jwks: localJwks, bus: {}, storage: {}, ai: {}, jobs: {}, gitlab: null } as unknown as AppDeps)
    for (const url of ['/me', '/projects', '/admin/settings', '/notifications']) {
      const res = await app.inject({ url, headers: { cookie: 'yoda_bg=anything; yoda_setup=anything', 'x-yoda-csrf': csrfFor('anything') } })
      expect(res.statusCode, url).toBe(401)
    }
    await app.close()
  })
})

describe('setup token file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yoda-setup-token-'))

  it('lives next to the master key, in the core-only directory', () => {
    expect(setupTokenFile({ YODA_MASTER_KEY_FILE: '/var/lib/yoda/core/master-key' })).toBe('/var/lib/yoda/core/setup-token')
    expect(setupTokenFile({})).toBeNull()
  })

  it('is written with mode 0600 and replaced atomically; a symlink in its place is refused', () => {
    const file = join(dir, 'setup-token')
    writeTokenFile(file, 'AAAA-BBBB-CCCC-DDDD-EEEE')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toBe('AAAA-BBBB-CCCC-DDDD-EEEE\n')
    writeTokenFile(file, 'FFFF-GGGG-HHHH-JJJJ-KKKK')
    expect(readTokenFile(file)).toBe('FFFF-GGGG-HHHH-JJJJ-KKKK')
    const target = join(dir, 'elsewhere')
    writeFileSync(target, 'x')
    const link = join(dir, 'linked')
    symlinkSync(target, link)
    expect(() => writeTokenFile(link, 'AAAA-BBBB-CCCC-DDDD-EEEE')).toThrow(/not a regular file/)
    expect(readTokenFile(link)).toBeNull()
    expect(readTokenFile(join(dir, 'missing'))).toBeNull()
  })

  it('the log banner frames the token and says how to get it again', () => {
    const b = setupTokenBanner('AAAA-BBBB-CCCC-DDDD-EEEE', new Date('2026-11-27T03:00:00Z'))
    expect(b).toContain('┌─ Yoda setup')
    expect(b).toContain('│   AAAA-BBBB-CCCC-DDDD-EEEE')
    expect(b).toContain('yoda-admin setup-token')
  })
})

describe('the pending OIDC change test sign-in (fake provider)', () => {
  let idp: FakeOidc
  const policy = { allowLoopback: true }
  const noAdmins = { execute: async () => [{ admin: false, any: false }] } as unknown as Db
  const now = () => new Date()
  const pendingFor = (over: Partial<{ clientId: string; jwksUrl: string | null }> = {}) => ({
    values: { issuer: idp.issuer, clientId: over.clientId ?? 'yoda-portal', jwksUrl: over.jwksUrl ?? null },
    stagedAt: now().toISOString(),
    stagedBy: 'break-glass:admin',
    testedAt: null,
    testedUsername: null,
  })

  beforeAll(async () => {
    idp = await startFakeOidc()
  })
  afterAll(() => idp.stop())

  it('builds a PKCE authorization request to the pending issuer, redirecting to /recovery', async () => {
    const r = await startTestSignIn(pendingFor(), { publicUrl: 'https://portal.example.org/x', policy, now: now() })
    const u = new URL(r.authorizeUrl)
    expect(u.origin + u.pathname).toBe(`${idp.issuer}/protocol/openid-connect/auth`)
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: 'yoda-portal', response_type: 'code', scope: 'openid', redirect_uri: 'https://portal.example.org/recovery', code_challenge_method: 'S256', prompt: 'login' })
    expect(u.searchParams.get('code_challenge')).not.toBe(r.data.verifier)
    expect(r.redirectUri).toBe(recoveryRedirectUri('https://portal.example.org/x'))
  })

  it('passes with a real round trip, and checks the tokens as core will', async () => {
    idp.tamper = {}
    const pending = pendingFor()
    const s = await startTestSignIn(pending, { publicUrl: 'https://portal.example.org', policy, now: now() })
    const back = idp.authorize(s.authorizeUrl, { username: 'somchai' })
    const r = await finishTestSignIn({ db: noAdmins, policy }, pending, s.data, { ...back, now: now() })
    expect(r.checks.map((c) => [c.id, c.ok])).toEqual([['state', true], ['token', true], ['jwks', true], ['id_token', true], ['access_token', true], ['admin', true]])
    expect(r).toMatchObject({ ok: true, username: 'somchai' })
  })

  it('fails on a wrong state, a reused code, a token for another client, a missing groups claim or a non-admin', async () => {
    const run = async (opts: { tamper?: FakeOidc['tamper']; state?: string; groups?: string[] | null; db?: Db; reuse?: boolean } = {}) => {
      idp.tamper = opts.tamper ?? {}
      const pending = pendingFor()
      const s = await startTestSignIn(pending, { publicUrl: 'https://portal.example.org', policy, now: now() })
      const back = idp.authorize(s.authorizeUrl, { username: 'somchai', groups: opts.groups })
      if (opts.reuse) await finishTestSignIn({ db: noAdmins, policy }, pending, s.data, { ...back, now: now() })
      return finishTestSignIn({ db: opts.db ?? noAdmins, policy }, pending, s.data, { code: back.code, state: opts.state ?? back.state, now: now() })
    }
    const failed = (r: Awaited<ReturnType<typeof run>>) => r.checks.filter((c) => !c.ok).map((c) => c.code)
    expect(failed(await run({ state: 'forged' }))).toEqual(['state_mismatch'])
    expect(failed(await run({ reuse: true }))).toEqual(['code_rejected'])
    expect(failed(await run({ tamper: { accessToken: { azp: 'another-client' } } }))).toEqual(['azp_mismatch'])
    expect(failed(await run({ tamper: { idToken: { nonce: 'other' } } }))).toEqual(['nonce_mismatch'])
    expect(failed(await run({ tamper: { idToken: { iss: 'https://evil.example.org' } } }))).toEqual(['token_invalid'])
    expect(failed(await run({ groups: null }))).toEqual(['groups_missing'])
    const otherAdmins = { execute: async () => [{ admin: false, any: true }] } as unknown as Db
    expect(failed(await run({ db: otherAdmins }))).toEqual(['not_admin'])
    expect((await run({ state: 'forged' })).ok).toBe(false)
    idp.tamper = {}
  })

  it('refuses a sign-in that started more than 10 minutes ago, or for values changed since', async () => {
    const pending = pendingFor()
    const s = await startTestSignIn(pending, { publicUrl: 'https://portal.example.org', policy, now: new Date(Date.now() - 11 * 60_000) })
    const back = idp.authorize(s.authorizeUrl, { username: 'somchai' })
    const late = await finishTestSignIn({ db: noAdmins, policy }, pending, s.data, { ...back, now: now() })
    expect(late.checks[0]).toMatchObject({ id: 'state', ok: false, code: 'expired' })
    const s2 = await startTestSignIn(pending, { publicUrl: 'https://portal.example.org', policy, now: now() })
    const back2 = idp.authorize(s2.authorizeUrl, { username: 'somchai' })
    const changed = await finishTestSignIn({ db: noAdmins, policy }, pendingFor({ clientId: 'other' }), s2.data, { ...back2, now: now() })
    expect(changed.checks[0]).toMatchObject({ id: 'state', ok: false, code: 'pending_changed' })
  })

  it('never returns a token or a server text in the result', async () => {
    const pending = pendingFor()
    const s = await startTestSignIn(pending, { publicUrl: 'https://portal.example.org', policy, now: now() })
    const back = idp.authorize(s.authorizeUrl, { username: 'somchai' })
    const r = await finishTestSignIn({ db: noAdmins, policy }, pending, s.data, { ...back, now: now() })
    expect(JSON.stringify(r)).not.toMatch(/eyJ/)
  })
})
