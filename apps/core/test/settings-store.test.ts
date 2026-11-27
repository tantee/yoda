import { SETTING_KEYS, byEnvName, settingDef } from '@yoda/shared'
import { readFileSync } from 'node:fs'
import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import { envSchema } from '../src/config.js'
import { people, projects, settings, settingsAudit, setupState } from '../src/db/schema.js'
import { masterKey, type MasterKeyLoad } from '../src/settings/crypto.js'
import {
  SecretsUnavailableError,
  SettingConflictError,
  SettingLockedError,
  SettingsStore,
  type SettingActor,
} from '../src/settings/store.js'
import { resetDb, testDb } from './helpers.js'

// Obviously fake 32-byte test keys.
const KEY_A: MasterKeyLoad = { status: 'ok', key: masterKey(Buffer.alloc(32, 0x11)) }
const KEY_B: MasterKeyLoad = { status: 'ok', key: masterKey(Buffer.alloc(32, 0x22)) }
const NO_KEY: MasterKeyLoad = { status: 'missing', reason: 'not set' }

const PASSWORD = 'smtp-password-placeholder-0001'
const TOKEN = 'gitlab-token-placeholder-abcd'
const admin: SettingActor = { personId: null, label: 'สมชาย', source: 'ui', ip: '10.0.0.5', requestId: 'req-1' }

function quietLog() {
  return { warn: vi.fn(), info: vi.fn() }
}

async function open(env: NodeJS.ProcessEnv = {}, key: MasterKeyLoad = KEY_A, log = quietLog()) {
  return SettingsStore.open({ db: await testDb(), env, masterKey: key, log })
}

async function auditRows() {
  const db = await testDb()
  return db.select().from(settingsAudit).orderBy(settingsAudit.id)
}

async function row(key: string) {
  const db = await testDb()
  const [r] = await db.select().from(settings).where(eq(settings.key, key))
  return r
}

describe('SettingsStore', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
  })

  describe('precedence env > db > default', () => {
    it('falls back to the default, then the stored value, and env wins over both', async () => {
      let s = await open()
      expect(s.get('smtp.port')).toBe(587)
      expect(s.info('smtp.port')).toMatchObject({ source: 'default', lock: null })
      expect(s.get('smtp.host')).toBeUndefined()
      expect(s.info('smtp.host').source).toBe('unset')

      await s.set('smtp.port', 2525, admin)
      expect(s.get('smtp.port')).toBe(2525)
      expect(s.info('smtp.port')).toMatchObject({ source: 'db', lock: null, version: 1, updatedByLabel: 'สมชาย', writeSource: 'ui' })

      s = await open({ SMTP_PORT: '465' })
      expect(s.get('smtp.port')).toBe(465)
      expect(s.info('smtp.port')).toMatchObject({ source: 'env', lock: 'env', envName: 'SMTP_PORT' })

      // An empty variable counts as unset, as in envSchema; the imported value stays in force.
      s = await open({ SMTP_PORT: '' })
      expect(s.get('smtp.port')).toBe(465)
      expect(s.info('smtp.port').source).toBe('db')
    })

    it('reads bootstrap-only settings from env or the default, never from a row', async () => {
      const db = await testDb()
      await db.insert(settings).values({ key: 'line.apiUrl', value: 'https://evil.example.org', source: 'ui' })
      const s = await open({ S3_BUCKET: 'yoda-demo' })
      expect(s.get('storage.s3Bucket')).toBe('yoda-demo')
      expect(s.get('line.apiUrl')).toBe('https://api.line.me')
      expect(s.info('line.apiUrl').lock).toBe('bootstrap')
    })

    it('never keeps the master key itself', async () => {
      const s = await open({ YODA_MASTER_KEY: Buffer.alloc(32, 0x11).toString('base64') })
      expect(s.get('security.masterKey')).toBeUndefined()
      expect(s.info('security.masterKey')).toMatchObject({ isSet: true, source: 'env', hint: null })
      expect(JSON.stringify(s.list())).not.toContain(Buffer.alloc(32, 0x11).toString('base64'))
    })

    it('ignores an invalid stored value with a warning and uses the default', async () => {
      const db = await testDb()
      await db.insert(settings).values({ key: 'smtp.port', value: 'not-a-port', source: 'ui' })
      const log = quietLog()
      const s = await open({}, KEY_A, log)
      expect(s.get('smtp.port')).toBe(587)
      expect(log.warn).toHaveBeenCalled()
    })

    it('stops on an invalid core env value, as envSchema does', async () => {
      await expect(open({ SMTP_PORT: 'nope' })).rejects.toThrow(/SMTP_PORT/)
    })
  })

  describe('set', () => {
    it('writes a value and an audit row with old and new', async () => {
      const s = await open()
      await s.set('work.dailyTaskCap', 10, admin)
      await s.set('work.dailyTaskCap', 12, admin)
      expect(s.get('work.dailyTaskCap')).toBe(12)
      expect((await row('work.dailyTaskCap'))).toMatchObject({ value: 12, version: 2, source: 'ui' })
      const audit = await auditRows()
      expect(audit.map((a) => [a.action, a.key, a.oldValue, a.newValue])).toEqual([
        ['set', 'work.dailyTaskCap', null, 10],
        ['set', 'work.dailyTaskCap', 10, 12],
      ])
      expect(audit[0]).toMatchObject({ actorLabel: 'สมชาย', source: 'ui', ip: '10.0.0.5', requestId: 'req-1' })
    })

    it('validates with the registry schema', async () => {
      const s = await open()
      await expect(s.set('runners.leaseSeconds', 10, admin)).rejects.toBeInstanceOf(ZodError)
      await expect(s.set('smtp.secure', 'maybe', admin)).rejects.toBeInstanceOf(ZodError)
    })

    it('refuses env-locked, bootstrap-only and read-only settings', async () => {
      const s = await open({ SMTP_HOST: 'smtp.example.org' })
      await expect(s.set('smtp.host', 'mail.example.org', admin)).rejects.toMatchObject({ reason: 'env', key: 'smtp.host' })
      await expect(s.set('storage.s3Bucket', 'other', admin)).rejects.toMatchObject({ reason: 'bootstrap' })
      await expect(s.set('line.apiUrl', 'https://evil.example.org', admin)).rejects.toBeInstanceOf(SettingLockedError)
      await expect(s.set('oidc.bootstrapAdmins', ['x'], admin)).rejects.toMatchObject({ reason: 'readonly' })
      await expect(s.clear('smtp.host', admin)).rejects.toMatchObject({ reason: 'env' })
      await expect(s.set('nope.key' as never, 1, admin)).rejects.toThrow(/unknown setting/)
      expect((await auditRows()).filter((a) => a.action !== 'import')).toEqual([])
    })

    it('refuses a stale version (optimistic concurrency)', async () => {
      const s = await open()
      await s.set('smtp.from', 'Yoda <yoda@example.org>', admin)
      await expect(s.set('smtp.from', 'x@example.org', admin, { expectedVersion: 0 })).rejects.toBeInstanceOf(SettingConflictError)
      await s.set('smtp.from', 'x@example.org', admin, { expectedVersion: 1 })
      expect(s.info('smtp.from').version).toBe(2)
    })

    it('clears a stored value back to the default', async () => {
      const s = await open()
      await s.set('smtp.port', 2525, admin)
      await s.clear('smtp.port', admin)
      expect(s.get('smtp.port')).toBe(587)
      expect(await row('smtp.port')).toBeUndefined()
      expect((await auditRows()).map((a) => [a.action, a.oldValue, a.newValue])).toEqual([
        ['set', null, 2525],
        ['clear', 2525, null],
      ])
    })
  })

  describe('secrets', () => {
    it('stores secrets encrypted, audits fingerprints only, logs no value', async () => {
      const log = quietLog()
      const s = await open({}, KEY_A, log)
      await s.set('smtp.password', PASSWORD, admin)
      await s.set('smtp.password', `${PASSWORD}-2`, admin)
      expect(s.get('smtp.password')).toBe(`${PASSWORD}-2`)

      const r = (await row('smtp.password'))!
      expect(r.value).toBeNull()
      expect(r.keyId).toBe(KEY_A.status === 'ok' && KEY_A.key.id)
      expect(r.ciphertext!.toString('utf8')).not.toContain('placeholder')
      expect(r.hint).toBe(`${PASSWORD}-2`.slice(-4))

      const audit = await auditRows()
      expect(audit).toHaveLength(2)
      expect(audit[0]!.oldFp).toBeNull()
      expect(audit[0]!.newFp).toMatch(/^[A-Za-z0-9_-]{22}$/)
      expect(audit[1]!.oldFp).toBe(audit[0]!.newFp)
      expect(audit.every((a) => a.oldValue === null && a.newValue === null)).toBe(true)
      const dump = JSON.stringify(audit) + JSON.stringify(log.warn.mock.calls) + JSON.stringify(log.info.mock.calls)
      expect(dump).not.toContain('placeholder')

      const info = s.info('smtp.password')
      expect(info).toMatchObject({ isSet: true, secret: true, source: 'db', hint: `${PASSWORD}-2`.slice(-4) })
      expect(info).not.toHaveProperty('value')
      expect(JSON.stringify(s.list())).not.toContain('placeholder')
    })

    it('shows no hint for short secrets', async () => {
      const s = await open()
      await s.set('gitlab.webhookSecret', 'sixteen-chars-xx', admin)
      expect(s.info('gitlab.webhookSecret').hint).toBeNull()
    })

    it('reads stored secrets back after a restart with the same key', async () => {
      await (await open()).set('gitlab.token', TOKEN, admin)
      expect((await open()).get('gitlab.token')).toBe(TOKEN)
    })
  })

  describe('master key', () => {
    it('writes the key canary on first open', async () => {
      const s = await open()
      expect(s.keyStatus).toBe('ok')
      expect(s.secretsUnavailable).toBe(false)
      const db = await testDb()
      const [st] = await db.select().from(setupState)
      expect(st!.keyCanary).toBeInstanceOf(Buffer)
      expect(st!.keyCanaryKeyId).toBe(KEY_A.status === 'ok' && KEY_A.key.id)
    })

    it('a wrong key fails the canary: recovery state, secret getters throw, nothing decrypted as garbage', async () => {
      await (await open()).set('gitlab.token', TOKEN, admin)
      const log = quietLog()
      const s = await open({ SMTP_PASSWORD: PASSWORD }, KEY_B, log)
      expect(s.keyStatus).toBe('mismatch')
      expect(s.secretsUnavailable).toBe(true)
      expect(s.recovery).toBe(true)
      expect(() => s.get('gitlab.token')).toThrow(SecretsUnavailableError)
      expect(s.info('gitlab.token')).toMatchObject({ isSet: true, unavailable: true })
      // Env secrets still work; they need no decryption.
      expect(s.get('smtp.password')).toBe(PASSWORD)
      // Non-secrets are unaffected.
      expect(s.get('smtp.port')).toBe(587)
      await expect(s.set('telegram.botToken', 'x', admin)).rejects.toBeInstanceOf(SecretsUnavailableError)
      // The wrong key never replaces the canary, and the env secret is not imported under it.
      const db = await testDb()
      const [st] = await db.select().from(setupState)
      expect(st!.keyCanaryKeyId).toBe(KEY_A.status === 'ok' && KEY_A.key.id)
      expect(await row('smtp.password')).toBeUndefined()
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain('placeholder')
    })

    it('a missing key with stored secrets is recovery; without any it is not', async () => {
      let s = await open({}, NO_KEY)
      expect(s.keyStatus).toBe('missing')
      expect(s.secretsUnavailable).toBe(true)
      expect(s.recovery).toBe(false)
      await expect(s.set('smtp.password', PASSWORD, admin)).rejects.toBeInstanceOf(SecretsUnavailableError)
      // Non-secret writes still work without a key.
      await s.set('smtp.port', 2525, admin)

      await (await open()).set('gitlab.token', TOKEN, admin)
      s = await open({}, NO_KEY)
      expect(s.recovery).toBe(true)
      expect(() => s.get('gitlab.token')).toThrow(SecretsUnavailableError)
      try {
        s.get('gitlab.token')
      } catch (err) {
        expect(String(err)).not.toContain('placeholder')
      }
    })

    it('a key used once and then missing, with no stored secrets, is not recovery (a canary alone does not force it)', async () => {
      await open()
      const db = await testDb()
      expect((await db.select().from(setupState))[0]!.keyCanary).toBeInstanceOf(Buffer)
      expect((await open({}, NO_KEY)).recovery).toBe(false)
      await (await open()).set('smtp.password', PASSWORD, admin)
      expect((await open({}, NO_KEY)).recovery).toBe(true)
    })

    it('forced recovery mode is recovery whatever the key', async () => {
      await open()
      const db = await testDb()
      await db.update(setupState).set({ recoveryMode: true })
      expect((await open()).recovery).toBe(true)
      expect((await open({}, NO_KEY)).recovery).toBe(true)
    })

    it('shows no hint for bootstrap-only secrets', async () => {
      const s = await open({ S3_SECRET_KEY: 'placeholder-rustfs-secret-key-0123', DATABASE_URL: 'postgres://u:placeholder-password-1234@db/yoda' })
      expect(s.info('storage.s3SecretKey')).toMatchObject({ isSet: true, hint: null })
      expect(s.info('boot.databaseUrl')).toMatchObject({ isSet: true, hint: null })
    })

    it('a non-string secret is a validation error', async () => {
      const s = await open()
      await expect(s.set('smtp.password', 12345678 as never, admin)).rejects.toBeInstanceOf(ZodError)
      await expect(s.set('smtp.password', { v: 'x' } as never, admin)).rejects.toBeInstanceOf(ZodError)
    })

    it('importFromEnv refreshes the snapshot', async () => {
      const s = await open()
      const db = await testDb()
      await db.insert(settings).values({ key: 'smtp.from', value: 'old@example.org', source: 'ui' })
      expect(s.get('smtp.from')).toBeUndefined()
      await s.importFromEnv()
      expect(s.get('smtp.from')).toBe('old@example.org')
    })

    it('a malformed key is recovery', async () => {
      const s = await open({}, { status: 'malformed', reason: 'YODA_MASTER_KEY: not base64' })
      expect(s.keyStatus).toBe('malformed')
      expect(s.recovery).toBe(true)
    })

    it('a row encrypted under another key id is unavailable, not garbage', async () => {
      await (await open()).set('gitlab.token', TOKEN, admin)
      const db = await testDb()
      await db.update(settings).set({ keyId: 'ffffffffffffffff' }).where(eq(settings.key, 'gitlab.token'))
      const log = quietLog()
      const s = await open({}, KEY_A, log)
      expect(s.keyStatus).toBe('ok')
      expect(() => s.get('gitlab.token')).toThrow(SecretsUnavailableError)
      expect(log.warn).toHaveBeenCalled()
    })
  })

  describe('import on boot (D4, §6.2)', () => {
    const env = {
      SMTP_HOST: 'smtp.example.org',
      SMTP_PASSWORD: PASSWORD,
      GITLAB_URL: 'https://gitlab.example.org/',
      PORTAL_URL: 'https://portal.example.org',
      DATABASE_URL: 'postgres://u:p@db:5432/yoda',
      S3_ACCESS_KEY: 'placeholder-access',
      S3_SECRET_KEY: 'placeholder-secret',
      LINE_API_URL: 'http://127.0.0.1:4110',
      YODA_MASTER_KEY: Buffer.alloc(32, 0x11).toString('base64'),
    }

    it('copies env values into the database, secrets encrypted, and audits them as import', async () => {
      const s = await open(env)
      expect(s.info('smtp.host')).toMatchObject({ source: 'env', lock: 'env' })
      expect(await row('smtp.host')).toMatchObject({ value: 'smtp.example.org', source: 'import', updatedByLabel: 'system' })
      expect(await row('gitlab.url')).toMatchObject({ value: 'https://gitlab.example.org' })
      expect(await row('org.publicUrl')).toMatchObject({ value: 'https://portal.example.org' })
      const pw = (await row('smtp.password'))!
      expect(pw.value).toBeNull()
      expect(pw.ciphertext).toBeInstanceOf(Buffer)
      const audit = await auditRows()
      expect(audit.every((a) => a.action === 'import' && a.source === 'import' && a.actorLabel === 'system')).toBe(true)
      expect(audit.map((a) => a.key).sort()).toEqual(['gitlab.url', 'org.publicUrl', 'smtp.host', 'smtp.password'])
      expect(JSON.stringify(audit)).not.toContain('placeholder')
    })

    it('never imports bootstrap-only settings', async () => {
      await open(env)
      for (const key of ['boot.databaseUrl', 'storage.s3AccessKey', 'storage.s3SecretKey', 'line.apiUrl', 'security.masterKey']) {
        expect(await row(key), key).toBeUndefined()
      }
    })

    it('is idempotent and re-imports a changed value', async () => {
      await open(env)
      await open(env)
      expect(await auditRows()).toHaveLength(4)
      await open({ ...env, SMTP_HOST: 'mail.example.org', SMTP_PASSWORD: `${PASSWORD}-new` })
      const audit = await auditRows()
      expect(audit).toHaveLength(6)
      expect(audit.slice(4).map((a) => [a.key, a.oldValue, a.newValue])).toEqual([
        ['smtp.host', 'smtp.example.org', 'mail.example.org'],
        ['smtp.password', null, null],
      ])
      expect(audit[5]!.oldFp).not.toBe(audit[5]!.newFp)
    })

    it('keeps the imported value in force after the variable is removed', async () => {
      await open(env)
      const s = await open({})
      expect(s.get('smtp.host')).toBe('smtp.example.org')
      expect(s.get('smtp.password')).toBe(PASSWORD)
      expect(s.info('smtp.host')).toMatchObject({ source: 'db', lock: null, writeSource: 'import' })
    })

    it('YODA_SETTINGS_IMPORT=false copies non-secrets but no secrets', async () => {
      const s = await open({ ...env, YODA_SETTINGS_IMPORT: 'false' })
      expect(s.get('smtp.password')).toBe(PASSWORD)
      expect(await row('smtp.password')).toBeUndefined()
      expect(await row('smtp.host')).toMatchObject({ value: 'smtp.example.org' })
    })

    it('without a master key imports non-secrets only', async () => {
      const s = await open(env, NO_KEY)
      expect(s.get('smtp.password')).toBe(PASSWORD)
      expect(await row('smtp.password')).toBeUndefined()
      expect(await row('smtp.host')).toBeDefined()
    })
  })

  describe('setup state (§6.5)', () => {
    it('a fresh database is not set up', async () => {
      const s = await open({ OIDC_ISSUER: 'https://sso.example.org/realms/yoda' })
      expect(s.setupDone).toBe(false)
      expect(s.installId).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('an existing env install with an admin is marked done by the upgrade', async () => {
      const db = await testDb()
      await db.insert(people).values({ keycloakSub: 'sub-boss', username: 'boss', displayName: 'Boss', isAdmin: true })
      const s = await open({ OIDC_ISSUER: 'https://sso.example.org/realms/yoda' })
      expect(s.setupDone).toBe(true)
      const [st] = await db.select().from(setupState)
      expect(st).toMatchObject({ setupCompletedSource: 'upgrade' })
      expect(st!.setupCompletedAt).toBeInstanceOf(Date)
      expect((await auditRows()).filter((a) => a.action === 'setup.completed')).toMatchObject([{ source: 'upgrade', actorLabel: 'system' }])
      // Only once.
      await open({ OIDC_ISSUER: 'https://sso.example.org/realms/yoda' })
      expect((await auditRows()).filter((a) => a.action === 'setup.completed')).toHaveLength(1)
    })

    it('an existing env install with projects is marked done too', async () => {
      const db = await testDb()
      await db.insert(projects).values({ name: 'ระบบนัดหมาย' })
      expect((await open({ OIDC_ISSUER: 'https://sso.example.org/realms/yoda' })).setupDone).toBe(true)
    })

    it('data without env sign-in config is not an upgrade', async () => {
      const db = await testDb()
      await db.insert(people).values({ keycloakSub: 'sub-boss', username: 'boss', displayName: 'Boss', isAdmin: true })
      expect((await open({})).setupDone).toBe(false)
    })
  })

  describe('settings_audit', () => {
    it('is append-only', async () => {
      const s = await open()
      await s.set('smtp.port', 2525, admin)
      const db = await testDb()
      await expect(db.execute(sql`update settings_audit set actor_label = 'x'`)).rejects.toThrow()
      await expect(db.execute(sql`delete from settings_audit`)).rejects.toThrow()
      expect(await auditRows()).toHaveLength(1)
    })

    it('lets a deleted person become null on old rows', async () => {
      const db = await testDb()
      const [p] = await db.insert(people).values({ keycloakSub: 'sub-x', username: 'x', displayName: 'X' }).returning()
      const s = await open()
      await s.set('smtp.port', 2525, { ...admin, personId: p!.id })
      await db.delete(people).where(eq(people.id, p!.id))
      const [a] = await auditRows()
      expect(a!.actorPerson).toBeNull()
      expect(a!.actorLabel).toBe('สมชาย')
    })
  })
})

describe('registry and envSchema agree', () => {
  const core = SETTING_KEYS.map(settingDef).filter((d) => d.scope === 'core' && d.envName)

  it('the registry accepts every value envSchema accepts (.env.example and edge values)', () => {
    const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')
    const samples: [string, string][] = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1]!, m[2]!])
    samples.push(
      ['BOOTSTRAP_ADMINS', ' somchai , dev1 ,, '],
      ['BOOTSTRAP_ADMINS', ','],
      ['OIDC_ISSUER', 'https://sso.example.org/realms/yoda/'],
      ['GITLAB_URL', 'https://gitlab.example.org//'],
      ['PORTAL_URL', 'http://10.0.0.5:3000/'],
      ['OPENAI_BASE_URL', 'https://llm.example.org/v1/'],
      ['TELEGRAM_BOT_USERNAME', '@yoda_demo_bot'],
      ['TELEGRAM_BOT_USERNAME', 'yoda_demo_bot'],
      ['STAFF_GROUP', ' /it-dev '],
      ['SMTP_HOST', ' smtp.example.org'],
      ['SMTP_USER', ' '],
      ['MAIL_FROM', 'Yoda <yoda@example.org>'],
      ['ANTHROPIC_API_KEY', ' x '],
      ['SMTP_PORT', ' 465 '],
      ['AI_WORKERS', '4.0'],
      ['RUNNER_LEASE_SECONDS', '86400'],
      ['PORT', '0'],
      ['AI_EMBEDDING_MODEL', 'openai:text-embedding-3-small'],
      ['GITLAB_WEBHOOK_SECRET', ' '.repeat(16)],
      ['TELEGRAM_WEBHOOK_SECRET', 'a'.repeat(256)],
      ['DATABASE_URL', 'postgres://yoda:yoda@localhost:5432/yoda'],
      ['S3_ENDPOINT', 'http://rustfs:9000'],
      ['YODA_SETTINGS_IMPORT', 'false'],
      ['YODA_MASTER_KEY_FILE', '/run/yoda/core/master-key'],
    )
    const coreNames = new Set(core.map((d) => d.envName!))
    const mismatches: string[] = []
    let checked = 0
    for (const [name, value] of samples) {
      // Empty means unset to both (the store skips it; envSchema's optional() does too).
      if (!coreNames.has(name) || value === '') continue
      if (!envSchema.shape[name as keyof typeof envSchema.shape].safeParse(value).success) continue
      checked++
      if (!byEnvName(name)!.schema.safeParse(value).success) mismatches.push(`${name}=${JSON.stringify(value)}`)
    }
    expect(checked).toBeGreaterThan(40)
    expect(mismatches).toEqual([])
  })

  it('on every default', () => {
    for (const d of core) {
      const field = envSchema.shape[d.envName as keyof typeof envSchema.shape]
      const r = field.safeParse(undefined)
      const envDefault = r.success ? r.data : undefined
      const expected = envDefault === undefined ? undefined : d.schema.parse(envDefault)
      expect(d.default, d.envName).toEqual(expected)
    }
  })

  it('on invalid values', () => {
    const bad: Record<string, string> = {
      PORT: '70000',
      OIDC_ISSUER: 'not a url',
      AI_MODEL_DRAFT: 'gpt-4',
      AI_WORKERS: '0',
      DAILY_TASK_CAP: '1001',
      GITLAB_WEBHOOK_SECRET: 'short',
      RUNNER_LEASE_SECONDS: '179',
      MCP_ENABLED: 'yes',
      SMTP_PORT: '0',
      SMTP_SECURE: 'on',
      TELEGRAM_BOT_USERNAME: 'a b',
      TELEGRAM_WEBHOOK_SECRET: 'short',
      LINE_API_URL: 'nope',
    }
    for (const [name, value] of Object.entries(bad)) {
      expect(envSchema.shape[name as keyof typeof envSchema.shape].safeParse(value).success, name).toBe(false)
      expect(byEnvName(name)!.schema.safeParse(value).success, name).toBe(false)
    }
  })
})
