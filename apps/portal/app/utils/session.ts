/** The parts of the Keycloak client the session check reads (keycloak-js `refreshToken`, `refreshTokenParsed`, `timeSkew`). */
export type SessionTokens = {
  refreshToken?: string
  refreshTokenParsed?: { exp?: number }
  timeSkew?: number | null
}

/** Seconds of slack: a refresh token this close to its expiry counts as expired. */
const SKEW_SECONDS = 5

/**
 * Whether a failed token refresh means the session really ended, so the user must sign in again. It has when the
 * refresh token is gone (keycloak-js clears it when Keycloak rejects the refresh) or has expired. Otherwise the
 * refresh failed for another reason (offline, Keycloak briefly down) and a later retry can still succeed.
 */
export function sessionEnded(kc: SessionTokens, nowMs = Date.now()): boolean {
  if (!kc.refreshToken) return true
  const exp = kc.refreshTokenParsed?.exp
  if (!exp) return false
  return exp - Math.ceil(nowMs / 1000) + (kc.timeSkew ?? 0) < SKEW_SECONDS
}
