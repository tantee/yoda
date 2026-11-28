import {
  DEFECT_LIMITS,
  DEFECT_TYPES,
  EXTENSION_API_VERSION,
  ExtensionAuthorize,
  ExtensionSession,
  ExtensionTokenRequest,
  type DefectKind,
  type ExtensionLatest,
} from '@yoda/shared'
import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { HttpError, requireSignedIn } from '../auth/plugin.js'
import { extensionGrants, projectMembers, projectRepos, projects } from '../db/schema.js'
import { exchangeCode, GrantError, issueAuthCode, refreshFamily, refreshGrant, revokeGrant } from '../extension/grants.js'
import { extensionSetting, grantSettings } from '../extension/hook.js'
import { extensionLimits, type ExtensionLimits } from '../extension/limits.js'
import { VERSION } from '../version.js'

/** Every kind a staff member may file; "bug-fix request" is optional for the tester (D1). */
const KINDS: DefectKind[] = ['defect', 'bug_fix_request']

const rateLimited = (retryAfter: number) => new HttpError(429, { error: 'rate_limited', retryAfter })
const tokenRefused = (reason: GrantError['reason']) => new HttpError(401, { error: 'unauthorized', reason })

function take(limiter: ExtensionLimits[keyof ExtensionLimits], key: string): void {
  const r = limiter.take(key)
  if (!r.ok) throw rateLimited(r.retryAfter)
}
function check(limiter: ExtensionLimits[keyof ExtensionLimits], key: string): void {
  const r = limiter.check(key)
  if (!r.ok) throw rateLimited(r.retryAfter)
}

/** The latest release core can serve; null until the downloads land (plan A12). */
export async function latestExtension(): Promise<ExtensionLatest> {
  return null
}

/**
 * Yoda Reporter routes (proposal §10.1, plan A3). Each route sets `config.extension`: the auth hook's extension gate
 * then answers 503 in forced recovery mode and 404 while `extension.enabled` is off, and `token` routes accept only
 * a `yoda_xt_` access token (`request.extension`). Lifecycle logs carry the grant and person ids only.
 */
export function extensionRoutes(app: FastifyInstance, limits: ExtensionLimits = extensionLimits()): void {
  const db = () => app.deps.db
  const now = () => app.deps.now?.() ?? new Date()
  const ext = (request: FastifyRequest) => {
    if (!request.extension) throw new HttpError(401, { error: 'unauthorized' })
    return request.extension
  }
  /** Grants whose last refresh asked for a portal sign-in, to log the refresh that follows it. */
  const awaitingReauth = new Set<string>()

  app.post('/extension/authorize', { config: { extension: 'keycloak' } }, async (request) => {
    // A requester gets through to issueAuthCode, which refuses with reason `not_staff`.
    requireSignedIn(request)
    const body = ExtensionAuthorize.parse(request.body)
    take(limits.authorize, request.me.id)
    return issueAuthCode(db(), request.me, body, { allowedIds: grantSettings(app.deps.settings).allowedIds, now: now() })
  })

  app.post('/extension/token', { config: { public: true, extension: 'public' } }, async (request) => {
    const ip = request.ip
    take(limits.token, ip)
    const body = ExtensionTokenRequest.parse(request.body)
    const ctx = { now: now(), ip, ...grantSettings(app.deps.settings) }
    if (body.grantType === 'authorization_code') {
      check(limits.codeFailures, ip)
      try {
        const tokens = await exchangeCode(db(), body, ctx)
        request.log.info({ grantId: tokens.grantId, personId: tokens.person.id }, 'extension grant created')
        return tokens
      } catch (err) {
        if (!(err instanceof GrantError)) throw err
        limits.codeFailures.take(ip)
        throw tokenRefused(err.reason)
      }
    }
    const family = await refreshFamily(db(), body.refreshToken)
    if (family) check(limits.refreshFailures, family)
    try {
      const tokens = await refreshGrant(db(), body.refreshToken, ctx)
      if (awaitingReauth.delete(tokens.grantId)) request.log.info({ grantId: tokens.grantId, personId: tokens.person.id }, 'extension grant refreshed_after_reauth')
      return tokens
    } catch (err) {
      if (!(err instanceof GrantError)) throw err
      if (err.familyId) limits.refreshFailures.take(err.familyId)
      if (err.revoked) {
        request.log.warn({ grantId: err.revoked.grantId }, err.revoked.reason === 'reuse_detected' ? 'extension grant reuse_detected' : `extension grant revoked (${err.revoked.reason})`)
      }
      if (err.reason === 'reauth_required') {
        const grantId = await grantOfFamily(err.familyId)
        if (grantId) awaitingReauth.add(grantId)
      }
      throw tokenRefused(err.reason)
    }
  })

  /** The grant of a family (one family per grant). */
  async function grantOfFamily(familyId: string | null): Promise<string | null> {
    if (!familyId) return null
    const [g] = await db().select({ id: extensionGrants.id }).from(extensionGrants).where(eq(extensionGrants.familyId, familyId))
    return g?.id ?? null
  }

  app.post('/extension/revoke', { config: { public: true, extension: 'token' } }, async (request, reply: FastifyReply) => {
    const { grant, me } = ext(request)
    if (await revokeGrant(db(), grant.id, { personId: me.id, reason: 'user' })) {
      request.log.info({ grantId: grant.id, personId: me.id }, 'extension grant revoked (user)')
    }
    return reply.status(204).send()
  })

  app.get('/extension/session', { config: { public: true, extension: 'token' } }, async (request) => {
    const { grant, me } = ext(request)
    take(limits.session, grant.id)
    const s = app.deps.settings
    const name = s?.get('org.name') ?? null
    const nameEn = s?.get('org.nameEn') ?? null
    const member = await db()
      .select({ id: projects.id, name: projects.name, noAi: projects.noAi })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(and(eq(projectMembers.personId, me.id), ne(projects.status, 'archived')))
      .orderBy(asc(projects.name), asc(projects.id))
    const repos = member.length
      ? await db()
          .select({ projectId: projectRepos.projectId, path: projectRepos.pathWithNamespace })
          .from(projectRepos)
          .where(inArray(projectRepos.projectId, member.map((p) => p.id)))
          .orderBy(asc(projectRepos.pathWithNamespace))
      : []
    const perRole = DEFECT_LIMITS.perRole
    return ExtensionSession.parse({
      apiVersion: EXTENSION_API_VERSION,
      instance: { name: { th: name ?? 'Yoda', en: nameEn ?? name ?? 'Yoda' }, publicUrl: app.deps.config.portalUrl, version: VERSION },
      latestExtension: await latestExtension(),
      person: { id: me.id, displayName: me.displayName, isStaff: me.isStaff },
      projects: member.map((p) => ({ ...p, kinds: KINDS, repos: repos.filter((r) => r.projectId === p.id).map((r) => r.path) })),
      limits: {
        maxFileBytes: Math.max(...Object.values(perRole)),
        maxReportBytes: DEFECT_LIMITS.maxReportBytes,
        maxFiles: DEFECT_LIMITS.maxFiles,
        maxVideoSeconds: extensionSetting(s, 'extension.maxVideoSeconds'),
        perRole,
        allowedTypes: DEFECT_TYPES,
      },
      policy: { videoOnProduction: false, logsOnProductionDefault: false, requireConfirm: true },
    })
  })
}

