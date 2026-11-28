import { EXTENSION_API_VERSION, ExtensionTokenResponse, isReleaseVersion, manifestVersion, type ExtensionSession } from '@yoda/shared'
import { getAccess, getRefresh, setAccess, setRefresh } from './secrets'
import { getProfile, updateProfile } from './store'

/** Refreshes in flight, per profile: concurrent callers share one (single flight). */
const inflight = new Map<string, Promise<boolean>>()

/** The refresh answered that the grant is over: reconnect, never retry. */
const ENDED = new Set(['invalid_grant', 'reauth_required', 'revoked'])
export const REFRESH_TIMEOUT_MS = 15_000

async function endGrant(profileId: string): Promise<void> {
  const p = await getProfile(profileId)
  if (!p) return
  await setRefresh(p, null)
  await setAccess(profileId, null)
  // Drafts are untouched: the tester reconnects and sends them.
  await updateProfile(profileId, { needsReconnect: true })
}

async function doRefresh(profileId: string): Promise<boolean> {
  const p = await getProfile(profileId)
  if (!p) return false
  const refreshToken = await getRefresh(p)
  if (!refreshToken) return false
  // A network failure throws and keeps the tokens: the next call tries again.
  const res = await fetch(`${p.url}/api/extension/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grantType: 'refresh_token', refreshToken }),
    // A stalled link must not hold every caller of this profile until Chrome stops the worker.
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  })
  if (res.ok) {
    // Once the server has rotated the token, a body that fails to parse loses it: the next refresh is then a
    // reuse and the tester reconnects (accepted: it needs a broken server).
    const t = ExtensionTokenResponse.parse(await res.json())
    // Removed while the refresh ran: never bring it back or store its tokens.
    const still = await getProfile(profileId)
    if (!still) return false
    await setRefresh(p, t.refreshToken)
    await setAccess(profileId, { token: t.accessToken, expiresAt: Date.now() + t.expiresIn * 1000 })
    await updateProfile(profileId, { needsReconnect: false, grantId: t.grantId, person: t.person })
    return true
  }
  const body = (await res.json().catch(() => ({}))) as { reason?: string }
  if (res.status === 401 && body.reason && ENDED.has(body.reason)) await endGrant(profileId)
  return false
}

/**
 * One refresh per profile at a time, shared by concurrent callers (a 401 burst refreshes once). A rotated token
 * used twice ends the grant on the server, so two refreshes must never race in one browser.
 */
export function refreshOnce(profileId: string): Promise<boolean> {
  // Only the service worker refreshes: a page with its own copy of this map could race it, and a rotated token
  // used twice ends the grant. Pages get tokens with the token.get message.
  if (typeof window !== 'undefined') throw new Error('refresh runs in the service worker only')
  const running = inflight.get(profileId)
  if (running) return running
  const p = doRefresh(profileId).finally(() => inflight.delete(profileId))
  inflight.set(profileId, p)
  return p
}

/** The current access token, refreshed first when it has expired (or within 30 s of it). */
export async function accessToken(profileId: string, opts: { force?: boolean } = {}): Promise<string | null> {
  const a = await getAccess(profileId)
  if (a && !opts.force && a.expiresAt - 30_000 > Date.now()) return a.token
  if (!(await refreshOnce(profileId))) return null
  return (await getAccess(profileId))?.token ?? null
}

/** A call to the profile's Yoda with its bearer; on 401 it refreshes once (single flight) and retries once. */
export async function yodaFetch(profileId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const p = await getProfile(profileId)
  if (!p) throw new Error('unknown profile')
  const send = (token: string | null) => {
    const headers = new Headers(init.headers)
    if (token) headers.set('authorization', `Bearer ${token}`)
    return fetch(`${p.url}${path}`, { ...init, headers })
  }
  const before = (await getAccess(profileId))?.token ?? (await accessToken(profileId))
  // No token and none to be had: answer 401 here rather than send an unauthenticated request.
  if (!before) return new Response(null, { status: 401 })
  const res = await send(before)
  if (res.status !== 401) return res
  // Another caller may have refreshed meanwhile: use its token, else refresh ourselves.
  const now = (await getAccess(profileId))?.token ?? null
  const token = now && now !== before ? now : (await refreshOnce(profileId)) ? ((await getAccess(profileId))?.token ?? null) : null
  return token ? send(token) : res
}

const rank = (v: string) => {
  const { version } = manifestVersion(v)
  return version.split('.').map(Number)
}
const newer = (a: string, b: string) => {
  const x = rank(a)
  const y = rank(b)
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i]! > y[i]!
  return false
}

/** Compares this extension with what the Yoda instance serves and the API version it speaks. */
export function checkVersion(session: Pick<ExtensionSession, 'apiVersion' | 'latestExtension'>, own: string): 'ok' | 'update_available' | 'api_too_new' {
  // `own` is the manifest's version_name (1.2.0), never its four-part version (1.2.0.1000).
  if (!isReleaseVersion(own)) throw new Error(`not a release version: ${own}`)
  if (session.apiVersion > EXTENSION_API_VERSION) return 'api_too_new'
  const latest = session.latestExtension?.version
  if (latest && isReleaseVersion(latest) && isReleaseVersion(own) && newer(latest, own)) return 'update_available'
  return 'ok'
}
