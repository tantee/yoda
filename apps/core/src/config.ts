import { readFileSync } from 'node:fs'
import { z } from 'zod'

export type Config = {
  port: number
  databaseUrl: string
  /** Unset until sign-in is configured (setup mode): every bearer token is refused with `not_configured`. */
  oidcIssuer?: string
  oidcClientId: string
  /** Where signing keys are fetched, when not the issuer's certs endpoint; the issuer check still uses `oidcIssuer`. */
  oidcJwksUrl?: string
  /** Run database migrations when the server starts (dev default); production runs the `migrate` service instead. */
  migrateOnStart: boolean
  staffGroup: string
  bootstrapAdmins: string[]
  anthropicApiKey?: string
  openaiApiKey?: string
  openaiBaseUrl?: string
  aiModelDraft: string
  aiModelFast: string
  aiEmbeddingModel?: string
  s3Endpoint: string
  s3Region: string
  s3Bucket: string
  s3AccessKey: string
  s3SecretKey: string
  aiWorkers: number
  /** Most automatic task assignments one person receives per Bangkok calendar day. */
  dailyTaskCap: number
  /** GitLab base URL (no trailing slash); unset = GitLab features off. */
  gitlabUrl?: string
  /** Bot token; only ever read from the environment. */
  gitlabToken?: string
  gitlabWebhookSecret?: string
  /** Base URL of the portal, used for links from GitLab issues back to it. */
  portalUrl: string
  /** How long a runner's claim lasts without a heartbeat. */
  runnerLeaseSeconds: number
  /** Serves the runner MCP endpoint at `/mcp`. */
  mcpEnabled: boolean
  /** SMTP relay for the email channel; unset host or sender = email not configured. */
  smtpHost?: string
  smtpPort: number
  smtpSecure: boolean
  smtpUser?: string
  /** Only ever read from the environment; never logged, stored or returned. */
  smtpPassword?: string
  mailFrom?: string
  /** LINE Messaging API channel access token; only ever read from the environment. */
  lineChannelAccessToken?: string
  /** LINE channel secret, the key of the webhook's `X-Line-Signature`; only ever read from the environment. */
  lineChannelSecret?: string
  /** LINE API base URL (no trailing slash); a fake in dev and tests. */
  lineApiUrl: string
  /** Telegram bot token; it sits in the API URL path, so URLs and errors carrying it are never logged. */
  telegramBotToken?: string
  /** The bot's username (without @), for the `t.me/<bot>?start=<code>` link. */
  telegramBotUsername?: string
  /** Checked against `X-Telegram-Bot-Api-Secret-Token` on the webhook; at least 16 characters. */
  telegramWebhookSecret?: string
  /** Telegram Bot API base URL (no trailing slash); a fake in dev and tests. */
  telegramApiUrl: string
  /** Dev only: report setup as done without the wizard (YODA_DEV_SKIP_SETUP). */
  devSkipSetup?: boolean
  /**
   * Proxies in front of core whose X-Forwarded-For entry is believed (YODA_TRUSTED_PROXY_HOPS, default 1: the
   * portal's /api proxy). Decides the client address for rate limits, the audit log and alerts.
   */
  trustedProxyHops?: number
  /**
   * The optional built-in HTTPS proxy (YODA_PROXY_*; docs/operations.md, section 4b), when deploy.sh found its
   * profile on. Read only for the setup wizard's status card.
   */
  proxy?: {
    domain: string | null
    certMode: 'internal' | 'files' | 'acme'
    httpsPort: number
    /** The YODA_PROXY_* names whose value core could not use (ignored, reported on the card; never a boot failure). */
    invalid: string[]
  }
}

const modelId = z.string().regex(/^(anthropic|openai):.+$/, 'must be provider:model with provider anthropic or openai')
const optional = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), s.optional())
/**
 * An empty value counts as unset (its default applies), as in the settings store: the prod compose passes
 * `${NAME:-}`, so a variable missing from .env reaches core as '' and the setting stays editable in the UI.
 */
const emptyUnset = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (v === '' ? undefined : v), s)

/** The environment core reads; exported so the runbook's variable table can be checked against it. */
export const envSchema = z.object({
  PORT: emptyUnset(z.coerce.number().int().min(0).max(65535).default(4000)),
  DATABASE_URL: z.string().min(1),
  // Optional (setup mode, R4): without it core starts and refuses every bearer token until sign-in is set up.
  OIDC_ISSUER: optional(z.string().url()),
  OIDC_CLIENT_ID: emptyUnset(z.string().min(1).default('yoda-portal')),
  OIDC_JWKS_URL: optional(z.string().url()),
  MIGRATE_ON_START: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['true', 'false']).default('true')),
  STAFF_GROUP: emptyUnset(z.string().min(1).default('/it-dev')),
  BOOTSTRAP_ADMINS: z.string().default(''),
  ANTHROPIC_API_KEY: optional(z.string()),
  OPENAI_API_KEY: optional(z.string()),
  OPENAI_BASE_URL: optional(z.string().url()),
  AI_MODEL_DRAFT: emptyUnset(modelId.default('anthropic:claude-opus-5-5')),
  AI_MODEL_FAST: emptyUnset(modelId.default('anthropic:claude-haiku-5-5')),
  AI_EMBEDDING_MODEL: optional(modelId),
  S3_ENDPOINT: emptyUnset(z.string().url().default('http://localhost:9000')),
  S3_REGION: emptyUnset(z.string().min(1).default('us-east-1')),
  S3_BUCKET: emptyUnset(z.string().min(1).default('yoda')),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  AI_WORKERS: emptyUnset(z.coerce.number().int().min(1).max(32).default(2)),
  DAILY_TASK_CAP: emptyUnset(z.coerce.number().int().min(1).max(1000).default(8)),
  GITLAB_URL: optional(z.string().url()),
  GITLAB_TOKEN: optional(z.string()),
  GITLAB_WEBHOOK_SECRET: optional(z.string().min(16)),
  PORTAL_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().default('http://localhost:3000')),
  RUNNER_LEASE_SECONDS: emptyUnset(z.coerce.number().int().min(180).max(86400).default(600)),
  MCP_ENABLED: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['true', 'false']).default('true')),
  SMTP_HOST: optional(z.string()),
  SMTP_PORT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(65535).default(587)),
  SMTP_SECURE: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['true', 'false']).default('false')),
  SMTP_USER: optional(z.string()),
  SMTP_PASSWORD: optional(z.string()),
  MAIL_FROM: optional(z.string()),
  LINE_CHANNEL_ACCESS_TOKEN: optional(z.string()),
  LINE_CHANNEL_SECRET: optional(z.string()),
  LINE_API_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().default('https://api.line.me')),
  TELEGRAM_BOT_TOKEN: optional(z.string()),
  TELEGRAM_BOT_USERNAME: optional(z.string().regex(/^@?[A-Za-z0-9_]{5,32}$/, 'must be the bot username')),
  TELEGRAM_WEBHOOK_SECRET: optional(z.string().regex(/^[A-Za-z0-9_-]{16,256}$/, 'must be 16-256 characters of A-Z, a-z, 0-9, _ and -')),
  TELEGRAM_API_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().default('https://api.telegram.org')),
  // Read by the settings store (src/settings), not mapped into Config: the master key never sits in Config. A bad
  // key does not stop core; it starts in the recovery state instead.
  YODA_MASTER_KEY: optional(z.string()),
  YODA_MASTER_KEY_FILE: optional(z.string()),
  // The bootstrap volume's aggregate file (written by the `init` service): fills DATABASE_URL and the S3 keys when
  // env leaves them empty (applyBootstrapFile). Read before loadConfig, not mapped into Config.
  YODA_BOOTSTRAP_FILE: optional(z.string()),
  // Dev only: setup counts as done without the wizard, so the env-only dev flow stays the default.
  YODA_DEV_SKIP_SETUP: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['true', 'false']).default('false')),
  // Proxies in front of core whose X-Forwarded-For entry counts: 1 = the portal only, 2 = portal behind a reverse proxy.
  YODA_TRUSTED_PROXY_HOPS: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(5).default(1)),
  // The built-in HTTPS proxy (deploy.sh pins YODA_PROXY_ENABLED=true when its profile is on): the wizard's status card.
  // Read leniently (proxyConfig below): a status card never stops core from starting; anything but `true` is off.
  YODA_PROXY_ENABLED: z.string().optional(),
  YODA_PROXY_DOMAIN: z.string().optional(),
  YODA_PROXY_CERT_MODE: z.string().optional(),
  YODA_PROXY_HTTPS_PORT: z.string().optional(),
  YODA_SETTINGS_IMPORT: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['true', 'false']).default('true')),
  // Dev and tests only: the settings tests may reach loopback (the fakes). Read by server.ts, not mapped into Config.
  YODA_OUTBOUND_ALLOW_LOOPBACK: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['true', 'false']).default('false')),
})

/** URLs lose trailing slashes here as in the settings registry, so the shown value is the one in effect. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new Error(`Invalid environment: ${details}`)
  }
  const e = parsed.data
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    oidcIssuer: e.OIDC_ISSUER?.replace(/\/+$/, ''),
    oidcClientId: e.OIDC_CLIENT_ID,
    oidcJwksUrl: e.OIDC_JWKS_URL?.replace(/\/+$/, ''),
    migrateOnStart: e.MIGRATE_ON_START === 'true',
    staffGroup: e.STAFF_GROUP,
    bootstrapAdmins: e.BOOTSTRAP_ADMINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    openaiApiKey: e.OPENAI_API_KEY,
    openaiBaseUrl: e.OPENAI_BASE_URL?.replace(/\/+$/, ''),
    aiModelDraft: e.AI_MODEL_DRAFT,
    aiModelFast: e.AI_MODEL_FAST,
    aiEmbeddingModel: e.AI_EMBEDDING_MODEL,
    s3Endpoint: e.S3_ENDPOINT.replace(/\/+$/, ''),
    s3Region: e.S3_REGION,
    s3Bucket: e.S3_BUCKET,
    s3AccessKey: e.S3_ACCESS_KEY,
    s3SecretKey: e.S3_SECRET_KEY,
    aiWorkers: e.AI_WORKERS,
    dailyTaskCap: e.DAILY_TASK_CAP,
    gitlabUrl: e.GITLAB_URL?.replace(/\/+$/, ''),
    gitlabToken: e.GITLAB_TOKEN,
    gitlabWebhookSecret: e.GITLAB_WEBHOOK_SECRET,
    portalUrl: e.PORTAL_URL.replace(/\/+$/, ''),
    runnerLeaseSeconds: e.RUNNER_LEASE_SECONDS,
    mcpEnabled: e.MCP_ENABLED === 'true',
    smtpHost: e.SMTP_HOST,
    smtpPort: e.SMTP_PORT,
    smtpSecure: e.SMTP_SECURE === 'true',
    smtpUser: e.SMTP_USER,
    smtpPassword: e.SMTP_PASSWORD,
    mailFrom: e.MAIL_FROM,
    lineChannelAccessToken: e.LINE_CHANNEL_ACCESS_TOKEN,
    lineChannelSecret: e.LINE_CHANNEL_SECRET,
    lineApiUrl: e.LINE_API_URL.replace(/\/+$/, ''),
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    telegramBotUsername: e.TELEGRAM_BOT_USERNAME?.replace(/^@/, ''),
    telegramWebhookSecret: e.TELEGRAM_WEBHOOK_SECRET,
    telegramApiUrl: e.TELEGRAM_API_URL.replace(/\/+$/, ''),
    devSkipSetup: e.YODA_DEV_SKIP_SETUP === 'true',
    trustedProxyHops: e.YODA_TRUSTED_PROXY_HOPS,
    ...(e.YODA_PROXY_ENABLED?.trim() === 'true' ? { proxy: proxyConfig(e) } : {}),
  }
}

/** One host name (no scheme, port, path or wildcard), as install.sh and deploy.sh accept it. */
const PROXY_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * The built-in proxy's values as compose gives them (deploy.sh checked them before the start). A value core cannot
 * use is ignored and named in `invalid`, for the card: the domain then is null, the mode `internal` (compose's
 * default, as for an empty one) and the port 443.
 */
function proxyConfig(e: { YODA_PROXY_DOMAIN?: string; YODA_PROXY_CERT_MODE?: string; YODA_PROXY_HTTPS_PORT?: string }): NonNullable<Config['proxy']> {
  const invalid: string[] = []
  const rawDomain = e.YODA_PROXY_DOMAIN?.trim().toLowerCase() ?? ''
  const domain = rawDomain === '' ? null : PROXY_DOMAIN.test(rawDomain) ? rawDomain : (invalid.push('YODA_PROXY_DOMAIN'), null)
  const rawMode = e.YODA_PROXY_CERT_MODE?.trim() ?? ''
  const modes = ['internal', 'files', 'acme'] as const
  const certMode = rawMode === '' ? 'internal' : (modes as readonly string[]).includes(rawMode) ? (rawMode as (typeof modes)[number]) : (invalid.push('YODA_PROXY_CERT_MODE'), 'internal')
  const rawPort = e.YODA_PROXY_HTTPS_PORT?.trim() ?? ''
  const port = /^[1-9][0-9]{0,4}$/.test(rawPort) ? Number(rawPort) : Number.NaN
  const httpsPort = rawPort === '' ? 443 : port <= 65535 ? port : (invalid.push('YODA_PROXY_HTTPS_PORT'), 443)
  return { domain, certMode, httpsPort, invalid }
}

/** The values the bootstrap file may supply; env always wins (installer proposal §3.2). */
export const BOOTSTRAP_FILE_KEYS = ['DATABASE_URL', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const

/** `KEY=value` lines (no quoting, no expansion); blank lines and `#` comments are skipped. */
export function parseBootstrapEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (m) out[m[1]!] = m[2]!
  }
  return out
}

/**
 * Fills DATABASE_URL, S3_ACCESS_KEY and S3_SECRET_KEY from the file YODA_BOOTSTRAP_FILE names when env leaves
 * them unset or empty (the prod compose passes `${VAR:-}`). The `init` service derives DATABASE_URL there from the
 * generated (or env-given) Postgres password. Changes `env` in place; a value set in env is never replaced. The
 * file is read only when a value is missing, and an unreadable file names the path's error code, never a value.
 */
export function applyBootstrapFile(env: NodeJS.ProcessEnv, readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')): void {
  const path = env.YODA_BOOTSTRAP_FILE
  if (!path) return
  const missing = BOOTSTRAP_FILE_KEYS.filter((k) => !env[k])
  if (!missing.length) return
  let values: Record<string, string>
  try {
    values = parseBootstrapEnv(readFile(path))
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'read_error'
    throw new Error(`YODA_BOOTSTRAP_FILE: cannot read ${path} (${code}); did the init service run?`)
  }
  for (const k of missing) if (values[k]) env[k] = values[k]
}
