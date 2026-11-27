import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { localSessions, notifications, people, settingsAudit, setupState } from '../src/db/schema.js'
import { createAdmin } from '../src/local/break-glass.js'
import { newTotpSecret, totpCodeAt } from '../src/local/totp.js'
import { masterKey, type MasterKeyLoad } from '../src/settings/crypto.js'
import { SettingsStore } from '../src/settings/store.js'
import { runAdmin } from '../src/yoda-admin.js'
import { startFakeOidc, type FakeOidc } from './fake-oidc.js'
import { resetDb, testDb, testDeps } from './helpers.js'
import { signToken } from './jwt.js'

// Task 10 hardening of /recovery (installer proposal §7.4, §12 T4/T10): status-only sessions with a wrong master
// key, granting and revoking portal admin, forced recovery mode, the admin banner's activity, and a failed apply.
// Placeholder passwords only.

const KEY = masterKey(Buffer.alloc(32, 0x5a))
const WRONG = masterKey(Buffer.alloc(32, 0x5b))
const ok = (k: typeof KEY): MasterKeyLoad => ({ status: 'ok', key: k })
const BG_LOGIN = 'river-copper-lantern-71'
const UA = { 'user-agent': 'vitest-browser' }
const quiet = () => ({ warn: vi.fn(), info: vi.fn() })

let app: FastifyInstance
let store: SettingsStore
let clock: Date
let seed: string
let channel: string

async function boot(opts: { key?: MasterKeyLoad; env?: NodeJS.ProcessEnv } = {}) {
  await app?.close()
  const db = await testDb()
  await db.update(setupState).set({ setupCompletedAt: sql`now()`, setupCompletedSource: 'setup' }).where(eq(setupState.id, 1))
  store = await SettingsStore.open({ db, env: { PORTAL_URL: 'https://portal.example.org', ...opts.env }, masterKey: opts.key ?? ok(KEY), log: quiet(), channel })
  const deps = await testDeps()
  app = await buildApp({ ...deps, config: { ...deps.config, devSkipSetup: false }, settings: store, outbound: { allowLoopback: true }, now: () => clock })
}

const cookieOf = (res: LightMyRequestResponse, name: string) => {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`))
  return raw ? raw.split(';')[0]! : null
}

async function withAdmin() {
  seed = newTotpSecret()
  await createAdmin({ db: await testDb(), settings: store }, { username: 'admin', password: BG_LOGIN, totp: { seed, step: Math.floor(clock.getTime() / 30_000) - 10 }, now: clock })
}

const bearer = async (username: string) => ({ authorization: `Bearer ${await signToken({ sub: `sub-${username}`, preferred_username: username, name: username, groups: ['/it-dev'] })}` })

/** A portal person (admin when `admin`), created by their first sign-in. */
async function person(username: string, admin = false) {
  await app.inject({ url: '/me', headers: await bearer(username) })
  if (admin) await (await testDb()).update(people).set({ isAdmin: true }).where(eq(people.username, username))
}

async function bg(over: Record<string, unknown> = {}) {
  clock = new Date(clock.getTime() + 30_000)
  const res = await app.inject({ method: 'POST', url: '/recovery/session', headers: UA, payload: { username: 'admin', password: BG_LOGIN, totpCode: totpCodeAt(seed, clock.getTime()), ...over } })
  expect(res.statusCode, res.body).toBe(200)
  return { res, h: { ...UA, cookie: cookieOf(res, 'yoda_bg')!, 'x-yoda-csrf': res.json().csrf } }
}

const code = () => {
  clock = new Date(clock.getTime() + 30_000)
  return totpCodeAt(seed, clock.getTime())
}

beforeEach(async () => {
  await resetDb(await testDb())
  clock = new Date('2026-11-27T03:00:00Z')
  channel = `settings_test_${randomUUID().slice(0, 8)}`
})

afterEach(async () => {
  await app?.close()
})

describe('wrong master key: status-only recovery sessions (7.4)', () => {
  it('after reset-break-glass the temporary password still opens status, and a new password can be set', async () => {
    await boot()
    await withAdmin()
    await boot({ key: ok(WRONG) })
    const out: string[] = []
    const r = await runAdmin(['reset-break-glass'], { db: await testDb(), settings: store, config: app.deps.config, tokenFile: null, jobs: { send: async () => {} }, now: () => clock, out: (l) => out.push(l), err: () => {} })
    expect(r).toBe(0)
    const temp = /^ {2}(\S+)$/m.exec(out.join('\n'))![1]!
    const { res, h } = await bg({ password: temp, totpCode: undefined })
    expect(res.json()).toMatchObject({ restricted: true, statusOnly: true, admin: { mustChangePassword: true } })
    expect((await app.inject({ url: '/recovery/status', headers: h })).json().masterKey.status).toBe('mismatch')
    const pw = await app.inject({ method: 'POST', url: '/recovery/password', headers: h, payload: { newPassword: 'quartz-meadow-falcon-88' } })
    expect(pw.json()).toMatchObject({ restricted: true, statusOnly: true, admin: { mustChangePassword: false } })
    expect((await app.inject({ method: 'POST', url: '/recovery/totp/start', headers: h })).json()).toEqual({ error: 'secrets_unavailable' })
  })

  it('a password-only session stays status-only when the key starts working in the running core, then ends', async () => {
    await boot()
    await withAdmin()
    await boot({ key: ok(WRONG) })
    const { res, h } = await bg({ totpCode: undefined })
    expect(res.json()).toMatchObject({ restricted: true, statusOnly: true })
    const [row] = await (await testDb()).select().from(localSessions)
    expect(row!.data).toMatchObject({ statusOnly: true })
    // The lost-key reset makes this process's key the master key (live, no restart).
    const r = await runAdmin(['reset-master-key', '--yes'], { db: await testDb(), settings: store, config: app.deps.config, tokenFile: null, jobs: { send: async () => {} }, masterKey: ok(WRONG), now: () => clock, out: () => {}, err: () => {} })
    expect(r).toBe(0)
    await store.load()
    expect(store.keyStatus).toBe('ok')
    // reset-master-key ends every session; an old cookie re-planted in the table would still not be trusted.
    await (await testDb()).insert(localSessions).values(row!)
    expect((await app.inject({ method: 'POST', url: '/recovery/fun-mode/off', headers: h })).statusCode).toBe(401)
    expect(await (await testDb()).select().from(localSessions)).toHaveLength(0)
  })

  it('with the right key, an enrolment-restricted session still gets no status (unchanged)', async () => {
    await boot()
    seed = newTotpSecret()
    await createAdmin({ db: await testDb(), settings: store }, { username: 'admin', password: BG_LOGIN, totp: null, now: clock })
    const { res, h } = await bg({ totpCode: undefined })
    expect(res.json()).toMatchObject({ restricted: true, statusOnly: false })
    expect((await app.inject({ url: '/recovery/status', headers: h })).json()).toEqual({ error: 'forbidden', reason: 'enrolment_required' })
  })
})

describe('portal admins from /recovery (T4)', () => {
  it('grants an existing person at once and revokes; step-up, audited, admins told', async () => {
    await boot()
    await person('boss', true)
    await person('nurse1')
    await withAdmin()
    const { h } = await bg()
    expect((await app.inject({ url: '/recovery/admins', headers: h })).json()).toMatchObject({ admins: [{ username: 'boss' }], preGranted: [] })
    expect((await app.inject({ method: 'POST', url: '/recovery/admins', headers: h, payload: { username: 'nurse1', totpCode: '000000' } })).json()).toEqual({ error: 'invalid_code' })
    const granted = (await app.inject({ method: 'POST', url: '/recovery/admins', headers: h, payload: { username: 'nurse1', totpCode: code() } })).json()
    expect(granted.admins.map((a: { username: string }) => a.username)).toEqual(['boss', 'nurse1'])
    // Also pre-granted: the same username under another identity provider (a new subject) is admin too.
    expect(granted.preGranted).toEqual(['nurse1'])
    expect((await app.inject({ url: '/me', headers: await bearer('nurse1') })).json().isAdmin).toBe(true)
    const revoked = (await app.inject({ method: 'POST', url: '/recovery/admins/revoke', headers: h, payload: { username: 'nurse1', totpCode: code() } })).json()
    expect(revoked.admins.map((a: { username: string }) => a.username)).toEqual(['boss'])
    expect(revoked.preGranted).toEqual([])
    expect((await app.inject({ url: '/me', headers: await bearer('nurse1') })).json().isAdmin).toBe(false)
    const db = await testDb()
    const actions = (await db.select().from(settingsAudit)).map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining(['recovery.admin_grant', 'recovery.admin_revoke']))
    const alerts = await db.select().from(notifications).where(eq(notifications.kind, 'security_alert'))
    expect(alerts.some((n) => n.title.includes('nurse1'))).toBe(true)
  })

  it('pre-grants an unknown username (oidc.bootstrapAdmins, source recovery) and revokes the pre-grant', async () => {
    await boot()
    await withAdmin()
    const { h } = await bg()
    const g = (await app.inject({ method: 'POST', url: '/recovery/admins', headers: h, payload: { username: 'new.admin', totpCode: code() } })).json()
    expect(g).toMatchObject({ admins: [], preGranted: ['new.admin'], preGrantLocked: false })
    expect(store.get('oidc.bootstrapAdmins')).toEqual(['new.admin'])
    expect(store.info('oidc.bootstrapAdmins')).toMatchObject({ source: 'db', writeSource: 'recovery' })
    const r = (await app.inject({ method: 'POST', url: '/recovery/admins/revoke', headers: h, payload: { username: 'new.admin', totpCode: code() } })).json()
    expect(r.preGranted).toEqual([])
    // The settings UI still cannot write it.
    await expect(store.set('oidc.bootstrapAdmins', ['x'], { label: 'สมชาย', source: 'ui' })).rejects.toThrow(/locked/)
  })

  it('revoking the last portal admin needs an explicit confirmation', async () => {
    await boot()
    await person('boss', true)
    await withAdmin()
    const { h } = await bg()
    expect((await app.inject({ method: 'POST', url: '/recovery/admins/revoke', headers: h, payload: { username: 'boss', totpCode: code() } })).json()).toEqual({ error: 'invalid_state', reason: 'last_admin' })
    expect((await app.inject({ url: '/me', headers: await bearer('boss') })).json().isAdmin).toBe(true)
    const ok = await app.inject({ method: 'POST', url: '/recovery/admins/revoke', headers: h, payload: { username: 'boss', totpCode: code(), confirmLastAdmin: true } })
    expect(ok.json().admins).toEqual([])
  })

  it('a pre-grant is refused while BOOTSTRAP_ADMINS is set in env (existing people are still granted)', async () => {
    await boot({ env: { BOOTSTRAP_ADMINS: 'boss' } })
    await person('nurse1')
    await withAdmin()
    const { h } = await bg()
    const known = (await app.inject({ method: 'POST', url: '/recovery/admins', headers: h, payload: { username: 'nurse1', totpCode: code() } })).json()
    expect(known).toMatchObject({ preGranted: ['boss'], preGrantLocked: true })
    expect(known.admins.map((a: { username: string }) => a.username)).toContain('nurse1')
    expect((await app.inject({ url: '/recovery/admins', headers: h })).json().preGrantLocked).toBe(true)
    const res = await app.inject({ method: 'POST', url: '/recovery/admins', headers: h, payload: { username: 'new.admin', totpCode: code() } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'setting_locked', envName: 'BOOTSTRAP_ADMINS' })
  })
})

describe('forced recovery mode and the admin banner (7.4)', () => {
  it('yoda-admin recovery on closes the portal API (503), keeps /recovery and public-config; off opens it again', async () => {
    await boot()
    await person('boss', true)
    await withAdmin()
    const cli = (argv: string[]) => runAdmin(argv, { db: app.deps.db, settings: store, config: app.deps.config, tokenFile: null, jobs: { send: async () => {} }, now: () => clock, out: () => {}, err: () => {} })
    expect(await cli(['recovery', 'on'])).toBe(0)
    expect((await app.inject({ url: '/me', headers: await bearer('boss') })).json()).toEqual({ error: 'recovery_mode' })
    expect((await app.inject({ url: '/public-config' })).json()).toMatchObject({ recovery: true, recoveryForced: true })
    const { h } = await bg()
    expect((await app.inject({ url: '/recovery/status', headers: h })).json().masterKey.recovery).toBe(true)
    expect(await cli(['recovery', 'off'])).toBe(0)
    expect((await app.inject({ url: '/me', headers: await bearer('boss') })).statusCode).toBe(200)
  })

  it('/admin/recovery-activity says when a break-glass session is open (admins only)', async () => {
    await boot()
    await person('boss', true)
    await person('nurse1')
    await withAdmin()
    expect((await app.inject({ url: '/admin/recovery-activity', headers: await bearer('boss') })).json()).toEqual({ active: false, username: null, since: null })
    expect((await app.inject({ url: '/admin/recovery-activity', headers: await bearer('nurse1') })).statusCode).toBe(403)
    const { h } = await bg()
    expect((await app.inject({ url: '/admin/recovery-activity', headers: await bearer('boss') })).json()).toMatchObject({ active: true, username: 'admin' })
    // Idle for 15 minutes: no longer open.
    clock = new Date(clock.getTime() + 16 * 60_000)
    expect((await app.inject({ url: '/admin/recovery-activity', headers: await bearer('boss') })).json().active).toBe(false)
    // Signed out: gone.
    clock = new Date(clock.getTime() - 16 * 60_000)
    await app.inject({ method: 'DELETE', url: '/recovery/session', headers: h })
    expect(await (await testDb()).select().from(localSessions)).toHaveLength(0)
  })
})

describe('OIDC apply that fails (CARRY e)', () => {
  let idp: FakeOidc
  beforeEach(async () => {
    idp = await startFakeOidc()
  })
  afterEach(() => idp.stop())

  it('puts back the pending change and the rollback snapshot from before', async () => {
    await boot()
    await person('boss', true)
    await withAdmin()
    const { h } = await bg()
    const stageAndTest = async (clientId: string) => {
      await app.inject({ method: 'PUT', url: '/recovery/oidc/pending', headers: h, payload: { issuer: idp.issuer, clientId, jwksUrl: null } })
      const s = await app.inject({ method: 'POST', url: '/recovery/oidc/signin', headers: h })
      const back = idp.authorize(s.json().authorizeUrl, { username: 'boss' })
      expect((await app.inject({ method: 'POST', url: '/recovery/oidc/callback', headers: h, payload: back })).json().ok).toBe(true)
    }
    await stageAndTest('yoda-portal')
    const first = (await app.inject({ method: 'POST', url: '/recovery/oidc/apply', headers: h })).json()
    const rollback = first.oidc.rollback
    expect(rollback).not.toBeNull()
    await stageAndTest('yoda-portal')
    const spy = vi.spyOn(store, 'apply').mockRejectedValueOnce(new Error('database went away'))
    const res = await app.inject({ method: 'POST', url: '/recovery/oidc/apply', headers: h })
    expect(res.statusCode).toBe(500)
    spy.mockRestore()
    const [st] = await (await testDb()).select().from(setupState)
    expect(st!.oidcPending).toMatchObject({ values: { issuer: idp.issuer }, testedUsername: 'boss' })
    expect(st!.oidcRollback).toEqual(rollback)
  })
})
