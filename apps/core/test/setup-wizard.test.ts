import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { localRecoveryCodes, localSessions, people, settings, settingsAudit, setupState } from '../src/db/schema.js'
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
    // The kit's codes are the ones that work (the set from the admin step is replaced).
    const rows = await (await db()).select().from(localRecoveryCodes)
    expect(rows).toHaveLength(10)
    const hashes = new Set(rows.map((r) => r.codeHash.toString('hex')))
    for (const c of kit.recoveryCodes) expect(hashes.has(recoveryCodeHash(MK, c).toString('hex'))).toBe(true)
    // Once only, in this session or any other.
    expect((await app.inject({ method: 'POST', url: '/setup/recovery-kit', headers: h })).json()).toEqual({ error: 'invalid_state', reason: 'kit_downloaded' })
    expect((await progress(h)).kitDownloadedAt).toBe(clock.toISOString())
    const audit = await (await db()).select().from(settingsAudit).where(eq(settingsAudit.action, 'setup.recovery_kit'))
    expect(audit).toHaveLength(1)
    expect(JSON.stringify(audit)).not.toContain(KEY_BYTES.toString('base64'))
    expect(JSON.stringify(audit)).toContain(MK.id)
    // The admin the kit was made for is not replaced during setup any more.
    const enrol = (await app.inject({ method: 'POST', url: '/setup/totp', headers: h })).json()
    const replace = await app.inject({ method: 'POST', url: '/setup/admin', headers: h, payload: { username: 'other', password: BG_LOGIN, totpCode: totpCodeAt(enrol.secret, clock.getTime()) } })
    expect(replace.json()).toEqual({ error: 'invalid_state', reason: 'kit_downloaded' })
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

  it('completes: marks done in the same process, ends every setup session, deletes the token, then /setup is 404', async () => {
    const h = await ready()
    await app.inject({ method: 'POST', url: '/setup/recovery-kit', headers: h })
    await claimAs(h, { username: 'somchai' })
    const other = await setupSession()
    expect(existsSync(tokenFile)).toBe(true)
    const token = await signToken({ sub: 'sub-somchai', preferred_username: 'somchai' })
    expect((await app.inject({ url: '/me', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(503)

    const res = await app.inject({ method: 'POST', url: '/setup/complete', headers: h })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ done: true })
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
