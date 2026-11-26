import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import { localSessions, notifications, people, settings, settingsAudit, setupState } from '../src/db/schema.js'
import { totpCodeAt } from '../src/local/totp.js'
import { encodeMasterKey, loadMasterKey, masterKey, type MasterKey, type MasterKeyLoad } from '../src/settings/crypto.js'
import { LiveSettings } from '../src/settings/live.js'
import { SettingsStore } from '../src/settings/store.js'
import { runAdmin } from '../src/yoda-admin.js'
import { startFakeOidc, type FakeOidc } from './fake-oidc.js'
import { mockModels, resetDb, testDb, testDeps } from './helpers.js'
import { signToken } from './jwt.js'

// End-to-end flows of the installer work (installer proposal §13.1 phase 6), in process: core as server.ts wires
// it (SettingsStore + LiveSettings, so sign-in follows the settings), the test database, a fake OIDC provider on
// 127.0.0.1 and `yoda-admin` as functions. A "restart" is a new store and app on the same database. The docker
// based checks (install.sh, init, compose) are listed in the Task 10 report. Placeholder values only.

const KEY = masterKey(Buffer.alloc(32, 0x41))
const WRONG = masterKey(Buffer.alloc(32, 0x42))
const ROTATED = masterKey(Buffer.alloc(32, 0x43))
const ok = (k: MasterKey): MasterKeyLoad => ({ status: 'ok', key: k })
const BG_LOGIN = 'river-copper-lantern-71'
const UA = { 'user-agent': 'vitest-browser' }
const PORTAL = 'https://portal.example.org'
const quiet = () => ({ warn: vi.fn(), info: vi.fn() })

let app: FastifyInstance | null = null
let live: LiveSettings | null = null
let store: SettingsStore
let clock: Date
let dir: string
let tokenFile: string
let keyFile: string
let channel: string
let idp: FakeOidc

/** Boots core like server.ts does (minus listening): store, live settings, app. */
async function start(key: MasterKeyLoad, opts: { env?: NodeJS.ProcessEnv; previousKey?: MasterKey | null } = {}) {
  await stop()
  const db = await testDb()
  store = await SettingsStore.open({
    db,
    env: opts.env ?? {},
    masterKey: key,
    previousKey: opts.previousKey ?? null,
    keyLoader: () => loadMasterKey({ YODA_MASTER_KEY_FILE: keyFile }),
    log: quiet(),
    channel,
  })
  const deps = await testDeps()
  // The env Config of a fresh install: no issuer (setup mode, R4); the wizard and /recovery set it.
  const { oidcIssuer: _issuer, ...base } = deps.config
  const fromEnv = opts.env?.OIDC_ISSUER ? { oidcIssuer: opts.env.OIDC_ISSUER } : {}
  live = new LiveSettings({ store, base: { ...base, ...fromEnv, devSkipSetup: false, bootstrapAdmins: [] } as Config, build: { models: () => mockModels() }, log: quiet() })
  app = await buildApp(live.attach({ ...deps, settings: store, outbound: { allowLoopback: true }, now: () => clock, setupTokenFile: tokenFile }))
}

async function stop() {
  await app?.close()
  await live?.close()
  app = null
  live = null
}

const inject = (opts: InjectOptions) => app!.inject(opts)

const cookieOf = (res: LightMyRequestResponse, name: string) => {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`))
  return raw ? raw.split(';')[0]! : null
}

async function cli(argv: string[], over: Partial<Parameters<typeof runAdmin>[1]> = {}) {
  const out: string[] = []
  const err: string[] = []
  const code = await runAdmin(argv, {
    db: await testDb(),
    settings: store,
    config: app!.deps.config,
    tokenFile,
    jobs: { send: async () => {} },
    keyFile,
    keySource: 'file',
    masterKey: ok(KEY),
    generateKey: () => ROTATED,
    now: () => clock,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

/** A portal access token from the fake provider's signing key (what keycloak-js would hold). */
const bearer = async (username: string, issuer = idp.issuer) => ({
  authorization: `Bearer ${await signToken({ iss: issuer, azp: 'yoda-portal', sub: `sub-${username}`, typ: 'Bearer', preferred_username: username, groups: ['/it-dev'] })}`,
})

let totpSeed: string

/** A fresh install through the wizard's API only, with the token from `yoda-admin setup-token`. */
async function wizard(): Promise<void> {
  writeFileSync(keyFile, `${encodeMasterKey(KEY)}\n`, { mode: 0o600 })
  await start(ok(KEY))
  expect((await inject({ url: '/public-config' })).json()).toMatchObject({ setup: 'required', oidc: null })
  expect((await inject({ url: '/me', headers: await bearer('somchai') })).json()).toEqual({ error: 'setup_required' })

  // Step 0: the token, from the host.
  const t = await cli(['setup-token'])
  expect(t.code).toBe(0)
  const token = /([A-Z2-9]{4}(?:-[A-Z2-9]{4}){4})/.exec(t.out)![1]!
  const s0 = await inject({ method: 'POST', url: '/setup/session', headers: UA, payload: { token } })
  expect(s0.statusCode).toBe(200)
  let h = { ...UA, cookie: cookieOf(s0, 'yoda_setup')!, 'x-yoda-csrf': s0.json().csrf }
  const put = (category: string, changes: Record<string, unknown>, versions?: Record<string, number>) =>
    inject({ method: 'PUT', url: `/setup/settings/${category}`, headers: h, payload: { changes, ...(versions ? { versions } : {}) } })

  // Step 1: organisation and the public URL.
  expect((await put('general', { 'org.name': 'โรงพยาบาลตัวอย่าง', 'org.publicUrl': PORTAL, 'org.defaultLocale': 'th' })).statusCode).toBe(200)
  // Step 2: the break-glass admin with TOTP (D3: not localhost).
  const enrol = (await inject({ method: 'POST', url: '/setup/totp', headers: h })).json()
  totpSeed = enrol.secret
  const admin = await inject({ method: 'POST', url: '/setup/admin', headers: h, payload: { username: 'admin', password: BG_LOGIN, totpCode: totpCodeAt(totpSeed, clock.getTime()) } })
  expect(admin.statusCode).toBe(200)
  h = { ...UA, cookie: cookieOf(admin, 'yoda_setup')!, 'x-yoda-csrf': admin.json().session.csrf }
  // Step 4: sign-in, checked against the provider.
  expect((await put('signin', { 'oidc.issuer': idp.issuer, 'oidc.clientId': 'yoda-portal' })).statusCode).toBe(200)
  const check = (await inject({ method: 'POST', url: '/setup/settings/signin/test', headers: h, payload: {} })).json()
  expect(check.ok).toBe(true)
  // An optional step: email, with its secret (encrypted under the master key).
  expect((await put('email', { 'smtp.host': 'smtp.example.org', 'smtp.password': 'placeholder-smtp-pass-1234' }, { 'smtp.host': 0 })).statusCode).toBe(200)
  // Step 9: the recovery kit.
  const kit = (await inject({ method: 'POST', url: '/setup/recovery-kit', headers: h })).json()
  expect(kit.content).toContain(encodeMasterKey(KEY))
  // Step 10: claim through the provider, then complete.
  const start1 = await inject({ method: 'POST', url: '/setup/claim/start', headers: h })
  const back = idp.authorize(start1.json().authorizeUrl, { username: 'somchai' })
  expect((await inject({ method: 'POST', url: '/setup/claim/callback', headers: h, payload: back })).json()).toMatchObject({ ok: true, username: 'somchai' })
  expect((await inject({ method: 'POST', url: '/setup/complete', headers: h })).json()).toEqual({ done: true })
}

beforeEach(async () => {
  await resetDb(await testDb())
  clock = new Date('2026-11-27T03:00:00Z')
  dir = mkdtempSync(join(tmpdir(), 'yoda-e2e-'))
  tokenFile = join(dir, 'setup-token')
  keyFile = join(dir, 'master-key')
  channel = `settings_test_${randomUUID().slice(0, 8)}`
  idp = await startFakeOidc()
})

afterEach(async () => {
  await stop()
  await idp.stop()
})

/** A break-glass session (password plus TOTP, unless `factor` says otherwise). */
async function recovery(factor: Record<string, unknown> = {}) {
  clock = new Date(clock.getTime() + 30_000)
  const res = await inject({ method: 'POST', url: '/recovery/session', headers: UA, payload: { username: 'admin', password: BG_LOGIN, totpCode: totpCodeAt(totpSeed, clock.getTime()), ...factor } })
  expect(res.statusCode, res.body).toBe(200)
  return { res, h: { ...UA, cookie: cookieOf(res, 'yoda_bg')!, 'x-yoda-csrf': res.json().csrf } }
}

describe('e2e: fresh install', () => {
  it('setup token → wizard → claim through OIDC → complete; the portal API then works with a provider token', async () => {
    await wizard()
    const pc = (await inject({ url: '/public-config' })).json()
    expect(pc).toMatchObject({ setup: 'done', recovery: false, oidc: { realm: 'test', clientId: 'yoda-portal' } })
    // The provider's token is accepted (the JWKS came from the issuer saved in the wizard), and the claimer is admin.
    const me = await inject({ url: '/me', headers: await bearer('somchai') })
    expect(me.statusCode, me.body).toBe(200)
    expect(me.json()).toMatchObject({ username: 'somchai', isAdmin: true })
    expect((await inject({ url: '/admin/settings', headers: await bearer('somchai') })).statusCode).toBe(200)
    // A token from another issuer is not.
    expect((await inject({ url: '/me', headers: await bearer('somchai', 'http://issuer.test') })).statusCode).toBe(401)
    // Setup is over: the wizard is gone and the CLI says so.
    expect((await inject({ url: '/setup/status' })).statusCode).toBe(404)
    expect((await cli(['status'])).out).toMatch(/setup: done[\s\S]*master key: ok \(id [0-9a-f]{16}\)[\s\S]*break-glass: admin, TOTP on, 10 recovery codes left/)
    // A restart keeps it all.
    await start(ok(KEY))
    expect((await inject({ url: '/me', headers: await bearer('somchai') })).statusCode).toBe(200)
    expect(store.get('smtp.password')).toBe('placeholder-smtp-pass-1234')
  })
})

describe('e2e: upgrade from an env install (§6)', () => {
  it('imports env values, marks setup done, shows them locked, and the portal keeps working', async () => {
    const db = await testDb()
    // The existing install: an admin and a project, configured by env only.
    await db.insert(people).values({ keycloakSub: 'sub-somchai', username: 'somchai', displayName: 'Somchai', isAdmin: true })
    await db.execute(sql`insert into projects (name) values ('Existing project')`)
    const env = { OIDC_ISSUER: idp.issuer, PORTAL_URL: PORTAL, SMTP_HOST: 'smtp.example.org', SMTP_PASSWORD: 'placeholder-env-smtp-pass', ORG_NAME: 'Example Hospital' }
    await start(ok(KEY), { env })
    expect(store.setupDone).toBe(true)
    const [st] = await db.select().from(setupState)
    expect(st!.setupCompletedSource).toBe('upgrade')
    // Imported (secrets encrypted), source `import`.
    const rows = Object.fromEntries((await db.select().from(settings)).map((r) => [r.key, r]))
    expect(rows['smtp.host']).toMatchObject({ source: 'import', value: 'smtp.example.org' })
    expect(rows['smtp.password']).toMatchObject({ source: 'import', value: null, keyId: KEY.id })
    expect(rows['smtp.password']!.ciphertext!.toString('utf8')).not.toContain('placeholder')
    // No wizard, portal works, env values are locked in the settings API.
    expect((await inject({ url: '/public-config' })).json().setup).toBe('done')
    expect((await inject({ url: '/setup/status' })).statusCode).toBe(404)
    const h = await bearer('somchai')
    expect((await inject({ url: '/me', headers: h })).json()).toMatchObject({ isAdmin: true })
    const email = (await inject({ url: '/admin/settings?category=email', headers: h })).json()
    const host = email.categories[0].settings.find((x: { key: string }) => x.key === 'smtp.host')
    expect(host.locked).toMatchObject({ reason: 'env', envName: 'SMTP_HOST' })
    const pass = email.categories[0].settings.find((x: { key: string }) => x.key === 'smtp.password')
    expect(JSON.stringify(pass)).not.toContain('placeholder-env-smtp-pass')
    expect((await db.select().from(settingsAudit).where(eq(settingsAudit.action, 'setup.completed')))[0]).toMatchObject({ source: 'upgrade' })
    // A second boot does not import again (nothing changed) and stays done.
    const before = (await db.select().from(settingsAudit)).length
    await start(ok(KEY), { env })
    expect((await db.select().from(settingsAudit)).length).toBe(before)
  })
})

describe('e2e: OIDC lockout, then recovery', () => {
  it('a wrong issuer locks everyone out; /recovery stages, tests and applies the right one; the portal works again', async () => {
    await wizard()
    const db = await testDb()
    // Someone broke sign-in (a wrong issuer straight in the database): every portal token fails.
    await db.update(settings).set({ value: 'http://127.0.0.1:9/realms/gone' }).where(eq(settings.key, 'oidc.issuer'))
    await store.load()
    expect(app!.deps.config.oidcIssuer).toBe('http://127.0.0.1:9/realms/gone')
    expect((await inject({ url: '/me', headers: await bearer('somchai') })).statusCode).toBe(401)

    // Break-glass: password + TOTP.
    const { h } = await recovery()
    const status = (await inject({ url: '/recovery/status', headers: h })).json()
    expect(status.oidc.current.issuer).toBe('http://127.0.0.1:9/realms/gone')
    // The admins hear of it (feed).
    expect((await db.select().from(notifications).where(eq(notifications.kind, 'security_alert'))).length).toBeGreaterThan(0)
    // Stage the right issuer, check it, test a real sign-in as the admin, apply.
    expect((await inject({ method: 'PUT', url: '/recovery/oidc/pending', headers: h, payload: { issuer: idp.issuer, clientId: 'yoda-portal', jwksUrl: null } })).statusCode).toBe(200)
    expect((await inject({ method: 'POST', url: '/recovery/oidc/check', headers: h })).json().ok).toBe(true)
    expect((await inject({ method: 'POST', url: '/recovery/oidc/apply', headers: h })).json()).toEqual({ error: 'invalid_state', reason: 'not_tested' })
    const signin = await inject({ method: 'POST', url: '/recovery/oidc/signin', headers: h })
    const back = idp.authorize(signin.json().authorizeUrl, { username: 'somchai' })
    expect((await inject({ method: 'POST', url: '/recovery/oidc/callback', headers: h, payload: back })).json()).toMatchObject({ ok: true, pending: { testedUsername: 'somchai' } })
    const applied = (await inject({ method: 'POST', url: '/recovery/oidc/apply', headers: h })).json()
    expect(applied.oidc.current.issuer).toBe(idp.issuer)
    expect(applied.oidc.rollback.values.issuer).toBe('http://127.0.0.1:9/realms/gone')
    // Live: no restart needed.
    const me = await inject({ url: '/me', headers: await bearer('somchai') })
    expect(me.statusCode, me.body).toBe(200)
    // The break-glass cookie never opens the portal API.
    expect((await inject({ url: '/me', headers: h })).statusCode).toBe(401)
  })
})

describe('e2e: wrong master key', () => {
  it('starts in recovery, gives a status-only recovery session, and recovers by restoring the key', async () => {
    await wizard()
    // A restart with the wrong key (a restored backup on a new host, the bootstrap volume lost).
    await start(ok(WRONG))
    expect(store.keyStatus).toBe('mismatch')
    expect((await inject({ url: '/health' })).json().settings).toEqual({ secrets: 'mismatch', recovery: true })
    expect((await inject({ url: '/public-config' })).json()).toMatchObject({ recovery: true, recoveryForced: false })
    // Non-secret things keep working; secrets show unavailable, never garbage.
    expect((await inject({ url: '/me', headers: await bearer('somchai') })).statusCode).toBe(200)
    const email = (await inject({ url: '/admin/settings?category=email', headers: await bearer('somchai') })).json()
    expect(email.masterKey).toMatchObject({ status: 'mismatch', recovery: true })
    expect(email.categories[0].settings.find((x: { key: string }) => x.key === 'smtp.password').secretState).toMatchObject({ set: true, unavailable: true })
    // TOTP cannot be checked without the key: the password alone gives a status-only session.
    const { res, h } = await recovery({ totpCode: undefined })
    expect(res.json()).toMatchObject({ restricted: true, statusOnly: true })
    const status = (await inject({ url: '/recovery/status', headers: h })).json()
    expect(status.masterKey).toEqual({ status: 'mismatch', keyId: null, recovery: true })
    for (const [method, url] of [['PUT', '/recovery/oidc/pending'], ['POST', '/recovery/fun-mode/off'], ['GET', '/recovery/admins'], ['POST', '/recovery/recovery-codes']] as const) {
      expect((await inject({ method, url, headers: h, payload: { issuer: idp.issuer, clientId: 'yoda-portal', jwksUrl: null } })).json(), url).toEqual({ error: 'forbidden', reason: 'secrets_unavailable' })
    }
    expect((await inject({ method: 'POST', url: '/recovery/totp/start', headers: h })).json()).toEqual({ error: 'secrets_unavailable' })
    const [signinAudit] = await (await testDb()).select().from(settingsAudit).where(eq(settingsAudit.action, 'recovery.signin'))
    expect(signinAudit!.newValue).toEqual({ factor: 'password_keyless' })

    // Fix: the right key back (the recovery kit), restart.
    await start(ok(KEY))
    expect(store.keyStatus).toBe('ok')
    // The password-only session never becomes a full one: with the key back it is over (no stage, apply, fun mode
    // or admin grant through it), and it is gone from the database.
    for (const [method, url, payload] of [
      ['PUT', '/recovery/oidc/pending', { issuer: idp.issuer, clientId: 'yoda-portal', jwksUrl: null }],
      ['POST', '/recovery/oidc/apply', {}],
      ['POST', '/recovery/fun-mode/off', {}],
      ['POST', '/recovery/admins', { username: 'mallory' }],
      ['GET', '/recovery/status', undefined],
    ] as const) {
      const r = await inject({ method, url, headers: h, ...(payload ? { payload } : {}) })
      expect(r.statusCode, url).toBe(401)
    }
    expect(await (await testDb()).select().from(localSessions)).toHaveLength(0)
    expect(store.get('smtp.password')).toBe('placeholder-smtp-pass-1234')
    const full = await recovery()
    expect(full.res.json()).toMatchObject({ restricted: false, statusOnly: false })
  })

  it('the key is lost: reset from the host, enrol again, a new kit, then rotate to a fresh key', async () => {
    await wizard()
    await start(ok(WRONG))
    // Lost for good: accept the loaded key; the running core leaves recovery by itself.
    const reset = await cli(['reset-master-key', '--yes'], { masterKey: ok(WRONG) })
    expect(reset.code, reset.err).toBe(0)
    expect(reset.out).toContain('smtp.password')
    await store.load()
    expect(store.keyStatus).toBe('ok')
    expect(store.recovery).toBe(false)
    expect((await inject({ url: '/health' })).json().settings).toEqual({ secrets: 'ok', recovery: false })
    // The break-glass account lost its TOTP: password, then enrol (now possible), then new codes.
    const { res, h } = await recovery({ totpCode: undefined })
    expect(res.json()).toMatchObject({ restricted: true, statusOnly: false, admin: { mustEnrolTotp: true, mustChangePassword: true } })
    // A new password first (the reset came from the host), then the authenticator.
    const pw = await inject({ method: 'POST', url: '/recovery/password', headers: h, payload: { newPassword: 'quartz-meadow-falcon-88' } })
    expect(pw.json()).toMatchObject({ admin: { mustChangePassword: false } })
    const enrol = (await inject({ method: 'POST', url: '/recovery/totp/start', headers: h })).json()
    const done = await inject({ method: 'POST', url: '/recovery/totp/confirm', headers: h, payload: { code: totpCodeAt(enrol.secret, clock.getTime()) } })
    expect(done.json()).toMatchObject({ restricted: false })
    expect(done.json().recoveryCodes).toHaveLength(10)
    totpSeed = enrol.secret
    // The secret is entered again; then a complete kit from the host.
    await store.set('smtp.password', 'placeholder-smtp-pass-again', { label: 'สมชาย', source: 'ui' })
    writeFileSync(keyFile, `${encodeMasterKey(WRONG)}\n`, { mode: 0o600 })
    const kit = await cli(['recovery-kit'])
    expect(kit.out).toContain(encodeMasterKey(WRONG))

    // Rotate away from the key that was generated without an owner's say.
    const rot = await cli(['rotate-master-key'])
    expect(rot.code, rot.err).toBe(0)
    expect(rot.out).toContain(encodeMasterKey(ROTATED))
    // The running core switched (key file), and a restart with the new key and .prev works too.
    await store.load()
    expect(store.keyId).toBe(ROTATED.id)
    await start(ok(ROTATED), { previousKey: WRONG })
    expect(store.get('smtp.password')).toBe('placeholder-smtp-pass-again')
    expect((await recovery({ password: 'quartz-meadow-falcon-88' })).res.json()).toMatchObject({ restricted: false })
    const fin = await cli(['rotate-master-key', '--finish'])
    expect(fin.code, fin.err).toBe(0)
  })
})

describe('e2e: moving to another identity provider with other usernames', () => {
  it('pre-grants admin at /recovery, so the test sign-in passes and the new username is admin at its first sign-in', async () => {
    await wizard()
    const other = await startFakeOidc()
    try {
      const { h } = await recovery()
      const stage = await inject({ method: 'PUT', url: '/recovery/oidc/pending', headers: h, payload: { issuer: other.issuer, clientId: 'yoda-portal', jwksUrl: null } })
      expect(stage.statusCode).toBe(200)
      const testAs = async () => {
        const s = await inject({ method: 'POST', url: '/recovery/oidc/signin', headers: h })
        const back = other.authorize(s.json().authorizeUrl, { username: 'somchai.j' })
        return (await inject({ method: 'POST', url: '/recovery/oidc/callback', headers: h, payload: back })).json()
      }
      // Not an admin anywhere yet: the test sign-in does not count.
      const first = await testAs()
      expect(first.checks.find((c: { id: string }) => c.id === 'admin')).toMatchObject({ ok: false, code: 'not_admin' })
      // Grant needs the current second factor.
      expect((await inject({ method: 'POST', url: '/recovery/admins', headers: h, payload: { username: 'somchai.j' } })).json()).toEqual({ error: 'second_factor_required' })
      clock = new Date(clock.getTime() + 30_000)
      const granted = await inject({ method: 'POST', url: '/recovery/admins', headers: h, payload: { username: 'somchai.j', totpCode: totpCodeAt(totpSeed, clock.getTime()) } })
      expect(granted.json()).toMatchObject({ admins: [{ username: 'somchai' }], preGranted: ['somchai.j'], preGrantLocked: false })
      expect((await testAs()).ok).toBe(true)
      expect((await inject({ method: 'POST', url: '/recovery/oidc/apply', headers: h })).statusCode).toBe(200)
      // The new provider's user signs in to the portal and is admin.
      const me = await inject({ url: '/me', headers: await bearer('somchai.j', other.issuer) })
      expect(me.statusCode, me.body).toBe(200)
      expect(me.json()).toMatchObject({ username: 'somchai.j', isAdmin: true })
      const audit = (await (await testDb()).select().from(settingsAudit).where(eq(settingsAudit.action, 'recovery.admin_grant')))[0]
      expect(audit).toMatchObject({ source: 'recovery', actorLabel: 'break-glass:admin', newValue: { username: 'somchai.j', preGranted: true } })
    } finally {
      await other.stop()
    }
  })
})

describe('e2e: another identity provider with the same usernames', () => {
  it('a grant at /recovery pre-grants the username: the new subject is admin at its first sign-in, once', async () => {
    await wizard()
    const token = async (sub: string) => ({
      authorization: `Bearer ${await signToken({ iss: idp.issuer, azp: 'yoda-portal', sub, typ: 'Bearer', preferred_username: 'somchai', groups: ['/it-dev'] })}`,
    })
    // Without a grant, somchai under a new subject is a new, ordinary person.
    expect((await inject({ url: '/me', headers: await token('other-idp-1') })).json().isAdmin).toBe(false)
    const { h } = await recovery()
    clock = new Date(clock.getTime() + 30_000)
    const g = (await inject({ method: 'POST', url: '/recovery/admins', headers: h, payload: { username: 'somchai', totpCode: totpCodeAt(totpSeed, clock.getTime()) } })).json()
    expect(g.preGranted).toEqual(['somchai'])
    // The next new subject with that username is admin, and the pre-grant is used up (audited as system).
    expect((await inject({ url: '/me', headers: await token('other-idp-2') })).json()).toMatchObject({ isAdmin: true })
    expect(store.get('oidc.bootstrapAdmins')).toEqual([])
    const [used] = await (await testDb()).select().from(settingsAudit).where(eq(settingsAudit.action, 'recovery.pregrant_used'))
    expect(used).toMatchObject({ actorLabel: 'system', newValue: { username: 'somchai' } })
    expect((await inject({ url: '/recovery/admins', headers: h })).json().preGranted).toEqual([])
    // Once only: a third subject with the same username is not.
    expect((await inject({ url: '/me', headers: await token('other-idp-3') })).json().isAdmin).toBe(false)
  })
})
