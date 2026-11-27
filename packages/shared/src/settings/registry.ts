import { z } from 'zod'

/**
 * The settings registry (installer proposal §5.1, inventory §9): one declaration per setting, shared by core and
 * the portal. Precedence is env > database > default; a value set in env is locked in the UI. A test keeps the
 * `envName`s in sync with core's `envSchema`, the portal runtime config and the runbook's variable table.
 */

export const SettingCategory = z.enum([
  'general',
  'signin',
  'ai',
  'gitlab',
  'email',
  'line',
  'telegram',
  'runners',
  'backups',
  'storage',
  'security',
])
export type SettingCategory = z.infer<typeof SettingCategory>

/** Who reads the value: core, the portal, the backup container, the Keycloak login theme, or compose itself. */
export type SettingScope = 'core' | 'portal' | 'backup' | 'keycloak-theme' | 'compose'

/** live: read per use; reconnect: rebuilds a client; restart: read once at boot (5.1). */
export type SettingApply = 'live' | 'reconnect' | 'restart'

export type TestActionId = 'smtp' | 'line' | 'telegram' | 'gitlab' | 'oidc' | 'ai' | 'storage' | 'backup'

/** Where a stored row came from (`settings.source`). */
export const SettingWriteSource = z.enum(['ui', 'setup', 'env', 'import', 'cli', 'recovery', 'upgrade'])
export type SettingWriteSource = z.infer<typeof SettingWriteSource>

export type SettingDef<S extends z.ZodTypeAny = z.ZodTypeAny> = {
  key: string
  /** Validates a stored or submitted value; accepts the env string form too (env values go through it). */
  schema: S
  category: SettingCategory
  /** Encrypted at rest, write-only in the API, fingerprinted (never stored) in the audit log. */
  secret: boolean
  /** The env variable that overrides the stored value (and is imported on boot unless bootstrap-only). */
  envName?: string
  scope: SettingScope
  apply: SettingApply
  /** False: shown read-only or hidden; the store refuses writes (8.6). */
  uiEditable: boolean
  /** Env/bootstrap only: never stored in the database, never imported (§6.3, 8.6). */
  bootstrapOnly: boolean
  default?: z.output<S>
  /** Credential-bound endpoints: changing one of these clears this secret unless a new one is given (8.6). */
  boundTo?: string[]
  test?: TestActionId
}

// Schemas take the env string form as well as the typed value, so env and stored values go through one rule.
const text = z.string().min(1)
const trimSlash = (s: string) => s.replace(/\/+$/, '')
const url = z.string().url().transform(trimSlash)
const bool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max)
const modelId = z.string().regex(/^(anthropic|openai):.+$/, 'must be provider:model with provider anthropic or openai')
const list = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
  z.array(z.string().min(1)),
)
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM')

type Base = Omit<SettingDef, 'schema' | 'default' | 'uiEditable' | 'bootstrapOnly' | 'secret' | 'scope' | 'apply'>
type Opts<S extends z.ZodTypeAny> = Partial<Pick<SettingDef<S>, 'uiEditable' | 'bootstrapOnly' | 'secret' | 'scope' | 'apply' | 'default'>>

/** A UI-editable core setting unless the options say otherwise. */
function def<const K extends string, S extends z.ZodTypeAny>(
  key: K,
  schema: S,
  base: Omit<Base, 'key'>,
  opts: Opts<S> = {},
): SettingDef<S> & { key: K } {
  return {
    key,
    schema,
    ...base,
    secret: opts.secret ?? false,
    scope: opts.scope ?? 'core',
    apply: opts.apply ?? 'live',
    uiEditable: opts.uiEditable ?? true,
    bootstrapOnly: opts.bootstrapOnly ?? false,
    ...(opts.default !== undefined ? { default: opts.default } : {}),
  }
}

/** Env/bootstrap only (8.6): never stored, never imported, never editable. */
const boot = { uiEditable: false, bootstrapOnly: true, apply: 'restart' } as const

const DEFS = [
  // 9.1 Core: bootstrap
  def('boot.port', int(0, 65535), { category: 'general', envName: 'PORT' }, { ...boot, default: 4000 }),
  def('boot.databaseUrl', text, { category: 'storage', envName: 'DATABASE_URL' }, { ...boot, secret: true }),
  def('boot.migrateOnStart', bool, { category: 'storage', envName: 'MIGRATE_ON_START' }, { ...boot, default: true }),
  def('storage.s3Endpoint', url, { category: 'storage', envName: 'S3_ENDPOINT', test: 'storage' }, { ...boot, default: 'http://localhost:9000' }),
  def('storage.s3Region', text, { category: 'storage', envName: 'S3_REGION' }, { ...boot, default: 'us-east-1' }),
  def('storage.s3Bucket', text, { category: 'storage', envName: 'S3_BUCKET' }, { ...boot, default: 'yoda' }),
  def('storage.s3AccessKey', text, { category: 'storage', envName: 'S3_ACCESS_KEY' }, { ...boot, secret: true }),
  def('storage.s3SecretKey', text, { category: 'storage', envName: 'S3_SECRET_KEY' }, { ...boot, secret: true }),
  def('security.masterKey', text, { category: 'security', envName: 'YODA_MASTER_KEY' }, { ...boot, secret: true }),
  def('security.masterKeyFile', text, { category: 'security', envName: 'YODA_MASTER_KEY_FILE' }, boot),
  // The bootstrap volume's aggregate file (DATABASE_URL and the S3 keys, written by the `init` service, §3.2).
  def('security.bootstrapFile', text, { category: 'security', envName: 'YODA_BOOTSTRAP_FILE' }, boot),
  // Dev only: setup counts as done without the wizard (§13.3).
  def('security.devSkipSetup', bool, { category: 'security', envName: 'YODA_DEV_SKIP_SETUP' }, { ...boot, default: false }),
  // How many proxies in front of core are believed for the client address (1: the portal; 2: behind a reverse proxy).
  def('security.trustedProxyHops', int(1, 5), { category: 'security', envName: 'YODA_TRUSTED_PROXY_HOPS' }, { ...boot, default: 1 }),
  def('security.settingsImport', bool, { category: 'security', envName: 'YODA_SETTINGS_IMPORT' }, { ...boot, default: true }),
  // Dev only: the settings tests may connect to loopback (the fakes on 127.0.0.1).
  def('security.outboundAllowLoopback', bool, { category: 'security', envName: 'YODA_OUTBOUND_ALLOW_LOOPBACK' }, { ...boot, default: false }),

  // 9.1 Core: sign-in
  def('oidc.issuer', url, { category: 'signin', envName: 'OIDC_ISSUER', test: 'oidc' }, { apply: 'reconnect' }),
  def('oidc.clientId', text, { category: 'signin', envName: 'OIDC_CLIENT_ID', test: 'oidc' }, { apply: 'reconnect', default: 'yoda-portal' }),
  def('oidc.jwksUrl', url, { category: 'signin', envName: 'OIDC_JWKS_URL', test: 'oidc' }, { apply: 'reconnect' }),
  def('oidc.staffGroup', text, { category: 'signin', envName: 'STAFF_GROUP' }, { default: '/it-dev' }),
  // Deprecated; still honoured from env (§6.6), never set in the UI.
  def('oidc.bootstrapAdmins', list, { category: 'signin', envName: 'BOOTSTRAP_ADMINS' }, { uiEditable: false, default: [] }),

  // 9.1 Core: AI
  def('ai.anthropicApiKey', text, { category: 'ai', envName: 'ANTHROPIC_API_KEY', test: 'ai' }, { secret: true, apply: 'reconnect' }),
  def(
    'ai.openaiApiKey',
    text,
    { category: 'ai', envName: 'OPENAI_API_KEY', test: 'ai', boundTo: ['ai.openaiBaseUrl'] },
    { secret: true, apply: 'reconnect' },
  ),
  def('ai.openaiBaseUrl', url, { category: 'ai', envName: 'OPENAI_BASE_URL', test: 'ai' }, { apply: 'reconnect' }),
  def('ai.modelDraft', modelId, { category: 'ai', envName: 'AI_MODEL_DRAFT', test: 'ai' }, { apply: 'reconnect', default: 'anthropic:claude-opus-5-5' }),
  def('ai.modelFast', modelId, { category: 'ai', envName: 'AI_MODEL_FAST', test: 'ai' }, { apply: 'reconnect', default: 'anthropic:claude-haiku-5-5' }),
  def('ai.embeddingModel', modelId, { category: 'ai', envName: 'AI_EMBEDDING_MODEL', test: 'ai' }, { apply: 'reconnect' }),
  def('ai.workers', int(1, 32), { category: 'ai', envName: 'AI_WORKERS' }, { apply: 'restart', default: 2 }),
  def('work.dailyTaskCap', int(1, 1000), { category: 'general', envName: 'DAILY_TASK_CAP' }, { default: 8 }),

  // 9.1 Core: GitLab
  def('gitlab.url', url, { category: 'gitlab', envName: 'GITLAB_URL', test: 'gitlab' }, { apply: 'reconnect' }),
  def(
    'gitlab.token',
    text,
    { category: 'gitlab', envName: 'GITLAB_TOKEN', test: 'gitlab', boundTo: ['gitlab.url'] },
    { secret: true, apply: 'reconnect' },
  ),
  def('gitlab.webhookSecret', z.string().min(16), { category: 'gitlab', envName: 'GITLAB_WEBHOOK_SECRET' }, { secret: true }),

  // 9.1 Core: general and runners
  def('org.publicUrl', url, { category: 'general', envName: 'PORTAL_URL' }, { default: 'http://localhost:3000' }),
  def('runners.leaseSeconds', int(180, 86400), { category: 'runners', envName: 'RUNNER_LEASE_SECONDS' }, { default: 600 }),
  // R5: restart mode until the /mcp routes get a per-request guard.
  def('runners.mcpEnabled', bool, { category: 'runners', envName: 'MCP_ENABLED' }, { apply: 'restart', default: true }),

  // 9.1 Core: email
  def('smtp.host', text, { category: 'email', envName: 'SMTP_HOST', test: 'smtp' }, { apply: 'reconnect' }),
  def('smtp.port', int(1, 65535), { category: 'email', envName: 'SMTP_PORT', test: 'smtp' }, { apply: 'reconnect', default: 587 }),
  def('smtp.secure', bool, { category: 'email', envName: 'SMTP_SECURE', test: 'smtp' }, { apply: 'reconnect', default: false }),
  def('smtp.user', text, { category: 'email', envName: 'SMTP_USER', test: 'smtp' }, { apply: 'reconnect' }),
  def(
    'smtp.password',
    text,
    // Bound to the whole server address: a new port or TLS mode can be another listener (8.6).
    { category: 'email', envName: 'SMTP_PASSWORD', test: 'smtp', boundTo: ['smtp.host', 'smtp.port', 'smtp.secure'] },
    { secret: true, apply: 'reconnect' },
  ),
  def('smtp.from', text, { category: 'email', envName: 'MAIL_FROM', test: 'smtp' }),

  // 9.1 Core: LINE and Telegram. The API base URLs exist for fakes in tests; editable, they would let someone
  // send the token to their own host (8.6), so they are env only.
  def('line.accessToken', text, { category: 'line', envName: 'LINE_CHANNEL_ACCESS_TOKEN', test: 'line' }, { secret: true, apply: 'reconnect' }),
  def('line.channelSecret', text, { category: 'line', envName: 'LINE_CHANNEL_SECRET' }, { secret: true }),
  def('line.apiUrl', url, { category: 'line', envName: 'LINE_API_URL' }, { ...boot, apply: 'reconnect', default: 'https://api.line.me' }),
  def('telegram.botToken', text, { category: 'telegram', envName: 'TELEGRAM_BOT_TOKEN', test: 'telegram' }, { secret: true, apply: 'reconnect' }),
  def(
    'telegram.botUsername',
    z.string().regex(/^@?[A-Za-z0-9_]{5,32}$/, 'must be the bot username').transform((s) => s.replace(/^@/, '')),
    { category: 'telegram', envName: 'TELEGRAM_BOT_USERNAME' },
    // Read-only: filled from the bot's getMe after a token test.
    { uiEditable: false },
  ),
  def(
    'telegram.webhookSecret',
    z.string().regex(/^[A-Za-z0-9_-]{16,256}$/, 'must be 16-256 characters of A-Z, a-z, 0-9, _ and -'),
    { category: 'telegram', envName: 'TELEGRAM_WEBHOOK_SECRET' },
    { secret: true },
  ),
  def('telegram.apiUrl', url, { category: 'telegram', envName: 'TELEGRAM_API_URL' }, { ...boot, apply: 'reconnect', default: 'https://api.telegram.org' }),

  // 9.2 Portal. The Keycloak overrides are deprecated: the portal derives them from oidc.issuer / oidc.clientId.
  def('portal.coreUrl', url, { category: 'general', envName: 'NUXT_CORE_URL' }, { ...boot, scope: 'portal' }),
  def('portal.keycloakUrl', url, { category: 'signin', envName: 'NUXT_PUBLIC_KEYCLOAK_URL' }, { ...boot, scope: 'portal', apply: 'live' }),
  def('portal.keycloakRealm', text, { category: 'signin', envName: 'NUXT_PUBLIC_KEYCLOAK_REALM' }, { ...boot, scope: 'portal', apply: 'live' }),
  def('portal.keycloakClientId', text, { category: 'signin', envName: 'NUXT_PUBLIC_KEYCLOAK_CLIENT_ID' }, { ...boot, scope: 'portal', apply: 'live' }),
  def('org.runnerDocsUrl', z.string().url(), { category: 'general', envName: 'NUXT_PUBLIC_RUNNER_DOCS_URL' }, { scope: 'portal', default: 'https://github.com/tantee/yoda#runners' }),
  def('line.addFriendUrl', z.string().url(), { category: 'line', envName: 'NUXT_PUBLIC_LINE_ADD_FRIEND_URL' }, { scope: 'portal' }),
  def('org.line', z.string().max(200), { category: 'general', envName: 'NUXT_PUBLIC_ORG_LINE' }, { scope: 'portal' }),
  def('org.name', z.string().min(1).max(200), { category: 'general' }, { scope: 'portal' }),
  def('org.nameEn', z.string().min(1).max(200), { category: 'general' }, { scope: 'portal' }),
  def('org.defaultLocale', z.enum(['th', 'en']), { category: 'general' }, { scope: 'portal', default: 'th' }),

  // 9.3 Compose, backup and Keycloak theme
  def('compose.imagePrefix', text, { category: 'general', envName: 'YODA_IMAGE_PREFIX' }, { ...boot, scope: 'compose' }),
  def('compose.version', text, { category: 'general', envName: 'YODA_VERSION' }, { ...boot, scope: 'compose' }),
  def('compose.coreDigest', text, { category: 'general', envName: 'YODA_CORE_DIGEST' }, { ...boot, scope: 'compose' }),
  def('compose.portalDigest', text, { category: 'general', envName: 'YODA_PORTAL_DIGEST' }, { ...boot, scope: 'compose' }),
  def('compose.runnerDigest', text, { category: 'general', envName: 'YODA_RUNNER_DIGEST' }, { ...boot, scope: 'compose' }),
  def('compose.backupDigest', text, { category: 'general', envName: 'YODA_BACKUP_DIGEST' }, { ...boot, scope: 'compose' }),
  def('compose.corePort', int(1, 65535), { category: 'general', envName: 'CORE_PORT' }, { ...boot, scope: 'compose', default: 4000 }),
  def('compose.coreBind', text, { category: 'general', envName: 'CORE_BIND' }, { ...boot, scope: 'compose', default: '127.0.0.1' }),
  def('compose.portalPort', int(1, 65535), { category: 'general', envName: 'PORTAL_PORT' }, { ...boot, scope: 'compose', default: 3000 }),
  def('compose.portalBind', text, { category: 'general', envName: 'PORTAL_BIND' }, { ...boot, scope: 'compose', default: '127.0.0.1' }),
  def('compose.postgresUser', text, { category: 'storage', envName: 'POSTGRES_USER' }, { ...boot, scope: 'compose', default: 'yoda' }),
  def('compose.postgresPassword', text, { category: 'storage', envName: 'POSTGRES_PASSWORD' }, { ...boot, scope: 'compose', secret: true }),
  def('compose.postgresDb', text, { category: 'storage', envName: 'POSTGRES_DB' }, { ...boot, scope: 'compose', default: 'yoda' }),
  def('compose.profiles', z.string(), { category: 'general', envName: 'COMPOSE_PROFILES' }, { ...boot, scope: 'compose' }),
  // The optional built-in HTTPS proxy (docs/operations.md, section 4b). Core reads these for the wizard's status card;
  // YODA_PROXY_ENABLED is pinned in release.env by deploy.sh when the `proxy` profile is on.
  def('proxy.enabled', bool, { category: 'general', envName: 'YODA_PROXY_ENABLED' }, { ...boot, default: false }),
  def('proxy.domain', text, { category: 'general', envName: 'YODA_PROXY_DOMAIN' }, boot),
  def('proxy.certMode', z.enum(['internal', 'files', 'acme']), { category: 'general', envName: 'YODA_PROXY_CERT_MODE' }, { ...boot, default: 'internal' }),
  def('proxy.httpsPort', int(1, 65535), { category: 'general', envName: 'YODA_PROXY_HTTPS_PORT' }, { ...boot, default: 443 }),
  def('proxy.httpPort', int(1, 65535), { category: 'general', envName: 'YODA_PROXY_HTTP_PORT' }, { ...boot, scope: 'compose', default: 80 }),
  def('proxy.bind', text, { category: 'general', envName: 'YODA_PROXY_BIND' }, { ...boot, scope: 'compose', default: '0.0.0.0' }),
  def('proxy.acmeEmail', text, { category: 'general', envName: 'YODA_PROXY_ACME_EMAIL' }, { ...boot, scope: 'compose' }),
  def('proxy.acmeCa', text, { category: 'general', envName: 'YODA_PROXY_ACME_CA' }, { ...boot, scope: 'compose' }),
  def('backup.at', time, { category: 'backups', envName: 'BACKUP_AT', test: 'backup' }, { scope: 'backup', default: '02:00' }),
  def('backup.keepDays', int(1, 3650), { category: 'backups', envName: 'BACKUP_KEEP_DAYS' }, { scope: 'backup', default: 14 }),
  // Lives on the Keycloak server; the UI only explains it.
  def('signin.loginFunMode', bool, { category: 'signin', envName: 'YODA_LOGIN_FUN_MODE' }, { ...boot, scope: 'keycloak-theme', apply: 'live' }),
] as const

type Defs = (typeof DEFS)[number]
export type SettingKey = Defs['key']
type DefOf<K extends SettingKey> = Extract<Defs, { key: K }>
/** The typed value of a setting. */
export type SettingValue<K extends SettingKey> = z.output<DefOf<K>['schema']>

/** Every setting, by key. */
export const SETTINGS: { readonly [K in SettingKey]: DefOf<K> } = Object.fromEntries(DEFS.map((d) => [d.key, d])) as never

export const SETTING_KEYS: readonly SettingKey[] = DEFS.map((d) => d.key)

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key)
}

export function settingDef(key: SettingKey): SettingDef {
  return SETTINGS[key]
}

/** The settings of one category, in registry order. */
export function byCategory(category: SettingCategory): SettingDef[] {
  return DEFS.filter((d) => d.category === category)
}

const BY_ENV = new Map<string, SettingDef>(DEFS.flatMap((d) => (d.envName ? [[d.envName, d] as const] : [])))

/** The setting an env variable maps to. */
export function byEnvName(envName: string): SettingDef | undefined {
  return BY_ENV.get(envName)
}

/** Every env variable the registry knows, in registry order. */
export const SETTING_ENV_NAMES: readonly string[] = [...BY_ENV.keys()]

/**
 * The container that reads a setting of a scope other than core from its own env only (shown in the "managed on the
 * host" lock). None today: the portal reads its settings from core's `/public-config` (§5.6), and the backup
 * container reads `backup.at` / `backup.keepDays` from the settings table (env still wins), so both are editable.
 */
export const SCOPE_CONTAINER: Partial<Record<SettingScope, string>> = {}

/** Secrets of 20+ characters show their last 4 after saving; shorter ones show nothing (5.2). */
export function secretHint(value: string): string | null {
  return value.length >= 20 ? value.slice(-4) : null
}
