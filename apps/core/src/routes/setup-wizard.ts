import {
  OidcCallbackBody,
  SETUP_CATEGORIES,
  SettingCategory,
  SettingsPutBody,
  SettingsTestBody,
  SetupStepBody,
  TelegramWebhookBody,
  isSettingKey,
  settingDef,
  type AdminSettingsResponse,
  type GeneratedSecret,
  type OidcPending,
  type OidcSignInStart,
  type RecoveryKit,
  type SettingKey,
  type SettingsCategoryView,
  type SettingsPutResponse,
  type SettingsTestCheck,
  type SettingsTestResult,
  type SetupClaimResult,
  type SetupProgress,
} from '@yoda/shared'
import { randomBytes } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { upsertPersonFromClaims } from '../auth/people.js'
import { HttpError, invalidState, notFound } from '../auth/plugin.js'
import type { Db, Tx } from '../db/client.js'
import { localAdmins, people, setupState } from '../db/schema.js'
import { firstAdmin, MasterKeyUnavailable, replaceRecoveryCodes, totpRequired } from '../local/break-glass.js'
import { nowOf, secretsUnavailable, storeOf, takeLimit, whereFrom } from '../local/http.js'
import { currentOidc, finishTestSignIn, OidcChangeFailed, startTestSignIn } from '../local/oidc-change.js'
import { clearSessionCookie, isHttps, requireSession, revokeSessions, updateSessionData, type ActiveSession, type SessionData } from '../local/session.js'
import { missingSteps, oidcHash, parseProgress, recoveryKitFilename, recoveryKitText, stepStates, type ProgressRecord } from '../local/setup-progress.js'
import { clearSetupToken } from '../local/setup-token.js'
import { readiness } from '../readiness.js'
import { RateLimiter } from '../settings/rate-limit.js'
import type { SettingActor, SettingsStore } from '../settings/store.js'
import { registerTelegramWebhook, runSettingsTest } from '../settings/tests.js'
import { setupState as setupMode } from '../setup-state.js'
import {
  BOUND_SECRETS,
  CATEGORY_TEST,
  DRAFT_ENDPOINTS,
  GENERATED,
  applyError,
  booleansOnly,
  categoryView,
  invalidSettings,
  lockOf,
  locked,
  modelWarnings,
  parseValues,
  safeGet,
  settingsTestContext,
} from './admin-settings.js'

/**
 * The setup wizard's API after the token and the break-glass admin (installer proposal §4.2, §8.1, §8.4; Task 8).
 * Everything needs the `yoda_setup` cookie session (plus the CSRF header on non-GET calls) and answers 404 once
 * setup is done (8.1: nothing to probe).
 *
 * - Settings: the same views, saves and tests as the admin settings API, through the store (env > database >
 *   default; env-set and bootstrap-only values stay locked). The setup session stands in for the recent sign-in,
 *   and the sign-in settings are editable here (there is nobody to lock out yet; the claim's sign-in proves them).
 *   An endpoint and its bound secret are saved together, as in the admin form (8.6).
 * - Progress lives in `setup_state.setup_progress` (no secret, nothing in the browser): a reload, or a new token
 *   after a restart, resumes.
 * - The recovery kit returns the master key once per install, during setup only, audited.
 * - The claim signs the person in through OIDC (PKCE, as the /recovery test sign-in) and makes them the first
 *   portal admin. Complete checks every required step in one transaction, marks setup done, reloads the store,
 *   ends every setup session and deletes the token.
 */

const SETUP = { config: { public: true, setupMode: true } } as const
const CATEGORIES = new Set<string>(SETUP_CATEGORIES)

const actorOf = (request: FastifyRequest): SettingActor => ({ personId: null, label: 'setup', source: 'setup', ...whereFrom(request) })

/** The claim tests the sign-in values in effect; `stagedAt` names them, so a change meanwhile fails its state check. */
function claimTarget(values: { issuer: string; clientId: string; jwksUrl: string | null }, hash: string): OidcPending {
  return { values, stagedAt: `setup:${hash}`, stagedBy: 'setup', testedAt: null, testedUsername: null }
}

/** Merges `patch` into the progress record (one statement, so concurrent marks do not drop each other). */
async function patchProgress(q: Db | Tx, patch: Partial<ProgressRecord>, opts: { mark?: { step: string; state: string } } = {}): Promise<void> {
  const base = sql`coalesce(${setupState.setupProgress}, '{}'::jsonb)`
  const marked = opts.mark
    ? sql`jsonb_set(${base}, '{marks}', coalesce(${base}->'marks', '{}'::jsonb) || ${JSON.stringify({ [opts.mark.step]: opts.mark.state })}::jsonb)`
    : base
  await q.update(setupState).set({ setupProgress: sql`${marked} || ${JSON.stringify(patch)}::jsonb` }).where(eq(setupState.id, 1))
}

export function setupWizardRoutes(app: FastifyInstance): void {
  // §8.4: tests 10 / min and 60 / hour; saves 30 / min (per address: the wizard has no person yet).
  const testLimit = new RateLimiter([
    { max: 10, windowMs: 60_000 },
    { max: 60, windowMs: 3_600_000 },
  ])
  const putLimit = new RateLimiter([{ max: 30, windowMs: 60_000 }])
  const policy = () => app.deps.outbound ?? {}

  /** 404 once setup is done; otherwise the store. */
  function open(): SettingsStore {
    const s = storeOf(app)
    if (setupMode(app.deps.config, s) === 'done') throw notFound()
    return s
  }

  const publicUrlOf = (s: SettingsStore): string | undefined => {
    try {
      return s.get('org.publicUrl')
    } catch {
      return undefined
    }
  }

  async function signed(request: FastifyRequest): Promise<{ s: SettingsStore; sess: ActiveSession }> {
    const s = open()
    const sess = await requireSession(app.deps.db, request, 'setup', { now: nowOf(app), publicUrl: publicUrlOf(s) })
    return { s, sess }
  }

  const oidcNow = (s: SettingsStore) => currentOidc(app.deps.config, s)

  async function readRecord(q: Db | Tx, forUpdate = false): Promise<{ installId: string; record: ProgressRecord }> {
    const base = q.select({ installId: setupState.installId, progress: setupState.setupProgress }).from(setupState).where(eq(setupState.id, 1))
    const [row] = forUpdate ? await base.for('update') : await base
    return { installId: row?.installId ?? '', record: parseProgress(row?.progress) }
  }

  async function facts(q: Db | Tx, s: SettingsStore, forUpdate = false) {
    const { installId, record } = await readRecord(q, forUpdate)
    const [admin] = await q.select().from(localAdmins).orderBy(localAdmins.createdAt).limit(1)
    let claimedIsAdmin = false
    if (record.claimed) {
      const [p] = await q.select({ isAdmin: people.isAdmin }).from(people).where(eq(people.id, record.claimed.personId))
      claimedIsAdmin = !!p?.isAdmin
    }
    const url = s.info('org.publicUrl').source
    const states = stepStates({
      session: true,
      organisation: s.info('org.name').isSet && (url === 'db' || url === 'env'),
      admin: !!admin,
      oidc: oidcHash(oidcNow(s)),
      claimedIsAdmin,
      record,
    })
    return { installId, record, admin, states }
  }

  async function progress(request: FastifyRequest, s: SettingsStore): Promise<SetupProgress> {
    const f = await facts(app.deps.db, s)
    return {
      installId: f.installId,
      steps: f.states,
      totpRequired: totpRequired(s, request.hostname),
      admin: f.admin ? { username: f.admin.username, totpEnabled: f.admin.totpEnabled } : null,
      kitDownloadedAt: f.record.kitDownloadedAt ?? null,
      claimed: f.record.claimed && f.states.claim === 'done' ? { username: f.record.claimed.username, at: f.record.claimed.at } : null,
      missing: missingSteps(f.states),
    }
  }

  function setupCategory(params: unknown): SettingCategory {
    const parsed = SettingCategory.safeParse((params as { category?: unknown })?.category)
    if (!parsed.success || !CATEGORIES.has(parsed.data)) throw notFound()
    return parsed.data
  }

  const view = (s: SettingsStore, c: SettingCategory): SettingsCategoryView => categoryView(s, c, { setup: true })

  // ── Progress ─────────────────────────────────────────────────────────────────────────────────────────────────

  app.get('/setup/progress', SETUP, async (request, reply): Promise<SetupProgress> => {
    const { s } = await signed(request)
    reply.header('cache-control', 'no-store')
    return progress(request, s)
  })

  app.post('/setup/progress/step', SETUP, async (request): Promise<SetupProgress> => {
    const { s } = await signed(request)
    const body = SetupStepBody.parse(request.body)
    await patchProgress(app.deps.db, {}, { mark: { step: body.step, state: body.state } })
    await s.audit({ action: 'setup.step', actor: actorOf(request), newValue: { step: body.step, state: body.state } })
    return progress(request, s)
  })

  // ── Settings (the admin settings API's rules, through the setup session) ─────────────────────────────────────

  app.get('/setup/settings', SETUP, async (request, reply): Promise<AdminSettingsResponse> => {
    const { s } = await signed(request)
    const q = request.query as { category?: unknown }
    const categories = q.category === undefined ? [...SETUP_CATEGORIES] : [setupCategory(q)]
    reply.header('cache-control', 'no-store')
    return {
      masterKey: { status: s.keyStatus, keyId: s.keyId, recovery: s.recovery },
      restartRequired: s.restartRequiredKeys,
      categories: categories.map((c) => view(s, c)),
      warnings: modelWarnings(s),
    }
  })

  app.put('/setup/settings/:category', SETUP, async (request, reply): Promise<SettingsPutResponse> => {
    const { s } = await signed(request)
    const category = setupCategory(request.params)
    takeLimit(putLimit, request.ip, reply)
    const body = SettingsPutBody.parse(request.body)
    const values = parseValues(category, body.changes)
    for (const key of values.keys()) {
      const l = lockOf(s, s.info(key), { setup: true })
      if (l) throw locked(key, l.reason, l.envName)
    }
    // As in the admin form: an endpoint a secret is bound to is saved against the version the form loaded (8.6).
    const unversioned = [...values.keys()].filter((k) => BOUND_SECRETS.has(k) && body.versions?.[k] === undefined)
    if (unversioned.length) throw invalidSettings(unversioned.map((key) => ({ key, message: 'version_required' })))
    let result: { changed: SettingKey[]; cleared: SettingKey[] }
    try {
      result = await s.apply(
        [...values].map(([key, value]) => ({ key, value, ...(body.versions?.[key] !== undefined ? { expectedVersion: body.versions[key] } : {}) })),
        actorOf(request),
      )
    } catch (err) {
      applyError(err)
    }
    return {
      applied: result.changed,
      cleared: result.cleared,
      restartRequired: s.restartRequiredKeys,
      warnings: modelWarnings(s).filter((w) => values.has(w.key as SettingKey)),
      category: view(s, category),
    }
  })

  app.post('/setup/settings/:category/test', SETUP, async (request, reply): Promise<SettingsTestResult> => {
    const { s } = await signed(request)
    const category = setupCategory(request.params)
    const action = CATEGORY_TEST[category]
    if (!action) throw notFound()
    takeLimit(testLimit, request.ip, reply)
    const body = SettingsTestBody.parse(request.body ?? {})
    // Storage is bootstrap-only (D9); and there is no person yet, so no "send to me" email.
    const draft = action === 'storage' ? new Map<SettingKey, unknown>() : parseValues(category, body.values)
    const ctx = settingsTestContext(app.deps, s, draft, { source: 'setup', ip: request.ip, requestId: String(request.id) })
    const raw = await runSettingsTest(action, ctx)
    const result = [...draft.keys()].some((k) => DRAFT_ENDPOINTS.has(k)) ? booleansOnly(raw) : raw
    await s.recordTest(category, action, result.ok ? 'ok' : (result.checks.find((c) => !c.ok)?.code ?? 'failed'), actorOf(request))
    if (action === 'oidc' && result.ok) {
      // The sign-in step is done once the values in effect passed (a draft that differs does not count).
      const tested = oidcHash({ issuer: ctx.get('oidc.issuer') ?? null, clientId: ctx.get('oidc.clientId') ?? app.deps.config.oidcClientId, jwksUrl: ctx.get('oidc.jwksUrl') ?? null })
      if (tested && tested === oidcHash(oidcNow(s))) await patchProgress(app.deps.db, { oidcTested: { hash: tested, at: nowOf(app).toISOString() } })
    }
    return result
  })

  /** Registers the Telegram webhook with the saved token and secret (§4.2 step 7). */
  app.post('/setup/settings/telegram/webhook', SETUP, async (request, reply): Promise<SettingsTestResult> => {
    const { s } = await signed(request)
    const body = TelegramWebhookBody.parse(request.body ?? {})
    takeLimit(testLimit, request.ip, reply)
    const ctx = settingsTestContext(app.deps, s, new Map(), { source: 'setup', ip: request.ip, requestId: String(request.id) })
    const c = await registerTelegramWebhook(ctx, { dropPending: body.dropPending })
    await s.recordTest('telegram', 'telegram.webhook', c.ok ? 'ok' : (c.code ?? 'failed'), actorOf(request))
    return { action: 'telegram', ok: c.ok, checks: [c] }
  })

  /** Generates a webhook secret (GitLab, Telegram), stores it and returns it this once. */
  app.post('/setup/settings/:category/generate/:key', SETUP, async (request, reply): Promise<GeneratedSecret & { webhook?: SettingsTestResult }> => {
    const { s } = await signed(request)
    const category = setupCategory(request.params)
    const key = (request.params as { key?: string }).key ?? ''
    if (!isSettingKey(key) || !GENERATED.has(key) || settingDef(key).category !== category) throw notFound()
    takeLimit(putLimit, request.ip, reply)
    const l = lockOf(s, s.info(key), { setup: true })
    if (l) throw locked(key, l.reason, l.envName)
    const version = (request.body as { version?: unknown } | null)?.version
    const value = randomBytes(24).toString('base64url')
    try {
      await s.apply([{ key, value, ...(typeof version === 'number' ? { expectedVersion: version } : {}) }], actorOf(request))
    } catch (err) {
      applyError(err)
    }
    reply.header('cache-control', 'no-store')
    const out: GeneratedSecret & { webhook?: SettingsTestResult } = { key, value, version: s.info(key).version ?? 0 }
    if (key === 'telegram.webhookSecret' && safeGet(s, 'telegram.botToken')) {
      const ctx = settingsTestContext(app.deps, s, new Map(), { source: 'setup', ip: request.ip, requestId: String(request.id) })
      const c = await registerTelegramWebhook(ctx, { dropPending: false })
      await s.recordTest('telegram', 'telegram.webhook', c.ok ? 'ok' : (c.code ?? 'failed'), actorOf(request))
      out.webhook = { action: 'telegram', ok: c.ok, checks: [c] }
    }
    return out
  })

  // ── System check (§4.2 step 3, read-only) ────────────────────────────────────────────────────────────────────

  app.post('/setup/check', SETUP, async (request, reply): Promise<SettingsTestResult> => {
    const { s } = await signed(request)
    takeLimit(testLimit, request.ip, reply)
    const started = performance.now()
    const r = await readiness(app.deps)
    const ms = Math.round(performance.now() - started)
    const checks: SettingsTestCheck[] = [
      { id: 'db', ok: r.checks.db === 'ok', ms, ...(r.checks.db === 'ok' ? {} : { code: 'unreachable' }) },
    ]
    if (r.checks.db === 'ok') {
      const t0 = performance.now()
      let has = false
      try {
        const [row] = await app.deps.db.execute<{ has: boolean }>(sql`select exists (select 1 from pg_extension where extname = 'vector') as has`)
        has = !!row?.has
      } catch {
        has = false
      }
      checks.push({ id: 'pgvector', ok: has, ms: Math.round(performance.now() - t0), ...(has ? {} : { code: 'no_pgvector' }) })
    }
    // The bucket test of the storage settings (bootstrap-only, D9: shown read-only), then the job queue.
    const storage = await runSettingsTest('storage', settingsTestContext(app.deps, s, new Map(), { source: 'setup', ip: request.ip, requestId: String(request.id) }))
    checks.push(...storage.checks)
    checks.push({ id: 'queue', ok: r.checks.queue === 'ok', ms, ...(r.checks.queue === 'ok' ? {} : { code: 'unreachable' }) })
    const ok = checks.every((c) => c.ok)
    await s.recordTest('storage', 'setup.check', ok ? 'ok' : (checks.find((c) => !c.ok)?.code ?? 'failed'), actorOf(request))
    return { action: 'storage', ok, checks }
  })

  // ── Recovery kit (§4.2 step 9, D7) ───────────────────────────────────────────────────────────────────────────

  /**
   * The master key and fresh break-glass recovery codes in one file, once per install: the download marker is set
   * in the same transaction that replaces the codes, and a second call is refused (409 `kit_downloaded`). After
   * setup the route is gone (404). Audited with the key id only.
   */
  app.post('/setup/recovery-kit', SETUP, async (request, reply): Promise<RecoveryKit> => {
    const { s } = await signed(request)
    const admin = await firstAdmin(app.deps.db)
    if (!admin) throw invalidState('no_admin')
    const masterKey = s.withKey((mk) => ({ id: mk.id, value: mk.key.toString('base64') }))
    if (!masterKey) throw secretsUnavailable()
    const now = nowOf(app)
    let codes: string[]
    try {
      codes = await app.deps.db.transaction(async (tx) => {
        const claimed = await tx
          .update(setupState)
          .set({ setupProgress: sql`coalesce(${setupState.setupProgress}, '{}'::jsonb) || ${JSON.stringify({ kitDownloadedAt: now.toISOString() })}::jsonb` })
          .where(and(eq(setupState.id, 1), isNull(setupState.setupCompletedAt), sql`${setupState.setupProgress}->>'kitDownloadedAt' is null`))
          .returning({ id: setupState.id })
        if (!claimed.length) throw invalidState('kit_downloaded')
        return replaceRecoveryCodes(tx, s, admin.id)
      })
    } catch (err) {
      if (err instanceof MasterKeyUnavailable) throw secretsUnavailable()
      throw err
    }
    const { installId } = await readRecord(app.deps.db)
    await s.audit({ action: 'setup.recovery_kit', actor: actorOf(request), newValue: { keyId: masterKey.id, username: admin.username } })
    reply.header('cache-control', 'no-store')
    return {
      filename: recoveryKitFilename(installId),
      content: recoveryKitText({
        installId,
        publicUrl: publicUrlOf(s) ?? '',
        keyId: masterKey.id,
        masterKey: masterKey.value,
        username: admin.username,
        codes,
        at: now,
      }),
      recoveryCodes: codes,
      downloadedAt: now.toISOString(),
    }
  })

  // ── Claim (§4.2 step 10, §7.2): the first portal admin is an OIDC identity ───────────────────────────────────

  function claimValues(s: SettingsStore) {
    const cur = oidcNow(s)
    const hash = oidcHash(cur)
    if (!cur.issuer || !hash) throw invalidState('no_issuer')
    return { target: claimTarget({ issuer: cur.issuer, clientId: cur.clientId, jwksUrl: cur.jwksUrl }, hash), hash }
  }

  app.post('/setup/claim/start', SETUP, async (request, reply): Promise<OidcSignInStart> => {
    const { s, sess } = await signed(request)
    takeLimit(testLimit, request.ip, reply)
    const { target } = claimValues(s)
    const publicUrl = publicUrlOf(s)
    if (!publicUrl) throw invalidState('no_public_url')
    let started
    try {
      started = await startTestSignIn(target, { publicUrl, policy: policy(), now: nowOf(app), redirectPath: '/setup' })
    } catch (err) {
      if (err instanceof OidcChangeFailed) throw new HttpError(422, { error: 'bad_request', reason: err.code })
      throw err
    }
    await updateSessionData(app.deps.db, sess.row.idHash, { ...(sess.row.data as SessionData), claim: started.data })
    return { authorizeUrl: started.authorizeUrl, redirectUri: started.redirectUri }
  })

  app.post('/setup/claim/callback', SETUP, async (request, reply): Promise<SetupClaimResult> => {
    const { s, sess } = await signed(request)
    takeLimit(testLimit, request.ip, reply)
    const body = OidcCallbackBody.parse(request.body)
    const data = sess.row.data as SessionData
    if (!data.claim) throw invalidState('no_signin')
    // Single use: the flow is dropped before anything else.
    const { claim: flow, ...rest } = data
    await updateSessionData(app.deps.db, sess.row.idHash, rest)
    const { target, hash } = claimValues(s)
    const now = nowOf(app)
    const r = await finishTestSignIn({ db: app.deps.db, policy: policy() }, target, flow, { ...body, now }, {
      requireAdmin: false,
      staffGroup: s.get('oidc.staffGroup') ?? app.deps.config.staffGroup,
    })
    await s.recordTest('signin', 'setup.claim', r.ok ? 'ok' : (r.checks.find((c) => !c.ok)?.code ?? 'failed'), actorOf(request))
    if (!r.ok || !r.claims) return { ok: false, checks: r.checks, username: null }
    const person = await upsertPersonFromClaims(app.deps.db, r.claims, app.deps.config)
    await app.deps.db.update(people).set({ isAdmin: true }).where(eq(people.id, person.id))
    await patchProgress(app.deps.db, {
      claimed: { personId: person.id, username: person.username, hash, at: now.toISOString() },
      oidcTested: { hash, at: now.toISOString() },
    })
    await s.audit({ action: 'setup.claimed', actor: actorOf(request), newValue: { username: person.username } })
    return { ok: true, checks: r.checks, username: person.username }
  })

  // ── Complete (8.1) ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * One transaction re-checks every required step (organisation saved, break-glass admin, recovery kit downloaded,
   * the claimed person still a portal admin through the sign-in values in effect) and marks setup done. Then the
   * store reloads (`setupDone`, so setup mode ends now, not at the next restart), every setup session ends and the
   * token is deleted.
   */
  app.post('/setup/complete', SETUP, async (request, reply: FastifyReply) => {
    const { s } = await signed(request)
    const done = await app.deps.db.transaction(async (tx) => {
      const f = await facts(tx, s, true)
      const missing = missingSteps(f.states)
      if (missing.length) throw new HttpError(409, { error: 'invalid_state', reason: 'incomplete', missing })
      const rows = await tx
        .update(setupState)
        .set({ setupCompletedAt: nowOf(app), setupCompletedBy: f.record.claimed!.personId, setupCompletedSource: 'setup', setupTokenHash: null, setupTokenExpires: null })
        .where(and(eq(setupState.id, 1), isNull(setupState.setupCompletedAt)))
        .returning({ id: setupState.id })
      return rows.length > 0 ? f.record.claimed!.username : null
    })
    if (!done) throw notFound()
    await s.audit({ action: 'setup.completed', actor: actorOf(request), newValue: { admin: done } })
    await s.load()
    await clearSetupToken(app.deps.db, app.deps.setupTokenFile ?? null)
    await revokeSessions(app.deps.db, { kind: 'setup' })
    clearSessionCookie(reply, 'setup', isHttps(request))
    return { done: true }
  })
}
