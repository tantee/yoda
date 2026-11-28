import { randomUUID } from 'node:crypto'
import {
  OFFICIAL_EXTENSION_ID,
  chromiumappRedirect,
  extensionTokenRe,
  type ExtensionAuthorize,
  type ExtensionGrant,
  type ExtensionTokenErrorReason,
  type ExtensionTokenResponse,
  type GrantRevokeReason,
  type Me,
} from '@yoda/shared'
import { and, desc, eq, gt, isNull, or, sql, type SQL } from 'drizzle-orm'
import type { Db, Tx } from '../db/client.js'
import { extensionAuthCodes, extensionGrants, extensionRefreshTokens, people } from '../db/schema.js'
import { HttpError } from '../auth/plugin.js'
import type { PersonRow } from '../auth/people.js'
import { meFromPerson } from '../runners/records.js'
import { hashToken, newExtensionToken, verifyPkceS256 } from './tokens.js'

/**
 * Yoda Reporter grants (proposal §7, plan decision 4): a 60 s PKCE code, then an access token on the grant row and
 * a refresh token that rotates on every use. A used refresh token presented again revokes the whole grant, with no
 * grace window. Everything is checked live: the grant, the person's staff status, the extension allowlist and the
 * person's last Keycloak sign-in.
 */

export type GrantRow = typeof extensionGrants.$inferSelect

export class GrantError extends Error {
  constructor(
    readonly reason: ExtensionTokenErrorReason,
    /** The grant's token family, for per-family failure limits; null when the token matched no grant. */
    readonly familyId: string | null = null,
    /** Set when this call revoked the grant (for the lifecycle log), with the grant's id. */
    readonly revoked: { reason: GrantRevokeReason; grantId: string } | null = null,
  ) {
    super(reason)
  }
}

export type GrantCtx = {
  now: Date
  ip: string
  allowedIds: string[]
  ttl: { accessMinutes: number; idleDays: number; absoluteDays: number; reauthDays: number }
}

const CODE_TTL_MS = 60_000
const DAY_MS = 86_400_000
const LAST_USED_THROTTLE_MS = 60_000

/** `extension.allowedIds` plus the official ID (null until the owner commits its key). */
export function effectiveAllowedIds(settings: { get(key: 'extension.allowedIds'): string[] | undefined } | null | undefined): string[] {
  const ids = [...(settings?.get('extension.allowedIds') ?? [])]
  if (OFFICIAL_EXTENSION_ID && !ids.includes(OFFICIAL_EXTENSION_ID)) ids.push(OFFICIAL_EXTENSION_ID)
  return ids
}

const refuse = (reason: 'extension_not_allowed' | 'redirect_mismatch' | 'not_staff') => new HttpError(403, { error: 'forbidden', reason })

/** Mints a code for the signed-in staff member who approved the connect page; nothing is stored on a refusal. */
export async function issueAuthCode(
  db: Db | Tx,
  me: Me,
  input: ExtensionAuthorize,
  opts: { allowedIds: string[]; now: Date },
): Promise<{ redirectTo: string }> {
  if (!me.isStaff) throw refuse('not_staff')
  if (!opts.allowedIds.includes(input.extensionId)) throw refuse('extension_not_allowed')
  if (input.redirectUri !== chromiumappRedirect(input.extensionId)) throw refuse('redirect_mismatch')
  const code = newExtensionToken('code')
  await db.insert(extensionAuthCodes).values({
    codeHash: code.hash,
    personId: me.id,
    extensionId: input.extensionId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    browserLabel: input.browserLabel,
    expiresAt: new Date(opts.now.getTime() + CODE_TTL_MS),
  })
  const url = new URL(input.redirectUri)
  url.searchParams.set('code', code.token)
  url.searchParams.set('state', input.state)
  return { redirectTo: url.toString() }
}

function person(p: PersonRow): ExtensionTokenResponse['person'] {
  const me = meFromPerson(p)
  return { id: me.id, displayName: me.displayName, isStaff: me.isStaff }
}

/** A fresh access token and refresh token on `grant` (inside the caller's transaction). */
async function issueTokens(tx: Tx, grant: GrantRow, p: PersonRow, ctx: GrantCtx): Promise<ExtensionTokenResponse> {
  const access = newExtensionToken('access')
  const refresh = newExtensionToken('refresh')
  const now = ctx.now.getTime()
  const idle = Math.min(now + ctx.ttl.idleDays * DAY_MS, grant.absoluteExpiresAt.getTime())
  await tx
    .update(extensionGrants)
    .set({
      accessHash: access.hash,
      accessExpiresAt: new Date(now + ctx.ttl.accessMinutes * 60_000),
      idleExpiresAt: new Date(idle),
      lastUsedAt: ctx.now,
      lastIp: ctx.ip,
    })
    .where(eq(extensionGrants.id, grant.id))
  await tx.insert(extensionRefreshTokens).values({ hash: refresh.hash, grantId: grant.id, createdAt: ctx.now })
  return { accessToken: access.token, expiresIn: ctx.ttl.accessMinutes * 60, refreshToken: refresh.token, grantId: grant.id, person: person(p) }
}

/**
 * Exchanges a code for the first tokens of a new grant. The code is claimed by one atomic UPDATE, so of two
 * concurrent exchanges exactly one gets tokens; PKCE and the extension ID are checked after the claim.
 */
export async function exchangeCode(
  db: Db,
  req: { code: string; codeVerifier: string; extensionId: string },
  ctx: GrantCtx,
): Promise<ExtensionTokenResponse> {
  if (!extensionTokenRe('code').test(req.code)) throw new GrantError('invalid_grant')
  // The claim commits on its own: a wrong verifier or extension ID still uses the code up.
  const [code] = await db
    .update(extensionAuthCodes)
    .set({ usedAt: ctx.now })
    .where(and(eq(extensionAuthCodes.codeHash, hashToken(req.code)), isNull(extensionAuthCodes.usedAt), gt(extensionAuthCodes.expiresAt, ctx.now)))
    .returning()
  if (!code) throw new GrantError('invalid_grant')
  if (!verifyPkceS256(req.codeVerifier, code.codeChallenge)) throw new GrantError('invalid_grant')
  if (req.extensionId !== code.extensionId || !ctx.allowedIds.includes(code.extensionId)) throw new GrantError('invalid_grant')
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(people).where(eq(people.id, code.personId))
    if (!p || !meFromPerson(p).isStaff) throw new GrantError('invalid_grant')
    const now = ctx.now.getTime()
    const [grant] = await tx
      .insert(extensionGrants)
      .values({
        personId: p.id,
        extensionId: code.extensionId,
        browserLabel: code.browserLabel,
        familyId: randomUUID(),
        idleExpiresAt: new Date(now + ctx.ttl.idleDays * DAY_MS),
        absoluteExpiresAt: new Date(now + ctx.ttl.absoluteDays * DAY_MS),
        createdAt: ctx.now,
      })
      .returning()
    return issueTokens(tx, grant!, p, ctx)
  })
}

type RefreshOutcome =
  | { ok: true; tokens: ExtensionTokenResponse }
  | { ok: false; reason: ExtensionTokenErrorReason; familyId: string | null; revoke?: GrantRevokeReason; grantId?: string }

/**
 * Rotates a refresh token. Locks the token row, then the grant (`FOR UPDATE`), so two refreshes of one token are
 * serialised: the second sees `used_at` and revokes the grant.
 */
export async function refreshGrant(db: Db, refreshToken: string, ctx: GrantCtx): Promise<ExtensionTokenResponse> {
  if (!extensionTokenRe('refresh').test(refreshToken)) throw new GrantError('invalid_grant')
  const outcome = await db.transaction(async (tx): Promise<RefreshOutcome> => {
    const [token] = await tx
      .select()
      .from(extensionRefreshTokens)
      .where(eq(extensionRefreshTokens.hash, hashToken(refreshToken)))
      .for('update')
    if (!token) return { ok: false, reason: 'invalid_grant', familyId: null }
    const [grant] = await tx.select().from(extensionGrants).where(eq(extensionGrants.id, token.grantId)).for('update')
    if (!grant) return { ok: false, reason: 'invalid_grant', familyId: null }
    const fail = (reason: ExtensionTokenErrorReason, revoke?: GrantRevokeReason): RefreshOutcome => ({
      ok: false,
      reason,
      familyId: grant.familyId,
      ...(revoke ? { revoke, grantId: grant.id } : {}),
    })
    if (grant.revokedAt) return fail('revoked')
    if (token.usedAt) return fail('revoked', 'reuse_detected')
    const now = ctx.now.getTime()
    if (now >= grant.idleExpiresAt.getTime() || now >= grant.absoluteExpiresAt.getTime()) return fail('invalid_grant')
    if (!ctx.allowedIds.includes(grant.extensionId)) return fail('revoked', 'extension_not_allowed')
    const [p] = await tx.select().from(people).where(eq(people.id, grant.personId))
    if (!p || !meFromPerson(p).isStaff) return fail('revoked', 'not_staff')
    if (p.lastSeenAt.getTime() < now - ctx.ttl.reauthDays * DAY_MS) return fail('reauth_required')
    await tx.update(extensionRefreshTokens).set({ usedAt: ctx.now }).where(eq(extensionRefreshTokens.hash, token.hash))
    return { ok: true, tokens: await issueTokens(tx, grant, p, ctx) }
  })
  if (outcome.ok) return outcome.tokens
  // The revocation commits on its own, after the read transaction: a refusal never rolls it back.
  if (outcome.revoke && outcome.grantId) {
    const revoked = await revokeGrant(db, outcome.grantId, { personId: null, reason: outcome.revoke })
    throw new GrantError(outcome.reason, outcome.familyId, revoked ? { reason: outcome.revoke, grantId: outcome.grantId } : null)
  }
  throw new GrantError(outcome.reason, outcome.familyId)
}

/** The token family of a refresh token, for the per-family failure limit checked before a refresh; null if unknown. */
export async function refreshFamily(db: Db, refreshToken: string): Promise<string | null> {
  if (!extensionTokenRe('refresh').test(refreshToken)) return null
  const [row] = await db
    .select({ familyId: extensionGrants.familyId })
    .from(extensionRefreshTokens)
    .innerJoin(extensionGrants, eq(extensionGrants.id, extensionRefreshTokens.grantId))
    .where(eq(extensionRefreshTokens.hash, hashToken(refreshToken)))
  return row?.familyId ?? null
}

/**
 * The grant and person behind a `Bearer yoda_xt_…` header, or null: anything else (a Keycloak JWT, a runner token, a
 * refresh token), an expired access token, a revoked grant, an extension ID no longer allowed, or a person who is
 * no longer staff.
 */
export async function authenticateExtension(
  db: Db,
  authorization: string | undefined,
  ctx: { now: Date; allowedIds: string[]; ip?: string },
): Promise<{ grant: GrantRow; me: Me } | null> {
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
  if (!token || !extensionTokenRe('access').test(token)) return null
  // Looked up by hash through a unique index, so timing reveals nothing about the stored token.
  const [found] = await db
    .select({ grant: extensionGrants, person: people })
    .from(extensionGrants)
    .innerJoin(people, eq(people.id, extensionGrants.personId))
    .where(eq(extensionGrants.accessHash, hashToken(token)))
  if (!found) return null
  const { grant } = found
  if (grant.revokedAt || !grant.accessExpiresAt || grant.accessExpiresAt.getTime() <= ctx.now.getTime()) return null
  if (!ctx.allowedIds.includes(grant.extensionId)) return null
  const me = meFromPerson(found.person)
  if (!me.isStaff) return null
  if (!grant.lastUsedAt || ctx.now.getTime() - grant.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS) {
    const [updated] = await db
      .update(extensionGrants)
      .set({ lastUsedAt: ctx.now, ...(ctx.ip ? { lastIp: ctx.ip } : {}) })
      .where(eq(extensionGrants.id, grant.id))
      .returning()
    return { grant: updated ?? grant, me }
  }
  return { grant, me }
}

/** Revokes one active grant; false when it was already revoked or does not exist. */
export async function revokeGrant(db: Db | Tx, grantId: string, by: { personId: string | null; reason: GrantRevokeReason }): Promise<boolean> {
  const rows = await db
    .update(extensionGrants)
    .set({ revokedAt: sql`now()`, revokedBy: by.personId, revokeReason: by.reason })
    .where(and(eq(extensionGrants.id, grantId), isNull(extensionGrants.revokedAt)))
    .returning({ id: extensionGrants.id })
  return rows.length > 0
}

/** Revokes every active grant; the number revoked. */
export async function revokeAllGrants(db: Db | Tx, by: { personId: string | null; reason: GrantRevokeReason }): Promise<number> {
  const rows = await db
    .update(extensionGrants)
    .set({ revokedAt: sql`now()`, revokedBy: by.personId, revokeReason: by.reason })
    .where(isNull(extensionGrants.revokedAt))
    .returning({ id: extensionGrants.id })
  return rows.length
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

/**
 * Grants as Connected browsers shows them, newest first: never a hash or the token family. `activeOnly` leaves out
 * revoked grants; otherwise revoked ones stay listed for 30 days.
 */
export async function listGrants(db: Db | Tx, opts: { personId?: string; activeOnly?: boolean; now: Date }): Promise<ExtensionGrant[]> {
  const conds: SQL[] = []
  if (opts.personId) conds.push(eq(extensionGrants.personId, opts.personId))
  if (opts.activeOnly) conds.push(isNull(extensionGrants.revokedAt))
  else conds.push(or(isNull(extensionGrants.revokedAt), gt(extensionGrants.revokedAt, new Date(opts.now.getTime() - 30 * DAY_MS)))!)
  const rows = await db
    .select({ g: extensionGrants, name: people.displayName })
    .from(extensionGrants)
    .innerJoin(people, eq(people.id, extensionGrants.personId))
    .where(and(...conds))
    .orderBy(desc(extensionGrants.createdAt), desc(extensionGrants.id))
  return rows.map(({ g, name }) => ({
    id: g.id,
    extensionId: g.extensionId,
    browserLabel: g.browserLabel,
    createdAt: g.createdAt.toISOString(),
    lastUsedAt: iso(g.lastUsedAt),
    lastIp: g.lastIp,
    revokedAt: iso(g.revokedAt),
    revokeReason: g.revokeReason as ExtensionGrant['revokeReason'],
    person: { id: g.personId, displayName: name },
  }))
}
