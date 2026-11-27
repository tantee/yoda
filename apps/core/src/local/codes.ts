import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { CODE_ALPHABET, normaliseCode } from '@yoda/shared'
import { deriveKey, type MasterKey } from '../settings/crypto.js'

/**
 * Random codes for setup and break-glass (installer proposal §7.2, §8.2; R2). The setup token is 20 symbols of a
 * 32-symbol alphabet (100 bits), shown as 5 groups of 4; a recovery code is 16 symbols (80 bits), 4 groups of 4.
 * Both are compared case-insensitively, without spaces or dashes.
 */

/** `n` symbols of the token alphabet, uniformly (randomInt has no modulo bias). */
function symbols(n: number): string {
  let out = ''
  for (let i = 0; i < n; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return out
}

const grouped = (s: string) => s.match(/.{1,4}/g)!.join('-')

export function newSetupToken(): string {
  return grouped(symbols(20))
}

export function newRecoveryCode(): string {
  return grouped(symbols(16))
}

export const sha256 = (s: string | Buffer): Buffer => createHash('sha256').update(s).digest()

/** What is stored for a setup token: SHA-256 of its normalised form (8.2). */
export function setupTokenHash(token: string): Buffer {
  return sha256(`yoda-setup-token:${normaliseCode(token)}`)
}

export function sameBytes(a: Buffer | null | undefined, b: Buffer | null | undefined): boolean {
  return !!a && !!b && a.length === b.length && timingSafeEqual(a, b)
}

/**
 * What is stored for a recovery code: HMAC-SHA-256 under a key derived from the master key (R2), so a database
 * dump alone cannot be brute-forced, and a code is looked up by its hash in one query.
 */
export function recoveryCodeHash(mk: MasterKey, code: string): Buffer {
  return createHmac('sha256', deriveKey(mk, 'yoda-break-glass-recovery-codes')).update(normaliseCode(code)).digest()
}

/** A random URL-safe token of `bytes` bytes (session ids, OIDC state, nonce and PKCE verifier). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
