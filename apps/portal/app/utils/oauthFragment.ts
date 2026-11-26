/** The parameters Keycloak's fragment redirect adds (`#state=…&session_state=…&iss=…&code=…`). */
const OAUTH_PARAMS = new Set(['code', 'state', 'session_state', 'iss', 'error', 'error_description', 'error_uri', 'kc_action', 'kc_action_status'])

/**
 * The URL hash without the sign-in callback parameters, or null when the hash is not a callback (nothing to do).
 * keycloak-js strips them itself, but the router's first navigation writes the URL it saw at start-up back, so the
 * portal strips them again once the router is ready. Any app hash around them is kept.
 */
export function hashWithoutOAuth(hash: string): string | null {
  const parts = hash.replace(/^#/, '').split('&').filter(Boolean)
  const key = (p: string) => decodeURIComponent(p.split('=')[0]!)
  const keys = new Set(parts.map(key))
  if (!keys.has('state') || !(keys.has('code') || keys.has('error'))) return null
  const rest = parts.filter((p) => !OAUTH_PARAMS.has(key(p))).join('&')
  return rest ? `#${rest}` : ''
}
