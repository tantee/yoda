import { PublicConfig } from '@yoda/shared'

/**
 * Connecting a browser to a Yoda (proposal §7.3), run from an extension page (options or popup), never the
 * service worker: `permissions.request` and `launchWebAuthFlow` need the click's user activation.
 */

export type ConnectResult =
  | { ok: true; profileId: string }
  | { ok: false; reason: 'invalid' | 'insecure' | 'permission_needed' | 'not_yoda' | 'extension_disabled' | 'cancelled' | 'state_mismatch' | 'exchange_failed' | 'unreachable' }

/** HTTPS, or plain http only to localhost / 127.0.0.1 (any port); paths are dropped. A bare host means https. */
export function normaliseYodaUrl(input: string): { ok: true; origin: string } | { ok: false; reason: 'invalid' | 'insecure' } {
  const raw = input.trim()
  if (!raw) return { ok: false, reason: 'invalid' }
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (u.protocol === 'https:') return { ok: true, origin: u.origin }
  if (u.protocol === 'http:') return u.hostname === 'localhost' || u.hostname === '127.0.0.1' ? { ok: true, origin: u.origin } : { ok: false, reason: 'insecure' }
  return { ok: false, reason: 'invalid' }
}

const b64url = (bytes: ArrayBuffer | Uint8Array) => {
  let s = ''
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A PKCE pair: 32 random bytes as the verifier (43 characters) and its S256 challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

type UaData = { brands?: { brand: string; version: string }[]; platform?: string }

/** "Edge 131 · Windows": the real brand (not Chromium or a GREASE brand), its version and the platform. */
export function browserLabel(ua: UaData | undefined): string {
  const brands = ua?.brands ?? []
  const real = brands.filter((b) => !/not.?a.?brand/i.test(b.brand))
  const pick = real.find((b) => /edge/i.test(b.brand)) ?? real.find((b) => /chrome/i.test(b.brand) && !/chromium/i.test(b.brand)) ?? real.find((b) => /chromium/i.test(b.brand)) ?? real[0]
  const name = pick ? pick.brand.replace(/^Microsoft /, '').replace(/^Google /, '') : 'Chrome'
  const label = [pick ? `${name} ${pick.version}` : name, ua?.platform].filter(Boolean).join(' · ')
  return label.slice(0, 120)
}

/**
 * The Connect button's click handler. The URL check and `permissions.request` happen synchronously, before any
 * await (Chrome requires the user's click to be the cause); everything else follows.
 */
export function onConnectClick(input: string): Promise<ConnectResult> {
  const n = normaliseYodaUrl(input)
  if (!n.ok) return Promise.resolve({ ok: false, reason: n.reason })
  // Both calls are made before any await; whether the origin was held already decides what a failure undoes.
  const hadIt = chrome.permissions.contains({ origins: [`${n.origin}/*`] })
  const granted = chrome.permissions.request({ origins: [`${n.origin}/*`] })
  return finishConnect(n.origin, granted, hadIt)
}

async function finishConnect(origin: string, granted: Promise<boolean>, hadIt: Promise<boolean>): Promise<ConnectResult> {
  if (!(await granted)) return { ok: false, reason: 'permission_needed' }
  // A failed Reconnect must not take away a working profile's access: only a new grant is undone.
  const held = await hadIt.catch(() => false)
  const forget = () => (held ? Promise.resolve(false) : chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => false))

  let config: PublicConfig
  try {
    const res = await fetch(`${origin}/api/public-config`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    const parsed = PublicConfig.safeParse(await res.json())
    if (!res.ok || !parsed.success || !parsed.data.extension) {
      await forget()
      return { ok: false, reason: 'not_yoda' }
    }
    config = parsed.data
  } catch {
    await forget()
    return { ok: false, reason: 'unreachable' }
  }
  if (!config.extension!.enabled) {
    await forget()
    return { ok: false, reason: 'extension_disabled' }
  }

  const { verifier, challenge } = await pkcePair()
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)))
  const redirectUri = chrome.identity.getRedirectURL()
  const url = new URL(`${origin}/extension/connect`)
  url.searchParams.set('ext', chrome.runtime.id)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('state', state)
  const label = browserLabel((navigator as unknown as { userAgentData?: UaData }).userAgentData)
  url.searchParams.set('browser', label)

  let back: string | undefined
  try {
    back = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true })
  } catch {
    // The tester closed the window, or Yoda's page never redirected back.
    return { ok: false, reason: 'cancelled' }
  }
  if (!back) return { ok: false, reason: 'cancelled' }
  const result = new URL(back).searchParams
  if (result.get('state') !== state) return { ok: false, reason: 'state_mismatch' }
  if (result.get('error')) return { ok: false, reason: 'cancelled' }
  const code = result.get('code')
  if (!code) return { ok: false, reason: 'cancelled' }

  // The worker exchanges the code and stores the tokens; this page never keeps them.
  const r = (await chrome.runtime.sendMessage({ type: 'profile.exchange', origin, code, verifier, browserLabel: label })) as { ok: boolean; profileId?: string }
  return r?.ok && r.profileId ? { ok: true, profileId: r.profileId } : { ok: false, reason: 'exchange_failed' }
}
