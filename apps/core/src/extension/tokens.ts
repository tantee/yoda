import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { EXTENSION_TOKEN, type ExtensionTokenKind } from '@yoda/shared'
import { hashToken } from '../runners/tokens.js'

export { hashToken }

/** A new extension token. Only `hash` (and at most the display `prefix`) is stored; `token` is never logged. */
export function newExtensionToken(kind: ExtensionTokenKind): { token: string; hash: string; prefix: string } {
  const token = EXTENSION_TOKEN[kind] + randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token), prefix: token.slice(0, 12) }
}

/** RFC 7636 verifier: 43–128 unreserved characters. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/

/** S256 PKCE: base64url(SHA-256(verifier)) equals the challenge, compared in constant time. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!VERIFIER_RE.test(verifier)) return false
  const want = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  const got = Buffer.from(challenge)
  return got.length === want.length && timingSafeEqual(got, want)
}
