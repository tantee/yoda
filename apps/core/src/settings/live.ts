import type { SettingKey } from '@yoda/shared'
import type { JWTVerifyGetKey } from 'jose'
import { buildModels, type ModelSet } from '../ai/models.js'
import { remoteJwks } from '../auth/jwks.js'
import type { Config } from '../config.js'
import { pgClient } from '../db/client.js'
import { GitLabClient } from '../gitlab/client.js'
import { createMailTransport, emailConfigured, type MailTransport } from '../notifications/channels/email.js'
import { SecretsUnavailableError, type SettingsLog, type SettingsStore } from './store.js'

/**
 * Live apply (installer proposal §5.3). `config` is the resolved settings snapshot shaped like `Config`; the
 * clients built from settings (JWKS, AI models, GitLab, SMTP) sit in holders rebuilt only when their own fields
 * change. A consumer reads `deps.config` / `deps.gitlab` / ... once at the start of a call and keeps that
 * reference, so a call in flight finishes on the old values and the next call gets the new ones. The snapshot and
 * every holder are swapped together, synchronously, so no reader ever sees half an update.
 *
 * Other instances learn of a write through `NOTIFY` (see `SettingsStore.notify`): the listener reloads the whole
 * snapshot on each notification and on every (re)connect, debounced, since notifications sent while it was down
 * are lost.
 */

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Read once at boot (pg-boss workers, MCP route registration): the snapshot keeps the boot value (§9). */
const RESTART_FIELDS = ['aiWorkers', 'mcpEnabled'] as const satisfies readonly (keyof Config)[]

/** Config field ← setting key, for every field the database may set (the rest are bootstrap-only). */
const FIELD_KEYS = {
  oidcIssuer: 'oidc.issuer',
  oidcClientId: 'oidc.clientId',
  oidcJwksUrl: 'oidc.jwksUrl',
  staffGroup: 'oidc.staffGroup',
  bootstrapAdmins: 'oidc.bootstrapAdmins',
  anthropicApiKey: 'ai.anthropicApiKey',
  openaiApiKey: 'ai.openaiApiKey',
  openaiBaseUrl: 'ai.openaiBaseUrl',
  aiModelDraft: 'ai.modelDraft',
  aiModelFast: 'ai.modelFast',
  aiEmbeddingModel: 'ai.embeddingModel',
  aiWorkers: 'ai.workers',
  dailyTaskCap: 'work.dailyTaskCap',
  gitlabUrl: 'gitlab.url',
  gitlabToken: 'gitlab.token',
  gitlabWebhookSecret: 'gitlab.webhookSecret',
  portalUrl: 'org.publicUrl',
  runnerLeaseSeconds: 'runners.leaseSeconds',
  mcpEnabled: 'runners.mcpEnabled',
  smtpHost: 'smtp.host',
  smtpPort: 'smtp.port',
  smtpSecure: 'smtp.secure',
  smtpUser: 'smtp.user',
  smtpPassword: 'smtp.password',
  mailFrom: 'smtp.from',
  lineChannelAccessToken: 'line.accessToken',
  lineChannelSecret: 'line.channelSecret',
  telegramBotToken: 'telegram.botToken',
  telegramBotUsername: 'telegram.botUsername',
  telegramWebhookSecret: 'telegram.webhookSecret',
} as const satisfies Partial<Record<keyof Config, SettingKey>>

/**
 * The snapshot. `base` is the env Config (`loadConfig`): it supplies the bootstrap-only fields (port, database,
 * migrations, S3, the LINE / Telegram API base URLs) and every field whose setting is set in env, so an env-only
 * install resolves to exactly the Config it had before. Other fields take the stored value, else the default
 * (the registry defaults equal envSchema's, so `base` holds the same default). A stored secret the master key
 * cannot decrypt reads as unset; the recovery state shows on /health.
 */
export function resolveConfig(base: Config, store: SettingsStore): Config {
  const next: Record<string, unknown> = { ...base }
  for (const [field, key] of Object.entries(FIELD_KEYS) as [keyof Config, SettingKey][]) {
    if (store.fromEnv(key)) continue
    let value: unknown
    try {
      value = store.get(key)
    } catch (err) {
      if (!(err instanceof SecretsUnavailableError)) throw err
    }
    next[field] = value ?? base[field]
  }
  return next as Config
}

/** How each holder's client is built from a snapshot; tests inject fakes. */
export type LiveBuilders = {
  jwks(config: Config): JWTVerifyGetKey
  models(config: Config): ModelSet
  /** Null when the GitLab URL or token is not set. */
  gitlab(config: Config): GitLabClient | null
  /** Undefined when SMTP is not configured. */
  mailTransport(config: Config): MailTransport | undefined
}

export const DEFAULT_BUILDERS: LiveBuilders = {
  jwks: remoteJwks,
  models: (c) => buildModels(c),
  gitlab: (c) => {
    if (!c.gitlabUrl || !c.gitlabToken) return null
    const client = new GitLabClient({ baseUrl: c.gitlabUrl, token: c.gitlabToken })
    // Caches the bot user for the webhook (which never calls GitLab); best effort, the admin status page retries it.
    void client.currentUser().catch(() => console.warn('gitlab: bot user not resolved (GitLab unreachable?)'))
    return client
  },
  mailTransport: (c) => (emailConfigured(c) ? createMailTransport(c) : undefined),
}

type Held = { [K in keyof LiveBuilders]: ReturnType<LiveBuilders[K]> }

/** The Config fields each holder is built from; any other change leaves the holder alone. */
const HOLDER_FIELDS: { [K in keyof Held]: readonly (keyof Config)[] } = {
  jwks: ['oidcIssuer', 'oidcJwksUrl'],
  models: ['anthropicApiKey', 'openaiApiKey', 'openaiBaseUrl', 'aiModelDraft', 'aiModelFast', 'aiEmbeddingModel'],
  gitlab: ['gitlabUrl', 'gitlabToken'],
  mailTransport: ['smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'smtpPassword', 'mailFrom'],
}

/** Frees an old client. Sends in flight are unaffected: the SMTP transport is not pooled (one connection per send). */
function dispose(old: unknown): void {
  const close = (old as { close?: unknown } | null | undefined)?.close
  if (typeof close === 'function') {
    try {
      close.call(old)
    } catch {
      // Nothing to do: the old client is dropped either way.
    }
  }
}

const consoleLog: SettingsLog = {
  warn: (obj, msg) => console.warn(`settings: ${msg}`, JSON.stringify(obj)),
  info: (obj, msg) => console.log(`settings: ${msg}`, JSON.stringify(obj)),
}

export class LiveSettings {
  private snapshot: Config
  private held: Held
  private readonly build: LiveBuilders
  private readonly log: SettingsLog
  private readonly debounceMs: number
  private readonly unsubscribe: () => void
  private readonly store: SettingsStore
  private readonly base: Config
  private sub: { unlisten(): Promise<unknown> } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private reloading: Promise<void> = Promise.resolve()
  private closed = false

  constructor(opts: {
    store: SettingsStore
    /** The env Config (`loadConfig`): bootstrap-only fields come from it. */
    base: Config
    build?: Partial<LiveBuilders>
    log?: SettingsLog
    /** How long notifications are gathered before one reload (default 250 ms). */
    debounceMs?: number
  }) {
    this.store = opts.store
    this.base = opts.base
    this.build = { ...DEFAULT_BUILDERS, ...opts.build }
    this.log = opts.log ?? consoleLog
    this.debounceMs = opts.debounceMs ?? 250
    this.snapshot = resolveConfig(this.base, this.store)
    this.held = {
      jwks: this.build.jwks(this.snapshot),
      models: this.build.models(this.snapshot),
      gitlab: this.build.gitlab(this.snapshot),
      mailTransport: this.build.mailTransport(this.snapshot),
    }
    this.unsubscribe = this.store.onChange(() => this.refresh())
  }

  /** The current resolved settings, typed as `Config`; read it once per call. */
  get config(): Config {
    return this.snapshot
  }

  get jwks(): JWTVerifyGetKey {
    return this.held.jwks
  }

  get models(): ModelSet {
    return this.held.models
  }

  get gitlab(): GitLabClient | null {
    return this.held.gitlab
  }

  get mailTransport(): MailTransport | undefined {
    return this.held.mailTransport
  }

  /** A restart-mode setting changed since boot (for the settings banner). */
  get restartRequired(): boolean {
    return this.store.restartRequired
  }

  /**
   * Recomputes the snapshot from the store and rebuilds the holders whose fields changed; returns the changed
   * field names. Runs after every store change (a write here or a reload from the listener).
   */
  refresh(): (keyof Config)[] {
    const prev = this.snapshot
    const next = resolveConfig(this.base, this.store)
    for (const f of RESTART_FIELDS) (next as Record<string, unknown>)[f] = prev[f]
    const changed = (Object.keys(next) as (keyof Config)[]).filter((f) => !same(prev[f], next[f]))
    if (!changed.length) return changed
    const held = { ...this.held }
    const old: unknown[] = []
    for (const name of Object.keys(HOLDER_FIELDS) as (keyof Held)[]) {
      if (!HOLDER_FIELDS[name].some((f) => changed.includes(f))) continue
      try {
        held[name] = this.build[name](next) as never
        old.push(this.held[name])
      } catch (err) {
        // Keep the old client; the values are schema-checked, so this is a bug or an environment problem.
        this.log.warn({ holder: name, err: err instanceof Error ? err.name : 'error' }, 'client rebuild failed; keeping the previous one')
      }
    }
    // One synchronous swap: no reader sees the new snapshot with an old client, or the reverse.
    this.snapshot = next
    this.held = held
    for (const o of old) dispose(o)
    // Field names only, never values.
    this.log.info({ fields: changed }, 'settings applied')
    return changed
  }

  /**
   * Listens for other instances' writes. Each notification and each (re)connect schedules one reload of the
   * whole snapshot. Needs a session-pinned connection (not PgBouncer in transaction mode).
   */
  async listen(): Promise<void> {
    if (this.closed || this.sub) return
    const schedule = () => this.schedule()
    this.sub = await pgClient(this.store.db).listen(this.store.channel, schedule, schedule)
  }

  private schedule(): void {
    if (this.closed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.closed) return
      // Reloads run one at a time; a reload's own failure (database down) waits for the next notify or reconnect.
      this.reloading = this.reloading
        .then(() => this.store.load())
        .catch((err) => this.log.warn({ err: err instanceof Error ? err.name : 'error' }, 'settings reload failed'))
    }, this.debounceMs)
  }

  /** Stops listening and waits for a reload in progress. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.unsubscribe()
    const sub = this.sub
    this.sub = null
    await sub?.unlisten().catch(() => {})
    await this.reloading
  }

  /**
   * Makes `deps.config`, `deps.jwks`, `deps.gitlab` and `deps.mailTransport` getters over this instance, so every
   * existing `deps.x` read is live with no change at the call site.
   */
  attach<T extends object>(deps: T): T & { config: Config; jwks: JWTVerifyGetKey; gitlab: GitLabClient | null; mailTransport?: MailTransport } {
    const prop = (get: () => unknown): PropertyDescriptor => ({ get, enumerable: true, configurable: true })
    Object.defineProperties(deps, {
      config: prop(() => this.config),
      jwks: prop(() => this.jwks),
      gitlab: prop(() => this.gitlab),
      mailTransport: prop(() => this.mailTransport),
    })
    return deps as T & { config: Config; jwks: JWTVerifyGetKey; gitlab: GitLabClient | null; mailTransport?: MailTransport }
  }
}
