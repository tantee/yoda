import { createHmac } from 'node:crypto'
import { CSRF_HEADER, type LocalSession } from '@yoda/shared'
import { and, eq, gt, lt, sql } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { HttpError } from '../auth/plugin.js'
import type { Db } from '../db/client.js'
import { localSessions } from '../db/schema.js'
import { randomToken, sameBytes, sha256 } from './codes.js'

/**
 * Setup and recovery cookie sessions (installer proposal §7.2, §8.3). The cookie holds 256 random bits; only its
 * SHA-256 is stored, bound to the user agent. The cookie is `HttpOnly; SameSite=Strict`, scoped to its API path
 * (the portal proxies core under /api), and `Secure` unless the request came over plain HTTP (D8: allowed on the
 * LAN, with a warning). Every non-GET call also needs the CSRF token in `X-Yoda-CSRF` (derived from the cookie
 * value, so the page can read it again after a reload) and an `Origin`, when the browser sends one, of the public
 * URL or the address the request came to.
 */

export type SessionKind = 'setup' | 'recovery'
export type SessionRow = typeof localSessions.$inferSelect

/** Session state kept server-side: a TOTP seed being enrolled (sealed), an OIDC test sign-in in flight. */
export type SessionData = {
  totpSeed?: { blob: string; keyId: string }
  /** Wrong step-up codes in this session (the fifth ends it). */
  stepUpFailures?: number
  /** `stagedAt`: the staging this sign-in tests; a restage (even of the same values) is another change. */
  oidc?: { state: string; nonce: string; verifier: string; redirectUri: string; startedAt: string; valuesHash: string; stagedAt: string }
}

export const COOKIE_NAME: Record<SessionKind, string> = { setup: 'yoda_setup', recovery: 'yoda_bg' }
/** Paths as the browser sees them (the portal's /api proxy in front of core's /setup and /recovery). */
export const COOKIE_PATH: Record<SessionKind, string> = { setup: '/api/setup', recovery: '/api/recovery' }
/** Recovery: 15 min idle, 1 h absolute (§7.2). Setup: the wizard takes a while; 2 h idle, 24 h absolute. */
export const SESSION_TTL: Record<SessionKind, { idleMs: number; absoluteMs: number }> = {
  setup: { idleMs: 2 * 3_600_000, absoluteMs: 24 * 3_600_000 },
  recovery: { idleMs: 15 * 60_000, absoluteMs: 3_600_000 },
}

export const sessionExpired = () => new HttpError(401, { error: 'unauthorized', reason: 'session' })
export const csrfFailed = () => new HttpError(403, { error: 'csrf_failed' })

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const name = part.slice(0, i).trim()
    if (name && !(name in out)) out[name] = part.slice(i + 1).trim()
  }
  return out
}

/** The CSRF token of a session: HMAC of a fixed label under the cookie value (not derivable without the cookie). */
export function csrfFor(cookieValue: string): string {
  return createHmac('sha256', cookieValue).update('yoda-csrf').digest('base64url')
}

/** The browser reached us over HTTPS (through the portal: its X-Forwarded-Proto, read via trustProxy). */
export function isHttps(request: FastifyRequest): boolean {
  return request.protocol === 'https'
}

function cookie(kind: SessionKind, value: string, opts: { secure: boolean; maxAgeS: number }): string {
  const parts = [`${COOKIE_NAME[kind]}=${value}`, `Path=${COOKIE_PATH[kind]}`, `Max-Age=${opts.maxAgeS}`, 'HttpOnly', 'SameSite=Strict']
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}

export function setSessionCookie(reply: FastifyReply, kind: SessionKind, value: string, secure: boolean): void {
  reply.header('set-cookie', cookie(kind, value, { secure, maxAgeS: Math.floor(SESSION_TTL[kind].absoluteMs / 1000) }))
  reply.header('cache-control', 'no-store')
}

export function clearSessionCookie(reply: FastifyReply, kind: SessionKind, secure: boolean): void {
  reply.header('set-cookie', cookie(kind, '', { secure, maxAgeS: 0 }))
}

const uaHash = (request: FastifyRequest) => sha256(`ua:${request.headers['user-agent'] ?? ''}`)

export function sessionView(row: SessionRow, cookieValue: string, kind: SessionKind, insecure: boolean): LocalSession {
  const idle = new Date(row.lastSeen.getTime() + SESSION_TTL[kind].idleMs)
  return {
    csrf: csrfFor(cookieValue),
    expiresAt: row.expiresAt.toISOString(),
    idleExpiresAt: (idle < row.expiresAt ? idle : row.expiresAt).toISOString(),
    insecure,
  }
}

/** Creates a session (and drops expired ones). Returns the cookie value, set by the caller. */
export async function createSession(
  db: Db,
  kind: SessionKind,
  request: FastifyRequest,
  opts: { adminId?: string | null; now: Date },
): Promise<{ value: string; row: SessionRow }> {
  await db.delete(localSessions).where(lt(localSessions.expiresAt, opts.now))
  const value = randomToken(32)
  const [row] = await db
    .insert(localSessions)
    .values({
      idHash: sha256(value),
      kind,
      adminId: opts.adminId ?? null,
      uaHash: uaHash(request),
      ip: request.ip,
      createdAt: opts.now,
      lastSeen: opts.now,
      expiresAt: new Date(opts.now.getTime() + SESSION_TTL[kind].absoluteMs),
    })
    .returning()
  return { value, row: row! }
}

/** The allowed `Origin`s of a state-changing call: the public URL's and the one the request came to. */
function originAllowed(request: FastifyRequest, publicUrl: string | undefined): boolean {
  const origin = request.headers.origin
  if (!origin) return true
  const allowed = new Set<string>([`${request.protocol}://${request.host}`])
  try {
    if (publicUrl) allowed.add(new URL(publicUrl).origin)
  } catch {
    // An unparseable public URL adds nothing.
  }
  return allowed.has(origin)
}

export type ActiveSession = { row: SessionRow; value: string }

/**
 * The live session of this kind for the request, or null: unknown, expired (idle or absolute), another user
 * agent. Touches `last_seen`. Does not check CSRF (see `requireSession`).
 */
export async function findSession(db: Db, request: FastifyRequest, kind: SessionKind, now: Date): Promise<ActiveSession | null> {
  const value = parseCookies(request.headers.cookie)[COOKIE_NAME[kind]]
  if (!value || value.length > 128) return null
  const idHash = sha256(value)
  const [row] = await db.select().from(localSessions).where(and(eq(localSessions.idHash, idHash), eq(localSessions.kind, kind)))
  if (!row) return null
  const idleCut = new Date(now.getTime() - SESSION_TTL[kind].idleMs)
  if (row.expiresAt <= now || row.lastSeen <= idleCut) {
    await db.delete(localSessions).where(eq(localSessions.idHash, idHash))
    return null
  }
  if (!sameBytes(row.uaHash, uaHash(request))) return null
  const [touched] = await db.update(localSessions).set({ lastSeen: now }).where(eq(localSessions.idHash, idHash)).returning()
  return touched ? { row: touched, value } : null
}

/** `findSession`, else 401; non-GET calls also need the CSRF header and an allowed Origin, else 403. */
export async function requireSession(
  db: Db,
  request: FastifyRequest,
  kind: SessionKind,
  opts: { now: Date; publicUrl?: string },
): Promise<ActiveSession> {
  const s = await findSession(db, request, kind, opts.now)
  if (!s) throw sessionExpired()
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const header = request.headers[CSRF_HEADER]
    const given = Buffer.from(typeof header === 'string' ? header : '')
    if (!sameBytes(given, Buffer.from(csrfFor(s.value))) || !originAllowed(request, opts.publicUrl)) throw csrfFailed()
  }
  return s
}

export async function updateSessionData(db: Db, idHash: Buffer, data: SessionData): Promise<void> {
  await db.update(localSessions).set({ data }).where(eq(localSessions.idHash, idHash))
}

export async function deleteSession(db: Db, idHash: Buffer): Promise<void> {
  await db.delete(localSessions).where(eq(localSessions.idHash, idHash))
}

/** Ends every session of a kind, or every session of a break-glass admin (password reset, CLI reset). */
export async function revokeSessions(db: Db, sel: { kind?: SessionKind; adminId?: string }): Promise<void> {
  const where = []
  if (sel.kind) where.push(eq(localSessions.kind, sel.kind))
  if (sel.adminId) where.push(eq(localSessions.adminId, sel.adminId))
  await db.delete(localSessions).where(where.length ? and(...where) : sql`true`)
}

/** A setup session is still open (so the token is not regenerated under it). */
export async function liveSetupSession(db: Db, now: Date): Promise<boolean> {
  const idleCut = new Date(now.getTime() - SESSION_TTL.setup.idleMs)
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(localSessions)
    .where(and(eq(localSessions.kind, 'setup'), gt(localSessions.expiresAt, now), gt(localSessions.lastSeen, idleCut)))
  return (r?.n ?? 0) > 0
}
