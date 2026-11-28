import { createHash } from 'node:crypto'
import { chromiumappRedirect, OFFICIAL_EXTENSION_ID, type ExtensionAuthorize, type Me } from '@yoda/shared'
import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../src/db/client.js'
import { extensionAuthCodes, extensionGrants, extensionRefreshTokens, people } from '../src/db/schema.js'
import {
  authenticateExtension,
  effectiveAllowedIds,
  exchangeCode,
  GrantError,
  issueAuthCode,
  refreshGrant,
  revokeAllGrants,
  revokeGrant,
  type GrantCtx,
} from '../src/extension/grants.js'
import { newExtensionToken, verifyPkceS256 } from '../src/extension/tokens.js'
import { HttpError } from '../src/auth/plugin.js'
import { meFromPerson } from '../src/runners/records.js'
import { newRunnerToken } from '../src/runners/tokens.js'
import { resetDb, testDb } from './helpers.js'
import { signToken } from './jwt.js'

const EXT = 'mmcaeimamhfdkmmkfpgfijlhiepcjoje'
const OTHER = 'a'.repeat(32)
const DAY = 86_400_000
const T0 = new Date('2026-11-28T03:00:00Z')

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const challenge = (v: string) => createHash('sha256').update(v).digest('base64url')

function ctx(o: Partial<GrantCtx> = {}): GrantCtx {
  return {
    now: T0,
    ip: '10.0.0.5',
    allowedIds: [EXT],
    ttl: { accessMinutes: 60, idleDays: 30, absoluteDays: 90, reauthDays: 14 },
    ...o,
  }
}
const at = (ms: number, o: Partial<GrantCtx> = {}) => ctx({ now: new Date(T0.getTime() + ms), ...o })

function authorizeInput(o: Partial<ExtensionAuthorize> = {}): ExtensionAuthorize {
  return {
    extensionId: EXT,
    redirectUri: chromiumappRedirect(EXT),
    codeChallenge: challenge(VERIFIER),
    codeChallengeMethod: 'S256',
    state: 'st-1',
    browserLabel: 'Chrome 131 Windows',
    ...o,
  }
}

async function person(db: Db, o: { username?: string; staff?: boolean; lastSeenAt?: Date } = {}) {
  const username = o.username ?? 'staff1'
  const [p] = await db
    .insert(people)
    .values({ keycloakSub: `sub-${username}`, username, displayName: username, lastSeenStaff: o.staff ?? true, lastSeenAt: o.lastSeenAt ?? T0 })
    .returning()
  return { row: p!, me: meFromPerson(p!) as Me }
}

const codeOf = (redirectTo: string) => new URL(redirectTo).searchParams.get('code')!

async function connect(db: Db, me: Me, c: GrantCtx = ctx()) {
  const { redirectTo } = await issueAuthCode(db, me, authorizeInput(), { allowedIds: c.allowedIds, now: c.now })
  return exchangeCode(db, { code: codeOf(redirectTo), codeVerifier: VERIFIER, extensionId: EXT }, c)
}

async function grantError(p: Promise<unknown>): Promise<GrantError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(GrantError)
  return err as GrantError
}

const bearer = (t: string) => `Bearer ${t}`

describe('extension tokens', () => {
  it('makes prefixed 43-character tokens and checks S256 PKCE', () => {
    const t = newExtensionToken('refresh')
    expect(t.token).toMatch(/^yoda_xr_[A-Za-z0-9_-]{43}$/)
    expect(t.prefix).toBe(t.token.slice(0, 12))
    expect(t.hash).toBe(createHash('sha256').update(t.token).digest('hex'))
    expect(verifyPkceS256(VERIFIER, challenge(VERIFIER))).toBe(true)
    expect(verifyPkceS256(VERIFIER, challenge('x'.repeat(43)))).toBe(false)
    expect(verifyPkceS256('short', challenge('short'))).toBe(false)
    expect(verifyPkceS256(`${VERIFIER}+`, challenge(`${VERIFIER}+`))).toBe(false)
    expect(verifyPkceS256(VERIFIER, 'nope')).toBe(false)
  })

  it('the effective allowlist adds the official ID to the setting', () => {
    expect(effectiveAllowedIds({ get: () => [OTHER] })).toEqual([OTHER, OFFICIAL_EXTENSION_ID])
    // The owner's key is committed (keys/yoda-reporter.pub), so the official ID is always allowed.
    expect(OFFICIAL_EXTENSION_ID).toBe('hcnhkfonaflhcknbhcphbfgpdfmgmibm')
    expect(effectiveAllowedIds(undefined)).toEqual([OFFICIAL_EXTENSION_ID])
  })
})

describe('extension grants', () => {
  let db: Db
  beforeEach(async () => {
    db = await testDb()
    await resetDb(db)
  })

  describe('codes', () => {
    it('code is single use, expires after 60 s, and is bound to the verifier and the extension id', async () => {
      const { me } = await person(db)
      const issue = async () => codeOf((await issueAuthCode(db, me, authorizeInput(), { allowedIds: [EXT, OTHER], now: T0 })).redirectTo)

      const { redirectTo } = await issueAuthCode(db, me, authorizeInput(), { allowedIds: [EXT], now: T0 })
      const u = new URL(redirectTo)
      expect(`${u.origin}/`).toBe(chromiumappRedirect(EXT))
      expect(u.searchParams.get('state')).toBe('st-1')
      const code = u.searchParams.get('code')!
      expect(code).toMatch(/^yoda_xc_/)

      const tokens = await exchangeCode(db, { code, codeVerifier: VERIFIER, extensionId: EXT }, at(1000))
      expect(tokens.accessToken).toMatch(/^yoda_xt_/)
      expect(tokens.refreshToken).toMatch(/^yoda_xr_/)
      expect(tokens.expiresIn).toBe(3600)
      expect(tokens.person).toMatchObject({ id: me.id, isStaff: true })
      expect((await grantError(exchangeCode(db, { code, codeVerifier: VERIFIER, extensionId: EXT }, at(2000)))).reason).toBe('invalid_grant')

      const late = await issue()
      expect((await grantError(exchangeCode(db, { code: late, codeVerifier: VERIFIER, extensionId: EXT }, at(61_000, { allowedIds: [EXT, OTHER] })))).reason).toBe('invalid_grant')

      const wrongVerifier = await issue()
      const e1 = await grantError(exchangeCode(db, { code: wrongVerifier, codeVerifier: 'x'.repeat(43), extensionId: EXT }, at(1000, { allowedIds: [EXT, OTHER] })))
      expect(e1.reason).toBe('invalid_grant')

      const wrongExt = await issue()
      const e2 = await grantError(exchangeCode(db, { code: wrongExt, codeVerifier: VERIFIER, extensionId: OTHER }, at(1000, { allowedIds: [EXT, OTHER] })))
      expect(e2.reason).toBe('invalid_grant')
      expect(e2.familyId).toBeNull()
    })

    it('two concurrent exchanges of one code: exactly one gets tokens, the other gets invalid_grant', async () => {
      const { me } = await person(db)
      const { redirectTo } = await issueAuthCode(db, me, authorizeInput(), { allowedIds: [EXT], now: T0 })
      const req = { code: codeOf(redirectTo), codeVerifier: VERIFIER, extensionId: EXT }
      const results = await Promise.allSettled([exchangeCode(db, req, ctx()), exchangeCode(db, req, ctx())])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      expect(rejected).toHaveLength(1)
      expect(rejected[0]!.reason).toBeInstanceOf(GrantError)
      expect((rejected[0]!.reason as GrantError).reason).toBe('invalid_grant')
      expect(await db.select().from(extensionGrants)).toHaveLength(1)
    })

    it('an unknown extension id or a redirect other than chromiumappRedirect(id) is refused, and no code is stored', async () => {
      const { me } = await person(db)
      const refused = async (input: ExtensionAuthorize, reason: string) => {
        const err = await issueAuthCode(db, me, input, { allowedIds: [EXT], now: T0 }).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(HttpError)
        expect((err as HttpError).statusCode).toBe(403)
        expect((err as HttpError).body).toEqual({ error: 'forbidden', reason })
      }
      await refused(authorizeInput({ extensionId: OTHER, redirectUri: chromiumappRedirect(OTHER) }), 'extension_not_allowed')
      await refused(authorizeInput({ redirectUri: 'https://evil.example.org/' }), 'redirect_mismatch')
      await refused(authorizeInput({ redirectUri: `${chromiumappRedirect(EXT)}cb` }), 'redirect_mismatch')
      await refused(authorizeInput({ redirectUri: chromiumappRedirect(OTHER) }), 'redirect_mismatch')
      expect(await db.select().from(extensionAuthCodes)).toEqual([])
    })

    it('requesters get not_staff', async () => {
      const { me } = await person(db, { username: 'req1', staff: false })
      const err = await issueAuthCode(db, me, authorizeInput(), { allowedIds: [EXT], now: T0 }).catch((e: unknown) => e)
      expect((err as HttpError).statusCode).toBe(403)
      expect((err as HttpError).body).toEqual({ error: 'forbidden', reason: 'not_staff' })
      expect(await db.select().from(extensionAuthCodes)).toEqual([])
    })
  })

  describe('refresh', () => {
    it('refresh rotates: the successor works and the access token changes', async () => {
      const { me } = await person(db)
      const first = await connect(db, me)
      const second = await refreshGrant(db, first.refreshToken, at(60_000))
      expect(second.grantId).toBe(first.grantId)
      expect(second.accessToken).not.toBe(first.accessToken)
      expect(second.refreshToken).not.toBe(first.refreshToken)
      // The old access token is replaced on the grant.
      expect(await authenticateExtension(db, bearer(first.accessToken), { now: at(61_000).now, allowedIds: [EXT] })).toBeNull()
      expect(await authenticateExtension(db, bearer(second.accessToken), { now: at(61_000).now, allowedIds: [EXT] })).not.toBeNull()
      const third = await refreshGrant(db, second.refreshToken, at(120_000))
      expect(third.grantId).toBe(first.grantId)
    })

    it('any reuse of a rotated refresh token, even one second later, revokes the grant with reuse_detected, and the successor stops working', async () => {
      const { me } = await person(db)
      const first = await connect(db, me)
      const second = await refreshGrant(db, first.refreshToken, at(1000))
      const err = await grantError(refreshGrant(db, first.refreshToken, at(2000)))
      expect(err.reason).toBe('revoked')
      const [g] = await db.select().from(extensionGrants)
      expect(g!.revokeReason).toBe('reuse_detected')
      expect(err.familyId).toBe(g!.familyId)
      expect((await grantError(refreshGrant(db, second.refreshToken, at(3000)))).reason).toBe('revoked')
      expect(await authenticateExtension(db, bearer(second.accessToken), { now: at(3000).now, allowedIds: [EXT] })).toBeNull()
    })

    it('idle 30 d and absolute 90 d expiry give invalid_grant', async () => {
      const { me, row } = await person(db)
      const idle = await connect(db, me)
      // Keep the person's portal sign-in fresh, so only the expiry speaks.
      await db.update(people).set({ lastSeenAt: new Date(T0.getTime() + 31 * DAY) }).where(eq(people.id, row.id))
      expect((await grantError(refreshGrant(db, idle.refreshToken, at(30 * DAY + 1000)))).reason).toBe('invalid_grant')

      let t = await connect(db, me)
      // Refreshing every 20 days keeps it alive until the absolute 90 days.
      for (const d of [20, 40, 60, 80]) {
        await db.update(people).set({ lastSeenAt: new Date(T0.getTime() + d * DAY) }).where(eq(people.id, row.id))
        t = await refreshGrant(db, t.refreshToken, at(d * DAY))
      }
      await db.update(people).set({ lastSeenAt: new Date(T0.getTime() + 90 * DAY) }).where(eq(people.id, row.id))
      expect((await grantError(refreshGrant(db, t.refreshToken, at(90 * DAY + 1000)))).reason).toBe('invalid_grant')
    })

    it('a person whose last_seen_at is older than reauthDays gets reauth_required, and a fresh portal sign-in clears it', async () => {
      const { me, row } = await person(db)
      const t = await connect(db, me)
      const err = await grantError(refreshGrant(db, t.refreshToken, at(15 * DAY)))
      expect(err.reason).toBe('reauth_required')
      const [g] = await db.select().from(extensionGrants)
      expect(g!.revokedAt).toBeNull()
      await db.update(people).set({ lastSeenAt: new Date(T0.getTime() + 15 * DAY) }).where(eq(people.id, row.id))
      const next = await refreshGrant(db, t.refreshToken, at(15 * DAY + 1000))
      expect(next.grantId).toBe(t.grantId)
    })

    it('a person who lost staff status is refused and the grant is revoked with not_staff', async () => {
      const { me, row } = await person(db)
      const t = await connect(db, me)
      await db.update(people).set({ lastSeenStaff: false }).where(eq(people.id, row.id))
      expect((await grantError(refreshGrant(db, t.refreshToken, at(1000)))).reason).toBe('revoked')
      const [g] = await db.select().from(extensionGrants)
      expect(g!.revokeReason).toBe('not_staff')
    })

    it('an unknown refresh token has no family', async () => {
      const err = await grantError(refreshGrant(db, newExtensionToken('refresh').token, ctx()))
      expect(err).toMatchObject({ reason: 'invalid_grant', familyId: null })
    })
  })

  describe('allowlist', () => {
    it('removing the extension id from extension.allowedIds makes authenticate refuse at once', async () => {
      const { me } = await person(db)
      const t = await connect(db, me)
      expect(await authenticateExtension(db, bearer(t.accessToken), { now: T0, allowedIds: [EXT] })).not.toBeNull()
      expect(await authenticateExtension(db, bearer(t.accessToken), { now: T0, allowedIds: [OTHER] })).toBeNull()
    })

    it('the next refresh revokes the grant with extension_not_allowed', async () => {
      const { me } = await person(db)
      const t = await connect(db, me)
      expect((await grantError(refreshGrant(db, t.refreshToken, at(1000, { allowedIds: [OTHER] })))).reason).toBe('revoked')
      const [g] = await db.select().from(extensionGrants)
      expect(g!.revokeReason).toBe('extension_not_allowed')
    })
  })

  describe('access and revocation', () => {
    it('authenticateExtension refuses a Keycloak JWT, a revoked grant, an expired access token, and a yoda_rt_ token', async () => {
      const { me, row } = await person(db)
      const t = await connect(db, me)
      const auth = (h: string | undefined, ms = 1000) => authenticateExtension(db, h, { now: at(ms).now, allowedIds: [EXT] })

      const ok = await auth(bearer(t.accessToken))
      expect(ok?.me).toMatchObject({ id: row.id, isStaff: true })
      expect(ok?.grant.id).toBe(t.grantId)

      expect(await auth(undefined)).toBeNull()
      expect(await auth(bearer(await signToken({ sub: row.keycloakSub, preferred_username: row.username })))).toBeNull()
      expect(await auth(bearer(newRunnerToken().token))).toBeNull()
      expect(await auth(bearer(t.refreshToken))).toBeNull()
      expect(await auth(bearer(t.accessToken), 3_600_000)).toBeNull()

      await revokeGrant(db, t.grantId, { personId: row.id, reason: 'user' })
      expect(await auth(bearer(t.accessToken))).toBeNull()
    })

    it('authenticate refuses a person who is no longer staff, and records use at most once a minute', async () => {
      const { me, row } = await person(db)
      const t = await connect(db, me)
      // Connecting counted as a use (at T0), so the next record is a minute later.
      await authenticateExtension(db, bearer(t.accessToken), { now: at(30_000).now, allowedIds: [EXT], ip: '10.0.0.8' })
      expect((await db.select().from(extensionGrants))[0]!.lastIp).toBe('10.0.0.5')
      await authenticateExtension(db, bearer(t.accessToken), { now: at(61_000).now, allowedIds: [EXT], ip: '10.0.0.9' })
      const [g1] = await db.select().from(extensionGrants)
      expect(g1!.lastIp).toBe('10.0.0.9')
      await authenticateExtension(db, bearer(t.accessToken), { now: at(90_000).now, allowedIds: [EXT], ip: '10.0.0.10' })
      const [g2] = await db.select().from(extensionGrants)
      expect(g2!.lastUsedAt!.getTime()).toBe(g1!.lastUsedAt!.getTime())
      expect(g2!.lastIp).toBe('10.0.0.9')
      await authenticateExtension(db, bearer(t.accessToken), { now: at(125_000).now, allowedIds: [EXT], ip: '10.0.0.10' })
      const [g3] = await db.select().from(extensionGrants)
      expect(g3!.lastIp).toBe('10.0.0.10')

      await db.update(people).set({ lastSeenStaff: false }).where(eq(people.id, row.id))
      expect(await authenticateExtension(db, bearer(t.accessToken), { now: at(130_000).now, allowedIds: [EXT] })).toBeNull()
    })

    it('revokeGrant stops the access token at once', async () => {
      const { me, row } = await person(db)
      const t = await connect(db, me)
      expect(await revokeGrant(db, t.grantId, { personId: row.id, reason: 'admin' })).toBe(true)
      expect(await revokeGrant(db, t.grantId, { personId: row.id, reason: 'admin' })).toBe(false)
      expect(await authenticateExtension(db, bearer(t.accessToken), { now: T0, allowedIds: [EXT] })).toBeNull()
      const [g] = await db.select().from(extensionGrants)
      expect(g).toMatchObject({ revokeReason: 'admin', revokedBy: row.id })
      expect((await grantError(refreshGrant(db, t.refreshToken, at(1000)))).reason).toBe('revoked')
    })

    it('revokeAllGrants revokes every active grant', async () => {
      const a = await person(db, { username: 'a' })
      const b = await person(db, { username: 'b' })
      const ta = await connect(db, a.me)
      await connect(db, b.me)
      await connect(db, b.me)
      await revokeGrant(db, ta.grantId, { personId: a.row.id, reason: 'user' })
      expect(await revokeAllGrants(db, { personId: a.row.id, reason: 'admin_all' })).toBe(2)
      const rows = await db.select().from(extensionGrants)
      expect(rows.filter((r) => r.revokeReason === 'admin_all')).toHaveLength(2)
      expect(rows.filter((r) => r.revokeReason === 'user')).toHaveLength(1)
    })

    it('only hashes and prefixes are stored', async () => {
      const { me } = await person(db)
      const first = await connect(db, me)
      const second = await refreshGrant(db, first.refreshToken, at(1000))
      const dump = JSON.stringify([
        await db.select().from(extensionGrants),
        await db.select().from(extensionAuthCodes),
        await db.select().from(extensionRefreshTokens),
        await db.execute(sql`select * from extension_grants`),
      ])
      for (const token of [first.accessToken, first.refreshToken, second.accessToken, second.refreshToken]) {
        expect(dump).not.toContain(token)
        expect(dump).not.toContain(token.slice(8))
      }
      expect(dump).toContain(createHash('sha256').update(second.refreshToken).digest('hex'))
    })
  })
})
