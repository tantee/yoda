import { chromiumappRedirect, isExtensionId } from '@yoda/shared'

export type ConnectQuery = { ext: string; redirectUri: string; codeChallenge: string; state: string; browser: string }

const one = (v: unknown): string | null => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null)

/**
 * The approve page's query, from the extension's `launchWebAuthFlow` URL. The redirect must be the extension's
 * own `https://<id>.chromiumapp.org/`, so an approval never sends a code anywhere else.
 */
export function parseConnectQuery(
  q: Record<string, unknown>,
): { ok: true; value: ConnectQuery } | { ok: false; reason: 'missing' | 'bad_id' | 'bad_redirect' } {
  const ext = one(q.ext)
  const redirectUri = one(q.redirect_uri)
  const codeChallenge = one(q.code_challenge)
  const state = one(q.state)
  const browser = one(q.browser) ?? ''
  if (!ext || !redirectUri || !codeChallenge || !state) return { ok: false, reason: 'missing' }
  if (!isExtensionId(ext)) return { ok: false, reason: 'bad_id' }
  if (redirectUri !== chromiumappRedirect(ext)) return { ok: false, reason: 'bad_redirect' }
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge) || state.length > 200) return { ok: false, reason: 'missing' }
  return { ok: true, value: { ext, redirectUri, codeChallenge, state, browser: browser.trim().slice(0, 120) || 'Chrome' } }
}

/** Where Cancel goes: back to the extension, which then shows "connection cancelled". */
export function cancelUrl(redirectUri: string, state: string): string {
  const u = new URL(redirectUri)
  u.searchParams.set('error', 'access_denied')
  u.searchParams.set('state', state)
  return u.toString()
}
