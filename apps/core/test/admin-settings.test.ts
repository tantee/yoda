import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp, type AppDeps } from '../src/app.js'
import { knowledgeChunks, knowledgeEntries, settings, settingsAudit } from '../src/db/schema.js'
import { masterKey, type MasterKeyLoad } from '../src/settings/crypto.js'
import { SettingsStore, type SettingActor } from '../src/settings/store.js'
import { startFakeGitLab, type FakeGitLab } from './fake-gitlab.js'
import { startFakeLine, type FakeLine } from './fake-line.js'
import { FakeSmtp } from './fake-smtp.js'
import { startFakeTelegram, type FakeTelegram } from './fake-telegram.js'
import { signToken, testJwksDocument } from './jwt.js'
import { resetDb, testDb, testDeps } from './helpers.js'

// Obviously fake key and placeholder credentials; no real secret anywhere.
const KEY: MasterKeyLoad = { status: 'ok', key: masterKey(Buffer.alloc(32, 0x44)) }
const GITLAB_TOKEN = 'gitlab-token-placeholder-0000-wxyz'
const SMTP_PASSWORD = 'smtp-placeholder-password-1234'
const TG_TOKEN = '123456:placeholder-telegram-token'
const system: SettingActor = { personId: null, label: 'seed', source: 'ui' }
const quiet = () => ({ warn: vi.fn(), info: vi.fn() })

type Who = { token: string; id: string }

/** Signs in; `authAgoS` sets the token's `auth_time` that many seconds ago (null: no `auth_time` claim). */
async function signIn(app: FastifyInstance, username: string, opts: { staff?: boolean; authAgoS?: number | null } = {}): Promise<Who> {
  const authAgo = opts.authAgoS === undefined ? 30 : opts.authAgoS
  const token = await signToken({
    sub: `sub-${username}`,
    preferred_username: username,
    name: username,
    email: `${username}@example.org`,
    groups: opts.staff ? ['/it-dev'] : [],
    ...(authAgo === null ? {} : { auth_time: Math.floor(Date.now() / 1000) - authAgo }),
  })
  const res = await app.inject({ url: '/me', headers: { authorization: `Bearer ${token}` } })
  return { token, id: res.json().id }
}

const h = (w: Who) => ({ authorization: `Bearer ${w.token}` })

let app: FastifyInstance
let store: SettingsStore
let boss: Who
let gl: FakeGitLab
let line: FakeLine
let tg: FakeTelegram

async function boot(env: NodeJS.ProcessEnv = {}, over: Partial<AppDeps> = {}, key: MasterKeyLoad = KEY) {
  store = await SettingsStore.open({
    db: await testDb(),
    env: { LINE_API_URL: line.url, TELEGRAM_API_URL: tg.url, ...env },
    masterKey: key,
    log: quiet(),
    channel: `settings_test_${randomUUID().slice(0, 8)}`,
  })
  const deps = await testDeps()
  app = await buildApp({ ...deps, config: { ...deps.config, bootstrapAdmins: ['boss'] }, settings: store, outbound: { allowLoopback: true }, ...over })
  boss = await signIn(app, 'boss')
}

beforeEach(async () => {
  await resetDb(await testDb())
  gl = await startFakeGitLab()
  line = await startFakeLine()
  tg = await startFakeTelegram()
})

afterEach(async () => {
  await app?.close()
  await Promise.all([gl.stop(), line.stop(), tg.stop()])
})

const put = (who: Who, category: string, payload: object) => app.inject({ method: 'PUT', url: `/admin/settings/${category}`, headers: h(who), payload })
const test = (who: Who, category: string, payload: object = {}) =>
  app.inject({ method: 'POST', url: `/admin/settings/${category}/test`, headers: h(who), payload })
const find = (body: { categories: { settings: { key: string }[] }[] }, key: string) =>
  body.categories.flatMap((c) => c.settings).find((s) => s.key === key) as Record<string, any>

describe('admin settings API: access', () => {
  it('admins only: staff and requesters get 403, no token 401', async () => {
    await boot()
    const staff = await signIn(app, 'dev1', { staff: true })
    const req = await signIn(app, 'nurse1')
    for (const who of [staff, req]) {
      expect((await app.inject({ url: '/admin/settings', headers: h(who) })).statusCode).toBe(403)
      expect((await put(who, 'email', { changes: { 'smtp.port': 2525 } })).statusCode).toBe(403)
      expect((await test(who, 'email')).statusCode).toBe(403)
      expect((await app.inject({ url: '/admin/settings/audit', headers: h(who) })).statusCode).toBe(403)
      expect((await app.inject({ method: 'POST', url: '/admin/settings/telegram/webhook', headers: h(who) })).statusCode).toBe(403)
      expect((await app.inject({ method: 'POST', url: '/admin/settings/gitlab/generate/gitlab.webhookSecret', headers: h(who) })).statusCode).toBe(403)
    }
    expect((await app.inject({ url: '/admin/settings' })).statusCode).toBe(401)
    expect(await store.list().filter((i) => i.source === 'db')).toEqual([])
  })

  it('answers 503 settings_unavailable without a store', async () => {
    await boot({}, { settings: undefined })
    const res = await app.inject({ url: '/admin/settings', headers: h(boss) })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: 'settings_unavailable' })
  })
})

describe('GET /admin/settings', () => {
  it('lists every category with sources, locks, apply modes and masked secrets', async () => {
    await boot({ MAIL_FROM: 'yoda@example.org' })
    await store.set('smtp.host', 'mail.example.org', system)
    await store.set('smtp.password', SMTP_PASSWORD, system)
    const res = await app.inject({ url: '/admin/settings', headers: h(boss) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(JSON.stringify(body)).not.toContain(SMTP_PASSWORD)
    expect(body.categories.map((c: { category: string }) => c.category)).toEqual(['general', 'signin', 'ai', 'gitlab', 'email', 'line', 'telegram', 'runners', 'backups', 'storage', 'security', 'extension'])
    expect(body.masterKey).toEqual({ status: 'ok', keyId: KEY.status === 'ok' ? KEY.key.id : null, recovery: false })

    expect(find(body, 'smtp.password')).toMatchObject({ secret: true, source: 'db', locked: null, apply: 'reconnect', version: 1, secretState: { set: true, hint: '1234', unavailable: false } })
    expect(find(body, 'smtp.password').value).toBeUndefined()
    expect(find(body, 'smtp.host')).toMatchObject({ value: 'mail.example.org', source: 'db', boundSecrets: ['smtp.password'] })
    expect(find(body, 'smtp.port')).toMatchObject({ value: 587, source: 'default', version: 0, locked: null })
    expect(find(body, 'smtp.from')).toMatchObject({ value: 'yoda@example.org', source: 'env', locked: { reason: 'env', envName: 'MAIL_FROM' } })
    expect(find(body, 'storage.s3Bucket')).toMatchObject({ locked: { reason: 'bootstrap' } })
    expect(find(body, 'telegram.botUsername')).toMatchObject({ locked: { reason: 'readonly' } })
    expect(find(body, 'oidc.issuer')).toMatchObject({ locked: { reason: 'recovery_only' } })
    expect(find(body, 'oidc.jwksUrl')).toMatchObject({ locked: { reason: 'recovery_only' } })
    // The portal reads its settings from /public-config and the backup container from the settings table.
    expect(find(body, 'org.name')).toMatchObject({ locked: null })
    expect(find(body, 'org.line')).toMatchObject({ locked: null, envName: 'NUXT_PUBLIC_ORG_LINE' })
    expect(find(body, 'backup.keepDays')).toMatchObject({ locked: null, envName: 'BACKUP_KEEP_DAYS' })
    expect(find(body, 'smtp.from')).toMatchObject({ importable: true })
    expect(find(body, 'smtp.host').importable).toBeUndefined()
    expect(find(body, 'ai.workers')).toMatchObject({ apply: 'restart', restartRequired: false })
    expect(body.categories.find((c: { category: string }) => c.category === 'email').test).toBe('smtp')

    const one = await app.inject({ url: '/admin/settings?category=email', headers: h(boss) })
    expect(one.json().categories.map((c: { category: string }) => c.category)).toEqual(['email'])
    expect((await app.inject({ url: '/admin/settings?category=nope', headers: h(boss) })).statusCode).toBe(404)
  })

  it('the prod compose env with an empty .env leaves the UI-editable settings unlocked (C1)', async () => {
    const { prodComposeCoreEnv } = await import('./prod-compose-env.js')
    await boot(prodComposeCoreEnv())
    const body = (await app.inject({ url: '/admin/settings', headers: h(boss) })).json()
    for (const k of ['smtp.port', 'smtp.secure', 'ai.modelDraft', 'ai.modelFast', 'ai.workers', 'work.dailyTaskCap', 'runners.leaseSeconds', 'runners.mcpEnabled', 'oidc.staffGroup']) {
      expect(find(body, k), k).toMatchObject({ locked: null })
    }
    const res = await put(boss, 'email', { changes: { 'smtp.port': 2525 }, versions: { 'smtp.port': 0 } })
    expect(res.statusCode).toBe(200)
    expect(store.get('smtp.port')).toBe(2525)
  })

  it('tells per env-locked key what removing the variable would do (kept by the import)', async () => {
    const env = { SMTP_PORT: '465', SMTP_PASSWORD, GITLAB_TOKEN }
    await boot(env)
    let body = (await app.inject({ url: '/admin/settings?category=email', headers: h(boss) })).json()
    expect(find(body, 'smtp.port')).toMatchObject({ locked: { reason: 'env', envName: 'SMTP_PORT' }, importable: true })
    expect(find(body, 'smtp.port').composeDefault).toBeUndefined()
    expect(find(body, 'smtp.password')).toMatchObject({ locked: { reason: 'env' }, importable: true })
    expect(find(body, 'smtp.password').writeSource).toBe('import')
    await app.close()
    // Import off: env secrets are not copied, so removing one disconnects the service.
    await boot({ ...env, YODA_SETTINGS_IMPORT: 'false' })
    body = (await app.inject({ url: '/admin/settings?category=email', headers: h(boss) })).json()
    expect(find(body, 'smtp.password')).toMatchObject({ importable: false })
    expect(find(body, 'smtp.port')).toMatchObject({ importable: true })
    await app.close()
    await boot(env, {}, { status: 'missing', reason: 'not set' })
    body = (await app.inject({ url: '/admin/settings?category=gitlab', headers: h(boss) })).json()
    expect(find(body, 'gitlab.token')).toMatchObject({ importable: false })
  })

  it('reports the master key from the key check, not from env (the key is taken out of env at boot)', async () => {
    await boot()
    let body = (await app.inject({ url: '/admin/settings?category=security', headers: h(boss) })).json()
    expect(find(body, 'security.masterKey').secretState.set).toBe(true)
    await app.close()
    await boot({}, {}, { status: 'missing', reason: 'not set' })
    body = (await app.inject({ url: '/admin/settings?category=security', headers: h(boss) })).json()
    expect(body.masterKey).toEqual({ status: 'missing', keyId: null, recovery: false })
    expect(find(body, 'security.masterKey').secretState.set).toBe(false)
    // Without a key no secret can be saved; non-secrets still can.
    const res = await put(boss, 'email', { changes: { 'smtp.password': SMTP_PASSWORD } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'secrets_unavailable', key: 'smtp.password' })
    expect((await put(boss, 'email', { changes: { 'smtp.from': 'yoda@example.org' } })).statusCode).toBe(200)
  })

  it('flags restart-mode changes and warns about unpriced models in effect', async () => {
    await boot()
    await store.set('ai.workers', 4, system)
    await store.set('ai.modelFast', 'anthropic:claude-unpriced-9', system)
    const body = (await app.inject({ url: '/admin/settings', headers: h(boss) })).json()
    expect(body.restartRequired).toEqual(['ai.workers'])
    expect(find(body, 'ai.workers').restartRequired).toBe(true)
    expect(body.warnings).toEqual([{ key: 'ai.modelFast', code: 'unpriced_model' }])
    expect((await app.inject({ url: '/admin/settings/restart-required', headers: h(boss) })).json()).toEqual({ restartRequired: ['ai.workers'] })
  })
})

describe('PUT /admin/settings/:category', () => {
  it('saves a partial change, bumps the version and audits the actor', async () => {
    await boot()
    const res = await put(boss, 'email', { changes: { 'smtp.port': '2525', 'smtp.host': 'mail.example.org' }, versions: { 'smtp.port': 0, 'smtp.host': 0 } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ applied: ['smtp.host', 'smtp.port'], cleared: [], warnings: [] })
    expect(body.category.settings.find((s: { key: string }) => s.key === 'smtp.port')).toMatchObject({ value: 2525, version: 1, source: 'db', updatedBy: { personId: boss.id, label: 'boss' } })
    expect(store.get('smtp.port')).toBe(2525)
    const rows = await (await testDb()).select().from(settingsAudit).where(eq(settingsAudit.key, 'smtp.port'))
    expect(rows).toMatchObject([{ action: 'set', actorPerson: boss.id, actorLabel: 'boss', source: 'ui', oldValue: null, newValue: 2525 }])
    expect(rows[0]!.ip).toBeTruthy()

    // null clears back to the default.
    const clear = await put(boss, 'email', { changes: { 'smtp.port': null }, versions: { 'smtp.port': 1 } })
    expect(clear.statusCode).toBe(200)
    expect(store.info('smtp.port')).toMatchObject({ source: 'default', version: null })
  })

  it('refuses env-locked, bootstrap-only, read-only and recovery-only settings with 409 and the reason', async () => {
    await boot({ SMTP_HOST: 'mail.example.org', NUXT_PUBLIC_RUNNER_DOCS_URL: 'https://runners.example.org', BACKUP_AT: '04:00' })
    const cases: [string, object, object][] = [
      ['email', { 'smtp.host': 'other.example.org' }, { key: 'smtp.host', reason: 'env', envName: 'SMTP_HOST' }],
      ['storage', { 'storage.s3Bucket': 'other' }, { key: 'storage.s3Bucket', reason: 'bootstrap' }],
      ['line', { 'line.apiUrl': 'https://evil.example.org' }, { key: 'line.apiUrl', reason: 'bootstrap' }],
      ['telegram', { 'telegram.botUsername': 'other_bot' }, { key: 'telegram.botUsername', reason: 'readonly' }],
      ['signin', { 'oidc.issuer': 'https://sso.example.org/realms/x' }, { key: 'oidc.issuer', reason: 'recovery_only' }],
      ['signin', { 'oidc.jwksUrl': 'https://sso.example.org/certs' }, { key: 'oidc.jwksUrl', reason: 'recovery_only' }],
      ['general', { 'org.runnerDocsUrl': 'https://docs.example.org' }, { key: 'org.runnerDocsUrl', reason: 'env', envName: 'NUXT_PUBLIC_RUNNER_DOCS_URL' }],
      ['backups', { 'backup.at': '03:00' }, { key: 'backup.at', reason: 'env', envName: 'BACKUP_AT' }],
    ]
    for (const [category, changes, expected] of cases) {
      const res = await put(boss, category, { changes })
      expect(res.statusCode, JSON.stringify(changes)).toBe(409)
      expect(res.json()).toEqual({ error: 'setting_locked', ...expected })
    }
    expect(store.list().filter((i) => i.source === 'db')).toEqual([])
  })

  it('saves the portal settings /public-config serves (org, LINE add-friend link)', async () => {
    await boot()
    const res = await put(boss, 'general', { changes: { 'org.name': 'Example hospital', 'org.line': 'IT department' } })
    expect(res.statusCode).toBe(200)
    expect(store.get('org.name')).toBe('Example hospital')
    expect((await put(boss, 'line', { changes: { 'line.addFriendUrl': 'https://line.example.org/add' } })).statusCode).toBe(200)
    expect(store.get('line.addFriendUrl')).toBe('https://line.example.org/add')
  })

  it('saves the backup settings the backup container reads from the database', async () => {
    await boot()
    const res = await put(boss, 'backups', { changes: { 'backup.at': '03:30', 'backup.keepDays': 30 } })
    expect(res.statusCode).toBe(200)
    expect(store.get('backup.at')).toBe('03:30')
    expect(store.get('backup.keepDays')).toBe(30)
  })

  it('validates per key: unknown keys, other categories and bad values are 422 with every issue, nothing saved', async () => {
    await boot()
    const res = await put(boss, 'email', { changes: { 'smtp.port': 'abc', 'gitlab.url': 'https://git.example.org', 'smtp.nope': 1, 'smtp.host': 'mail.example.org' } })
    expect(res.statusCode).toBe(422)
    const issues = res.json().issues as { key: string; message: string }[]
    expect(issues.map((i) => i.key).sort()).toEqual(['gitlab.url', 'smtp.nope', 'smtp.port'])
    expect(issues.find((i) => i.key === 'gitlab.url')!.message).toBe('wrong_category')
    expect(issues.find((i) => i.key === 'smtp.nope')!.message).toBe('unknown_setting')
    expect(store.get('smtp.host')).toBeUndefined()
    expect((await put(boss, 'email', { changes: {} })).statusCode).toBe(400)
    expect((await put(boss, 'nope', { changes: { a: 1 } })).statusCode).toBe(404)
  })

  it('stale versions get 409 version_conflict and write nothing', async () => {
    await boot()
    expect((await put(boss, 'email', { changes: { 'smtp.port': 2525 }, versions: { 'smtp.port': 0 } })).statusCode).toBe(200)
    // A second admin loaded the form at version 0 too.
    const stale = await put(boss, 'email', { changes: { 'smtp.port': 2526, 'smtp.host': 'mail.example.org' }, versions: { 'smtp.port': 0, 'smtp.host': 0 } })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'version_conflict', key: 'smtp.port', version: 1 })
    expect(store.get('smtp.port')).toBe(2525)
    expect(store.get('smtp.host')).toBeUndefined()
  })

  describe('recent sign-in for secrets and sign-in settings', () => {
    it('needs auth_time within 10 minutes to save or clear a secret', async () => {
      await boot()
      const old = await signIn(app, 'boss', { authAgoS: 11 * 60 })
      const none = await signIn(app, 'boss', { authAgoS: null })
      const future = await signIn(app, 'boss', { authAgoS: -3600 })
      for (const who of [old, none, future]) {
        const res = await put(who, 'email', { changes: { 'smtp.password': SMTP_PASSWORD } })
        expect(res.statusCode).toBe(401)
        expect(res.json()).toEqual({ error: 'reauth_required' })
      }
      expect(store.info('smtp.password').isSet).toBe(false)
      // A non-secret change in the same category does not need it.
      expect((await put(old, 'email', { changes: { 'smtp.from': 'yoda@example.org' } })).statusCode).toBe(200)

      const fresh = await signIn(app, 'boss', { authAgoS: 60 })
      expect((await put(fresh, 'email', { changes: { 'smtp.password': SMTP_PASSWORD } })).statusCode).toBe(200)
      expect(store.get('smtp.password')).toBe(SMTP_PASSWORD)
      expect((await put(old, 'email', { changes: { 'smtp.password': null } })).statusCode).toBe(401)
      expect((await put(fresh, 'email', { changes: { 'smtp.password': null } })).statusCode).toBe(200)
      expect(store.info('smtp.password').isSet).toBe(false)
    })

    it('needs it for any sign-in setting', async () => {
      await boot()
      const old = await signIn(app, 'boss', { authAgoS: 3600 })
      expect((await put(old, 'signin', { changes: { 'oidc.staffGroup': '/staff' } })).statusCode).toBe(401)
      expect((await put(boss, 'signin', { changes: { 'oidc.staffGroup': '/staff' } })).statusCode).toBe(200)
    })
  })

  describe('credential-bound endpoints (8.6)', () => {
    it('changing the endpoint clears its stored secret unless a new one is given in the same save', async () => {
      await boot()
      await store.set('gitlab.url', 'https://git.example.org', system)
      await store.set('gitlab.token', GITLAB_TOKEN, system)

      const res = await put(boss, 'gitlab', { changes: { 'gitlab.url': 'https://other.example.org' }, versions: { 'gitlab.url': 1 } })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ applied: ['gitlab.url'], cleared: ['gitlab.token'] })
      expect(store.info('gitlab.token').isSet).toBe(false)
      const audit = await (await testDb()).select().from(settingsAudit).where(eq(settingsAudit.key, 'gitlab.token')).orderBy(settingsAudit.id)
      expect(audit.map((a) => a.action)).toEqual(['set', 'clear'])

      // Endpoint and a new secret together: kept.
      const both = await put(boss, 'gitlab', { changes: { 'gitlab.url': 'https://git.example.org', 'gitlab.token': GITLAB_TOKEN }, versions: { 'gitlab.url': 2 } })
      expect(both.json()).toMatchObject({ cleared: [] })
      expect(store.get('gitlab.token')).toBe(GITLAB_TOKEN)
      // Saving the same endpoint again changes nothing: no write, no audit row.
      const auditCount = (await (await testDb()).select().from(settingsAudit)).length
      const again = await put(boss, 'gitlab', { changes: { 'gitlab.url': 'https://git.example.org/', 'gitlab.token': GITLAB_TOKEN }, versions: { 'gitlab.url': 3 } })
      expect(again.json()).toMatchObject({ applied: [], cleared: [] })
      expect(store.get('gitlab.token')).toBe(GITLAB_TOKEN)
      expect(store.info('gitlab.url').version).toBe(3)
      expect((await (await testDb()).select().from(settingsAudit)).length).toBe(auditCount)
    })

    it('an endpoint is saved only with the version the form loaded', async () => {
      await boot()
      const res = await put(boss, 'gitlab', { changes: { 'gitlab.url': 'https://git.example.org' } })
      expect(res.statusCode).toBe(422)
      expect(res.json()).toEqual({ error: 'invalid_settings', issues: [{ key: 'gitlab.url', message: 'version_required' }] })
    })

    it('decides the clear on the locked row, not on a stale snapshot (another instance moved the endpoint)', async () => {
      await boot()
      await store.set('gitlab.url', 'https://git.example.org', system)
      await store.set('gitlab.token', GITLAB_TOKEN, system)
      // Another instance moved the endpoint and set its token there; this instance has not reloaded yet.
      const db = await testDb()
      await db.update(settings).set({ value: 'https://other.example.org', version: 2 }).where(eq(settings.key, 'gitlab.url'))
      expect(store.get('gitlab.url')).toBe('https://git.example.org')
      // Saving the value the stale snapshot holds would look like no change, but it moves the token back.
      const res = await put(boss, 'gitlab', { changes: { 'gitlab.url': 'https://git.example.org' }, versions: { 'gitlab.url': 2 } })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ applied: ['gitlab.url'], cleared: ['gitlab.token'] })
      expect(store.info('gitlab.token').isSet).toBe(false)
    })

    it('moving an endpoint needs a recent sign-in (it can clear a secret)', async () => {
      await boot()
      await store.set('smtp.host', 'mail.example.org', system)
      await store.set('smtp.password', SMTP_PASSWORD, system)
      const old = await signIn(app, 'boss', { authAgoS: 3600 })
      expect((await put(old, 'email', { changes: { 'smtp.host': 'evil.example.org' }, versions: { 'smtp.host': 1 } })).statusCode).toBe(401)
      expect(store.get('smtp.host')).toBe('mail.example.org')
      expect(store.get('smtp.password')).toBe(SMTP_PASSWORD)
    })

    it('the SMTP port and TLS mode are bound like the host: re-auth, version, and the password cleared unless retyped', async () => {
      await boot()
      await store.set('smtp.host', 'mail.example.org', system)
      await store.set('smtp.password', SMTP_PASSWORD, system)
      const old = await signIn(app, 'boss', { authAgoS: 3600 })
      expect((await put(boss, 'email', { changes: { 'smtp.port': 465 } })).json()).toEqual({ error: 'invalid_settings', issues: [{ key: 'smtp.port', message: 'version_required' }] })
      expect((await put(old, 'email', { changes: { 'smtp.secure': true }, versions: { 'smtp.secure': 0 } })).statusCode).toBe(401)
      expect(store.get('smtp.password')).toBe(SMTP_PASSWORD)

      const port = await put(boss, 'email', { changes: { 'smtp.port': 465 }, versions: { 'smtp.port': 0 } })
      expect(port.statusCode).toBe(200)
      expect(port.json()).toMatchObject({ applied: ['smtp.port'], cleared: ['smtp.password'] })
      expect(store.info('smtp.password').isSet).toBe(false)

      // TLS mode and a retyped password in one save: kept.
      const secure = await put(boss, 'email', { changes: { 'smtp.secure': true, 'smtp.password': SMTP_PASSWORD }, versions: { 'smtp.secure': 0 } })
      expect(secure.json()).toMatchObject({ cleared: [] })
      expect(store.get('smtp.password')).toBe(SMTP_PASSWORD)
      expect(find((await app.inject({ url: '/admin/settings?category=email', headers: h(boss) })).json(), 'smtp.port').boundSecrets).toEqual(['smtp.password'])
    })

    it('refuses to move an endpoint whose secret is set in env', async () => {
      await boot({ OPENAI_API_KEY: 'sk-placeholder-openai-0000' })
      const res = await put(boss, 'ai', { changes: { 'ai.openaiBaseUrl': 'https://llm.example.org/v1' }, versions: { 'ai.openaiBaseUrl': 0 } })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'setting_locked', key: 'ai.openaiBaseUrl', reason: 'bound_secret_in_env', envName: 'OPENAI_API_KEY' })
    })
  })

  it('the public URL needs a recent sign-in (webhooks and links point at it)', async () => {
    await boot()
    const old = await signIn(app, 'boss', { authAgoS: 3600 })
    expect((await put(old, 'general', { changes: { 'org.publicUrl': 'https://evil.example.org' } })).statusCode).toBe(401)
    expect((await put(old, 'general', { changes: { 'work.dailyTaskCap': 5 } })).statusCode).toBe(200)
    expect((await put(boss, 'general', { changes: { 'org.publicUrl': 'https://portal.example.org' } })).statusCode).toBe(200)
  })

  it('refuses a plain-http public URL away from this machine (D8): nobody could sign in there', async () => {
    await boot()
    for (const url of ['http://10.0.0.5:3000', 'http://portal.example.org', 'http://localhost.example.org', 'http://localhost@evil.example.org', 'ftp://10.0.0.5']) {
      const res = await put(boss, 'general', { changes: { 'org.publicUrl': url } })
      expect(res.statusCode, url).toBe(422)
      expect(res.json()).toEqual({ error: 'invalid_settings', issues: [{ key: 'org.publicUrl', message: 'https_required' }] })
    }
    expect(store.info('org.publicUrl').source).not.toBe('db')
    for (const url of ['https://portal.example.org', 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'http://yoda.localhost:3000']) {
      expect((await put(boss, 'general', { changes: { 'org.publicUrl': url } })).statusCode, url).toBe(200)
    }
  })

  it('warns about unpriced models and an embedding model change with embeddings stored', async () => {
    await boot()
    await store.set('ai.embeddingModel', 'openai:text-embedding-3-small', system)
    const db = await testDb()
    const [e] = await db
      .insert(knowledgeEntries)
      .values({ lineageId: randomUUID(), version: 1, scope: 'department', type: 'fact', title: 't', status: 'confirmed', sourceKind: 'person' })
      .returning()
    await db.insert(knowledgeChunks).values({ entryId: e!.id, idx: 0, text: 't', embedding: Array(1024).fill(0.1) })
    const res = await put(boss, 'ai', { changes: { 'ai.embeddingModel': 'openai:embed-unpriced-x', 'ai.modelDraft': 'anthropic:claude-opus-5-5' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().warnings).toEqual([
      { key: 'ai.embeddingModel', code: 'unpriced_model' },
      { key: 'ai.embeddingModel', code: 'embedding_model_changed', count: 1 },
    ])
  })

  it('rate limits saves per admin (30 / min)', async () => {
    await boot()
    for (let i = 0; i < 30; i++) expect((await put(boss, 'general', { changes: { 'work.dailyTaskCap': 5 + (i % 3) } })).statusCode).toBe(200)
    const res = await put(boss, 'general', { changes: { 'work.dailyTaskCap': 9 } })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toMatchObject({ error: 'rate_limited' })
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
  })
})

describe('GET /admin/settings/audit', () => {
  it('pages newest first, filters by category and key, and shows secrets as fingerprints only', async () => {
    await boot()
    for (let i = 1; i <= 5; i++) await put(boss, 'general', { changes: { 'work.dailyTaskCap': i } })
    await put(boss, 'email', { changes: { 'smtp.password': SMTP_PASSWORD } })
    await put(boss, 'email', { changes: { 'smtp.password': `${SMTP_PASSWORD}-2` } })

    const page1 = await app.inject({ url: '/admin/settings/audit?limit=3', headers: h(boss) })
    expect(page1.statusCode).toBe(200)
    const p1 = page1.json()
    expect(p1.entries).toHaveLength(3)
    expect(p1.entries[0]).toMatchObject({ key: 'smtp.password', category: 'email', action: 'set', oldValue: null, newValue: null, actor: { personId: boss.id, label: 'boss' } })
    expect(p1.entries[0].oldFp).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(p1.entries[0].newFp).not.toBe(p1.entries[0].oldFp)
    expect(p1.nextCursor).toBe(p1.entries[2].id)
    const p2 = (await app.inject({ url: `/admin/settings/audit?limit=3&cursor=${p1.nextCursor}`, headers: h(boss) })).json()
    const p3 = (await app.inject({ url: `/admin/settings/audit?limit=3&cursor=${p2.nextCursor}`, headers: h(boss) })).json()
    expect(p3.nextCursor).toBeNull()
    const all = [...p1.entries, ...p2.entries, ...p3.entries]
    expect(all).toHaveLength(7)
    expect(new Set(all.map((e) => e.id)).size).toBe(7)
    expect(all.map((e) => e.id)).toEqual([...all.map((e) => e.id)].sort((a, b) => b - a))

    const email = (await app.inject({ url: '/admin/settings/audit?category=email', headers: h(boss) })).json()
    expect(email.entries.map((e: { key: string }) => e.key)).toEqual(['smtp.password', 'smtp.password'])
    const byKey = (await app.inject({ url: '/admin/settings/audit?key=work.dailyTaskCap', headers: h(boss) })).json()
    expect(byKey.entries.map((e: { newValue: number }) => e.newValue)).toEqual([5, 4, 3, 2, 1])

    const raw = JSON.stringify(all) + JSON.stringify(await (await testDb()).select().from(settingsAudit))
    expect(raw).not.toContain(SMTP_PASSWORD)
    expect((await app.inject({ url: '/admin/settings/audit?limit=500', headers: h(boss) })).statusCode).toBe(400)
  })
})

/** A small OIDC provider: discovery, JWKS and an authorization endpoint that knows one client. */
async function fakeOidc(clientId: string, opts: { issuerSuffix?: string } = {}) {
  let base = ''
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/realms/yoda/.well-known/openid-configuration')
      return send(200, {
        issuer: `${base}/realms/yoda${opts.issuerSuffix ?? ''}`,
        jwks_uri: `${base}/realms/yoda/protocol/openid-connect/certs`,
        authorization_endpoint: `${base}/realms/yoda/protocol/openid-connect/auth`,
      })
    if (url.pathname === '/realms/yoda/protocol/openid-connect/certs') return send(200, await testJwksDocument())
    if (url.pathname === '/realms/yoda/protocol/openid-connect/auth') {
      if (url.searchParams.get('client_id') !== clientId) return send(400, { error: 'invalid client' })
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end('<html>sign in</html>')
    }
    send(404, {})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { issuer: `${base}/realms/yoda`, close: () => new Promise<void>((r) => server.close(() => r())) }
}

/** An OpenAI-compatible models list and an Anthropic one. */
async function fakeModels() {
  const seen: { path: string; auth: string | undefined }[] = []
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', auth: (req.headers.authorization ?? req.headers['x-api-key']) as string | undefined })
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url?.startsWith('/v1/models')) return res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }] }))
    res.end(JSON.stringify({ data: [{ id: 'text-embedding-3-small' }] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, seen, close: () => new Promise<void>((r) => server.close(() => r())) }
}

describe('POST /admin/settings/:category/test', () => {
  it('blocks SSRF targets: metadata, link-local, service names, and loopback outside dev', async () => {
    await boot()
    await store.set('gitlab.token', GITLAB_TOKEN, system)
    const codeFor = async (url: string) => {
      const res = await test(boss, 'gitlab', { values: { 'gitlab.url': url, 'gitlab.token': 'candidate-placeholder' } })
      expect(res.statusCode).toBe(200)
      return res.json().checks[0].code
    }
    expect(await codeFor('http://169.254.169.254')).toBe('blocked_address')
    expect(await codeFor('http://[fd00:ec2::254]')).toBe('blocked_address')
    expect(await codeFor('http://metadata.google.internal')).toBe('blocked_host')
    expect(await codeFor('http://postgres:5432')).toBe('blocked_host')
    expect(await codeFor('http://rustfs:9000')).toBe('blocked_host')
    // Decimal, octal and hex spellings of the metadata address.
    for (const url of ['http://2852039166/', 'http://0251.0376.0251.0376/', 'http://0xa9fea9fe/', 'http://0xa9.0xfe.0xa9.0xfe/', 'http://169.254.43518/']) {
      expect(await codeFor(url), url).toBe('blocked_address')
    }
    await app.close()
    await boot({}, { outbound: {} })
    await store.set('gitlab.token', GITLAB_TOKEN, system)
    expect(await codeFor(gl.url)).toBe('blocked_address')
    expect(gl.requests).toEqual([])
  })

  it('gitlab: user and scopes with the saved token; a draft endpoint never gets the saved token', async () => {
    await boot()
    gl.requireToken(GITLAB_TOKEN)
    await store.set('gitlab.url', gl.url, system)
    await store.set('gitlab.token', GITLAB_TOKEN, system)
    const res = await test(boss, 'gitlab')
    expect(res.json()).toEqual({
      action: 'gitlab',
      ok: true,
      checks: [
        { id: 'user', ok: true, ms: expect.any(Number), detail: { username: 'yoda-bot' } },
        { id: 'scopes', ok: true, ms: expect.any(Number), detail: { scopes: ['api'], expiresAt: '2027-06-30' } },
      ],
    })
    expect(JSON.stringify(res.json())).not.toContain(GITLAB_TOKEN)

    gl.tokenScopes = ['read_api']
    expect((await test(boss, 'gitlab')).json().checks[1]).toMatchObject({ ok: false, code: 'missing_scope' })

    const other = await startFakeGitLab()
    try {
      const moved = await test(boss, 'gitlab', { values: { 'gitlab.url': other.url } })
      expect(moved.json()).toMatchObject({ ok: false, checks: [{ id: 'user', code: 'secret_required' }] })
      expect(other.requests).toEqual([])
      // A draft server answers with booleans only: nothing it sends is reflected back.
      const draft = (await test(boss, 'gitlab', { values: { 'gitlab.url': other.url, 'gitlab.token': 'draft-placeholder' } })).json()
      expect(draft.ok).toBe(true)
      expect(draft.checks.map((c: { detail?: unknown }) => c.detail)).toEqual([undefined, undefined])
      // A draft token is used as given.
      const wrong = await test(boss, 'gitlab', { values: { 'gitlab.token': 'wrong-placeholder' } })
      expect(wrong.json().checks[0]).toMatchObject({ ok: false, code: 'auth_rejected' })
    } finally {
      await other.stop()
    }
  })

  it('audits every test run with its result and no values', async () => {
    await boot()
    await test(boss, 'gitlab', { values: { 'gitlab.url': 'http://169.254.169.254', 'gitlab.token': 'candidate-placeholder' } })
    const rows = await (await testDb()).select().from(settingsAudit).where(eq(settingsAudit.action, 'test'))
    expect(rows).toMatchObject([{ actorPerson: boss.id, key: null, result: 'blocked_address', newValue: { test: 'gitlab', category: 'gitlab' } }])
    expect(JSON.stringify(rows)).not.toContain('candidate-placeholder')
    const page = (await app.inject({ url: '/admin/settings/audit?category=gitlab', headers: h(boss) })).json()
    expect(page.entries).toMatchObject([{ action: 'test', category: 'gitlab', result: 'blocked_address' }])
  })

  it('telegram: getMe fills the read-only bot username through the internal path; the webhook registers', async () => {
    await boot({ PORTAL_URL: 'https://portal.example.org' })
    tg.requireToken(TG_TOKEN)
    await store.set('telegram.botToken', TG_TOKEN, system)
    await store.set('telegram.webhookSecret', 'webhook_secret_placeholder_01', system)
    const res = await test(boss, 'telegram')
    expect(res.json().checks).toMatchObject([
      { id: 'bot', ok: true, detail: { username: 'yoda_test_bot' } },
      { id: 'webhook', ok: false, code: 'webhook_not_registered', detail: { registered: false } },
    ])
    expect(JSON.stringify(res.json())).not.toContain(TG_TOKEN)
    expect(store.info('telegram.botUsername')).toMatchObject({ source: 'db', value: 'yoda_test_bot', updatedByLabel: 'system' })
    const [derived] = await (await testDb()).select().from(settingsAudit).where(eq(settingsAudit.key, 'telegram.botUsername'))
    expect(derived).toMatchObject({ action: 'derived', actorLabel: 'system', newValue: 'yoda_test_bot' })

    // It sends the webhook secret: a recent sign-in is needed.
    const old = await signIn(app, 'boss', { authAgoS: 3600 })
    expect((await app.inject({ method: 'POST', url: '/admin/settings/telegram/webhook', headers: h(old) })).statusCode).toBe(401)
    expect(tg.webhook).toBeNull()
    const reg = await app.inject({ method: 'POST', url: '/admin/settings/telegram/webhook', headers: h(boss) })
    expect(reg.json()).toMatchObject({ ok: true, checks: [{ id: 'webhook', ok: true }] })
    // Pending updates are kept unless the admin confirmed dropping them.
    expect(tg.webhook).toMatchObject({ url: 'https://portal.example.org/api/webhooks/telegram', secret_token: 'webhook_secret_placeholder_01', drop_pending_updates: false })
    await app.inject({ method: 'POST', url: '/admin/settings/telegram/webhook', headers: h(boss), payload: { dropPending: true } })
    expect(tg.webhook).toMatchObject({ drop_pending_updates: true })
    expect((await test(boss, 'telegram')).json()).toMatchObject({ ok: true })

    // A failed save of the username does not fail the bot check.
    tg.username = 'renamed_test_bot'
    const spy = vi.spyOn(store, 'setDerived').mockRejectedValueOnce(new Error('db down'))
    expect((await test(boss, 'telegram')).json().checks[0]).toMatchObject({ id: 'bot', ok: true })
    spy.mockRestore()
    tg.username = 'yoda_test_bot'

    // A draft token does not write the username.
    tg.username = 'other_test_bot'
    tg.requireToken(null)
    await test(boss, 'telegram', { values: { 'telegram.botToken': '999:draft-placeholder' } })
    expect(store.get('telegram.botUsername')).toBe('yoda_test_bot')
  })

  it('line: bot info', async () => {
    await boot()
    line.requireToken('line-token-placeholder')
    expect((await test(boss, 'line')).json()).toMatchObject({ ok: false, checks: [{ code: 'not_configured' }] })
    const res = await test(boss, 'line', { values: { 'line.accessToken': 'line-token-placeholder' } })
    expect(res.json()).toMatchObject({ ok: true, checks: [{ id: 'bot', ok: true, detail: { basicId: '@yoda-test' } }] })
    expect((await test(boss, 'line', { values: { 'line.accessToken': 'nope' } })).json().checks[0].code).toBe('auth_rejected')
    // The API base URL is bootstrap-only: a draft value for it is ignored, so the token cannot be sent elsewhere.
    const other = await startFakeLine()
    try {
      await store.set('line.accessToken', 'line-token-placeholder', system)
      expect((await test(boss, 'line', { values: { 'line.apiUrl': other.url } })).json()).toMatchObject({ ok: true })
      expect(other.requests).toEqual([])
    } finally {
      await other.stop()
    }
  })

  it('smtp: connect and auth with the saved password, wrong password rejected, optional send to self', async () => {
    const smtp = new FakeSmtp({ user: 'yoda', pass: SMTP_PASSWORD })
    await smtp.start()
    try {
      await boot()
      await store.apply(
        [
          { key: 'smtp.host', value: '127.0.0.1' },
          // Any port on loopback in dev (the fakes); elsewhere only the SMTP ports.
          { key: 'smtp.port', value: smtp.port },
          { key: 'smtp.user', value: 'yoda' },
          { key: 'smtp.password', value: SMTP_PASSWORD },
          { key: 'smtp.from', value: 'yoda@example.org' },
        ],
        system,
      )
      const ok = (await test(boss, 'email')).json()
      expect(ok).toEqual({ action: 'smtp', ok: true, checks: [{ id: 'connect', ok: true, ms: expect.any(Number), detail: { auth: true } }] })
      const bad = (await test(boss, 'email', { values: { 'smtp.password': 'wrong-placeholder' } })).json()
      expect(bad.checks[0]).toMatchObject({ ok: false, code: 'auth_rejected' })
      const sent = (await test(boss, 'email', { sendTo: 'self' })).json()
      expect(sent.checks).toMatchObject([{ id: 'connect', ok: true }, { id: 'send', ok: true }])
      expect(smtp.messages).toHaveLength(1)
      expect(smtp.messages[0]!.to).toEqual(['TO:<boss@example.org>'])
      // A draft host never gets the saved password.
      const moved = (await test(boss, 'email', { values: { 'smtp.host': 'localhost' } })).json()
      expect(moved.checks[0]).toMatchObject({ ok: false, code: 'secret_required' })
      // Nor a draft port or TLS mode (another listener).
      for (const values of [{ 'smtp.port': 2525 }, { 'smtp.secure': true }]) {
        expect((await test(boss, 'email', { values })).json().checks[0]).toMatchObject({ ok: false, code: 'secret_required' })
      }
      // Not an SMTP port on a non-loopback host: refused before connecting.
      const port = (await test(boss, 'email', { values: { 'smtp.host': '10.255.255.1', 'smtp.port': 5432, 'smtp.password': 'x-placeholder' } })).json()
      expect(port.checks[0]).toMatchObject({ ok: false, code: 'blocked_port' })
    } finally {
      await smtp.stop()
    }
  })

  it('oidc: discovery, JWKS and client; an issuer mismatch fails', async () => {
    await boot()
    const idp = await fakeOidc('yoda-portal')
    const bad = await fakeOidc('yoda-portal', { issuerSuffix: '-other' })
    try {
      const res = await test(boss, 'signin', { values: { 'oidc.issuer': idp.issuer, 'oidc.clientId': 'yoda-portal' } })
      // A draft issuer: booleans only, so the key count is not reflected.
      expect(res.json()).toMatchObject({ ok: true, checks: [{ id: 'discovery', ok: true }, { id: 'jwks', ok: true }, { id: 'client', ok: true }] })
      expect(res.json().checks[1].detail).toBeUndefined()
      const wrongClient = await test(boss, 'signin', { values: { 'oidc.issuer': idp.issuer, 'oidc.clientId': 'nope' } })
      expect(wrongClient.json().checks[2]).toMatchObject({ ok: false, code: 'client_rejected' })
      const mismatch = await test(boss, 'signin', { values: { 'oidc.issuer': bad.issuer, 'oidc.clientId': 'yoda-portal' } })
      expect(mismatch.json()).toMatchObject({ ok: false, checks: [{ id: 'discovery', ok: false, code: 'issuer_mismatch' }] })
    } finally {
      await idp.close()
      await bad.close()
    }
  })

  it('ai: lists models (no tokens spent) and checks the configured ones', async () => {
    const models = await fakeModels()
    try {
      await boot({}, { anthropicUrl: models.url })
      await store.set('ai.anthropicApiKey', 'sk-ant-placeholder-0000', system)
      const res = await test(boss, 'ai', { values: { 'ai.modelFast': 'anthropic:claude-missing-1' } })
      expect(res.json()).toMatchObject({
        ok: false,
        checks: [
          { id: 'anthropic', ok: true, detail: { models: 2 } },
          { id: 'model.draft', ok: true, detail: { priced: true } },
          { id: 'model.fast', ok: false, code: 'model_not_found' },
        ],
      })
      const openai = await test(boss, 'ai', {
        values: { 'ai.openaiBaseUrl': `${models.url}/openai`, 'ai.openaiApiKey': 'sk-placeholder-openai-1', 'ai.embeddingModel': 'openai:text-embedding-3-small' },
      })
      expect(openai.json().checks).toContainEqual(expect.objectContaining({ id: 'openai', ok: true }))
      expect(openai.json().checks).toContainEqual(expect.objectContaining({ id: 'model.embed', ok: true }))
      expect(models.seen.every((s) => s.path.includes('models'))).toBe(true)
    } finally {
      await models.close()
    }
  })

  it('backups validate the config; storage heads the bucket (D9) and takes no draft values', async () => {
    await boot()
    expect((await test(boss, 'backups')).json()).toMatchObject({ ok: true, checks: [{ id: 'config', ok: true }] })
    expect((await test(boss, 'backups', { values: { 'backup.at': '25:00' } })).statusCode).toBe(422)
    expect((await test(boss, 'storage', { values: { 'storage.s3Bucket': 'other' } })).json()).toMatchObject({ ok: true, checks: [{ id: 'bucket', ok: true }] })
    expect((await test(boss, 'runners')).statusCode).toBe(404)
  })

  it('rate limits tests per admin (10 / min)', async () => {
    await boot()
    for (let i = 0; i < 10; i++) expect((await test(boss, 'backups')).statusCode).toBe(200)
    const res = await test(boss, 'backups')
    expect(res.statusCode).toBe(429)
    expect(res.json().error).toBe('rate_limited')
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(60)
    expect(res.json().retryAfter).toBe(Number(res.headers['retry-after']))
  })
})

describe('POST /admin/settings/:category/generate/:key', () => {
  it('generates a webhook secret, returns it once, and needs a recent sign-in', async () => {
    await boot()
    const old = await signIn(app, 'boss', { authAgoS: 3600 })
    expect((await app.inject({ method: 'POST', url: '/admin/settings/gitlab/generate/gitlab.webhookSecret', headers: h(old) })).statusCode).toBe(401)
    const res = await app.inject({ method: 'POST', url: '/admin/settings/gitlab/generate/gitlab.webhookSecret', headers: h(boss) })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const { value, version } = res.json()
    expect(value).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(version).toBe(1)
    expect(store.get('gitlab.webhookSecret')).toBe(value)
    const list = await app.inject({ url: '/admin/settings', headers: h(boss) })
    expect(list.body).not.toContain(value)
    expect((await app.inject({ method: 'POST', url: '/admin/settings/gitlab/generate/gitlab.token', headers: h(boss) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/admin/settings/email/generate/gitlab.webhookSecret', headers: h(boss) })).statusCode).toBe(404)
    const [row] = await (await testDb()).select().from(settings).where(eq(settings.key, 'gitlab.webhookSecret'))
    expect(row!.ciphertext).toBeTruthy()
  })
})
