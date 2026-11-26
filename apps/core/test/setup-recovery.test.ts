import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { departmentSettings, localAdmins, localRecoveryCodes, localSessions, notifications, settings, settingsAudit, setupState } from '../src/db/schema.js'
import { createAdmin } from '../src/local/break-glass.js'
import { burnSetupToken, issueSetupToken } from '../src/local/setup-token.js'
import { newTotpSecret, totpCodeAt } from '../src/local/totp.js'
import { masterKey, type MasterKeyLoad } from '../src/settings/crypto.js'
import { SettingsStore } from '../src/settings/store.js'
import { runAdmin } from '../src/yoda-admin.js'
import { startFakeOidc, type FakeOidc } from './fake-oidc.js'
import { resetDb, testDb, testDeps } from './helpers.js'
import { signToken } from './jwt.js'

// Setup mode, the setup token, the break-glass admin and /recovery against the test database (installer proposal
// §4.1, §7, §8). Placeholder passwords only.

const KEY: MasterKeyLoad = { status: 'ok', key: masterKey(Buffer.alloc(32, 0x5a)) }
const BG_LOGIN = 'river-copper-lantern-71'
const UA = { 'user-agent': 'vitest-browser' }
const quiet = () => ({ warn: vi.fn(), info: vi.fn() })

let app: FastifyInstance
let store: SettingsStore
let clock: Date
let dir: string
let tokenFile: string
let logged: string[]

/** Boots core against the test database. `done`: setup is finished (the recovery tests). */
async function boot(opts: { done?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const db = await testDb()
  if (opts.done) await db.update(setupState).set({ setupCompletedAt: sql`now()`, setupCompletedSource: 'setup' }).where(eq(setupState.id, 1))
  store = await SettingsStore.open({ db, env: { PORTAL_URL: 'https://portal.example.org', ...opts.env }, masterKey: KEY, log: quiet(), channel: `settings_test_${randomUUID().slice(0, 8)}` })
  const deps = await testDeps()
  app = await buildApp({
    ...deps,
    config: { ...deps.config, devSkipSetup: false, bootstrapAdmins: ['boss'] },
    settings: store,
    outbound: { allowLoopback: true },
    now: () => clock,
    setupTokenFile: tokenFile,
  })
}

const cookieOf = (res: LightMyRequestResponse, name: string) => {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`))
  return raw ? raw.split(';')[0]! : null
}

beforeEach(async () => {
  await resetDb(await testDb())
  clock = new Date('2026-11-27T03:00:00Z')
  dir = mkdtempSync(join(tmpdir(), 'yoda-setup-'))
  tokenFile = join(dir, 'setup-token')
  logged = []
})

afterEach(async () => {
  await app?.close()
})

const db = () => testDb()

async function issue() {
  return issueSetupToken(await db(), { file: tokenFile, now: clock, log: (l) => logged.push(l) })
}

/** A setup session: cookie and CSRF token. */
async function setupSession(): Promise<{ cookie: string; csrf: string }> {
  const { token } = await issue()
  const res = await app.inject({ method: 'POST', url: '/setup/session', headers: UA, payload: { token } })
  expect(res.statusCode).toBe(200)
  return { cookie: cookieOf(res, 'yoda_setup')!, csrf: res.json().csrf }
}

describe('setup mode', () => {
  it('serves only /setup, /public-config, /health and /ready until setup is done', async () => {
    await boot()
    const token = await signToken({ sub: 'u1', preferred_username: 'boss' })
    for (const url of ['/me', '/projects', '/admin/settings', '/recovery/status']) {
      const res = await app.inject({ url, headers: { authorization: `Bearer ${token}` } })
      expect(res.statusCode, url).toBe(503)
      expect(res.json()).toEqual({ error: 'setup_required' })
    }
    expect((await app.inject({ method: 'POST', url: '/recovery/session', payload: { username: 'x', password: 'y' } })).statusCode).toBe(503)
    for (const url of ['/health', '/public-config', '/setup/status']) expect((await app.inject({ url })).statusCode, url).toBe(200)
  })

  it('once setup is done, every /setup route is 404 and the portal APIs answer again', async () => {
    await boot({ done: true })
    for (const [method, url] of [['GET', '/setup/status'], ['POST', '/setup/session'], ['POST', '/setup/admin']] as const) {
      expect((await app.inject({ method, url, payload: {} })).statusCode, url).toBe(404)
    }
    const token = await signToken({ sub: 'u1', preferred_username: 'boss' })
    expect((await app.inject({ url: '/me', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200)
  })
})

describe('setup token', () => {
  it('is stored as a hash only, written to a 0600 file and printed once in a banner', async () => {
    await boot()
    const { token, expiresAt } = await issue()
    const [st] = await (await db()).select().from(setupState)
    expect(st!.setupTokenHash).toHaveLength(32)
    expect(st!.setupTokenExpires!.getTime()).toBe(clock.getTime() + 24 * 3_600_000)
    expect(expiresAt).toEqual(st!.setupTokenExpires)
    expect(JSON.stringify(st)).not.toContain(token)
    expect(readFileSync(tokenFile, 'utf8').trim()).toBe(token)
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
    expect(logged.join('\n')).toContain(token)
  })

  it('is single use, expires after 24 hours, and a new one (a restart) replaces the old', async () => {
    await boot()
    const d = await db()
    const a = await issue()
    expect(await burnSetupToken(d, a.token.toLowerCase(), clock)).toBe(true)
    expect(await burnSetupToken(d, a.token, clock)).toBe(false)
    const b = await issue()
    expect(await burnSetupToken(d, b.token, new Date(clock.getTime() + 24 * 3_600_000 + 1))).toBe(false)
    const c = await issue()
    const restart = await issue()
    expect(await burnSetupToken(d, c.token, clock)).toBe(false)
    expect(await burnSetupToken(d, restart.token, clock)).toBe(true)
  })

  it('exchanging it sets the setup cookie (HttpOnly, SameSite=Strict, /api/setup) and returns the CSRF token', async () => {
    await boot()
    const { token } = await issue()
    const res = await app.inject({ method: 'POST', url: '/setup/session', headers: { ...UA, 'x-forwarded-proto': 'https' }, payload: { token } })
    expect(res.statusCode).toBe(200)
    const set = String(res.headers['set-cookie'])
    expect(set).toMatch(/^yoda_setup=[A-Za-z0-9_-]{43}; Path=\/api\/setup; Max-Age=86400; HttpOnly; SameSite=Strict; Secure$/)
    expect(res.json()).toMatchObject({ insecure: false, csrf: expect.any(String) })
    // Plain HTTP (D8): allowed, without Secure, and said so.
    const again = await issue()
    const plain = await app.inject({ method: 'POST', url: '/setup/session', headers: UA, payload: { token: again.token } })
    expect(String(plain.headers['set-cookie'])).not.toContain('Secure')
    expect(plain.json().insecure).toBe(true)
    const audits = await (await db()).select().from(settingsAudit).where(eq(settingsAudit.action, 'setup.session'))
    expect(audits.map((a) => a.result)).toEqual(['ok', 'ok'])
  })

  it('a wrong token is 401 and audited; the sixth try from one address in 15 minutes is 429', async () => {
    await boot()
    await issue()
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'POST', url: '/setup/session', payload: { token: 'AAAA-BBBB-CCCC-DDDD-EEEE' } })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ error: 'invalid_credentials' })
    }
    const limited = await app.inject({ method: 'POST', url: '/setup/session', payload: { token: 'AAAA-BBBB-CCCC-DDDD-EEEE' } })
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['retry-after']).toBeDefined()
    const other = await app.inject({ method: 'POST', url: '/setup/session', remoteAddress: '10.1.2.3', payload: { token: 'AAAA-BBBB-CCCC-DDDD-EEEE' } })
    expect(other.statusCode).toBe(401)
    const audits = await (await db()).select().from(settingsAudit).where(eq(settingsAudit.action, 'setup.session'))
    expect(audits.every((a) => a.result === 'invalid_token')).toBe(true)
  })

  it('status issues a new token when the last one was used and its session ended', async () => {
    await boot()
    const { cookie, csrf } = await setupSession()
    logged = []
    vi.spyOn(console, 'log').mockImplementation((l: string) => void logged.push(l))
    // A live session: no new token.
    await app.inject({ url: '/setup/status', headers: { ...UA, cookie } })
    expect(logged).toEqual([])
    await app.inject({ method: 'DELETE', url: '/setup/session', headers: { ...UA, cookie, 'x-yoda-csrf': csrf } })
    const res = await app.inject({ url: '/setup/status' })
    expect(res.json()).toMatchObject({ required: true, session: false, totpRequired: true, steps: { admin: 'todo' } })
    expect(logged.join('\n')).toContain('Yoda setup')
    expect(readFileSync(tokenFile, 'utf8').trim()).toMatch(/^[A-Z2-9-]{24}$/)
    vi.restoreAllMocks()
  })
})

describe('setup: the break-glass admin', () => {
  it('needs the setup cookie, the same user agent and the CSRF header', async () => {
    await boot()
    const { cookie, csrf } = await setupSession()
    const body = { username: 'admin', password: BG_LOGIN }
    expect((await app.inject({ method: 'POST', url: '/setup/admin', headers: UA, payload: body })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/setup/admin', headers: { ...UA, cookie }, payload: body })).json()).toEqual({ error: 'csrf_failed' })
    expect((await app.inject({ method: 'POST', url: '/setup/admin', headers: { ...UA, cookie, 'x-yoda-csrf': 'wrong' }, payload: body })).statusCode).toBe(403)
    const origin = await app.inject({ method: 'POST', url: '/setup/admin', headers: { ...UA, cookie, 'x-yoda-csrf': csrf, origin: 'https://evil.example.org' }, payload: body })
    expect(origin.json()).toEqual({ error: 'csrf_failed' })
    const otherUa = await app.inject({ method: 'POST', url: '/setup/admin', headers: { 'user-agent': 'other', cookie, 'x-yoda-csrf': csrf }, payload: body })
    expect(otherUa.statusCode).toBe(401)
  })

  it('requires TOTP when the public URL is not localhost (D3), then creates the admin with 10 recovery codes', async () => {
    await boot()
    const { cookie, csrf } = await setupSession()
    const h = { ...UA, cookie, 'x-yoda-csrf': csrf }
    const weak = await app.inject({ method: 'POST', url: '/setup/admin', headers: h, payload: { username: 'admin', password: 'admin-password-long' } })
    expect(weak.json()).toEqual({ error: 'weak_password', reason: 'contains_username' })
    const noTotp = await app.inject({ method: 'POST', url: '/setup/admin', headers: h, payload: { username: 'admin', password: BG_LOGIN } })
    expect(noTotp.json()).toEqual({ error: 'second_factor_required' })
    const enrol = (await app.inject({ method: 'POST', url: '/setup/totp', headers: h })).json()
    expect(enrol.uri).toMatch(/^otpauth:\/\/totp\//)
    const wrong = await app.inject({ method: 'POST', url: '/setup/admin', headers: h, payload: { username: 'admin', password: BG_LOGIN, totpCode: '000000' } })
    expect(wrong.json()).toEqual({ error: 'invalid_code' })
    const ok = await app.inject({ method: 'POST', url: '/setup/admin', headers: h, payload: { username: 'Admin', password: BG_LOGIN, totpCode: totpCodeAt(enrol.secret, clock.getTime()) } })
    expect(ok.statusCode).toBe(200)
    const body = ok.json()
    expect(body).toMatchObject({ username: 'admin', totpEnabled: true })
    expect(body.recoveryCodes).toHaveLength(10)
    const [admin] = await (await db()).select().from(localAdmins)
    expect(admin!.passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/)
    expect(admin!.totpSecret!.toString('utf8')).not.toContain(enrol.secret)
    const codes = await (await db()).select().from(localRecoveryCodes)
    expect(codes).toHaveLength(10)
    const dump = JSON.stringify(codes.map((c) => c.codeHash.toString('hex'))) + JSON.stringify(admin)
    for (const c of body.recoveryCodes as string[]) expect(dump).not.toContain(c)
    expect((await app.inject({ url: '/setup/status', headers: { ...UA, cookie } })).json().steps.admin).toBe('done')
    // The setup session is rotated after the TOTP step: the old cookie is over, the new one carries on.
    expect((await app.inject({ url: '/setup/session', headers: { ...UA, cookie } })).statusCode).toBe(401)
    const next = cookieOf(ok, 'yoda_setup')!
    expect(next).not.toBe(cookie)
    expect((await app.inject({ url: '/setup/session', headers: { ...UA, cookie: next } })).json().csrf).toBe(body.session.csrf)
  })

  it('TOTP is optional on a localhost install', async () => {
    await boot({ env: { PORTAL_URL: 'http://localhost:3000' } })
    const { cookie, csrf } = await setupSession()
    const res = await app.inject({ method: 'POST', url: '/setup/admin', headers: { ...UA, cookie, 'x-yoda-csrf': csrf }, payload: { username: 'admin', password: BG_LOGIN } })
    expect(res.json()).toMatchObject({ username: 'admin', totpEnabled: false })
  })
})

// ── Recovery ─────────────────────────────────────────────────────────────────────────────────────────────────

let seed: string
let codes: string[]

async function withAdmin(opts: { totp?: boolean } = {}) {
  seed = newTotpSecret()
  const step = Math.floor(clock.getTime() / 30_000) - 10
  const r = await createAdmin({ db: await db(), settings: store }, { username: 'admin', password: BG_LOGIN, totp: opts.totp === false ? null : { seed, step }, now: clock })
  codes = r.codes
}

/** A boss person (portal admin) to be notified. */
async function boss() {
  const token = await signToken({ sub: 'sub-boss', preferred_username: 'boss', name: 'Boss', email: 'boss@example.org', groups: [] })
  const res = await app.inject({ url: '/me', headers: { authorization: `Bearer ${token}` } })
  return res.json().id as string
}

async function signInBg(over: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/recovery/session',
    headers: { ...UA, ...headers },
    payload: { username: 'admin', password: BG_LOGIN, totpCode: totpCodeAt(seed, clock.getTime()), ...over },
  })
}

async function bg(): Promise<Record<string, string>> {
  const res = await signInBg()
  expect(res.statusCode).toBe(200)
  return { ...UA, cookie: cookieOf(res, 'yoda_bg')!, 'x-yoda-csrf': res.json().csrf }
}

describe('recovery sign-in', () => {
  it('password + TOTP opens a yoda_bg session (HttpOnly, SameSite=Strict, /api/recovery, 1 h); audited; admins notified', async () => {
    await boot({ done: true })
    const bossId = await boss()
    await withAdmin()
    const res = await signInBg({}, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.168.5.6' })
    expect(res.statusCode).toBe(200)
    expect(String(res.headers['set-cookie'])).toMatch(/^yoda_bg=[A-Za-z0-9_-]{43}; Path=\/api\/recovery; Max-Age=3600; HttpOnly; SameSite=Strict; Secure$/)
    expect(res.json()).toMatchObject({ admin: { username: 'admin', totpEnabled: true, recoveryCodesLeft: 10 }, restricted: false, insecure: false })
    const [audit] = await (await db()).select().from(settingsAudit).where(eq(settingsAudit.action, 'recovery.signin'))
    expect(audit).toMatchObject({ actorLabel: 'break-glass:admin', source: 'recovery', result: 'ok', ip: '192.168.5.6' })
    const notes = await (await db()).select().from(notifications).where(eq(notifications.personId, bossId))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ kind: 'security_alert', link: '/admin/settings/security' })
    expect(notes[0]!.body).toContain('192.168.5.6')
  })

  it('refuses a replayed TOTP code, takes a recovery code once, and asks for a second factor', async () => {
    await boot({ done: true })
    await withAdmin()
    expect((await signInBg()).statusCode).toBe(200)
    const replay = await signInBg()
    expect(replay.json()).toEqual({ error: 'invalid_code' })
    expect((await signInBg({ totpCode: undefined })).json()).toEqual({ error: 'second_factor_required' })
    const code = codes[0]!.toLowerCase().replace(/-/g, ' ')
    expect((await signInBg({ totpCode: undefined, recoveryCode: code })).statusCode).toBe(200)
    expect((await signInBg({ totpCode: undefined, recoveryCode: codes[0] }, { 'x-forwarded-for': '10.0.0.9' })).json()).toEqual({ error: 'invalid_code' })
    const [used] = await (await db()).select({ n: sql<number>`count(*)::int` }).from(localRecoveryCodes).where(sql`${localRecoveryCodes.usedAt} is not null`)
    expect(used!.n).toBe(1)
  })

  it('a wrong password and an unknown user get the same answer; 5 failures lock the account with backoff', async () => {
    await boot({ done: true })
    await withAdmin()
    const tries = async (username: string, n: number) => {
      const out: number[] = []
      for (let i = 0; i < n; i++) {
        const res = await app.inject({ method: 'POST', url: '/recovery/session', remoteAddress: `10.9.${i}.${username.length}`, headers: UA, payload: { username, password: 'wrong-password-xyz' } })
        out.push(res.statusCode)
      }
      return out
    }
    expect(await tries('admin', 5)).toEqual([401, 401, 401, 401, 401])
    expect(await tries('ghost', 5)).toEqual([401, 401, 401, 401, 401])
    const locked = await signInBg({}, { 'x-forwarded-for': '10.8.8.8' })
    expect(locked.statusCode).toBe(429)
    expect(locked.json()).toMatchObject({ error: 'rate_limited', reason: 'locked', retryAfter: 60 })
    const ghost = await app.inject({ method: 'POST', url: '/recovery/session', remoteAddress: '10.7.7.7', headers: UA, payload: { username: 'ghost', password: BG_LOGIN } })
    expect(ghost.json()).toMatchObject({ error: 'rate_limited', reason: 'locked', retryAfter: 60 })
    clock = new Date(clock.getTime() + 61_000)
    expect((await signInBg({}, { 'x-forwarded-for': '10.8.8.9' })).statusCode).toBe(200)
    const [row] = await (await db()).select().from(localAdmins)
    expect(row).toMatchObject({ failedAttempts: 0, lockedUntil: null })
  })

  it('limits sign-ins to 5 per address per 15 minutes', async () => {
    await boot({ done: true })
    await withAdmin()
    const codes: number[] = []
    for (let i = 0; i < 6; i++) codes.push((await app.inject({ method: 'POST', url: '/recovery/session', headers: UA, payload: { username: `user${i}`, password: 'x' } })).statusCode)
    expect(codes).toEqual([401, 401, 401, 401, 401, 429])
  })

  it('ends after 15 minutes idle and after 1 hour in any case', async () => {
    await boot({ done: true })
    await withAdmin()
    const h = await bg()
    clock = new Date(clock.getTime() + 14 * 60_000)
    expect((await app.inject({ url: '/recovery/status', headers: h })).statusCode).toBe(200)
    clock = new Date(clock.getTime() + 16 * 60_000)
    expect((await app.inject({ url: '/recovery/status', headers: h })).json()).toEqual({ error: 'unauthorized', reason: 'session' })
    const h2 = await bg()
    for (let i = 0; i < 5; i++) {
      clock = new Date(clock.getTime() + 13 * 60_000)
      await app.inject({ url: '/recovery/status', headers: h2 })
    }
    expect((await app.inject({ url: '/recovery/status', headers: h2 })).statusCode).toBe(401)
  })

  it('needs the CSRF header on every non-GET call', async () => {
    await boot({ done: true })
    await withAdmin()
    const { 'x-yoda-csrf': _csrf, ...noCsrf } = await bg()
    for (const [method, url] of [['POST', '/recovery/fun-mode/off'], ['PUT', '/recovery/oidc/pending'], ['POST', '/recovery/oidc/apply'], ['DELETE', '/recovery/session']] as const) {
      const res = await app.inject({ method, url, headers: noCsrf, payload: {} })
      expect(res.statusCode, url).toBe(403)
    }
  })

  it('a break-glass session reaches no portal API', async () => {
    await boot({ done: true })
    await withAdmin()
    const h = await bg()
    for (const url of ['/me', '/projects', '/admin/settings', '/admin/ai-settings', '/notifications', '/runners', '/people']) {
      const res = await app.inject({ url, headers: h })
      expect(res.statusCode, url).toBe(401)
    }
    expect((await app.inject({ method: 'PUT', url: '/admin/settings/signin', headers: h, payload: { changes: { 'oidc.staffGroup': '/x' } } })).statusCode).toBe(401)
    // Nor do /setup routes (404 once setup is done).
    expect((await app.inject({ method: 'POST', url: '/setup/admin', headers: h, payload: {} })).statusCode).toBe(404)
  })
})

describe('recovery actions', () => {
  it('shows status, switches fun mode off (audited, notified)', async () => {
    await boot({ done: true })
    await boss()
    await withAdmin()
    const h = await bg()
    const st = (await app.inject({ url: '/recovery/status', headers: h })).json()
    expect(st).toMatchObject({ masterKey: { status: 'ok', recovery: false }, setup: 'done', funMode: true, oidc: { pending: null, rollback: null }, breakGlass: { username: 'admin', recoveryCodesLeft: 10 } })
    const off = (await app.inject({ method: 'POST', url: '/recovery/fun-mode/off', headers: h })).json()
    expect(off.funMode).toBe(false)
    const [dept] = await (await db()).select().from(departmentSettings)
    expect(dept!.funMode).toBe(false)
    expect((await (await db()).select().from(notifications)).length).toBe(2)
  })

  it('new recovery codes need the current TOTP code and replace the old ones', async () => {
    await boot({ done: true })
    await withAdmin()
    const h = await bg()
    expect((await app.inject({ method: 'POST', url: '/recovery/recovery-codes', headers: h, payload: {} })).json()).toEqual({ error: 'second_factor_required' })
    clock = new Date(clock.getTime() + 30_000)
    const res = await app.inject({ method: 'POST', url: '/recovery/recovery-codes', headers: h, payload: { totpCode: totpCodeAt(seed, clock.getTime()) } })
    expect(res.json().recoveryCodes).toHaveLength(10)
    clock = new Date(clock.getTime() + 30_000)
    expect((await signInBg({ totpCode: undefined, recoveryCode: codes[1] }, { 'x-forwarded-for': '10.3.3.3' })).json()).toEqual({ error: 'invalid_code' })
    expect((await signInBg({ totpCode: undefined, recoveryCode: res.json().recoveryCodes[0] }, { 'x-forwarded-for': '10.3.3.4' })).statusCode).toBe(200)
  })

  it('a password change needs the current second factor and ends other sessions', async () => {
    await boot({ done: true })
    await withAdmin()
    const h = await bg()
    clock = new Date(clock.getTime() + 30_000)
    const other = await bg()
    expect((await app.inject({ method: 'POST', url: '/recovery/password', headers: h, payload: { newPassword: 'quartz-meadow-falcon-88' } })).json()).toEqual({ error: 'second_factor_required' })
    clock = new Date(clock.getTime() + 30_000)
    const ok = await app.inject({ method: 'POST', url: '/recovery/password', headers: h, payload: { newPassword: 'quartz-meadow-falcon-88', recoveryCode: codes[2] } })
    expect(ok.statusCode).toBe(200)
    expect((await app.inject({ url: '/recovery/status', headers: other })).statusCode).toBe(401)
    expect((await app.inject({ url: '/recovery/status', headers: h })).statusCode).toBe(200)
  })

  it('re-enrols TOTP after a code of the new seed and the current factor', async () => {
    await boot({ done: true })
    await withAdmin()
    const h = await bg()
    const enrol = (await app.inject({ method: 'POST', url: '/recovery/totp/start', headers: h })).json()
    clock = new Date(clock.getTime() + 30_000)
    const noCurrent = await app.inject({ method: 'POST', url: '/recovery/totp/confirm', headers: h, payload: { code: totpCodeAt(enrol.secret, clock.getTime()) } })
    expect(noCurrent.json()).toEqual({ error: 'second_factor_required' })
    const ok = await app.inject({ method: 'POST', url: '/recovery/totp/confirm', headers: h, payload: { code: totpCodeAt(enrol.secret, clock.getTime()), currentTotpCode: totpCodeAt(seed, clock.getTime()) } })
    expect(ok.statusCode).toBe(200)
    clock = new Date(clock.getTime() + 30_000)
    // Every session of the account ended (this one rotated): the old cookie is over, the returned one works.
    expect((await app.inject({ url: '/recovery/status', headers: h })).statusCode).toBe(401)
    expect((await app.inject({ url: '/recovery/status', headers: { ...UA, cookie: cookieOf(ok, 'yoda_bg')! } })).statusCode).toBe(200)
    expect(ok.json().recoveryCodes).toBeUndefined()
    expect((await signInBg({}, { 'x-forwarded-for': '10.4.4.4' })).json()).toEqual({ error: 'invalid_code' })
    expect((await signInBg({ totpCode: totpCodeAt(enrol.secret, clock.getTime()) }, { 'x-forwarded-for': '10.4.4.5' })).statusCode).toBe(200)
  })

  it('wrong step-up codes count as failures: the fifth ends the session and locks the account; admins are told', async () => {
    await boot({ done: true })
    const bossId = await boss()
    await withAdmin()
    const h = await bg()
    const wrong = () => app.inject({ method: 'POST', url: '/recovery/recovery-codes', headers: h, payload: { totpCode: '000001' } })
    for (let i = 0; i < 4; i++) expect((await wrong()).json()).toEqual({ error: 'invalid_code' })
    const fifth = await wrong()
    expect(fifth.json()).toEqual({ error: 'unauthorized', reason: 'session' })
    expect(String(fifth.headers['set-cookie'])).toContain('Max-Age=0')
    expect((await app.inject({ url: '/recovery/status', headers: h })).statusCode).toBe(401)
    const [row] = await (await db()).select().from(localAdmins)
    expect(row!.failedAttempts).toBe(5)
    expect(row!.lockedUntil!.getTime()).toBe(clock.getTime() + 60_000)
    clock = new Date(clock.getTime() + 30_000)
    expect((await signInBg({}, { 'x-forwarded-for': '10.6.6.6' })).json()).toMatchObject({ error: 'rate_limited', reason: 'locked' })
    const titles = (await (await db()).select().from(notifications).where(eq(notifications.personId, bossId))).map((n) => n.title)
    expect(titles.some((t) => t.includes('ล็อก'))).toBe(true)
    expect((await (await db()).select().from(settingsAudit).where(eq(settingsAudit.action, 'recovery.step_up'))).length).toBe(5)
  })

  it('step-up checks are rate limited per account (10 per 15 minutes)', async () => {
    await boot({ done: true })
    await withAdmin()
    const results: number[] = []
    for (let round = 0; round < 3; round++) {
      clock = new Date(clock.getTime() + 30_000)
      const h = await bg()
      // A sign-in resets the account's failure count; the per-account limiter does not reset.
      for (let i = 0; i < 4; i++) {
        results.push((await app.inject({ method: 'POST', url: '/recovery/recovery-codes', headers: h, payload: { totpCode: '000001' } })).statusCode)
      }
    }
    expect(results).toEqual([401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 429, 429])
  })
})

describe('D3: TOTP fails closed', () => {
  it('a localhost public URL reached at another host name still needs TOTP', async () => {
    await boot({ env: { PORTAL_URL: 'http://localhost:3000' } })
    const { cookie, csrf } = await setupSession()
    const far = { ...UA, cookie, 'x-yoda-csrf': csrf, 'x-forwarded-host': 'portal.example.org' }
    expect((await app.inject({ url: '/setup/status', headers: { 'x-forwarded-host': 'portal.example.org' } })).json().totpRequired).toBe(true)
    expect((await app.inject({ url: '/setup/status' })).json().totpRequired).toBe(false)
    const res = await app.inject({ method: 'POST', url: '/setup/admin', headers: far, payload: { username: 'admin', password: BG_LOGIN } })
    expect(res.json()).toEqual({ error: 'second_factor_required' })
  })

  it('an unset public URL (the registry default) counts as not localhost', async () => {
    const d = await db()
    store = await SettingsStore.open({ db: d, env: {}, masterKey: KEY, log: quiet(), channel: `settings_test_${randomUUID().slice(0, 8)}` })
    const deps = await testDeps()
    app = await buildApp({ ...deps, config: { ...deps.config, devSkipSetup: false }, settings: store, now: () => clock, setupTokenFile: tokenFile })
    expect((await app.inject({ url: '/setup/status' })).json().totpRequired).toBe(true)
  })
})

describe('recovery: changing the OIDC settings (8.6)', () => {
  let idp: FakeOidc
  beforeEach(async () => {
    idp = await startFakeOidc()
  })
  afterEach(() => idp.stop())

  async function signInThrough(h: Record<string, string>, username = 'boss') {
    const start = await app.inject({ method: 'POST', url: '/recovery/oidc/signin', headers: h })
    expect(start.statusCode).toBe(200)
    const back = idp.authorize(start.json().authorizeUrl, { username })
    return app.inject({ method: 'POST', url: '/recovery/oidc/callback', headers: h, payload: back })
  }

  it('stages, refuses Apply until a test sign-in passes, applies, then rolls back within 7 days', async () => {
    await boot({ done: true })
    await boss()
    await withAdmin()
    const h = await bg()
    const before = store.get('oidc.issuer')
    expect(before).toBeUndefined()
    const staged = await app.inject({ method: 'PUT', url: '/recovery/oidc/pending', headers: h, payload: { issuer: `${idp.issuer}/`, clientId: 'yoda-portal', jwksUrl: null } })
    expect(staged.json().oidc.pending).toMatchObject({ values: { issuer: idp.issuer, clientId: 'yoda-portal', jwksUrl: null }, testedAt: null })
    // Nothing changed yet.
    expect(store.get('oidc.issuer')).toBeUndefined()
    expect((await app.inject({ method: 'POST', url: '/recovery/oidc/apply', headers: h })).json()).toEqual({ error: 'invalid_state', reason: 'not_tested' })
    const check = (await app.inject({ method: 'POST', url: '/recovery/oidc/check', headers: h })).json()
    expect(check.checks.map((c: { id: string }) => c.id)).toEqual(['discovery', 'jwks', 'client'])
    // A sign-in as someone who is not a portal admin does not count.
    const notAdmin = (await signInThrough(h, 'nurse1')).json()
    expect(notAdmin.ok).toBe(false)
    expect(notAdmin.checks.find((c: { id: string }) => c.id === 'admin')).toMatchObject({ ok: false, code: 'not_admin' })
    const passed = (await signInThrough(h)).json()
    expect(passed.ok).toBe(true)
    expect(passed.pending).toMatchObject({ testedUsername: 'boss' })
    // The flow is single use.
    expect((await app.inject({ method: 'POST', url: '/recovery/oidc/callback', headers: h, payload: { code: 'x', state: 'y' } })).json()).toEqual({ error: 'invalid_state', reason: 'no_signin' })

    const applied = (await app.inject({ method: 'POST', url: '/recovery/oidc/apply', headers: h })).json()
    expect(applied.oidc.current.issuer).toBe(idp.issuer)
    expect(applied.oidc.pending).toBeNull()
    expect(applied.oidc.rollback).toMatchObject({ values: { issuer: before ?? null } })
    expect(store.get('oidc.issuer')).toBe(idp.issuer)
    const [row] = await (await db()).select().from(settings).where(eq(settings.key, 'oidc.issuer'))
    expect(row).toMatchObject({ source: 'recovery', updatedByLabel: 'break-glass:admin' })
    const actions = (await (await db()).select().from(settingsAudit)).map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining(['oidc.stage', 'test', 'oidc.apply_pending', 'set']))

    const rolled = (await app.inject({ method: 'POST', url: '/recovery/oidc/rollback', headers: h })).json()
    expect(rolled.oidc.rollback).toBeNull()
    expect(store.info('oidc.issuer').source).not.toBe('db')
    expect((await (await db()).select().from(settingsAudit).where(eq(settingsAudit.action, 'oidc.rollback'))).length).toBe(1)
  })

  it('a test sign-in does not mark values restaged meanwhile as tested', async () => {
    await boot({ done: true })
    await boss()
    await withAdmin()
    const h = await bg()
    const values = { issuer: idp.issuer, clientId: 'yoda-portal', jwksUrl: null }
    await app.inject({ method: 'PUT', url: '/recovery/oidc/pending', headers: h, payload: values })
    const start = await app.inject({ method: 'POST', url: '/recovery/oidc/signin', headers: h })
    const back = idp.authorize(start.json().authorizeUrl, { username: 'boss' })
    clock = new Date(clock.getTime() + 1000)
    await app.inject({ method: 'PUT', url: '/recovery/oidc/pending', headers: h, payload: values })
    const res = await app.inject({ method: 'POST', url: '/recovery/oidc/callback', headers: h, payload: back })
    expect(res.json()).toEqual({ error: 'invalid_state', reason: 'pending_changed' })
    expect((await app.inject({ url: '/recovery/status', headers: h })).json().oidc.pending.testedAt).toBeNull()
  })

  it('the rollback closes after 7 days', async () => {
    await boot({ done: true })
    await boss()
    await withAdmin()
    const h = await bg()
    await app.inject({ method: 'PUT', url: '/recovery/oidc/pending', headers: h, payload: { issuer: idp.issuer, clientId: 'yoda-portal', jwksUrl: null } })
    expect((await signInThrough(h)).json().ok).toBe(true)
    expect((await app.inject({ method: 'POST', url: '/recovery/oidc/apply', headers: h })).statusCode).toBe(200)
    clock = new Date(clock.getTime() + 7 * 24 * 3_600_000 + 1000)
    clock = new Date(clock.getTime() + 30_000)
    const h2 = await bg()
    expect((await app.inject({ url: '/recovery/status', headers: h2 })).json().oidc.rollback).toBeNull()
    expect((await app.inject({ method: 'POST', url: '/recovery/oidc/rollback', headers: h2 })).json()).toEqual({ error: 'invalid_state', reason: 'no_rollback' })
  })

  it('an issuer set in env cannot be staged', async () => {
    await boot({ done: true, env: { OIDC_ISSUER: 'https://sso.example.org/realms/hospital' } })
    await withAdmin()
    const h = await bg()
    const res = await app.inject({ method: 'PUT', url: '/recovery/oidc/pending', headers: h, payload: { issuer: idp.issuer, clientId: 'yoda-portal', jwksUrl: null } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'setting_locked', key: 'oidc.issuer', envName: 'OIDC_ISSUER' })
  })
})

describe('yoda-admin', () => {
  const cli = async (argv: string[]) => {
    const out: string[] = []
    const err: string[] = []
    const code = await runAdmin(argv, {
      db: await db(),
      settings: store,
      config: { ...app.deps.config },
      tokenFile,
      jobs: { send: async () => {} },
      now: () => clock,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }

  it('setup-token prints the current token from the file, or a new one with --new or when none is valid', async () => {
    await boot()
    const first = await cli(['setup-token'])
    expect(first.code).toBe(0)
    const token = readFileSync(tokenFile, 'utf8').trim()
    expect(first.out).toContain(token)
    const again = await cli(['setup-token'])
    expect(again.out).toContain(token)
    const fresh = await cli(['setup-token', '--new'])
    const next = readFileSync(tokenFile, 'utf8').trim()
    expect(next).not.toBe(token)
    expect(fresh.out).toContain(next)
    expect(await burnSetupToken(await db(), token, clock)).toBe(false)
    expect(await burnSetupToken(await db(), next, clock)).toBe(true)
    // Used: the next call issues a new one.
    expect((await cli(['setup-token'])).out).not.toContain(next)
    const status = await cli(['status'])
    expect(status.out).toContain('setup: required')
    expect(status.out).toContain('setup token: valid until')
  })

  it('setup-token refuses once setup is done', async () => {
    await boot({ done: true })
    const r = await cli(['setup-token'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('already done')
  })

  it('reset-break-glass prints a temporary password, ends sessions, forces a new password and TOTP; audited and notified', async () => {
    await boot({ done: true })
    await boss()
    await withAdmin()
    const h = await bg()
    const r = await cli(['reset-break-glass'])
    expect(r.code).toBe(0)
    const temp = /^ {2}(\S+)$/m.exec(r.out)![1]!
    expect((await (await db()).select().from(localSessions)).length).toBe(0)
    expect((await app.inject({ url: '/recovery/status', headers: h })).statusCode).toBe(401)
    const [audit] = await (await db()).select().from(settingsAudit).where(eq(settingsAudit.action, 'break_glass.reset'))
    expect(audit).toMatchObject({ source: 'cli', actorLabel: 'cli' })
    expect(JSON.stringify(audit)).not.toContain(temp)
    expect((await (await db()).select().from(notifications).where(eq(notifications.kind, 'security_alert'))).length).toBe(2)

    // Password only (TOTP was removed); the session is restricted until the reset is finished.
    const res = await signInBg({ password: temp, totpCode: undefined }, { 'x-forwarded-for': '10.5.5.5' })
    expect(res.json()).toMatchObject({ restricted: true, admin: { mustChangePassword: true, mustEnrolTotp: true, totpEnabled: false } })
    const rh = { ...UA, cookie: cookieOf(res, 'yoda_bg')!, 'x-yoda-csrf': res.json().csrf }
    expect((await app.inject({ url: '/recovery/status', headers: rh })).json()).toEqual({ error: 'forbidden', reason: 'enrolment_required' })
    const pw = await app.inject({ method: 'POST', url: '/recovery/password', headers: rh, payload: { newPassword: 'quartz-meadow-falcon-88' } })
    expect(pw.json()).toMatchObject({ restricted: true, admin: { mustChangePassword: false, mustEnrolTotp: true } })
    const enrol = (await app.inject({ method: 'POST', url: '/recovery/totp/start', headers: rh })).json()
    const done = await app.inject({ method: 'POST', url: '/recovery/totp/confirm', headers: rh, payload: { code: totpCodeAt(enrol.secret, clock.getTime()) } })
    expect(done.json()).toMatchObject({ restricted: false, admin: { totpEnabled: true } })
    // Finishing the reset hands out new recovery codes (the old ones were dropped by the reset).
    expect(done.json().recoveryCodes).toHaveLength(10)
    // The session was rotated: the old cookie is over, the new one works.
    expect((await app.inject({ url: '/recovery/status', headers: rh })).statusCode).toBe(401)
    const nh = { ...UA, cookie: cookieOf(done, 'yoda_bg')!, 'x-yoda-csrf': done.json().csrf }
    expect((await app.inject({ url: '/recovery/status', headers: nh })).json().breakGlass.recoveryCodesLeft).toBe(10)
    clock = new Date(clock.getTime() + 30_000)
    seed = enrol.secret
    expect((await signInBg({ password: 'quartz-meadow-falcon-88', totpCode: undefined, recoveryCode: codes[0] }, { 'x-forwarded-for': '10.5.5.6' })).json()).toEqual({ error: 'invalid_code' })
    expect((await cli(['status'])).out).toMatch(/break-glass: admin, TOTP on/)
  })

  it('reset-break-glass without an account says so', async () => {
    await boot({ done: true })
    expect((await cli(['reset-break-glass'])).code).toBe(1)
    expect((await cli(['nope'])).err).toContain('usage: yoda-admin')
  })
})
