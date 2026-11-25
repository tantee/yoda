import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose'
import type { Config } from '../config.js'

/**
 * Where signing keys are fetched: OIDC_JWKS_URL when set (e.g. Keycloak reached on an internal address),
 * otherwise the issuer's own certs endpoint. Tokens are always checked against OIDC_ISSUER either way.
 */
export function jwksUrl(config: Pick<Config, 'oidcIssuer' | 'oidcJwksUrl'>): URL {
  return new URL(config.oidcJwksUrl ?? `${config.oidcIssuer}/protocol/openid-connect/certs`)
}

export function remoteJwks(config: Pick<Config, 'oidcIssuer' | 'oidcJwksUrl'>): JWTVerifyGetKey {
  return createRemoteJWKSet(jwksUrl(config))
}
