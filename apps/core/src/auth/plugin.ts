import type { Me } from '@yoda/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { jwtVerify } from 'jose'
import type { AppDeps } from '../app.js'
import { isStaff, TokenClaims, upsertPersonFromClaims } from './people.js'

/** Thrown by guards / auth; mapped to `{ error }` bodies by the app error handler. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: 401 | 403 | 404 | 409 | 413 | 415 | 422 | 502,
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
        | 'gitlab_unavailable'
    },
  ) {
    super(body.error)
  }
}

const unauthorized = () => new HttpError(401, { error: 'unauthorized' })
export const notFound = () => new HttpError(404, { error: 'not_found' })
export const lastAdmin = () => new HttpError(409, { error: 'last_admin' })
export const lastPm = () => new HttpError(409, { error: 'last_pm' })
export const notStaff = () => new HttpError(422, { error: 'not_staff' })
export const forbidden = () => new HttpError(403, { error: 'forbidden' })
export const invalidState = () => new HttpError(409, { error: 'invalid_state' })
export const notMember = () => new HttpError(422, { error: 'not_member' })
export const decisionRequired = () => new HttpError(422, { error: 'decision_required' })
export const tooLarge = () => new HttpError(413, { error: 'too_large' })
export const unsupportedType = () => new HttpError(415, { error: 'unsupported_type' })
/** Accepting a create_work_item proposal that names no project, without choosing one. */
export const projectRequired = () => new HttpError(422, { error: 'project_required' })
export const gitlabNotConnected = () => new HttpError(422, { error: 'gitlab_not_connected' })
export const repoNotFound = () => new HttpError(422, { error: 'repo_not_found' })
export const commentRequired = () => new HttpError(422, { error: 'comment_required' })

/**
 * Verify the bearer token. Returns validated claims, or null for any failure
 * (missing header, bad signature, expired, wrong issuer, wrong client, missing claims).
 */
async function verifyRequest(request: FastifyRequest, deps: AppDeps): Promise<TokenClaims | null> {
  const header = request.headers.authorization
  const match = header?.match(/^Bearer\s+(\S+)$/i)
  if (!match) return null
  try {
    const { payload } = await jwtVerify(match[1], deps.jwks, {
      issuer: deps.config.oidcIssuer,
      algorithms: ['RS256'],
      requiredClaims: ['exp'],
    })
    if (payload.azp !== deps.config.oidcClientId) return null
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
 */
export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('me', null as unknown as Me)
  app.decorateRequest('tokenExp', 0)

  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.config?.public === true) return
    const { deps } = app
    const claims = await verifyRequest(request, deps)
    if (!claims) throw unauthorized()
    const person = await upsertPersonFromClaims(deps.db, claims, deps.config)
    request.tokenExp = claims.exp * 1000
    request.me = {
      id: person.id,
      username: person.username,
      displayName: person.displayName,
      email: person.email,
      isAdmin: person.isAdmin,
      // Admins count as staff.
      isStaff: person.isAdmin || isStaff(person, claims, deps.config.staffGroup),
    }
  })
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
  }
  interface FastifyContextConfig {
    public?: boolean
  }
}
