import type { Me } from '@yoda/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { jwtVerify } from 'jose'
import type { AppDeps } from '../app.js'
import type { Config } from '../config.js'
import { people } from '../db/schema.js'
import { setupState } from '../setup-state.js'
import { isStaff, TokenClaims, upsertPersonFromClaims } from './people.js'

/** Thrown by guards / auth; mapped to `{ error }` bodies by the app error handler. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 502 | 503,
    readonly body: {
      error:
        | 'unauthorized'
        | 'forbidden'
        | 'not_found'
        | 'last_pm'
        | 'last_admin'
        | 'not_staff'
        | 'invalid_state'
        | 'not_member'
        | 'decision_required'
        | 'comment_required'
        | 'too_large'
        | 'unsupported_type'
        | 'project_required'
        | 'gitlab_not_connected'
        | 'repo_not_found'
        | 'issue_not_found'
        | 'gitlab_unavailable'
        | 'empty_patch'
        | 'invalid_branch'
        | 'invalid_prefs'
        | 'channel_not_configured'
        | 'channel_unavailable'
        | 'bad_request'
        | 'reauth_required'
        | 'setting_locked'
        | 'version_conflict'
        | 'invalid_settings'
        | 'secrets_unavailable'
        | 'settings_unavailable'
        | 'rate_limited'
        | 'not_configured'
        | 'setup_required'
        | 'invalid_credentials'
        | 'csrf_failed'
        | 'second_factor_required'
        | 'invalid_code'
        | 'weak_password'
        | 'recovery_mode'
      /** Machine-readable detail for some errors (runner claims: why `invalid_state`; a setting's lock reason). */
      reason?: string
      /** The setting an error is about (settings API). */
      key?: string
      envName?: string
      /** The current version of a setting that changed meanwhile (`version_conflict`). */
      version?: number
      /** Per-key validation messages (`invalid_settings`). */
      issues?: { key: string; message: string }[]
      /** Seconds until a rate-limited call may be retried. */
      retryAfter?: number
      /** The required setup steps still open (`invalid_state` reason `incomplete`, POST /setup/complete). */
      missing?: string[]
    },
  ) {
    super(body.error)
  }
}

const unauthorized = () => new HttpError(401, { error: 'unauthorized' })
/** Sign-in is not configured yet (no OIDC issuer: setup mode); no bearer token can be checked. */
export const notConfigured = () => new HttpError(503, { error: 'not_configured' })
/** Setup mode (§4.1): only /setup, /public-config, /health and /ready answer until setup is done. */
export const setupRequired = () => new HttpError(503, { error: 'setup_required' })
export const notFound = () => new HttpError(404, { error: 'not_found' })
export const lastAdmin = () => new HttpError(409, { error: 'last_admin' })
export const lastPm = () => new HttpError(409, { error: 'last_pm' })
export const notStaff = () => new HttpError(422, { error: 'not_staff' })
export const forbidden = () => new HttpError(403, { error: 'forbidden' })
export const invalidState = (reason?: string) =>
  new HttpError(409, reason ? { error: 'invalid_state', reason } : { error: 'invalid_state' })
export const notMember = () => new HttpError(422, { error: 'not_member' })
export const decisionRequired = () => new HttpError(422, { error: 'decision_required' })
export const tooLarge = () => new HttpError(413, { error: 'too_large' })
export const unsupportedType = () => new HttpError(415, { error: 'unsupported_type' })
/** Accepting a create_work_item proposal that names no project, without choosing one. */
export const projectRequired = () => new HttpError(422, { error: 'project_required' })
export const gitlabNotConnected = () => new HttpError(422, { error: 'gitlab_not_connected' })
export const repoNotFound = () => new HttpError(422, { error: 'repo_not_found' })
export const issueNotFound = () => new HttpError(422, { error: 'issue_not_found' })
export const commentRequired = () => new HttpError(422, { error: 'comment_required' })
export const emptyPatch = () => new HttpError(422, { error: 'empty_patch' })
export const invalidBranch = (reason?: string) =>
  new HttpError(422, reason ? { error: 'invalid_branch', reason } : { error: 'invalid_branch' })
/** Notification prefs naming an unknown kind or channel, or a kind the person may not choose. */
export const invalidPrefs = () => new HttpError(422, { error: 'invalid_prefs' })
/** Enabling an outside channel whose credentials are not set in env. */
export const channelNotConfigured = () => new HttpError(422, { error: 'channel_not_configured' })
/** A link code for a channel that is not configured and enabled. */
export const channelUnavailable = () => new HttpError(422, { error: 'channel_unavailable' })
export const gitlabUnavailable = () => new HttpError(502, { error: 'gitlab_unavailable' })

/**
 * Verify the bearer token. Returns validated claims, or null for any failure
 * (missing header, bad signature, expired, wrong issuer, wrong client, missing claims).
 */
async function verifyRequest(request: FastifyRequest, deps: Pick<AppDeps, 'jwks'>, config: Config): Promise<TokenClaims | null> {
  if (!config.oidcIssuer) return null
  const header = request.headers.authorization
  const match = header?.match(/^Bearer\s+(\S+)$/i)
  if (!match) return null
  try {
    const { payload } = await jwtVerify(match[1], deps.jwks, {
      issuer: config.oidcIssuer,
      algorithms: ['RS256'],
      requiredClaims: ['exp'],
    })
    if (payload.azp !== config.oidcClientId) return null
    // Keycloak ID tokens share issuer/azp with access tokens; only accept access tokens.
    if (payload.typ !== undefined && payload.typ !== 'Bearer') return null
    const claims = TokenClaims.safeParse(payload)
    return claims.success ? claims.data : null
  } catch {
    return null
  }
}

/**
 * Authenticates every route except those marked `config: { public: true }`.
 * Registered directly on the root instance so the hook applies app-wide.
 *
 * Setup mode first (§4.1): while setup is required, every route not marked `setupMode: true` answers
 * 503 `setup_required`, before any token is looked at. The setup and recovery routes are `public` to this hook:
 * they check their own cookie session (local/session.ts), and that cookie opens nothing else. In forced recovery
 * mode every authenticated route answers 503 `recovery_mode`.
 */
export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('me', null as unknown as Me)
  app.decorateRequest('tokenExp', 0)
  app.decorateRequest('authTime', null)

  app.addHook('onRequest', async (request) => {
    const { deps } = app
    const route = request.routeOptions.config
    if (route?.setupMode !== true && setupState(deps.config, deps.settings) === 'required') throw setupRequired()
    if (route?.public === true) return
    // Forced recovery mode (`yoda-admin recovery on`, 7.4): the portal API is closed; /recovery, the public routes
    // and the webhooks (public too) keep working.
    if (deps.settings?.recoveryForced) throw new HttpError(503, { error: 'recovery_mode' })
    // One snapshot of the settings for the whole check (the issuer, client id and JWKS are swapped together).
    const config = deps.config
    if (!config.oidcIssuer) throw notConfigured()
    const claims = await verifyRequest(request, { jwks: deps.jwks }, config)
    if (!claims) throw unauthorized()
    const person = await personOf(deps, claims, config)
    request.tokenExp = claims.exp * 1000
    request.authTime = claims.auth_time ?? null
    request.me = {
      id: person.id,
      username: person.username,
      displayName: person.displayName,
      email: person.email,
      isAdmin: person.isAdmin,
      // Admins count as staff.
      isStaff: person.isAdmin || isStaff(person, claims, config.staffGroup),
    }
  })
}

/**
 * The person for the token. A username pre-granted at /recovery (`oidc.bootstrapAdmins` in the database) becomes
 * admin when its person row is created, and the pre-grant is used up in that same transaction (T4): it never
 * makes a later, different person with the same username an admin.
 */
async function personOf(deps: FastifyInstance['deps'], claims: TokenClaims, config: Config) {
  const store = deps.settings
  // Only a pre-grant stored in the database (not env-set, not a Config built elsewhere) goes through the lock.
  const preGranted = !!store && store.recoveryWritable('oidc.bootstrapAdmins') && (store.get('oidc.bootstrapAdmins') ?? []).includes(claims.preferred_username)
  if (!store || !preGranted) {
    return upsertPersonFromClaims(deps.db, claims, config)
  }
  let used = false
  const person = await deps.db.transaction(async (tx) => {
    const [known] = await tx.select({ id: people.id }).from(people).where(eq(people.keycloakSub, claims.sub))
    // The pre-grant row is locked and consumed first; only the sign-in that consumed it creates an admin. The
    // in-memory list is never trusted for the flag: two first sign-ins at once (or another core that has not
    // reloaded yet) would both see the username in it. (BOOTSTRAP_ADMINS in env never reaches here.)
    if (!known) used = await store.consumePreGrant(tx, claims.preferred_username)
    return upsertPersonFromClaims(tx, claims, { ...config, bootstrapAdmins: used ? [claims.preferred_username] : [] })
  })
  if (used) await store.reloadSetting('oidc.bootstrapAdmins')
  return person
}

/** Any signed-in person, staff or requester; the route itself must then authorize per resource. */
export function requireSignedIn(request: FastifyRequest): void {
  if (!request.me) throw unauthorized()
}

export function requireStaff(request: FastifyRequest): void {
  if (!request.me) throw unauthorized()
  // me.isStaff already includes admins (computed in the auth hook).
  if (!request.me.isStaff) throw forbidden()
}

export function requireAdmin(request: FastifyRequest): void {
  if (!request.me) throw unauthorized()
  if (!request.me.isAdmin) throw forbidden()
}

declare module 'fastify' {
  interface FastifyRequest {
    me: Me
    /** Access-token expiry, epoch ms. */
    tokenExp: number
    /**
     * When the person last entered their credentials at Keycloak (the token's `auth_time`, epoch seconds), or null
     * when the token has none. Token refreshes keep it; only a fresh sign-in (`prompt=login` / `max_age`) moves it.
     */
    authTime: number | null
  }
  interface FastifyContextConfig {
    public?: boolean
    /** Served in setup mode (§4.1); every other route answers 503 `setup_required` until setup is done. */
    setupMode?: boolean
  }
}
