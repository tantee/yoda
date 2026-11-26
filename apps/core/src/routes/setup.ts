import {
  SetupAdminBody,
  SetupSessionBody,
  passwordIssue,
  type LocalSession,
  type SetupAdminResult,
  type SetupStatus,
  type TotpEnrolment,
} from '@yoda/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { invalidState, notFound } from '../auth/plugin.js'
import { setupState as setupStateTable } from '../db/schema.js'
import { createAdmin, firstAdmin, MasterKeyUnavailable, PENDING_TOTP_AAD, totpRequired } from '../local/break-glass.js'
import { invalidCredentials, nowOf, secondFactorRequired, secretsUnavailable, storeOf, takeLimit, weakPassword, whereFrom, invalidCode } from '../local/http.js'
import {
  createSession,
  deleteSession,
  clearSessionCookie,
  findSession,
  isHttps,
  liveSetupSession,
  requireSession,
  sessionView,
  setSessionCookie,
  updateSessionData,
  type ActiveSession,
  type SessionData,
} from '../local/session.js'
import { burnSetupToken, hasLiveSetupToken, issueSetupToken } from '../local/setup-token.js'
import { parseProgress } from '../local/setup-progress.js'
import { newTotpSecret, totpUri, verifyTotp } from '../local/totp.js'
import { RateLimiter } from '../settings/rate-limit.js'
import { setupState } from './public-config.js'

/**
 * The setup API, Task 7 part (installer proposal §4, §7.2, §8.1–8.4, §11): status, the token exchange for a setup
 * session, and the break-glass admin step. The wizard's other steps (organisation, checks, OIDC, kit, claim,
 * complete) are in setup-wizard.ts, on the same session helpers. Every route is public to the bearer-token hook (its own cookie
 * session instead), served in setup mode, and answers 404 once setup is done (8.1: nothing to probe).
 */

const SETUP = { config: { public: true, setupMode: true } } as const

const sealAad = (s: ActiveSession) => `${PENDING_TOTP_AAD}:${s.row.idHash.toString('hex')}`

export function setupRoutes(app: FastifyInstance): void {
  // §8.4: 5 tries per IP per 15 min and 50 overall per hour (per core process; a restart resets them).
  const perIp = new RateLimiter([{ max: 5, windowMs: 15 * 60_000 }])
  const overall = new RateLimiter([{ max: 50, windowMs: 3_600_000 }])

  /** 404 once setup is done; otherwise the store. */
  function open() {
    const s = storeOf(app)
    if (setupState(app.deps.config, s) === 'done') throw notFound()
    return s
  }

  const publicUrl = () => {
    try {
      return app.deps.settings?.get('org.publicUrl')
    } catch {
      return undefined
    }
  }

  const session = (request: FastifyRequest) => requireSession(app.deps.db, request, 'setup', { now: nowOf(app), publicUrl: publicUrl() })

  app.get('/setup/status', SETUP, async (request): Promise<SetupStatus> => {
    const s = open()
    const now = nowOf(app)
    const mine = await findSession(app.deps.db, request, 'setup', now)
    // The token was used and its session ended without finishing setup: issue a new one (8.2).
    if (!mine && !(await hasLiveSetupToken(app.deps.db, now)) && !(await liveSetupSession(app.deps.db, now))) {
      await issueSetupToken(app.deps.db, { file: app.deps.setupTokenFile ?? null, now })
    }
    return {
      required: true,
      detectedUrl: `${request.protocol}://${request.host}`,
      https: isHttps(request),
      session: !!mine,
      totpRequired: totpRequired(s, request.hostname),
      steps: { admin: (await firstAdmin(app.deps.db)) ? 'done' : 'todo' },
    }
  })

  /** Exchanges the setup token for a setup session; the token is burnt (single use). */
  app.post('/setup/session', SETUP, async (request, reply): Promise<LocalSession> => {
    const s = open()
    takeLimit(perIp, request.ip, reply)
    takeLimit(overall, 'all', reply)
    const body = SetupSessionBody.parse(request.body)
    const now = nowOf(app)
    const actor = { label: 'setup', source: 'setup', ...whereFrom(request) }
    if (!(await burnSetupToken(app.deps.db, body.token, now))) {
      await s.audit({ action: 'setup.session', actor, result: 'invalid_token' })
      throw invalidCredentials()
    }
    const { value, row } = await createSession(app.deps.db, 'setup', request, { now })
    const secure = isHttps(request)
    if (!secure) request.log.warn('setup: session over plain HTTP; the cookie is not Secure (D8)')
    setSessionCookie(reply, 'setup', value, secure)
    await s.audit({ action: 'setup.session', actor, result: 'ok' })
    return sessionView(row, value, 'setup', !secure)
  })

  app.get('/setup/session', SETUP, async (request, reply): Promise<LocalSession> => {
    open()
    const sess = await session(request)
    reply.header('cache-control', 'no-store')
    return sessionView(sess.row, sess.value, 'setup', !isHttps(request))
  })

  app.delete('/setup/session', SETUP, async (request, reply) => {
    open()
    const sess = await session(request)
    await deleteSession(app.deps.db, sess.row.idHash)
    clearSessionCookie(reply, 'setup', isHttps(request))
    return reply.status(204).send()
  })

  /** A new TOTP seed for the break-glass admin, kept (sealed) in the session until a code of it is confirmed. */
  app.post('/setup/totp', SETUP, async (request, reply): Promise<TotpEnrolment> => {
    const s = open()
    const sess = await session(request)
    const secret = newTotpSecret()
    const sealed = s.seal(sealAad(sess), secret)
    if (!sealed) throw secretsUnavailable()
    const data: SessionData = { ...(sess.row.data as SessionData), totpSeed: { blob: sealed.blob.toString('base64'), keyId: sealed.keyId } }
    await updateSessionData(app.deps.db, sess.row.idHash, data)
    reply.header('cache-control', 'no-store')
    return { uri: totpUri(secret, 'break-glass'), secret }
  })

  /**
   * Creates the break-glass admin (step 2). TOTP is required unless the public URL is localhost (D3); with a seed
   * from POST /setup/totp, its current code must verify. Returns the 10 recovery codes once.
   */
  app.post('/setup/admin', SETUP, async (request, reply): Promise<SetupAdminResult> => {
    const s = open()
    const sess = await session(request)
    const body = SetupAdminBody.parse(request.body)
    const issue = passwordIssue(body.username, body.password)
    if (issue) throw weakPassword(issue)
    const now = nowOf(app)
    const data = sess.row.data as SessionData
    let totp: { seed: string; step: number } | null = null
    if (body.totpCode) {
      const seed = data.totpSeed ? s.open(sealAad(sess), Buffer.from(data.totpSeed.blob, 'base64'), data.totpSeed.keyId) : null
      if (!seed) throw secondFactorRequired()
      const step = verifyTotp(seed, body.totpCode, { now: now.getTime() })
      if (step === null) throw invalidCode()
      totp = { seed, step }
    } else if (totpRequired(s, request.hostname)) {
      throw secondFactorRequired()
    }
    let created
    try {
      // The recovery kit holds this admin's codes: once it is downloaded, the admin is not replaced (8.1). Checked
      // under the same row lock the kit download takes, so the two cannot interleave.
      created = await createAdmin({ db: app.deps.db, settings: s }, { username: body.username, password: body.password, totp, now }, async (tx) => {
        const [st] = await tx.select({ progress: setupStateTable.setupProgress }).from(setupStateTable).where(eq(setupStateTable.id, 1)).for('update')
        if (parseProgress(st?.progress).kitDownloadedAt) throw invalidState('kit_downloaded')
      })
    } catch (err) {
      if (err instanceof MasterKeyUnavailable) throw secretsUnavailable()
      throw err
    }
    // Rotated after the TOTP step (8.3): the old cookie ends, this browser gets a new one (and a new CSRF token).
    await deleteSession(app.deps.db, sess.row.idHash)
    const next = await createSession(app.deps.db, 'setup', request, { now })
    setSessionCookie(reply, 'setup', next.value, isHttps(request))
    await s.audit({
      action: 'break_glass.created',
      actor: { label: 'setup', source: 'setup', ...whereFrom(request) },
      newValue: { username: created.admin.username, totp: created.admin.totpEnabled },
    })
    reply.header('cache-control', 'no-store')
    return {
      username: created.admin.username,
      totpEnabled: created.admin.totpEnabled,
      recoveryCodes: created.codes,
      session: sessionView(next.row, next.value, 'setup', !isHttps(request)),
    }
  })
}
