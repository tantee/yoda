import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose'
import type { Config } from '../config.js'

/**
 * Where signing keys are fetched: OIDC_JWKS_URL when set (e.g. Keycloak reached on an internal address),
 * otherwise the issuer's own certs endpoint. Tokens are always checked against OIDC_ISSUER either way. Null when
 * neither is set (setup mode: sign-in is not configured yet).
 */
export function jwksUrl(config: Pick<Config, 'oidcIssuer' | 'oidcJwksUrl'>): URL | null {
  if (config.oidcJwksUrl) return new URL(config.oidcJwksUrl)
  return config.oidcIssuer ? new URL(`${config.oidcIssuer}/protocol/openid-connect/certs`) : null
}

/** Without an issuer every key lookup fails (the auth hook refuses tokens before it gets here anyway). */
export function remoteJwks(config: Pick<Config, 'oidcIssuer' | 'oidcJwksUrl'>): JWTVerifyGetKey {
  const url = jwksUrl(config)
  if (!url) {
    return async () => {
      throw new Error('sign-in is not configured')
    }
  }
  return createRemoteJWKSet(url)
}
