import { hash, verify } from '@node-rs/argon2'

/**
 * Break-glass password hashing (§7.2, R1): argon2id, m = 64 MiB, t = 3, p = 1, as a PHC string (so the
 * parameters can change later and old hashes still verify). Hashing runs on the libuv pool, off the event loop.
 */
// `algorithm: 2` is Argon2id (the package's Algorithm is a declared const enum, which isolated modules cannot read).
export const ARGON2_PARAMS = { algorithm: 2, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_PARAMS)
}

let dummy: Promise<string> | undefined

/**
 * Verifies a password against a stored hash. With no stored hash (an unknown username) it verifies against a
 * fixed dummy hash with the same parameters, so an unknown and a known username take the same time.
 */
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  dummy ??= hashPassword('yoda-break-glass-dummy-password')
  const target = stored ?? (await dummy)
  let ok = false
  try {
    ok = await verify(target, password)
  } catch {
    ok = false
  }
  return stored !== null && ok
}
