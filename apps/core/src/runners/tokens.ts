import { createHash, randomBytes } from 'node:crypto'

export const RUNNER_TOKEN_PREFIX = 'yoda_rt_'
/** `yoda_rt_` followed by 32 random bytes in base64url (43 characters, no padding). */
export const RUNNER_TOKEN_RE = /^yoda_rt_[A-Za-z0-9_-]{43}$/

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** A new runner token. Only `hash` and `prefix` are stored; `token` is shown once and never logged. */
export function newRunnerToken(): { token: string; hash: string; prefix: string } {
  const token = RUNNER_TOKEN_PREFIX + randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token), prefix: token.slice(0, 12) }
}
