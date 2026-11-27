import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { pgClient } from '../src/db/client.js'
import { localAdmins, localRecoveryCodes, localSessions, people, settings, settingsAudit, setupState } from '../src/db/schema.js'
import { recoveryCodeHash } from '../src/local/codes.js'
import { issueSetupToken } from '../src/local/setup-token.js'
import { totpCodeAt } from '../src/local/totp.js'
import { masterKey, type MasterKeyLoad } from '../src/settings/crypto.js'
import { SettingsStore } from '../src/settings/store.js'
import { startFakeOidc, type FakeOidc } from './fake-oidc.js'
import { resetDb, testDb, testDeps } from './helpers.js'
import { signToken } from './jwt.js'

// The setup wizard's API against the test database (installer proposal §4.2, §8.1; Task 8): settings through the
// setup session, progress, the one-time recovery kit, the claim and completion. Placeholder values only.

const KEY_BYTES = Buffer.alloc(32, 0x5a)
const MK = masterKey(KEY_BYTES)
const KEY: MasterKeyLoad = { status: 'ok', key: MK }
const BG_LOGIN = 'river-copper-lantern-71'
const UA = { 'user-agent': 'vitest-browser' }
const quiet = () => ({ warn: vi.fn(), info: vi.fn() })

let app: FastifyInstance
let store: SettingsStore
let clock: Date
let tokenFile: string
let idp: FakeOidc

async function boot(env: NodeJS.ProcessEnv = {}) {
  const db = await testDb()
  store = await SettingsStore.open({ db, env: { PORTAL_URL: 'https://portal.example.org', ...env }, masterKey: KEY, log: quiet(), channel: `settings_test_${randomUUID().slice(0, 8)}` })
  const deps = await testDeps()
  app = await buildApp({
    ...deps,
    config: { ...deps.config, devSkipSetup: false },
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
  tokenFile = join(mkdtempSync(join(tmpdir(), 'yoda-wizard-')), 'setup-token')
  idp = await startFakeOidc()
})

afterEach(async () => {
  await app?.close()
  await idp.stop()
})

const db = () => testDb()

/** A setup session's headers (cookie, CSRF). */
async function setupSession(): Promise<Record<string, string>> {
  const { token } = await issueSetupToken(await db(), { file: tokenFile, now: clock, log: () => {} })
  const res = await app.inject({ method: 'POST', url: '/setup/session', headers: UA, payload: { token } })
  expect(res.statusCode).toBe(200)
  return { ...UA, cookie: cookieOf(res, 'yoda_setup')!, 'x-yoda-csrf': res.json().csrf }
}

/** The break-glass admin through the wizard (TOTP, D3); returns the rotated session's headers. */
async function createAdmin(h: Record<string, string>): Promise<Record<string, string>> {
  const enrol = (await app.inject({ method: 'POST', url: '/setup/totp', headers: h })).json()
  const res = await app.inject({ method: 'POST', url: '/setup/admin', headers: h, payload: { username: 'admin', password: BG_LOGIN, totpCode: totpCodeAt(enrol.secret, clock.getTime()) } })
  expect(res.statusCode).toBe(200)
  return { ...UA, cookie: cookieOf(res, 'yoda_setup')!, 'x-yoda-csrf': res.json().session.csrf }
}

const put = (h: Record<string, string>, category: string, changes: Record<string, unknown>, versions?: Record<string, number>) =>
  app.inject({ method: 'PUT', url: `/setup/settings/${category}`, headers: h, payload: { changes, ...(versions ? { versions } : {}) } })

const progress = async (h: Record<string, string>) => (await app.inject({ url: '/setup/progress', headers: h })).json()

async function claimAs(h: Record<string, string>, user: { username: string; groups?: string[] | null }) {
  const start = await app.inject({ method: 'POST', url: '/setup/claim/start', headers: h })
  expect(start.statusCode).toBe(200)
  expect(start.json().redirectUri).toBe('https://portal.example.org/setup')
  const back = idp.authorize(start.json().authorizeUrl, user)
  return app.inject({ method: 'POST', url: '/setup/claim/callback', headers: h, payload: back })
}

describe('setup settings: only through the setup session', () => {
  it('needs the setup cookie and CSRF; a portal bearer token does not open them', async () => {
    await boot()
    expect((await app.inject({ url: '/setup/settings', headers: UA })).statusCode).toBe(401)
    const token = await signToken({ sub: 'u1', preferred_username: 'boss' })
    expect((await app.inject({ url: '/setup/progress', headers: { ...UA, authorization: `Bearer ${token}` } })).statusCode).toBe(401)
    const h = await setupSession()
    const noCsrf = await app.inject({ method: 'PUT', url: '/setup/settings/general', headers: { ...UA, cookie: h.cookie }, payload: { changes: { 'org.name': 'x' } } })
    expect(noCsrf.json()).toEqual({ error: 'csrf_failed' })
    // Categories outside the wizard: 404 from the route. (A path with no route at all is not a setup route, so the
    // setup-mode gate answers it 503 setup_required, like any other.)
    expect((await app.inject({ url: '/setup/settings?category=security', headers: h })).statusCode).toBe(404)
    expect((await app.inject({ url: '/setup/settings/security', headers: h })).json()).toEqual({ error: 'setup_required' })
    expect((await put(h, 'runners', { 'runners.leaseSeconds': 900 })).statusCode).toBe(404)
  })

  it('shows the sign-in settings editable (no recovery-only lock in setup), env values locked', async () => {
    await boot()
    const h = await setupSession()
    const body = (await app.inject({ url: '/setup/settings', headers: h })).json()
    const signin = body.categories.find((c: { category: string }) => c.category === 'signin')
    const issuer = signin.settings.find((s: { key: string }) => s.key === 'oidc.issuer')
    expect(issuer.locked).toBeNull()
    const general = body.categories.find((c: { category: string }) => c.category === 'general')
    expect(general.settings.find((s: { key: string }) => s.key === 'org.publicUrl').locked).toMatchObject({ reason: 'env', envName: 'PORTAL_URL' })
    const refused = await put(h, 'general', { 'org.publicUrl': 'https://other.example.org' })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ error: 'setting_locked', key: 'org.publicUrl', reason: 'env' })
  })

  it('refuses an issuer that is not Keycloak (the portal needs /realms/<realm>)', async () => {
    await boot()
    const h = await setupSession()
    const res = await put(h, 'signin', { 'oidc.issuer': 'https://login.example.org/oauth2' })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ error: 'invalid_settings', issues: [{ key: 'oidc.issuer', message: expect.stringContaining('/realms/<realm>') }] })
    expect(store.get('oidc.issuer')).toBeUndefined()
    expect((await put(h, 'signin', { 'oidc.issuer': 'https://sso.example.org/realms/hospital' })).statusCode).toBe(200)
  })

  it('refuses a plain-http public URL unless the host is this machine (D8), naming https_required', async () => {
    await boot({ PORTAL_URL: '' })
    const h = await setupSession()
    for (const url of ['http://10.0.0.5:3000', 'http://192.168.1.20', 'http://portal.example.org/', 'http://127.example.org']) {
      const res = await put(h, 'general', { 'org.name': 'Example Hospital', 'org.publicUrl': url })
      expect(res.statusCode, url).toBe(422)
      expect(res.json()).toEqual({ error: 'invalid_settings', issues: [{ key: 'org.publicUrl', message: 'https_required' }] })
    }
    // Nothing of the refused save is kept (the name neither).
    expect(store.info('org.publicUrl').source).toBe('default')
    expect(store.info('org.name').isSet).toBe(false)
    for (const url of ['http://127.0.0.1:3000', 'http://localhost:3000', 'http://[::1]:3000', 'http://yoda.localhost:3000', 'http://127.1.2.3:3000', 'https://10.0.0.5', 'https://portal.example.org']) {
      expect((await put(h, 'general', { 'org.name': 'Example Hospital', 'org.publicUrl': url })).statusCode, url).toBe(200)
    }
  })

  it('saves through the store (source setup, audited), an endpoint and its secret together', async () => {
    await boot()
    const h = await setupSession()
    expect((await put(h, 'general', { 'org.name': 'โรงพยาบาลตัวอย่าง', 'org.defaultLocale': 'th' })).statusCode).toBe(200)
    expect(store.get('org.name')).toBe('โรงพยาบาลตัวอย่าง')
    const [row] = await (await db()).select().from(settings).where(eq(settings.key, 'org.name'))
    expect(row!.source).toBe('setup')
    const audit = await (await db()).select().from(settingsAudit).where(eq(settingsAudit.key, 'org.name'))
    expect(audit[0]).toMatchObject({ actorLabel: 'setup', source: 'setup' })
    // Bound endpoint (8.6): saved against the loaded version, with its secret in the same save.
    expect((await put(h, 'email', { 'smtp.host': 'smtp.example.org' })).json()).toMatchObject({ error: 'invalid_settings', issues: [{ key: 'smtp.host', message: 'version_required' }] })
    const saved = await put(h, 'email', { 'smtp.host': 'smtp.example.org', 'smtp.password': 'placeholder-smtp-pass-1234' }, { 'smtp.host': 0 })
    expect(saved.statusCode).toBe(200)
    expect(saved.json().category.settings.find((s: { key: string }) => s.key === 'smtp.password').secretState).toMatchObject({ set: true })
    expect(JSON.stringify(saved.json())).not.toContain('placeholder-smtp-pass-1234')
    expect(store.get('smtp.password')).toBe('placeholder-smtp-pass-1234')
    // Moving the endpoint alone clears the secret bound to it.
    const moved = await put(h, 'email', { 'smtp.host': 'mail.example.org' }, { 'smtp.host': 1 })
    expect(moved.json().cleared).toEqual(['smtp.password'])
  })

  it('runs the settings tests; a passing sign-in test of the saved values marks the step', async () => {
    await boot()
    const h = await setupSession()
    expect((await progress(h)).steps.signin).toBe('todo')
    expect((await put(h, 'signin', { 'oidc.issuer': idp.issuer })).statusCode).toBe(200)
    // A draft that differs from the saved values does not count.
    const draft = await app.inject({ method: 'POST', url: '/setup/settings/signin/test', headers: h, payload: { values: { 'oidc.clientId': 'yoda-portal-2' } } })
    expect(draft.statusCode).toBe(200)
    expect((await progress(h)).steps.signin).toBe('todo')
    const res = await app.inject({ method: 'POST', url: '/setup/settings/signin/test', headers: h, payload: {} })
    expect(res.json()).toMatchObject({ action: 'oidc', ok: true })
    expect((await progress(h)).steps.signin).toBe('done')
    // Changing the values afterwards needs a new test.
    await put(h, 'signin', { 'oidc.clientId': 'yoda-portal-2' })
    expect((await progress(h)).steps.signin).toBe('todo')
    const tests = await (await db()).select().from(settingsAudit).where(eq(settingsAudit.action, 'test'))
    expect(tests.every((t) => t.source === 'setup')).toBe(true)
  })

  it('the system check reports the database, pgvector, the bucket and the queue', async () => {
    await boot()
    const h = await setupSession()
    const res = await app.inject({ method: 'POST', url: '/setup/check', headers: h })
    expect(res.statusCode).toBe(200)
    const ids = res.json().checks.map((c: { id: string }) => c.id)
    expect(ids[0]).toBe('db')
    expect(ids).toContain('pgvector')
    expect(ids.at(-1)).toBe('queue')
    expect(res.json().checks.find((c: { id: string }) => c.id === 'pgvector').ok).toBe(true)
  })
})

describe('setup progress', () => {
  it('is kept server-side: marks, then a new session (a restart, a new token) resumes', async () => {
    await boot()
    const h = await setupSession()
    const first = await progress(h)
    expect(first).toMatchObject({ steps: { token: 'done', organisation: 'todo', admin: 'todo' }, missing: ['organisation', 'admin', 'kit', 'claim'], totpRequired: true })
    await put(h, 'general', { 'org.name': 'Example Hospital' })
    await app.inject({ method: 'POST', url: '/setup/progress/step', headers: h, payload: { step: 'check', state: 'done' } })
    const marked = await app.inject({ method: 'POST', url: '/setup/progress/step', headers: h, payload: { step: 'email', state: 'skipped' } })
    expect(marked.json().steps).toMatchObject({ organisation: 'done', check: 'done', email: 'skipped' })
    expect((await app.inject({ method: 'POST', url: '/setup/progress/step', headers: h, payload: { step: 'kit', state: 'done' } })).statusCode).toBe(400)
    await app.inject({ method: 'DELETE', url: '/setup/session', headers: h })
    const again = await setupSession()
    expect((await progress(again)).steps).toMatchObject({ organisation: 'done', check: 'done', email: 'skipped' })
    const [st] = await (await db()).select().from(setupState)
    expect(JSON.stringify(st!.setupProgress)).not.toMatch(/password|secret/i)
  })
})

describe('recovery kit (D7)', () => {
  it('returns the master key and fresh recovery codes once, audited without the key; never again', async () => {
    await boot()
    const h0 = await setupSession()
    expect((await app.inject({ method: 'POST', url: '/setup/recovery-kit', headers: h0 })).json()).toEqual({ error: 'invalid_state', reason: 'no_admin' })
    const h = await createAdmin(h0)
    const res = await app.inject({ method: 'POST', url: '/setup/recovery-kit', headers: h })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const kit = res.json()
    expect(kit.filename).toMatch(/^yoda-recovery-kit-[0-9a-f]{8}\.txt$/)
    expect(kit.content).toContain(KEY_BYTES.toString('base64'))
    expect(kit.recoveryCodes).toHaveLength(10)
    for (const c of kit.recoveryCodes) expect(kit.content).toContain(c)
    // The test database and bucket are not the bundled services: their credentials stay out of the kit.
    const cfg = (await testDeps()).config
    expect(kit.content).toContain('Postgres: external service — credentials managed outside Yoda')
    expect(kit.content).not.toContain(`S3_SECRET_KEY=${cfg.s3SecretKey}`)
    expect(kit.content).not.toContain('POSTGRES_PASSWORD=')
    // The kit's codes are the ones that work (the set from the admin step is replaced).
    const rows = await (await db()).select().from(localRecoveryCodes)
    expect(rows).toHaveLength(10)
    const hashes = new Set(rows.map((r) => r.codeHash.toString('hex')))
    for (const c of kit.recoveryCodes) expect(hashes.has(recoveryCodeHash(MK, c).toString('hex'))).toBe(true)
    expect(res.headers['pragma']).toBe('no-cache')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(kit.reissued).toBe(false)
    const downloadedAt = clock.toISOString()
    expect(await progress(h)).toMatchObject({ kitDownloadedAt: downloadedAt, kitReissueUntil: new Date(clock.getTime() + 10 * 60_000).toISOString() })
    const audit = await (await db()).select().from(settingsAudit).where(eq(settingsAudit.action, 'setup.recovery_kit'))
    expect(audit).toHaveLength(1)
    expect(audit[0]!.newValue).toEqual({ keyId: MK.id, username: 'admin', reissue: false })
    expect(JSON.stringify(audit)).not.toContain(KEY_BYTES.toString('base64'))
    // The admin the kit was made for is not replaced during setup any more.
    const enrol = (await app.inject({ method: 'POST', url: '/setup/totp', headers: h })).json()
    const replace = await app.inject({ method: 'POST', url: '/setup/admin', headers: h, payload: { username: 'other', password: BG_LOGIN, totpCode: totpCodeAt(enrol.secret, clock.getTime()) } })
    expect(replace.json()).toEqual({ error: 'invalid_state', reason: 'kit_downloaded' })
  })
})

describe('recovery kit re-issue (same session, 10 minutes)', () => {
  it('is rate limited like the tests (10 a minute per address)', async () => {
    await boot()
    const h = await createAdmin(await setupSession())
    for (let i = 0; i < 10; i++) expect((await app.inject({ method: 'POST', url: '/setup/recovery-kit', headers: h })).statusCode).toBe(200)
    const limited = await app.inject({ method: 'POST', url: '/setup/recovery-kit', headers: h })
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ error: 'rate_limited' })
  })

  it('the session that downloaded it gets it again (same key, new codes, audited reissue); others and later get 409', async () => {
    await boot()
    const h = await createAdmin(await setupSession())
    const first = (await app.inject({ method: 'POST', url: '/setup/recovery-kit', headers: h })).json()
    const downloadedAt = clock.toISOString()
    clock = new Date(clock.getTime() + 9 * 60_000)
    const again = await app.inject({ method: 'POST', url: '/setup/recovery-kit', headers: h })
    expect(again.statusCode).toBe(200)
    const kit = again.json()
    expect(kit).toMatchObject({ reissued: true, downloadedAt })
    expect(kit.content).toContain(KEY_BYTES.toString('base64'))
    expect(kit.recoveryCodes).not.toEqual(first.recoveryCodes)
    // Only the new codes work.
    const hashes = new Set((await (await db()).select().from(localRecoveryCodes)).map((r) => r.codeHash.toString('hex')))
    for (const c of kit.recoveryCodes) expect(hashes.has(recoveryCodeHash(MK, c).toString('hex'))).toBe(true)
    for (const c of first.recoveryCodes) expect(hashes.has(recoveryCodeHash(MK, c).toString('hex'))).toBe(false)
    const audit = await (await db()).select().from(settingsAudit).where(eq(settingsAudit.action, 'setup.recovery_kit'))
    expect(audit.map((a) => (a.newValue as { reissue: boolean }).reissue)).toEqual([false, true])
    // Another setup session: refused, and it sees no re-issue window.
    const other = await setupSession()
    expect((await app.inject({ method: 'POST', url: '/setup/recovery-kit', headers: other })).json()).toEqual({ error: 'invalid_state', reason: 'kit_downloaded' })
    expect((await progress(other)).kitReissueUntil).toBeNull()
    // After 10 minutes from the first download: refused for this session too.
    clock = new Date(new Date(downloadedAt).getTime() + 10 * 60_000 + 1000)
    expect((await app.inject({ method: 'POST', url: '/setup/recovery-kit', headers: h })).json()).toEqual({ error: 'invalid_state', reason: 'kit_downloaded' })
    expect((await progress(h)).kitReissueUntil).toBeNull()
  })

  it('two sessions downloading at once: one gets the kit, the other 409', async () => {
    await boot()
    const a = await createAdmin(await setupSession())
    const b = await setupSession()
    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: '/setup/recovery-kit', headers: a }),
      app.inject({ method: 'POST', url: '/setup/recovery-kit', headers: b }),
    ])
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409])
    expect([r1, r2].find((r) => r.statusCode === 409)!.json()).toEqual({ error: 'invalid_state', reason: 'kit_downloaded' })
    expect(await (await db()).select().from(localRecoveryCodes)).toHaveLength(10)
    expect(await (await db()).select().from(settingsAudit).where(eq(settingsAudit.action, 'setup.recovery_kit'))).toHaveLength(1)
  })

  it('the admin step and the kit download take the same lock: no admin replacement once the kit is out', async () => {
    await boot()
    const h = await createAdmin(await setupSession())
    const enrol = (await app.inject({ method: 'POST', url: '/setup/totp', headers: h })).json()
    const [kit, replace] = await Promise.all([
      app.inject({ method: 'POST', url: '/setup/recovery-kit', headers: h }),
      app.inject({ method: 'POST', url: '/setup/admin', headers: h, payload: { username: 'other', password: BG_LOGIN, totpCode: totpCodeAt(enrol.secret, clock.getTime()) } }),
    ])
    // Either the admin was replaced first (then the kit's codes are the new admin's) or the kit came first and the
    // replacement is refused; never a kit whose codes belong to a deleted admin.
    if (replace.statusCode === 200) {
      // The kit call may also have lost its session to the rotation (401).
      expect([200, 401]).toContain(kit.statusCode)
    } else {
      expect(replace.json()).toEqual({ error: 'invalid_state', reason: 'kit_downloaded' })
    }
    const admins = await (await db()).select().from(localAdmins)
    expect(admins).toHaveLength(1)
    const codes = await (await db()).select().from(localRecoveryCodes)
    expect(codes).toHaveLength(10)
    expect(codes.every((c) => c.adminId === admins[0]!.id)).toBe(true)
  })
})

describe('claim and complete (8.1)', () => {
  async function ready() {
    await boot()
    let h = await setupSession()
    await put(h, 'general', { 'org.name': 'Example Hospital' })
    h = await createAdmin(h)
    await put(h, 'signin', { 'oidc.issuer': idp.issuer })
    return h
  }

  it('the claim signs in through OIDC and makes that person the first portal admin', async () => {
    const h = await ready()
    const outsider = await claimAs(h, { username: 'nurse1', groups: ['/ward'] })
    expect(outsider.json()).toMatchObject({ ok: false, username: null })
    expect(outsider.json().checks.find((c: { ok: boolean }) => !c.ok)).toMatchObject({ id: 'staff', code: 'not_staff' })
    expect(await (await db()).select().from(people)).toHaveLength(0)
    const res = await claimAs(h, { username: 'somchai' })
    expect(res.json()).toMatchObject({ ok: true, username: 'somchai' })
    expect(JSON.stringify(res.json())).not.toMatch(/eyJ/)
    const [p] = await (await db()).select().from(people).where(eq(people.username, 'somchai'))
    expect(p).toMatchObject({ isAdmin: true, keycloakSub: 'sub-somchai' })
    expect((await progress(h))).toMatchObject({ claimed: { username: 'somchai' }, steps: { signin: 'done', claim: 'done' } })
    // The flow is single use.
    const start = await app.inject({ method: 'POST', url: '/setup/claim/start', headers: h })
    const back = idp.authorize(start.json().authorizeUrl, { username: 'somchai' })
    await app.inject({ method: 'POST', url: '/setup/claim/callback', headers: h, payload: back })
    expect((await app.inject({ method: 'POST', url: '/setup/claim/callback', headers: h, payload: back })).json()).toEqual({ error: 'invalid_state', reason: 'no_signin' })
  })

  it('a claim by someone else takes back the admin flag the earlier claim gave; a staff group change reopens the claim', async () => {
    const h = await ready()
    await claimAs(h, { username: 'somchai' })
    expect((await claimAs(h, { username: 'dev1' })).json()).toMatchObject({ ok: true, username: 'dev1' })
    const rows = await (await db()).select({ username: people.username, isAdmin: people.isAdmin }).from(people)
    expect(Object.fromEntries(rows.map((r) => [r.username, r.isAdmin]))).toEqual({ somchai: false, dev1: true })
    expect((await (await db()).select().from(settingsAudit).where(eq(settingsAudit.action, 'setup.unclaimed')))[0]!.newValue).toEqual({ username: 'somchai' })
    // Someone who was an admin already (not by this claim) keeps it when another person claims after them.
    await (await db()).update(people).set({ isAdmin: true }).where(eq(people.username, 'somchai'))
    await claimAs(h, { username: 'somchai' })
    await claimAs(h, { username: 'dev1' })
    const after = await (await db()).select({ username: people.username, isAdmin: people.isAdmin }).from(people)
    expect(Object.fromEntries(after.map((r) => [r.username, r.isAdmin]))).toEqual({ somchai: true, dev1: true })
    expect((await progress(h)).steps.claim).toBe('done')
    await put(h, 'signin', { 'oidc.staffGroup': '/it-ops' })
    expect((await progress(h)).steps.claim).toBe('todo')
  })

  it('refuses to complete with a required step open, naming the steps', async () => {
    const h = await ready()
    const res = await app.inject({ method: 'POST', url: '/setup/complete', headers: h })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'invalid_state', reason: 'incomplete', missing: ['kit', 'claim'] })
    await claimAs(h, { username: 'somchai' })
    expect((await app.inject({ method: 'POST', url: '/setup/complete', headers: h })).json().missing).toEqual(['kit'])
    // Sign-in values changed after the claim: the claim no longer counts.
    await app.inject({ method: 'POST', url: '/setup/recovery-kit', headers: h })
    await put(h, 'signin', { 'oidc.clientId': 'yoda-portal-2' })
    expect((await app.inject({ method: 'POST', url: '/setup/complete', headers: h })).json().missing).toEqual(['claim'])
    expect((await (await db()).select().from(setupState))[0]!.setupCompletedAt).toBeNull()
  })

  it('an admin made without TOTP (localhost) counts as missing once the URL needs TOTP; the wizard enrols it (I4)', async () => {
    await boot({ PORTAL_URL: '' })
    let h = await setupSession()
    await put(h, 'general', { 'org.name': 'Example Hospital', 'org.publicUrl': 'http://localhost:3000' })
    const made = await app.inject({ method: 'POST', url: '/setup/admin', headers: h, payload: { username: 'admin', password: BG_LOGIN } })
    expect(made.json()).toMatchObject({ totpEnabled: false })
    h = { ...UA, cookie: cookieOf(made, 'yoda_setup')!, 'x-yoda-csrf': made.json().session.csrf }
    await put(h, 'signin', { 'oidc.issuer': idp.issuer })
    await app.inject({ method: 'POST', url: '/setup/recovery-kit', headers: h })
    const version = store.info('org.publicUrl').version ?? 0
    await put(h, 'general', { 'org.publicUrl': 'https://portal.example.org' }, { 'org.publicUrl': version })
    expect(await progress(h)).toMatchObject({ adminNeedsTotp: true, steps: { admin: 'todo' } })
    expect((await claimAs(h, { username: 'somchai' })).json().ok).toBe(true)
    const refused = await app.inject({ method: 'POST', url: '/setup/complete', headers: h })
    expect(refused.json()).toEqual({ error: 'invalid_state', reason: 'incomplete', missing: ['admin'] })

    // Enrol: a seed in the session, then its code and the admin's password.
    const enrol = (await app.inject({ method: 'POST', url: '/setup/totp', headers: h })).json()
    const code = totpCodeAt(enrol.secret, clock.getTime())
    const wrong = await app.inject({ method: 'POST', url: '/setup/totp/confirm', headers: h, payload: { password: 'not-the-password-1', totpCode: code } })
    expect(wrong.json()).toEqual({ error: 'invalid_credentials' })
    const badCode = await app.inject({ method: 'POST', url: '/setup/totp/confirm', headers: h, payload: { password: BG_LOGIN, totpCode: code === '000000' ? '111111' : '000000' } })
    expect(badCode.json()).toEqual({ error: 'invalid_code' })
    const ok = await app.inject({ method: 'POST', url: '/setup/totp/confirm', headers: h, payload: { password: BG_LOGIN, totpCode: code } })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ username: 'admin', totpEnabled: true })
    expect(JSON.stringify(ok.json())).not.toContain(enrol.secret)
    // The session was rotated: the old cookie is gone.
    expect((await app.inject({ url: '/setup/progress', headers: h })).statusCode).toBe(401)
    h = { ...UA, cookie: cookieOf(ok, 'yoda_setup')!, 'x-yoda-csrf': ok.json().session.csrf }
    expect(await progress(h)).toMatchObject({ adminNeedsTotp: false, steps: { admin: 'done' } })
    expect((await app.inject({ method: 'POST', url: '/setup/totp/confirm', headers: h, payload: { password: BG_LOGIN, totpCode: code } })).json()).toMatchObject({ reason: 'totp_enabled' })
    const audit = await (await db()).select().from(settingsAudit).where(eq(settingsAudit.action, 'break_glass.totp'))
    expect(audit.map((a) => a.result)).toEqual(['invalid_password', 'ok'])
    expect((await app.inject({ method: 'POST', url: '/setup/complete', headers: h })).json()).toEqual({ done: true })
  })

  it('a plain-http URL saved before D8 (or set in env) does not let setup finish: 422 https_required', async () => {
    await boot({ PORTAL_URL: '' })
    let h = await setupSession()
    await put(h, 'general', { 'org.name': 'Example Hospital', 'org.publicUrl': 'https://portal.example.org' })
    h = await createAdmin(h)
    await put(h, 'signin', { 'oidc.issuer': idp.issuer })
    await app.inject({ method: 'POST', url: '/setup/recovery-kit', headers: h })
    expect((await claimAs(h, { username: 'somchai' })).json().ok).toBe(true)
    expect((await progress(h)).missing).toEqual([])
    // Written straight to the store, as an older release (or a hand edit) would have.
    await store.apply([{ key: 'org.publicUrl', value: 'http://10.0.0.5:3000' }], { personId: null, label: 'test', source: 'setup' })
    expect((await progress(h)).steps.organisation).toBe('todo')
    const refused = await app.inject({ method: 'POST', url: '/setup/complete', headers: h })
    expect(refused.statusCode).toBe(422)
    expect(refused.json()).toEqual({ error: 'invalid_settings', issues: [{ key: 'org.publicUrl', message: 'https_required' }] })
    expect((await (await db()).select().from(setupState))[0]!.setupCompletedAt).toBeNull()
  })

  it('an env PORTAL_URL on plain http away from localhost blocks completion too', async () => {
    await boot({ PORTAL_URL: 'http://10.0.0.5:3000' })
    const h = await setupSession()
    expect((await put(h, 'general', { 'org.name': 'Example Hospital' })).statusCode).toBe(200)
    expect((await progress(h)).steps.organisation).toBe('todo')
    expect((await app.inject({ method: 'POST', url: '/setup/complete', headers: h })).json()).toMatchObject({ issues: [{ key: 'org.publicUrl', message: 'https_required' }] })
  })

  it('completes: marks done in the same process, ends every setup session, deletes the token, then /setup is 404', async () => {
    const h = await ready()
    await app.inject({ method: 'POST', url: '/setup/recovery-kit', headers: h })
    await claimAs(h, { username: 'somchai' })
    const other = await setupSession()
    expect(existsSync(tokenFile)).toBe(true)
    const token = await signToken({ sub: 'sub-somchai', preferred_username: 'somchai' })
    expect((await app.inject({ url: '/me', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(503)

    const notes: string[] = []
    const listener = await pgClient(await db()).listen(store.channel, (payload) => void notes.push(payload))
    const res = await app.inject({ method: 'POST', url: '/setup/complete', headers: h })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ done: true })
    // Other core instances hear of it and reload (`setupDone`).
    await vi.waitFor(() => expect(notes).toContain('[]'))
    await listener.unlisten()
    expect(String(res.headers['set-cookie'])).toMatch(/^yoda_setup=; Path=\/api\/setup; Max-Age=0/)
    const [st] = await (await db()).select().from(setupState)
    const [p] = await (await db()).select().from(people).where(eq(people.username, 'somchai'))
    expect(st).toMatchObject({ setupCompletedSource: 'setup', setupCompletedBy: p!.id, setupTokenHash: null })
    expect(st!.setupCompletedAt).not.toBeNull()
    expect(store.setupDone).toBe(true)
    expect(existsSync(tokenFile)).toBe(false)
    expect(await (await db()).select().from(localSessions).where(eq(localSessions.kind, 'setup'))).toHaveLength(0)
    // Setup mode is over now, not at the next restart.
    expect((await app.inject({ url: '/me', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200)
    for (const [method, url] of [['GET', '/setup/status'], ['GET', '/setup/progress'], ['POST', '/setup/recovery-kit'], ['POST', '/setup/complete']] as const) {
      expect((await app.inject({ method, url, headers: other })).statusCode, url).toBe(404)
    }
    const audit = await (await db()).select().from(settingsAudit).where(eq(settingsAudit.action, 'setup.completed'))
    expect(audit[0]).toMatchObject({ source: 'setup', newValue: { admin: 'somchai' } })
    expect((await app.inject({ url: '/public-config' })).json().setup).toBe('done')
  })
})
