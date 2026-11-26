import {
  OidcCallbackBody,
  OidcValues,
  PasswordChangeBody,
  RecoveryCodesBody,
  RecoverySignInBody,
  TotpConfirmBody,
  passwordIssue,
  settingDef,
  type OidcCheckResult,
  type OidcPending,
  type OidcSignInStart,
  type RecoveryCodesResult,
  type RecoverySession,
  type RecoveryStatus,
  type SettingKey,
  type TotpEnrolment,
} from '@yoda/shared'
import { and, eq, ne, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { HttpError, invalidState } from '../auth/plugin.js'
import { departmentSettings, localSessions } from '../db/schema.js'
import {
  adminById,
  adminView,
  changePassword,
  checkSecondFactor,
  MasterKeyUnavailable,
  notifyAdmins,
  PENDING_TOTP_AAD,
  replaceRecoveryCodes,
  setTotp,
  signIn,
  totpRequired,
  UnknownUserGuard,
  type AdminRow,
} from '../local/break-glass.js'
import { invalidCode, invalidCredentials, nowOf, secondFactorRequired, secretsUnavailable, storeOf, takeLimit, weakPassword, whereFrom } from '../local/http.js'
import {
  applyPending,
  currentOidc,
  discardPending,
  envLockedOidc,
  finishTestSignIn,
  markTested,
  OidcChangeFailed,
  readOidcState,
  rollbackOidc,
  stagePending,
  startTestSignIn,
} from '../local/oidc-change.js'
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  isHttps,
  requireSession,
  sessionView,
  setSessionCookie,
  updateSessionData,
  type ActiveSession,
  type SessionData,
} from '../local/session.js'
import { newTotpSecret, totpUri, verifyTotp } from '../local/totp.js'
import { RateLimiter } from '../settings/rate-limit.js'
import type { SettingActor, SettingsStore } from '../settings/store.js'
import { runSettingsTest } from '../settings/tests.js'
import { funMode } from './admin.js'
import { setupState } from './public-config.js'

/**
 * The recovery API (installer proposal §7.2, §7.4, §8.3, §8.6, §11): the break-glass admin signs in with password
 * plus TOTP (or a recovery code) and gets a `yoda_bg` cookie session on /api/recovery (15 min idle, 1 h absolute,
 * CSRF header on every non-GET). It can see the install's state, change the sign-in settings through a staged and
 * tested change (with a 7-day rollback), switch fun mode off, and look after its own password, TOTP and recovery
 * codes. It never gets a portal session: these routes are the only ones its cookie opens. Every use is audited
 * and every portal admin is notified. Not served in setup mode (the break-glass admin uses /setup then).
 */

const PUBLIC = { config: { public: true } } as const

type Signed = { session: ActiveSession; admin: AdminRow; store: SettingsStore; restricted: boolean }

const actorOf = (request: FastifyRequest, admin: AdminRow): SettingActor => ({
  personId: null,
  label: `break-glass:${admin.username}`,
  source: 'recovery',
  ...whereFrom(request),
})

const restrictedOf = (s: SettingsStore, admin: AdminRow) => admin.mustChangePassword || (!admin.totpEnabled && totpRequired(s))

export function recoveryRoutes(app: FastifyInstance): void {
  // §8.4: 5 sign-ins per IP per 15 min (the per-account backoff is in break-glass.ts); tests 10 / min, 60 / hour.
  const signInLimit = new RateLimiter([{ max: 5, windowMs: 15 * 60_000 }])
  const testLimit = new RateLimiter([
    { max: 10, windowMs: 60_000 },
    { max: 60, windowMs: 3_600_000 },
  ])
  const unknownUsers = new UnknownUserGuard()
  const policy = () => app.deps.outbound ?? {}

  const publicUrl = (s: SettingsStore): string => s.get('org.publicUrl') ?? 'http://localhost:3000'

  /** The recovery session and its admin; restricted sessions (a reset not finished) only reach `allowRestricted` routes. */
  async function signed(request: FastifyRequest, opts: { allowRestricted?: boolean } = {}): Promise<Signed> {
    const store = storeOf(app)
    if (setupState(app.deps.config, store) === 'required') throw new HttpError(503, { error: 'setup_required' })
    const session = await requireSession(app.deps.db, request, 'recovery', { now: nowOf(app), publicUrl: publicUrl(store) })
    const admin = session.row.adminId ? await adminById(app.deps.db, session.row.adminId) : undefined
    if (!admin) throw new HttpError(401, { error: 'unauthorized', reason: 'session' })
    const restricted = restrictedOf(store, admin)
    if (restricted && !opts.allowRestricted) throw new HttpError(403, { error: 'forbidden', reason: 'enrolment_required' })
    return { session, admin, store, restricted }
  }

  async function sessionBody(request: FastifyRequest, s: Signed): Promise<RecoverySession> {
    return {
      ...sessionView(s.session.row, s.session.value, 'recovery', !isHttps(request)),
      admin: await adminView(app.deps.db, s.store, s.admin),
      restricted: s.restricted,
    }
  }

  /** Audited, and every portal admin is told (feed, and email when they have it). */
  async function used(request: FastifyRequest, admin: AdminRow, store: SettingsStore, action: string, what: string, newValue?: object) {
    const at = nowOf(app)
    await store.audit({ action, actor: actorOf(request, admin), result: 'ok', ...(newValue ? { newValue } : {}) })
    await notifyAdmins(app.deps, { what, username: admin.username, ip: request.ip, at, key: `${action}:${request.id}:${at.getTime()}` })
  }

  async function status(s: Signed): Promise<RecoveryStatus> {
    const { pending, rollback } = await readOidcState(app.deps.db)
    const now = nowOf(app)
    return {
      masterKey: { status: s.store.keyStatus, keyId: s.store.keyId, recovery: s.store.recovery },
      setup: setupState(app.deps.config, s.store),
      oidc: {
        current: currentOidc(app.deps.config, s.store),
        envLocked: envLockedOidc(s.store),
        pending,
        rollback: rollback && new Date(rollback.until) > now ? rollback : null,
      },
      funMode: await funMode(app.deps.db),
      breakGlass: await adminView(app.deps.db, s.store, s.admin),
    }
  }

  // ── Session ──────────────────────────────────────────────────────────────────────────────────────────────────

  app.post('/recovery/session', PUBLIC, async (request, reply): Promise<RecoverySession> => {
    const store = storeOf(app)
    if (setupState(app.deps.config, store) === 'required') throw new HttpError(503, { error: 'setup_required' })
    takeLimit(signInLimit, request.ip, reply)
    const body = RecoverySignInBody.parse(request.body)
    const now = nowOf(app)
    const r = await signIn({ db: app.deps.db, settings: store }, unknownUsers, { ...body, now })
    if (!r.ok) {
      await store.audit({ action: 'recovery.signin', actor: { label: `break-glass:${body.username.trim().toLowerCase().slice(0, 64)}`, source: 'recovery', ...whereFrom(request) }, result: r.code })
      if (r.code === 'locked') {
        reply.header('retry-after', String(r.retryAfter ?? 60))
        throw new HttpError(429, { error: 'rate_limited', reason: 'locked', retryAfter: r.retryAfter ?? 60 })
      }
      if (r.code === 'second_factor_required') throw secondFactorRequired()
      if (r.code === 'invalid_code') throw invalidCode()
      if (r.code === 'unavailable') throw secretsUnavailable()
      throw invalidCredentials()
    }
    const { value, row } = await createSession(app.deps.db, 'recovery', request, { adminId: r.admin.id, now })
    const secure = isHttps(request)
    if (!secure) request.log.warn('recovery: session over plain HTTP; the cookie is not Secure (D8)')
    setSessionCookie(reply, 'recovery', value, secure)
    await used(request, r.admin, store, 'recovery.signin', 'เข้าสู่ระบบหน้ากู้คืน (/recovery)', { factor: r.factor })
    return sessionBody(request, { session: { row, value }, admin: r.admin, store, restricted: restrictedOf(store, r.admin) })
  })

  app.get('/recovery/session', PUBLIC, async (request, reply): Promise<RecoverySession> => {
    const s = await signed(request, { allowRestricted: true })
    reply.header('cache-control', 'no-store')
    return sessionBody(request, s)
  })

  app.delete('/recovery/session', PUBLIC, async (request, reply) => {
    const s = await signed(request, { allowRestricted: true })
    await deleteSession(app.deps.db, s.session.row.idHash)
    clearSessionCookie(reply, 'recovery', isHttps(request))
    await s.store.audit({ action: 'recovery.signout', actor: actorOf(request, s.admin), result: 'ok' })
    return reply.status(204).send()
  })

  // ── Status and fun mode ──────────────────────────────────────────────────────────────────────────────────────

  app.get('/recovery/status', PUBLIC, async (request, reply): Promise<RecoveryStatus> => {
    const s = await signed(request)
    reply.header('cache-control', 'no-store')
    return status(s)
  })

  app.post('/recovery/fun-mode/off', PUBLIC, async (request): Promise<RecoveryStatus> => {
    const s = await signed(request)
    await app.deps.db
      .insert(departmentSettings)
      .values({ id: 1, funMode: false, updatedAt: sql`now()` })
      .onConflictDoUpdate({ target: departmentSettings.id, set: { funMode: false, updatedAt: sql`now()` } })
    await used(request, s.admin, s.store, 'recovery.fun_mode_off', 'ปิดโหมดสนุก')
    return status(s)
  })

  // ── OIDC change: stage, check, test sign-in, apply, rollback (8.6) ───────────────────────────────────────────

  async function pendingOrFail(): Promise<OidcPending> {
    const { pending } = await readOidcState(app.deps.db)
    if (!pending) throw invalidState('no_pending')
    return pending
  }

  app.put('/recovery/oidc/pending', PUBLIC, async (request): Promise<RecoveryStatus> => {
    const s = await signed(request)
    const values = OidcValues.parse(request.body)
    const locked = envLockedOidc(s.store)
    if (locked.length) {
      const key = locked[0]!
      throw new HttpError(409, { error: 'setting_locked', key, reason: 'env', envName: settingDef(key as SettingKey).envName })
    }
    await stagePending(app.deps.db, values, `break-glass:${s.admin.username}`, nowOf(app))
    await s.store.audit({ action: 'oidc.stage', actor: actorOf(request, s.admin), newValue: { ...values } })
    return status(s)
  })

  app.delete('/recovery/oidc/pending', PUBLIC, async (request): Promise<RecoveryStatus> => {
    const s = await signed(request)
    await discardPending(app.deps.db)
    await s.store.audit({ action: 'oidc.discard_pending', actor: actorOf(request, s.admin) })
    return status(s)
  })

  /** Discovery, JWKS and client checks of the pending values (the settings test, with the pending values as draft). */
  app.post('/recovery/oidc/check', PUBLIC, async (request, reply): Promise<OidcCheckResult> => {
    const s = await signed(request)
    takeLimit(testLimit, s.admin.id, reply)
    const pending = await pendingOrFail()
    const draft: Partial<Record<SettingKey, unknown>> = {
      'oidc.issuer': pending.values.issuer,
      'oidc.clientId': pending.values.clientId,
      'oidc.jwksUrl': pending.values.jwksUrl ?? undefined,
    }
    const result = await runSettingsTest('oidc', {
      get: ((key: SettingKey) => (key in draft ? draft[key] : s.store.get(key))) as never,
      policy: policy(),
    })
    // A server the admin typed: codes and booleans only.
    const checks = result.checks.map(({ detail: _d, ...c }) => c)
    await s.store.recordTest('signin', 'oidc.pending', result.ok ? 'ok' : (checks.find((c) => !c.ok)?.code ?? 'failed'), actorOf(request, s.admin))
    return { ok: result.ok, checks }
  })

  /** Starts the test sign-in through the pending values; the browser goes to `authorizeUrl` and back to /recovery. */
  app.post('/recovery/oidc/signin', PUBLIC, async (request, reply): Promise<OidcSignInStart> => {
    const s = await signed(request)
    takeLimit(testLimit, s.admin.id, reply)
    const pending = await pendingOrFail()
    let started
    try {
      started = await startTestSignIn(pending, { publicUrl: publicUrl(s.store), policy: policy(), now: nowOf(app) })
    } catch (err) {
      if (err instanceof OidcChangeFailed) throw new HttpError(422, { error: 'bad_request', reason: err.code })
      throw err
    }
    await updateSessionData(app.deps.db, s.session.row.idHash, { ...(s.session.row.data as SessionData), oidc: started.data })
    return { authorizeUrl: started.authorizeUrl, redirectUri: started.redirectUri }
  })

  /** The identity provider's answer (code and state from the /recovery URL); marks the pending change tested. */
  app.post('/recovery/oidc/callback', PUBLIC, async (request, reply): Promise<OidcCheckResult & { pending: OidcPending | null }> => {
    const s = await signed(request)
    takeLimit(testLimit, s.admin.id, reply)
    const body = OidcCallbackBody.parse(request.body)
    const data = s.session.row.data as SessionData
    if (!data.oidc) throw invalidState('no_signin')
    // Single use: the flow is dropped before anything else.
    const { oidc: flow, ...rest } = data
    await updateSessionData(app.deps.db, s.session.row.idHash, rest)
    const pending = await pendingOrFail()
    const now = nowOf(app)
    const r = await finishTestSignIn({ db: app.deps.db, policy: policy() }, pending, flow, { ...body, now })
    const result = r.ok ? 'ok' : (r.checks.find((c) => !c.ok)?.code ?? 'failed')
    await s.store.recordTest('signin', 'oidc.signin', result, actorOf(request, s.admin))
    const next = r.ok && r.username ? await markTested(app.deps.db, pending, r.username, now) : pending
    return { ok: r.ok, checks: r.checks, pending: next }
  })

  app.post('/recovery/oidc/apply', PUBLIC, async (request): Promise<RecoveryStatus> => {
    const s = await signed(request)
    const pending = await pendingOrFail()
    if (!pending.testedAt) throw invalidState('not_tested')
    if (envLockedOidc(s.store).length) throw new HttpError(409, { error: 'setting_locked', reason: 'env' })
    await applyPending({ db: app.deps.db, settings: s.store, config: app.deps.config }, pending, actorOf(request, s.admin), nowOf(app))
    await notifyAdmins(app.deps, {
      what: `เปลี่ยนการตั้งค่าเข้าสู่ระบบ (OIDC) เป็น ${pending.values.issuer}`,
      username: s.admin.username,
      ip: request.ip,
      at: nowOf(app),
      key: `oidc.apply:${request.id}:${nowOf(app).getTime()}`,
    })
    return status(s)
  })

  app.post('/recovery/oidc/rollback', PUBLIC, async (request): Promise<RecoveryStatus> => {
    const s = await signed(request)
    const { rollback } = await readOidcState(app.deps.db)
    if (!rollback || new Date(rollback.until) <= nowOf(app)) throw invalidState('no_rollback')
    if (envLockedOidc(s.store).length) throw new HttpError(409, { error: 'setting_locked', reason: 'env' })
    await rollbackOidc({ db: app.deps.db, settings: s.store }, rollback, actorOf(request, s.admin))
    await notifyAdmins(app.deps, {
      what: 'ย้อนการตั้งค่าเข้าสู่ระบบ (OIDC) กลับเป็นค่าก่อนหน้า',
      username: s.admin.username,
      ip: request.ip,
      at: nowOf(app),
      key: `oidc.rollback:${request.id}:${nowOf(app).getTime()}`,
    })
    return status(s)
  })

  // ── The break-glass account itself ───────────────────────────────────────────────────────────────────────────

  /** The current second factor, when TOTP is enrolled; otherwise nothing to check. */
  async function secondFactor(s: Signed, input: { totpCode?: string; recoveryCode?: string }): Promise<void> {
    const r = await checkSecondFactor(app.deps.db, s.store, s.admin, input, nowOf(app))
    if (r === 'missing') throw secondFactorRequired()
    if (r === 'invalid') throw invalidCode()
    if (r === 'unavailable') throw secretsUnavailable()
  }

  app.post('/recovery/recovery-codes', PUBLIC, async (request, reply): Promise<RecoveryCodesResult> => {
    const s = await signed(request)
    const body = RecoveryCodesBody.parse(request.body ?? {})
    await secondFactor(s, body)
    let codes: string[]
    try {
      codes = await replaceRecoveryCodes(app.deps.db, s.store, s.admin.id)
    } catch (err) {
      if (err instanceof MasterKeyUnavailable) throw secretsUnavailable()
      throw err
    }
    await used(request, s.admin, s.store, 'break_glass.recovery_codes', 'สร้างรหัสกู้คืนชุดใหม่')
    reply.header('cache-control', 'no-store')
    return { recoveryCodes: codes }
  })

  /** A new password; needs the current second factor when TOTP is enrolled. Other sessions of the account end. */
  app.post('/recovery/password', PUBLIC, async (request): Promise<RecoverySession> => {
    const s = await signed(request, { allowRestricted: true })
    const body = PasswordChangeBody.parse(request.body)
    const issue = passwordIssue(s.admin.username, body.newPassword)
    if (issue) throw weakPassword(issue)
    await secondFactor(s, body)
    await changePassword(app.deps.db, s.admin.id, body.newPassword, nowOf(app))
    await app.deps.db
      .delete(localSessions)
      .where(and(eq(localSessions.adminId, s.admin.id), ne(localSessions.idHash, s.session.row.idHash)))
    await used(request, s.admin, s.store, 'break_glass.password', 'เปลี่ยนรหัสผ่านบัญชีฉุกเฉิน')
    return sessionBody(request, await signed(request, { allowRestricted: true }))
  })

  const sealAad = (sess: ActiveSession) => `${PENDING_TOTP_AAD}:${sess.row.idHash.toString('hex')}`

  app.post('/recovery/totp/start', PUBLIC, async (request, reply): Promise<TotpEnrolment> => {
    const s = await signed(request, { allowRestricted: true })
    const secret = newTotpSecret()
    const sealed = s.store.seal(sealAad(s.session), secret)
    if (!sealed) throw secretsUnavailable()
    await updateSessionData(app.deps.db, s.session.row.idHash, {
      ...(s.session.row.data as SessionData),
      totpSeed: { blob: sealed.blob.toString('base64'), keyId: sealed.keyId },
    })
    reply.header('cache-control', 'no-store')
    return { uri: totpUri(secret, s.admin.username), secret }
  })

  /** Switches to the new seed once a code of it verifies; replacing an enrolled seed needs the current factor. */
  app.post('/recovery/totp/confirm', PUBLIC, async (request): Promise<RecoverySession> => {
    const s = await signed(request, { allowRestricted: true })
    const body = TotpConfirmBody.parse(request.body)
    const data = s.session.row.data as SessionData
    const seed = data.totpSeed ? s.store.open(sealAad(s.session), Buffer.from(data.totpSeed.blob, 'base64'), data.totpSeed.keyId) : null
    if (!seed) throw invalidState('no_enrolment')
    const step = verifyTotp(seed, body.code, { now: nowOf(app).getTime() })
    if (step === null) throw invalidCode()
    await secondFactor(s, { totpCode: body.currentTotpCode, recoveryCode: body.recoveryCode })
    try {
      await setTotp(app.deps.db, s.store, s.admin.id, seed, step)
    } catch (err) {
      if (err instanceof MasterKeyUnavailable) throw secretsUnavailable()
      throw err
    }
    const { totpSeed: _used, ...rest } = data
    await updateSessionData(app.deps.db, s.session.row.idHash, rest)
    await used(request, s.admin, s.store, 'break_glass.totp', 'ตั้งค่า TOTP ของบัญชีฉุกเฉินใหม่')
    return sessionBody(request, await signed(request, { allowRestricted: true }))
  })
}
