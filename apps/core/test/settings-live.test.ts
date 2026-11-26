import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiGateway } from '../src/ai/gateway.js'
import { buildModels } from '../src/ai/models.js'
import { buildApp, type AppDeps } from '../src/app.js'
import { loadConfig, type Config } from '../src/config.js'
import { pgClient } from '../src/db/client.js'
import { settings } from '../src/db/schema.js'
import { GitLabClient } from '../src/gitlab/client.js'
import { LiveBus } from '../src/live/bus.js'
import { emailChannel, type MailMessage, type MailTransport } from '../src/notifications/channels/email.js'
import { masterKey, type MasterKeyLoad } from '../src/settings/crypto.js'
import { LiveSettings, type LiveBuilders } from '../src/settings/live.js'
import { SettingsStore, type SettingActor } from '../src/settings/store.js'
import { localJwks, signToken, TEST_ISSUER } from './jwt.js'
import { resetDb, testConfig, testDb, testDeps } from './helpers.js'

// Obviously fake 32-byte test key and placeholder credentials.
const KEY: MasterKeyLoad = { status: 'ok', key: masterKey(Buffer.alloc(32, 0x33)) }
const admin: SettingActor = { personId: null, label: 'admin', source: 'ui' }
const quiet = () => ({ warn: vi.fn(), info: vi.fn() })

const opened: LiveSettings[] = []
let channel: string

async function open(env: NodeJS.ProcessEnv = {}) {
  return SettingsStore.open({ db: await testDb(), env, masterKey: KEY, log: quiet(), channel })
}

/** A fake SMTP transport that records sends; `hold` keeps the next send open until released. */
function fakeTransport(host: string | undefined) {
  const sent: MailMessage[] = []
  let gate: Promise<void> | null = null
  let release = () => {}
  const t: MailTransport & { host?: string; sent: MailMessage[]; hold(): () => void } = {
    host,
    sent,
    async sendMail(msg) {
      if (gate) await gate
      sent.push(msg)
      return {}
    },
    hold() {
      gate = new Promise<void>((r) => (release = r))
      return () => {
        gate = null
        release()
      }
    },
  }
  return t
}

type FakeMail = ReturnType<typeof fakeTransport>

function builders(opts: { gitlabFetch?: typeof fetch } = {}) {
  const transports: FakeMail[] = []
  const jwksFor: string[] = []
  const build: Partial<LiveBuilders> = {
    jwks: (c) => (jwksFor.push(c.oidcIssuer), localJwks),
    models: (c) => buildModels(c, () => {}),
    gitlab: (c) => (c.gitlabUrl && c.gitlabToken ? new GitLabClient({ baseUrl: c.gitlabUrl, token: c.gitlabToken, fetch: opts.gitlabFetch, retryBaseMs: 1 }) : null),
    mailTransport: (c) => {
      if (!c.smtpHost || !c.mailFrom) return undefined
      const t = fakeTransport(c.smtpHost)
      transports.push(t)
      return t
    },
  }
  return { build, transports, jwksFor }
}

async function live(store: SettingsStore, build: Partial<LiveBuilders>, base: Config = testConfig(), debounceMs = 20) {
  const l = new LiveSettings({ store, base, build, log: quiet(), debounceMs })
  opened.push(l)
  return l
}

beforeEach(async () => {
  await resetDb(await testDb())
  channel = `settings_test_${randomUUID().replace(/-/g, '')}`
})
afterEach(async () => {
  for (const l of opened.splice(0)) await l.close()
})

describe('live settings', () => {
  it('builds the same Config as loadConfig for an env-only install', async () => {
    const env = {
      DATABASE_URL: 'postgres://yoda:yoda@localhost:5432/yoda_test',
      OIDC_ISSUER: 'https://sso.example.org/realms/yoda/',
      OIDC_CLIENT_ID: 'yoda-portal',
      OIDC_JWKS_URL: 'http://keycloak:8080/realms/yoda/protocol/openid-connect/certs',
      STAFF_GROUP: '/it-dev',
      BOOTSTRAP_ADMINS: ' boss, ,second ',
      ANTHROPIC_API_KEY: 'anthropic-placeholder-key',
      AI_EMBEDDING_MODEL: 'openai:text-embedding-3-small',
      OPENAI_API_KEY: 'openai-placeholder-key',
      OPENAI_BASE_URL: 'https://llm.example.org/v1/',
      S3_ACCESS_KEY: 'access-placeholder',
      S3_SECRET_KEY: 'secret-placeholder',
      AI_WORKERS: '3',
      GITLAB_URL: 'https://gitlab.example.org/',
      GITLAB_TOKEN: 'gitlab-placeholder-token',
      GITLAB_WEBHOOK_SECRET: 'webhook-placeholder-secret',
      PORTAL_URL: 'https://yoda.example.org/',
      MCP_ENABLED: 'false',
      SMTP_HOST: 'smtp.example.org',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_USER: 'yoda',
      SMTP_PASSWORD: 'smtp-placeholder-password',
      MAIL_FROM: 'yoda@example.org',
      TELEGRAM_BOT_USERNAME: '@yoda_demo_bot',
      TELEGRAM_WEBHOOK_SECRET: 'telegram_placeholder_secret',
      LINE_API_URL: 'http://127.0.0.1:4110/',
    }
    const base = loadConfig(env)
    const l = await live(await open(env), builders().build, base)
    expect(l.config).toEqual(base)
  })

  it('applies a new SMTP host on the next send, while a send in flight finishes on the old transport', async () => {
    const { build, transports } = builders()
    const store = await open()
    await store.set('smtp.host', 'smtp-a.example.org', admin)
    await store.set('smtp.from', 'yoda@example.org', admin)
    const l = await live(store, build)
    const deps = l.attach({ db: await testDb() } as Partial<AppDeps>)
    const email = () => emailChannel(deps as AppDeps)
    const msg = { title: 'Hello', body: 'b', url: 'http://localhost:3000/x' }

    const old = transports.at(-1)!
    expect(old.host).toBe('smtp-a.example.org')
    const release = old.hold()
    const inFlight = email().send({ personId: 'p', email: 'a@example.org' }, msg)

    await store.set('smtp.host', 'smtp-b.example.org', admin)
    expect(deps.config!.smtpHost).toBe('smtp-b.example.org')
    const next = transports.at(-1)!
    expect(next).not.toBe(old)
    expect(next.host).toBe('smtp-b.example.org')

    await email().send({ personId: 'p', email: 'b@example.org' }, msg)
    expect(next.sent.map((m) => m.to)).toEqual(['b@example.org'])
    release()
    await inFlight
    expect(old.sent.map((m) => m.to)).toEqual(['a@example.org'])

    await store.clear('smtp.host', admin)
    expect(deps.mailTransport).toBeUndefined()
    await expect(email().send({ personId: 'p', email: 'c@example.org' }, msg)).rejects.toMatchObject({ code: 'not_configured' })
  })

  it('uses a new GitLab token on the next call; a call in flight completes with the old client', async () => {
    const seen: string[] = []
    let hold: Promise<void> | null = null
    const gitlabFetch = (async (_url: string, init: RequestInit) => {
      const token = (init.headers as Record<string, string>)['PRIVATE-TOKEN']
      if (hold) await hold
      seen.push(token)
      return new Response(JSON.stringify({ id: token === 'token-b-placeholder' ? 2 : 1, username: 'bot' }), { status: 200 })
    }) as unknown as typeof fetch
    const { build } = builders({ gitlabFetch })
    const store = await open()
    await store.set('gitlab.url', 'https://gitlab.example.org', admin)
    await store.set('gitlab.token', 'token-a-placeholder', admin)
    const l = await live(store, build)
    const deps = l.attach({} as Partial<AppDeps>)

    const before = deps.gitlab!
    let release = () => {}
    hold = new Promise<void>((r) => (release = r))
    const inFlight = before.currentUser()
    await store.set('gitlab.token', 'token-b-placeholder', admin)
    hold = null
    const after = deps.gitlab!
    expect(after).not.toBe(before)
    expect((await after.currentUser()).id).toBe(2)
    release()
    expect((await inFlight).id).toBe(1)
    expect(seen).toEqual(['token-b-placeholder', 'token-a-placeholder'])

    // Unrelated keys leave the client alone.
    await store.set('work.dailyTaskCap', 5, admin)
    expect(deps.gitlab).toBe(after)
    await store.clear('gitlab.token', admin)
    expect(deps.gitlab).toBeNull()
  })

  it('rebuilds the AI models when a provider key is set', async () => {
    const { build } = builders()
    const store = await open()
    const l = await live(store, build)
    const ai = new AiGateway({
      db: await testDb(),
      bus: new LiveBus(),
      get models() {
        return l.models
      },
      get config() {
        return l.config
      },
    })
    expect(ai.available('draft')).toBe(false)
    const models = l.models
    await store.set('ai.anthropicApiKey', 'anthropic-placeholder-key', admin)
    expect(l.models).not.toBe(models)
    expect(ai.available('draft')).toBe(true)
    await store.set('ai.modelFast', 'openai:gpt-placeholder', admin)
    expect(ai.available('fast')).toBe(false)
  })

  it('checks tokens against a new OIDC issuer and rebuilds the JWKS', async () => {
    const { build, jwksFor } = builders()
    const store = await open()
    const l = await live(store, build)
    const deps = l.attach(await testDeps())
    const app: FastifyInstance = await buildApp(deps as AppDeps)
    try {
      const claims = { sub: 'sub-a', preferred_username: 'a', name: 'a', groups: [] }
      const me = async (iss: string) =>
        (await app.inject({ url: '/me', headers: { authorization: `Bearer ${await signToken({ ...claims, iss })}` } })).statusCode
      expect(await me(TEST_ISSUER)).toBe(200)
      await store.set('oidc.issuer', 'https://sso.example.org/realms/yoda/', admin)
      expect(jwksFor.at(-1)).toBe('https://sso.example.org/realms/yoda')
      expect(await me(TEST_ISSUER)).toBe(401)
      expect(await me('https://sso.example.org/realms/yoda')).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('keeps an env-locked value when the database changes', async () => {
    const { build, transports } = builders()
    const writer = await open()
    const reader = await open({ SMTP_HOST: 'smtp-env.example.org', MAIL_FROM: 'yoda@example.org' })
    // As in server.ts, the base Config comes from the same env.
    const l = await live(reader, build, { ...testConfig(), smtpHost: 'smtp-env.example.org', mailFrom: 'yoda@example.org' })
    await l.listen()
    const built = transports.length
    // Another instance (no env) stores a different host; the env value still wins here.
    await writer.set('smtp.host', 'smtp-db.example.org', admin)
    await writer.set('work.dailyTaskCap', 3, admin)
    await vi.waitFor(() => expect(l.config.dailyTaskCap).toBe(3), { timeout: 5000, interval: 20 })
    expect(l.config.smtpHost).toBe('smtp-env.example.org')
    expect(transports.length).toBe(built)
  })

  it('reloads when another instance writes (NOTIFY), coalescing a burst', async () => {
    const writer = await open()
    const reader = await open()
    const l = await live(reader, builders().build, testConfig(), 150)
    await l.listen()
    // Let the reload that follows LISTEN itself pass first.
    await new Promise((r) => setTimeout(r, 300))
    const load = vi.spyOn(reader, 'load')
    await writer.set('work.dailyTaskCap', 4, admin)
    await writer.set('runners.leaseSeconds', 900, admin)
    await writer.set('org.publicUrl', 'https://yoda.example.org', admin)
    await vi.waitFor(() => expect(l.config.portalUrl).toBe('https://yoda.example.org'), { timeout: 5000, interval: 20 })
    expect(l.config).toMatchObject({ dailyTaskCap: 4, runnerLeaseSeconds: 900 })
    expect(load.mock.calls.length).toBeLessThan(3)
  })

  it('sends key names only, on commit only', async () => {
    const db = await testDb()
    const store = await open()
    const payloads: string[] = []
    const sub = await pgClient(db).listen(channel, (p) => payloads.push(p))
    try {
      await store.set('smtp.password', 'smtp-placeholder-password', admin)
      await store.set('smtp.port', 2525, admin)
      await expect(store.set('smtp.port', 2526, admin, { expectedVersion: 0 })).rejects.toThrow()
      await vi.waitFor(() => expect(payloads.length).toBe(2), { timeout: 5000, interval: 20 })
      expect(payloads.map((p) => JSON.parse(p))).toEqual([['smtp.password'], ['smtp.port']])
      expect(payloads.join()).not.toContain('placeholder')
    } finally {
      await sub.unlisten()
    }
  })

  it('reloads the whole snapshot after the listener reconnects', async () => {
    const db = await testDb()
    const store = await open()
    const l = await live(store, builders().build)
    await l.listen()
    // A change made while the listener is down sends no notification it can hear.
    await db.insert(settings).values({ key: 'smtp.host', value: 'smtp-missed.example.org', source: 'ui' })
    await db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where query = ${`listen "${channel}"`}`)
    await vi.waitFor(() => expect(l.config.smtpHost).toBe('smtp-missed.example.org'), { timeout: 10_000, interval: 50 })
  })

  it('flags restart-mode settings that changed since boot', async () => {
    const writer = await open()
    const reader = await open()
    const l = await live(reader, builders().build)
    await l.listen()
    expect(writer.restartRequired).toBe(false)
    await writer.set('runners.leaseSeconds', 900, admin)
    expect(writer.restartRequired).toBe(false)
    await writer.set('ai.workers', 4, admin)
    expect(writer.restartRequired).toBe(true)
    expect(writer.restartRequiredKeys).toEqual(['ai.workers'])
    await vi.waitFor(() => expect(reader.restartRequired).toBe(true), { timeout: 5000, interval: 20 })
    expect(l.restartRequired).toBe(true)
    // The running value is the boot value until a restart.
    expect(l.config.aiWorkers).toBe(2)
    await writer.set('runners.mcpEnabled', false, admin)
    expect(writer.restartRequiredKeys).toEqual(['ai.workers', 'runners.mcpEnabled'])
    await writer.set('ai.workers', 2, admin)
    expect(writer.restartRequiredKeys).toEqual(['runners.mcpEnabled'])
  })

  it('stops listening on close', async () => {
    const writer = await open()
    const reader = await open()
    const l = await live(reader, builders().build)
    await l.listen()
    await l.close()
    await writer.set('work.dailyTaskCap', 6, admin)
    await new Promise((r) => setTimeout(r, 200))
    expect(l.config.dailyTaskCap).toBe(8)
  })
})

describe('routes read config per request', () => {
  it('channel webhooks and channel statuses follow a config change after registration', async () => {
    const deps = await testDeps()
    let config: Config = deps.config
    Object.defineProperty(deps, 'config', { get: () => config, configurable: true })
    const app = await buildApp(deps)
    try {
      const hook = () => app.inject({ method: 'POST', url: '/webhooks/telegram', headers: { 'x-telegram-bot-api-secret-token': 'test-telegram-webhook-secret' }, payload: {} })
      expect((await hook()).statusCode).toBe(404)
      config = { ...config, telegramBotToken: 'test-telegram-bot-token', telegramBotUsername: 'yoda_test_bot', telegramWebhookSecret: 'test-telegram-webhook-secret' }
      expect((await hook()).statusCode).toBe(200)

      const token = await signToken({ sub: 'sub-boss', preferred_username: 'boss', name: 'boss', groups: [] })
      config = { ...config, bootstrapAdmins: ['boss'] }
      const res = await app.inject({ url: '/admin/notification-channels', headers: { authorization: `Bearer ${token}` } })
      expect(res.statusCode).toBe(200)
      const telegram = (res.json() as { name: string; configured: boolean }[]).find((c) => c.name === 'telegram')
      expect(telegram?.configured).toBe(true)
    } finally {
      await app.close()
    }
  })
})
