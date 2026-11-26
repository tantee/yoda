import { Secret, TOTP } from 'otpauth'

/**
 * Break-glass TOTP (RFC 6238 via otpauth, R6): SHA-1, 6 digits, 30 s, one step of drift either way. A code is
 * accepted once: the caller stores the accepted step and refuses that step or an earlier one again (R2).
 */
const PERIOD = 30

export function newTotpSecret(): string {
  return new Secret({ size: 20 }).base32
}

function totp(secret: string, label = 'break-glass'): TOTP {
  return new TOTP({ issuer: 'Yoda', label, algorithm: 'SHA1', digits: 6, period: PERIOD, secret: Secret.fromBase32(secret) })
}

/** The `otpauth://` URI for the QR code. */
export function totpUri(secret: string, label: string): string {
  return totp(secret, label).toString()
}

/** The step a valid code belongs to, or null. `after`: the last accepted step; that step and earlier ones are refused. */
export function verifyTotp(secret: string, code: string, opts: { now?: number; after?: number | null } = {}): number | null {
  const now = opts.now ?? Date.now()
  const delta = totp(secret).validate({ token: code, timestamp: now, window: 1 })
  if (delta === null) return null
  const step = Math.floor(now / 1000 / PERIOD) + delta
  if (opts.after !== undefined && opts.after !== null && step <= opts.after) return null
  return step
}

/** The current code (tests and the CLI's self-check only). */
export function totpCodeAt(secret: string, now: number): string {
  return totp(secret).generate({ timestamp: now })
}
