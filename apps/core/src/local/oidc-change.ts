import { createHash, timingSafeEqual } from 'node:crypto'
import { OidcPending, OidcRollback, type OidcCurrent, type OidcValues, type SettingKey, type SettingsTestCheck } from '@yoda/shared'
import { and, eq, sql } from 'drizzle-orm'
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose'
import type { AppDeps } from '../app.js'
import { TokenClaims } from '../auth/people.js'
import type { Db } from '../db/client.js'
import { people, setupState } from '../db/schema.js'
import { OutboundError, safeFetch, type OutboundPolicy } from '../settings/outbound.js'
import type { SettingActor, SettingsStore } from '../settings/store.js'
import { randomToken } from './codes.js'
import type { SessionData } from './session.js'

/**
 * Changing the OIDC issuer, client id or JWKS URL from /recovery (installer proposal §8.6, T10): the new values
 * are staged as pending, a real test sign-in (authorization code + PKCE, `prompt=login`) through them must pass,
 * and only then does Apply switch. The previous values are kept 7 days for one-click rollback.
 *
 * The test checks what core itself will check afterwards: the ID token (issuer, audience, nonce, signature by the
 * JWKS core will use) and the access token (issuer, `azp`, `typ`, the claims the portal needs), and that the person
 * who signed in is a portal admin (or that there is no admin yet), so the change cannot lock the admins out.
 */

export const OIDC_KEYS = ['oidc.issuer', 'oidc.clientId', 'oidc.jwksUrl'] as const satisfies readonly SettingKey[]
export const ROLLBACK_MS = 7 * 24 * 3_600_000
/** A test sign-in must come back within this long. */
const SIGNIN_TTL_MS = 10 * 60_000

/** The sign-in settings in effect: the store's (env > database > default), else the env Config without a store. */
export function currentOidc(config: AppDeps['config'], settings?: SettingsStore): OidcCurrent {
  if (!settings) return { issuer: config.oidcIssuer ?? null, clientId: config.oidcClientId, jwksUrl: config.oidcJwksUrl ?? null }
  return {
    issuer: settings.get('oidc.issuer') ?? null,
    clientId: settings.get('oidc.clientId') ?? config.oidcClientId,
    jwksUrl: settings.get('oidc.jwksUrl') ?? null,
  }
}

export async function readOidcState(db: Db): Promise<{ pending: OidcPending | null; rollback: OidcRollback | null }> {
  const [st] = await db.select({ pending: setupState.oidcPending, rollback: setupState.oidcRollback }).from(setupState).where(eq(setupState.id, 1))
  const pending = OidcPending.safeParse(st?.pending)
  const rollback = OidcRollback.safeParse(st?.rollback)
  return { pending: pending.success ? pending.data : null, rollback: rollback.success ? rollback.data : null }
}

const valuesHash = (v: OidcValues) => createHash('sha256').update(JSON.stringify([v.issuer, v.clientId, v.jwksUrl])).digest('base64url')

export async function stagePending(db: Db, values: OidcValues, by: string, now: Date): Promise<OidcPending> {
  const pending: OidcPending = { values, stagedAt: now.toISOString(), stagedBy: by, testedAt: null, testedUsername: null }
  await db.update(setupState).set({ oidcPending: pending }).where(eq(setupState.id, 1))
  return pending
}

export async function discardPending(db: Db): Promise<void> {
  await db.update(setupState).set({ oidcPending: null }).where(eq(setupState.id, 1))
}

/** The env-set sign-in keys (they cannot be changed here, so a change touching them is refused). */
export function envLockedOidc(settings: SettingsStore): SettingKey[] {
  return OIDC_KEYS.filter((k) => settings.fromEnv(k))
}

type Discovery = { issuer?: unknown; authorization_endpoint?: unknown; token_endpoint?: unknown }

class Failed extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

async function discover(values: OidcValues, policy: OutboundPolicy): Promise<{ authorize: string; token: string }> {
  const res = await safeFetch(`${values.issuer}/.well-known/openid-configuration`, { policy })
  if (res.status !== 200) throw new Failed(`http_${res.status}`)
  let doc: Discovery
  try {
    doc = JSON.parse(res.body) as Discovery
  } catch {
    throw new Failed('invalid_response')
  }
  if (doc.issuer !== values.issuer) throw new Failed('issuer_mismatch')
  const http = (u: unknown) => typeof u === 'string' && /^https?:\/\//.test(u)
  if (!http(doc.authorization_endpoint) || !http(doc.token_endpoint)) throw new Failed('invalid_response')
  return { authorize: doc.authorization_endpoint as string, token: doc.token_endpoint as string }
}

/** The redirect URI of the test sign-in: the portal's /recovery page (or /setup, the claim) on the public URL. */
export function recoveryRedirectUri(publicUrl: string, path: '/recovery' | '/setup' = '/recovery'): string {
  return `${new URL(publicUrl).origin}${path}`
}

/**
 * Starts the test sign-in: discovery of the pending issuer, then an authorization URL with a fresh state, nonce
 * and PKCE challenge (kept in the recovery session, never in the browser).
 */
export async function startTestSignIn(
  pending: OidcPending,
  opts: { publicUrl: string; policy: OutboundPolicy; now: Date; redirectPath?: '/recovery' | '/setup' },
): Promise<{ authorizeUrl: string; redirectUri: string; data: NonNullable<SessionData['oidc']> }> {
  let endpoints: { authorize: string }
  try {
    endpoints = await discover(pending.values, opts.policy)
  } catch (err) {
    throw new Failed(err instanceof Failed ? err.code : err instanceof OutboundError ? err.code : 'failed')
  }
  const verifier = randomToken(32)
  const data = {
    state: randomToken(24),
    nonce: randomToken(24),
    verifier,
    redirectUri: recoveryRedirectUri(opts.publicUrl, opts.redirectPath),
    startedAt: opts.now.toISOString(),
    valuesHash: valuesHash(pending.values),
    stagedAt: pending.stagedAt,
  }
  const url = new URL(endpoints.authorize)
  url.searchParams.set('client_id', pending.values.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid')
  url.searchParams.set('redirect_uri', data.redirectUri)
  url.searchParams.set('state', data.state)
  url.searchParams.set('nonce', data.nonce)
  url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('prompt', 'login')
  return { authorizeUrl: url.toString(), redirectUri: data.redirectUri, data }
}

export { Failed as OidcChangeFailed }

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

async function check(id: string, fn: () => Promise<void>): Promise<SettingsTestCheck> {
  const started = performance.now()
  const ms = () => Math.round(performance.now() - started)
  try {
    await fn()
    return { id, ok: true, ms: ms() }
  } catch (err) {
    const code = err instanceof Failed ? err.code : err instanceof OutboundError ? err.code : 'failed'
    return { id, ok: false, ms: ms(), code }
  }
}

/** The JWKS core will use with these values (the same rule as auth/jwks.ts). */
const jwksUrlOf = (v: OidcValues) => v.jwksUrl ?? `${v.issuer}/protocol/openid-connect/certs`

/**
 * Finishes the test sign-in: exchanges the code (PKCE), verifies both tokens and the person. Every check reports
 * a short code, never a token or a server's text. `ok` marks the pending change as tested.
 *
 * The setup wizard's claim (§4.2 step 10) uses the same sign-in with `requireAdmin: false` (nobody is an admin
 * yet: the person signing in becomes the first) and `staffGroup` (the first admin must be in the staff group, so
 * the group setting is proven too); it also needs the verified claims to create the person.
 */
export async function finishTestSignIn(
  deps: { db: Db; policy: OutboundPolicy },
  pending: OidcPending,
  flow: NonNullable<SessionData['oidc']>,
  input: { code: string; state: string; now: Date },
  /** `preGranted`: usernames that become admin at their first sign-in (`oidc.bootstrapAdmins`, granted at /recovery). */
  opts: { requireAdmin?: boolean; staffGroup?: string; preGranted?: readonly string[] } = {},
): Promise<{ ok: boolean; checks: SettingsTestCheck[]; username: string | null; claims: TokenClaims | null }> {
  const checks: SettingsTestCheck[] = []
  const v = pending.values
  const fresh = input.now.getTime() - new Date(flow.startedAt).getTime() <= SIGNIN_TTL_MS
  checks.push(
    await check('state', async () => {
      if (!same(flow.state, input.state)) throw new Failed('state_mismatch')
      if (!fresh) throw new Failed('expired')
      if (flow.valuesHash !== valuesHash(v) || flow.stagedAt !== pending.stagedAt) throw new Failed('pending_changed')
    }),
  )
  if (!checks[0]!.ok) return { ok: false, checks, username: null, claims: null }

  let tokens: { id_token?: unknown; access_token?: unknown } = {}
  checks.push(
    await check('token', async () => {
      const { token } = await discover(v, deps.policy)
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: flow.redirectUri,
        client_id: v.clientId,
        code_verifier: flow.verifier,
      }).toString()
      const res = await safeFetch(token, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
        policy: deps.policy,
      })
      if (res.status === 400 || res.status === 401) throw new Failed('code_rejected')
      if (res.status !== 200) throw new Failed(`http_${res.status}`)
      try {
        tokens = JSON.parse(res.body) as typeof tokens
      } catch {
        throw new Failed('invalid_response')
      }
      if (typeof tokens.id_token !== 'string' || typeof tokens.access_token !== 'string') throw new Failed('invalid_response')
    }),
  )
  if (!checks[1]!.ok) return { ok: false, checks, username: null, claims: null }

  let keys: ReturnType<typeof createLocalJWKSet> | null = null
  checks.push(
    await check('jwks', async () => {
      const res = await safeFetch(jwksUrlOf(v), { policy: deps.policy })
      if (res.status !== 200) throw new Failed(`http_${res.status}`)
      try {
        keys = createLocalJWKSet(JSON.parse(res.body) as JSONWebKeySet)
      } catch {
        throw new Failed('no_keys')
      }
    }),
  )
  if (!keys) return { ok: false, checks, username: null, claims: null }
  const jwks = keys as ReturnType<typeof createLocalJWKSet>

  checks.push(
    await check('id_token', async () => {
      try {
        const { payload } = await jwtVerify(tokens.id_token as string, jwks, { issuer: v.issuer, audience: v.clientId, algorithms: ['RS256'] })
        if (payload.nonce !== flow.nonce) throw new Failed('nonce_mismatch')
      } catch (err) {
        if (err instanceof Failed) throw err
        throw new Failed('token_invalid')
      }
    }),
  )

  let claims: TokenClaims | null = null
  checks.push(
    await check('access_token', async () => {
      let payload
      try {
        ;({ payload } = await jwtVerify(tokens.access_token as string, jwks, { issuer: v.issuer, algorithms: ['RS256'], requiredClaims: ['exp'] }))
      } catch {
        throw new Failed('token_invalid')
      }
      // What the auth hook will require of every portal token after the switch.
      if (payload.azp !== v.clientId) throw new Failed('azp_mismatch')
      if (payload.typ !== undefined && payload.typ !== 'Bearer') throw new Failed('typ_mismatch')
      const parsed = TokenClaims.safeParse(payload)
      if (!parsed.success) throw new Failed('claims_missing')
      // Keycloak leaves the claim out for a person in no group, as well as when the client has no groups mapper. With
      // a staff check (the setup claim) that is the staff check's failure, as the portal treats it (no groups: not
      // staff); without one (the /recovery test sign-in) it still means the mapper is missing.
      if (!parsed.data.groups && opts.staffGroup === undefined) throw new Failed('groups_missing')
      claims = parsed.data
    }),
  )
  const verified = claims as TokenClaims | null
  const username = verified?.preferred_username ?? null
  if (verified && opts.staffGroup !== undefined) {
    const group = opts.staffGroup
    checks.push(
      await check('staff', async () => {
        if (!verified.groups) throw new Failed('not_staff_no_groups')
        if (!verified.groups.includes(group)) throw new Failed('not_staff')
      }),
    )
  }
  if (username && opts.requireAdmin !== false) {
    checks.push(
      await check('admin', async () => {
        const [r] = await deps.db.execute<{ admin: boolean; any: boolean }>(
          sql`select exists (select 1 from ${people} where ${people.isAdmin} and ${people.username} = ${username}) as admin,
            exists (select 1 from ${people} where ${people.isAdmin}) as any`,
        )
        if (r?.any && !r.admin && !(opts.preGranted ?? []).includes(username)) throw new Failed('not_admin')
      }),
    )
  }
  const ok = checks.every((c) => c.ok) && !!username
  return { ok, checks, username, claims: ok ? verified : null }
}

/**
 * The stored pending change is still the one `pending` describes (same staging time and values), so a test or an
 * apply never lands on values staged meanwhile by another session.
 */
const samePending = (pending: OidcPending) =>
  and(
    eq(setupState.id, 1),
    sql`${setupState.oidcPending}->>'stagedAt' = ${pending.stagedAt}`,
    sql`${setupState.oidcPending}->'values' = ${JSON.stringify(pending.values)}::jsonb`,
  )

/** Pending changed between reading it and writing (restaged or discarded by another session). */
export class PendingChangedError extends Error {
  constructor() {
    super('the pending sign-in change changed meanwhile')
    this.name = 'PendingChangedError'
  }
}

export async function markTested(db: Db, pending: OidcPending, username: string, now: Date): Promise<OidcPending> {
  const next: OidcPending = { ...pending, testedAt: now.toISOString(), testedUsername: username }
  const rows = await db.update(setupState).set({ oidcPending: next }).where(samePending(pending)).returning({ id: setupState.id })
  if (!rows.length) throw new PendingChangedError()
  return next
}

/** Writes the three sign-in settings (null clears one back to its default) as one change. */
async function writeOidc(settings: SettingsStore, values: OidcCurrent, actor: SettingActor): Promise<void> {
  await settings.apply(
    [
      { key: 'oidc.issuer', value: values.issuer },
      { key: 'oidc.clientId', value: values.clientId },
      { key: 'oidc.jwksUrl', value: values.jwksUrl },
    ],
    actor,
  )
}

/** Applies a tested pending change and keeps the previous values for rollback (7 days). */
export async function applyPending(
  deps: { db: Db; settings: SettingsStore; config: AppDeps['config'] },
  pending: OidcPending,
  actor: SettingActor,
  now: Date,
): Promise<OidcRollback> {
  const previous = currentOidc(deps.config, deps.settings)
  const rollback: OidcRollback = { values: previous, appliedAt: now.toISOString(), until: new Date(now.getTime() + ROLLBACK_MS).toISOString() }
  // Claim the tested pending change first (one conditional update, under the row lock): a change restaged since
  // the test is refused, and two applies cannot both win. If writing the settings fails, both the pending change
  // and the rollback snapshot from before are put back, so a failed apply never loses the way back.
  const before = await deps.db.transaction(async (tx) => {
    const [row] = await tx.select({ rollback: setupState.oidcRollback }).from(setupState).where(eq(setupState.id, 1)).for('update')
    const [claimed] = await tx
      .update(setupState)
      .set({ oidcPending: null, oidcRollback: rollback })
      .where(and(samePending(pending), sql`${setupState.oidcPending}->>'testedAt' = ${pending.testedAt ?? ''}`))
      .returning({ id: setupState.id })
    if (!claimed) throw new PendingChangedError()
    return (row?.rollback ?? null) as OidcRollback | null
  })
  try {
    await writeOidc(deps.settings, pending.values, actor)
  } catch (err) {
    await deps.db.update(setupState).set({ oidcPending: pending, oidcRollback: before }).where(eq(setupState.id, 1))
    throw err
  }
  await deps.settings.audit({ action: 'oidc.apply_pending', actor, newValue: { issuer: pending.values.issuer, clientId: pending.values.clientId, jwksUrl: pending.values.jwksUrl, testedUsername: pending.testedUsername } })
  return rollback
}

/** Puts back the values from before the last apply, while the rollback window is open. */
export async function rollbackOidc(deps: { db: Db; settings: SettingsStore }, rollback: OidcRollback, actor: SettingActor): Promise<void> {
  await writeOidc(deps.settings, rollback.values, actor)
  await deps.db.update(setupState).set({ oidcRollback: null, oidcPending: null }).where(eq(setupState.id, 1))
  await deps.settings.audit({ action: 'oidc.rollback', actor, newValue: { ...rollback.values } })
}
