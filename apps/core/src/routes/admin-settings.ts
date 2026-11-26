import { randomBytes } from 'node:crypto'
import {
  PROD_COMPOSE_CORE_ENV,
  SCOPE_CONTAINER,
  SETTING_KEYS,
  SettingCategory,
  SettingsAuditQuery,
  SettingsPutBody,
  SettingsTestBody,
  TelegramWebhookBody,
  isSettingKey,
  settingDef,
  type AdminSettingsResponse,
  type GeneratedSecret,
  type SettingKey,
  type SettingLockReason,
  type SettingView,
  type SettingWarning,
  type SettingsAuditEntry,
  type SettingsAuditPage,
  type SettingsCategoryView,
  type SettingsPutResponse,
  type SettingsTestAction,
  type SettingsTestResult,
} from '@yoda/shared'
import { isNotNull, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { isPriced } from '../ai/gateway.js'
import { parseModelId } from '../ai/models.js'
import type { AppDeps } from '../app.js'
import { HttpError, notFound, requireAdmin } from '../auth/plugin.js'
import { knowledgeChunks } from '../db/schema.js'
import { RateLimiter } from '../settings/rate-limit.js'
import {
  BoundSecretInEnvError,
  SecretsUnavailableError,
  SettingConflictError,
  SettingLockedError,
  type SettingActor,
  type SettingChange,
  type SettingInfo,
  type SettingsStore,
} from '../settings/store.js'
import { registerTelegramWebhook, runSettingsTest, type TestContext } from '../settings/tests.js'

/**
 * The admin settings API (installer proposal §5.2, §8, §11). Admins only; requesters and staff get 403.
 *
 * - Secrets are write-only: a response shows whether one is set, its hint and who set it, never the value.
 * - Values set in env, bootstrap-only and read-only settings are refused (409 `setting_locked` with the reason).
 * - Saving a secret, clearing one, or changing a sign-in setting needs a recent sign-in: the access token's
 *   `auth_time` within 10 minutes, else 401 `reauth_required` (the portal then signs in again with `max_age`).
 * - Changing an endpoint a secret is bound to clears that secret unless a new one comes in the same save (8.6).
 * - Tests run through `safeOutbound`, take draft values, use saved secrets without ever returning them, and are
 *   audited and rate limited.
 */

/** Seconds since the last interactive sign-in that still count as recent (8.6). */
export const REAUTH_WINDOW_S = 600
/**
 * The OIDC issuer, client id and JWKS URL change only from a recovery session, staged and tested (8.6, Task 10):
 * a wrong JWKS URL fails every token check, as a wrong issuer does.
 */
const RECOVERY_ONLY = new Set<SettingKey>(['oidc.issuer', 'oidc.clientId', 'oidc.jwksUrl'])
const COMPOSE_ENV = new Set(PROD_COMPOSE_CORE_ENV)
/** Secrets an admin may have generated (shown once). */
export const GENERATED = new Set<SettingKey>(['gitlab.webhookSecret', 'telegram.webhookSecret'])
/** Keys that choose which server a test talks to. */
export const DRAFT_ENDPOINTS = new Set<SettingKey>(['oidc.issuer', 'oidc.jwksUrl', 'gitlab.url', 'smtp.host', 'smtp.port', 'smtp.secure', 'ai.openaiBaseUrl'])

export function booleansOnly(r: SettingsTestResult): SettingsTestResult {
  return {
    ...r,
    checks: r.checks.map(({ detail, ...c }) => {
      const kept = Object.entries(detail ?? {}).filter(([, v]) => typeof v === 'boolean')
      return kept.length ? { ...c, detail: Object.fromEntries(kept) } : c
    }),
  }
}

const MODEL_KEYS = ['ai.modelDraft', 'ai.modelFast', 'ai.embeddingModel'] as const

export const CATEGORY_TEST: Partial<Record<SettingCategory, SettingsTestAction>> = {
  signin: 'oidc',
  email: 'smtp',
  line: 'line',
  telegram: 'telegram',
  gitlab: 'gitlab',
  ai: 'ai',
  backups: 'backup',
  storage: 'storage',
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const settingsUnavailable = () => new HttpError(503, { error: 'settings_unavailable' })
const reauthRequired = () => new HttpError(401, { error: 'reauth_required' })
export const locked = (key: string, reason: string, envName?: string) =>
  new HttpError(409, { error: 'setting_locked', key, reason, ...(envName ? { envName } : {}) })
export const invalidSettings = (issues: { key: string; message: string }[]) => new HttpError(422, { error: 'invalid_settings', issues })

function rateLimited(retryAfter: number): HttpError {
  return new HttpError(429, { error: 'rate_limited', retryAfter })
}

/** A store value, or undefined for a stored secret the master key cannot read. */
export function safeGet(store: SettingsStore, key: SettingKey): unknown {
  try {
    return store.get(key)
  } catch (err) {
    if (err instanceof SecretsUnavailableError) return undefined
    throw err
  }
}

type Lock = { reason: SettingLockReason; envName?: string; container?: string }

/** Who is looking: an admin in the portal, or the setup wizard (where the sign-in settings are set first). */
export type ViewOpts = { setup?: boolean }

export function lockOf(store: SettingsStore, info: SettingInfo, opts: ViewOpts = {}): Lock | null {
  const d = settingDef(info.key)
  if (info.lock === 'bootstrap') return { reason: 'bootstrap' }
  // TODO(Task 9): backup.at / backup.keepDays are read from the backup container's env only; they unlock once it
  // reads the database. The portal settings are served by /public-config, so they follow the usual env lock.
  const container = SCOPE_CONTAINER[d.scope]
  if (container) return { reason: 'managed_on_host', container, ...(d.envName ? { envName: d.envName } : {}) }
  if (info.lock === 'env') return { reason: 'env', ...(info.envName ? { envName: info.envName } : {}) }
  if (info.lock) return { reason: info.lock }
  // In setup there is nobody to lock out yet: the wizard sets them, and the claim's sign-in proves them.
  if (RECOVERY_ONLY.has(info.key) && !opts.setup) return { reason: 'recovery_only' }
  return null
}

export const BOUND_SECRETS = new Map<string, SettingKey[]>()
for (const k of SETTING_KEYS) for (const b of settingDef(k).boundTo ?? []) BOUND_SECRETS.set(b, [...(BOUND_SECRETS.get(b) ?? []), k])

function view(store: SettingsStore, info: SettingInfo, restart: Set<SettingKey>, opts: ViewOpts): SettingView {
  const d = settingDef(info.key)
  const updatedBy = info.updatedBy || info.updatedByLabel ? { personId: info.updatedBy, label: info.updatedByLabel } : null
  const v: SettingView = {
    key: info.key,
    category: info.category,
    secret: info.secret,
    apply: info.apply,
    source: info.source,
    ...(info.envName ? { envName: info.envName } : {}),
    locked: lockOf(store, info, opts),
    version: info.version ?? 0,
    updatedAt: info.updatedAt?.toISOString() ?? null,
    updatedBy,
    writeSource: info.writeSource,
    restartRequired: restart.has(info.key),
    ...(d.test ? { test: d.test } : {}),
    ...(BOUND_SECRETS.has(info.key) ? { boundSecrets: BOUND_SECRETS.get(info.key) } : {}),
  }
  if (v.locked?.reason === 'env') {
    // What removing the variable from the host's .env would do (the lock help wording depends on it).
    v.importable = !info.secret || store.importsSecrets
    v.composeDefault = !!info.envName && COMPOSE_ENV.has(info.envName)
  }
  if (info.secret) {
    // The store never keeps the master key, so its state comes from the key check (keyStatus / keyId).
    const set = info.key === 'security.masterKey' ? store.keyStatus !== 'missing' : info.isSet
    v.secretState = { set, hint: info.hint, unavailable: info.unavailable, updatedAt: v.updatedAt, updatedBy }
  } else if (info.value !== undefined) {
    v.value = info.value
  }
  return v
}

export function categoryView(store: SettingsStore, category: SettingCategory, opts: ViewOpts = {}): SettingsCategoryView {
  const restart = new Set(store.restartRequiredKeys)
  return { category, settings: store.list(category).map((i) => view(store, i, restart, opts)), test: CATEGORY_TEST[category] ?? null }
}

/** Models in effect that have no price: their calls cost null and are refused for budgeted projects. */
export function modelWarnings(store: SettingsStore): SettingWarning[] {
  return MODEL_KEYS.flatMap((key) => {
    const spec = store.get(key)
    return spec && !isPriced(parseModelId(spec).model) ? [{ key, code: 'unpriced_model' }] : []
  })
}

function actorOf(request: FastifyRequest): SettingActor {
  return { personId: request.me.id, label: request.me.displayName, source: 'ui', ip: request.ip, requestId: String(request.id) }
}

/** The access token's `auth_time` is within the window (and not in the future beyond a minute of skew). */
function recentlyAuthenticated(request: FastifyRequest): boolean {
  const at = request.authTime
  if (at === null) return false
  const now = Date.now() / 1000
  return now - at <= REAUTH_WINDOW_S && at <= now + 60
}

function parseCategory(params: unknown): SettingCategory {
  const parsed = SettingCategory.safeParse((params as { category?: unknown })?.category)
  if (!parsed.success) throw notFound()
  return parsed.data
}

/** Draft or new values: known keys of this category, each valid; otherwise 422 with every issue. */
export function parseValues(category: SettingCategory, input: Record<string, unknown>): Map<SettingKey, unknown> {
  const issues: { key: string; message: string }[] = []
  const out = new Map<SettingKey, unknown>()
  for (const [key, raw] of Object.entries(input)) {
    if (!isSettingKey(key)) {
      issues.push({ key, message: 'unknown_setting' })
      continue
    }
    const d = settingDef(key)
    if (d.category !== category) {
      issues.push({ key, message: 'wrong_category' })
      continue
    }
    if (raw === null) {
      out.set(key, null)
      continue
    }
    const parsed = d.schema.safeParse(raw)
    if (!parsed.success || (d.secret && typeof parsed.data !== 'string')) {
      issues.push({ key, message: parsed.success ? 'secret must be a string' : parsed.error.issues.map((i) => i.message).join(', ') })
      continue
    }
    out.set(key, parsed.data)
  }
  if (issues.length) throw invalidSettings(issues)
  return out
}

/** The values a test runs with: draft values over the saved ones; locked settings keep their value in force. */
export function settingsTestContext(
  deps: Pick<AppDeps, 'outbound' | 'storage' | 'anthropicUrl'>,
  s: SettingsStore,
  draft: Map<SettingKey, unknown>,
  where: { source: SettingActor['source']; ip: string; requestId: string },
): TestContext {
  for (const key of [...draft.keys()]) if (s.info(key).lock) draft.delete(key)
  const get = ((key: SettingKey) => {
    if (draft.has(key)) return draft.get(key) ?? undefined
    const d = settingDef(key)
    // A saved secret is never sent to an endpoint the draft changes (8.6): it must be entered again.
    if (d.secret && d.boundTo?.some((b) => draft.has(b as SettingKey) && !same(draft.get(b as SettingKey), safeGet(s, b as SettingKey)))) return undefined
    return safeGet(s, key)
  }) as TestContext['get']
  return {
    get,
    policy: deps.outbound ?? {},
    storage: deps.storage,
    ...(deps.anthropicUrl ? { anthropicUrl: deps.anthropicUrl } : {}),
    onTelegramUsername: draft.has('telegram.botToken')
      ? undefined
      : async (username) => {
          // The internal write path for a derived value; an env-set username stays as it is.
          if (s.fromEnv('telegram.botUsername') || same(safeGet(s, 'telegram.botUsername'), username)) return
          await s.setDerived('telegram.botUsername', username, where)
        },
  }
}

/** A store refusal as the API's answer (409 lock, version or key; 422 invalid); anything else is rethrown. */
export function applyError(err: unknown): never {
  if (err instanceof BoundSecretInEnvError) throw locked(err.key, 'bound_secret_in_env', settingDef(err.secret).envName)
  if (err instanceof SettingConflictError) throw new HttpError(409, { error: 'version_conflict', key: err.key, version: err.version })
  if (err instanceof SettingLockedError) throw locked(err.key, err.reason)
  if (err instanceof SecretsUnavailableError) throw new HttpError(409, { error: 'secrets_unavailable', key: err.key })
  if (err instanceof ZodError) throw invalidSettings(err.issues.map((i) => ({ key: String(i.path[0] ?? ''), message: i.message })))
  throw err
}

export function adminSettingsRoutes(app: FastifyInstance): void {
  // Per admin, per app instance (§8.4): saves 30 / min; tests 10 / min and 60 / hour.
  const putLimit = new RateLimiter([{ max: 30, windowMs: 60_000 }])
  const testLimit = new RateLimiter([
    { max: 10, windowMs: 60_000 },
    { max: 60, windowMs: 3_600_000 },
  ])

  const store = (): SettingsStore => app.deps.settings ?? (() => { throw settingsUnavailable() })()

  function limit(limiter: RateLimiter, request: FastifyRequest, reply: { header(k: string, v: string): unknown }) {
    const r = limiter.take(request.me.id)
    if (!r.ok) {
      reply.header('retry-after', String(r.retryAfter))
      throw rateLimited(r.retryAfter)
    }
  }

  const testContext = (s: SettingsStore, draft: Map<SettingKey, unknown>, request: FastifyRequest) =>
    settingsTestContext(app.deps, s, draft, { source: 'ui', ip: request.ip, requestId: String(request.id) })

  app.get('/admin/settings', async (request): Promise<AdminSettingsResponse> => {
    requireAdmin(request)
    const s = store()
    const q = request.query as { category?: unknown }
    const categories = q.category === undefined ? SettingCategory.options : [parseCategory(q)]
    return {
      masterKey: { status: s.keyStatus, keyId: s.keyId, recovery: s.recovery },
      restartRequired: s.restartRequiredKeys,
      categories: categories.map((c) => categoryView(s, c)),
      warnings: modelWarnings(s),
    }
  })

  app.get('/admin/settings/restart-required', async (request) => {
    requireAdmin(request)
    return { restartRequired: store().restartRequiredKeys }
  })

  app.put('/admin/settings/:category', async (request, reply): Promise<SettingsPutResponse> => {
    requireAdmin(request)
    const s = store()
    const category = parseCategory(request.params)
    limit(putLimit, request, reply)
    const body = SettingsPutBody.parse(request.body)
    const values = parseValues(category, body.changes)
    for (const key of values.keys()) {
      const l = lockOf(s, s.info(key))
      if (l) throw locked(key, l.reason, l.envName)
    }
    // An endpoint a secret is bound to is saved only against the version the form loaded: the store clears the
    // bound secret when the locked row's endpoint differs (8.6), and the version makes that a decision on what
    // the admin saw.
    const unversioned = [...values.keys()].filter((k) => BOUND_SECRETS.has(k) && body.versions?.[k] === undefined)
    if (unversioned.length) throw invalidSettings(unversioned.map((key) => ({ key, message: 'version_required' })))
    // Recent sign-in: any secret (set, cleared, or cleared with its endpoint), any sign-in setting, and the public
    // URL (where webhooks and links point).
    const sensitive = [...values.keys()].some((k) => settingDef(k).secret || BOUND_SECRETS.has(k) || k === 'org.publicUrl')
    if ((sensitive || category === 'signin') && !recentlyAuthenticated(request)) throw reauthRequired()

    const oldEmbedding = safeGet(s, 'ai.embeddingModel')
    const changes: SettingChange[] = [
      ...[...values].map(([key, value]) => ({ key, value, ...(body.versions?.[key] !== undefined ? { expectedVersion: body.versions[key] } : {}) })),
    ]
    let result: { changed: SettingKey[]; cleared: SettingKey[] }
    try {
      result = await s.apply(changes, actorOf(request))
    } catch (err) {
      applyError(err)
    }

    const warnings: SettingWarning[] = modelWarnings(s).filter((w) => values.has(w.key as SettingKey))
    const newEmbedding = safeGet(s, 'ai.embeddingModel')
    if (values.has('ai.embeddingModel') && oldEmbedding && !same(oldEmbedding, newEmbedding)) {
      // Embeddings made with the old model do not compare with new ones (same 1024 dimensions, other space).
      const [r] = await app.deps.db.select({ n: sql<number>`count(*)::int` }).from(knowledgeChunks).where(isNotNull(knowledgeChunks.embedding))
      if (r && r.n > 0) warnings.push({ key: 'ai.embeddingModel', code: 'embedding_model_changed', count: r.n })
    }
    return {
      applied: result.changed,
      cleared: result.cleared,
      restartRequired: s.restartRequiredKeys,
      warnings,
      category: categoryView(s, category),
    }
  })

  app.post('/admin/settings/:category/test', async (request, reply): Promise<SettingsTestResult> => {
    requireAdmin(request)
    const s = store()
    const category = parseCategory(request.params)
    const action = CATEGORY_TEST[category]
    if (!action) throw notFound()
    limit(testLimit, request, reply)
    const body = SettingsTestBody.parse(request.body ?? {})
    // Storage is bootstrap-only (D9): its test takes no draft values.
    const draft = action === 'storage' ? new Map<SettingKey, unknown>() : parseValues(category, body.values)
    const ctx = testContext(s, draft, request)
    if (body.sendTo === 'self' && action === 'smtp') ctx.sendTo = request.me.email ?? null
    const raw = await runSettingsTest(action, ctx)
    // A draft endpoint is a server the admin chose: only booleans come back from it, never its own fields.
    const result = [...draft.keys()].some((k) => DRAFT_ENDPOINTS.has(k)) ? booleansOnly(raw) : raw
    await s.recordTest(category, action, result.ok ? 'ok' : (result.checks.find((c) => !c.ok)?.code ?? 'failed'), actorOf(request))
    return result
  })

  /**
   * Registers the Telegram webhook with the saved token and secret. It sends the webhook secret, so it needs a
   * recent sign-in. `dropPending: true` (the portal confirms it first) discards updates Telegram still holds.
   */
  app.post('/admin/settings/telegram/webhook', async (request, reply): Promise<SettingsTestResult> => {
    requireAdmin(request)
    const s = store()
    const body = TelegramWebhookBody.parse(request.body ?? {})
    limit(testLimit, request, reply)
    if (!recentlyAuthenticated(request)) throw reauthRequired()
    const c = await registerTelegramWebhook(testContext(s, new Map(), request), { dropPending: body.dropPending })
    await s.recordTest('telegram', 'telegram.webhook', c.ok ? 'ok' : (c.code ?? 'failed'), actorOf(request))
    return { action: 'telegram', ok: c.ok, checks: [c] }
  })

  /** Generates a webhook secret, stores it and returns it this once (it is pasted into GitLab's webhook form). */
  app.post('/admin/settings/:category/generate/:key', async (request, reply): Promise<GeneratedSecret & { webhook?: SettingsTestResult }> => {
    requireAdmin(request)
    const s = store()
    const category = parseCategory(request.params)
    const key = (request.params as { key?: string }).key ?? ''
    if (!isSettingKey(key) || !GENERATED.has(key) || settingDef(key).category !== category) throw notFound()
    limit(putLimit, request, reply)
    const l = lockOf(s, s.info(key))
    if (l) throw locked(key, l.reason, l.envName)
    if (!recentlyAuthenticated(request)) throw reauthRequired()
    const version = (request.body as { version?: unknown } | null)?.version
    // 32 characters of A-Z, a-z, 0-9, - and _: valid for GitLab and for Telegram's secret_token.
    const value = randomBytes(24).toString('base64url')
    try {
      await s.apply([{ key, value, ...(typeof version === 'number' ? { expectedVersion: version } : {}) }], actorOf(request))
    } catch (err) {
      if (err instanceof SettingConflictError) throw new HttpError(409, { error: 'version_conflict', key: err.key, version: err.version })
      if (err instanceof SecretsUnavailableError) throw new HttpError(409, { error: 'secrets_unavailable', key: err.key })
      throw err
    }
    reply.header('cache-control', 'no-store')
    const out: GeneratedSecret & { webhook?: SettingsTestResult } = { key, value, version: s.info(key).version ?? 0 }
    // Rotating the Telegram secret re-registers the webhook with it (§9.1), when the bot token is set.
    if (key === 'telegram.webhookSecret' && safeGet(s, 'telegram.botToken')) {
      const c = await registerTelegramWebhook(testContext(s, new Map(), request), { dropPending: false })
      await s.recordTest('telegram', 'telegram.webhook', c.ok ? 'ok' : (c.code ?? 'failed'), actorOf(request))
      out.webhook = { action: 'telegram', ok: c.ok, checks: [c] }
    }
    return out
  })

  app.get('/admin/settings/audit', async (request): Promise<SettingsAuditPage> => {
    requireAdmin(request)
    const q = SettingsAuditQuery.parse(request.query)
    const page = await store().auditPage(q)
    const entries: SettingsAuditEntry[] = page.rows.map((r) => {
      const known = r.key !== null && isSettingKey(r.key)
      const secret = known && settingDef(r.key as SettingKey).secret
      const testCategory = SettingCategory.safeParse((r.newValue as { category?: unknown } | null)?.category)
      return {
        id: r.id,
        at: r.at.toISOString(),
        actor: { personId: r.actorPerson, label: r.actorLabel },
        source: r.source,
        action: r.action,
        key: r.key,
        category: known ? settingDef(r.key as SettingKey).category : r.action === 'test' && testCategory.success ? testCategory.data : null,
        // Secrets: fingerprints only, even if a value were ever in the row.
        oldValue: secret ? null : (r.oldValue ?? null),
        newValue: secret ? null : (r.newValue ?? null),
        oldFp: r.oldFp,
        newFp: r.newFp,
        result: r.result,
        ip: r.ip,
        requestId: r.requestId,
      }
    })
    return { entries, nextCursor: page.nextCursor }
  })
}
