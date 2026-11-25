import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose'

// Test-only signing key, generated fresh at runtime — never committed.
const KID = 'test-key'
const keysPromise = (async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' }
  return { privateKey, jwk, jwks: createLocalJWKSet({ keys: [jwk] }) }
})()

/** The public half of the test key as a JWKS document (for a test JWKS server). */
export async function testJwksDocument(): Promise<{ keys: object[] }> {
  return { keys: [(await keysPromise).jwk] }
}

/** Verifies tokens signed by `signToken`. */
export const localJwks: JWTVerifyGetKey = async (header, token) => {
  const { jwks } = await keysPromise
  return jwks(header, token)
}

export const TEST_ISSUER = 'http://issuer.test'
export const TEST_CLIENT_ID = 'yoda-portal'

/**
 * Sign an access token. Defaults: iss = TEST_ISSUER, azp = TEST_CLIENT_ID, exp = now + 5 min.
 * Any claim can be overridden (e.g. `exp` in the past, a different `iss`/`azp`).
 */
export async function signToken(claims: JWTPayload & Record<string, unknown>): Promise<string> {
  const { privateKey } = await keysPromise
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: TEST_ISSUER,
    azp: TEST_CLIENT_ID,
    iat: now,
    exp: now + 5 * 60,
    ...claims,
  }
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: KID }).sign(privateKey)
}
