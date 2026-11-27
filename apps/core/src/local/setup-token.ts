import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { and, eq, gt, isNotNull } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { setupState } from '../db/schema.js'
import { newSetupToken, sameBytes, setupTokenHash } from './codes.js'

/**
 * The setup token (installer proposal §4.1, §8.2). While setup is not done, core issues one on every start (and
 * when the last one was used and its session ended), keeps only its SHA-256 and expiry in `setup_state`, writes the
 * plain value to a 0600 file in the core-only bootstrap directory and prints it once in the log. Exchanging it
 * for a setup session burns it (single use). It expires after 24 hours.
 */

export const SETUP_TOKEN_TTL_MS = 24 * 3_600_000

/** Next to the master key, in the core-only directory of the bootstrap volume (R3); null when there is none (dev). */
export function setupTokenFile(env: NodeJS.ProcessEnv): string | null {
  return env.YODA_MASTER_KEY_FILE ? join(dirname(env.YODA_MASTER_KEY_FILE), 'setup-token') : null
}

export type TokenLog = (line: string) => void

/** The framed log lines (§4.1), so the token is easy to find in `docker compose logs core`. */
export function setupTokenBanner(token: string, expiresAt: Date): string {
  return [
    '┌─ Yoda setup ─────────────────────────────────────────────',
    '│ Open /setup on the portal and enter this token:',
    `│   ${token}`,
    `│ It expires at ${expiresAt.toISOString()} (24 hours) and changes when core restarts.`,
    '│ Again later: docker compose exec core yoda-admin setup-token',
    '└──────────────────────────────────────────────────────────',
  ].join('\n')
}

/** Writes the token file atomically with mode 0600; a symlink or a non-file in the way is refused. */
export function writeTokenFile(file: string, token: string): void {
  try {
    const st = lstatSync(file)
    if (!st.isFile()) throw new Error(`${file} is not a regular file`)
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err
  }
  const tmp = `${file}.tmp-${process.pid}`
  rmSync(tmp, { force: true })
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeSync(fd, `${token}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}

export function readTokenFile(file: string | null): string | null {
  if (!file) return null
  try {
    if (!lstatSync(file).isFile()) return null
    return readFileSync(file, 'utf8').trim() || null
  } catch {
    return null
  }
}

export function removeTokenFile(file: string | null): void {
  if (file) rmSync(file, { force: true })
}

/**
 * Issues a new setup token: stores its hash and expiry (replacing any earlier one), writes the file and prints the
 * banner. A file that cannot be written is a warning (the log line and `yoda-admin setup-token` still work).
 */
export async function issueSetupToken(db: Db, opts: { file: string | null; now: Date; log?: TokenLog; warn?: TokenLog }): Promise<{ token: string; expiresAt: Date }> {
  const token = newSetupToken()
  const expiresAt = new Date(opts.now.getTime() + SETUP_TOKEN_TTL_MS)
  await db.insert(setupState).values({ id: 1 }).onConflictDoNothing()
  await db.update(setupState).set({ setupTokenHash: setupTokenHash(token), setupTokenExpires: expiresAt }).where(eq(setupState.id, 1))
  if (opts.file) {
    try {
      writeTokenFile(opts.file, token)
    } catch (err) {
      ;(opts.warn ?? console.warn)(`setup: cannot write the setup token file ${opts.file} (${(err as { code?: string }).code ?? 'error'})`)
    }
  }
  ;(opts.log ?? console.log)(setupTokenBanner(token, expiresAt))
  return { token, expiresAt }
}

/** A stored, unexpired setup token exists. */
export async function hasLiveSetupToken(db: Db, now: Date): Promise<boolean> {
  const [r] = await db
    .select({ id: setupState.id })
    .from(setupState)
    .where(and(eq(setupState.id, 1), isNotNull(setupState.setupTokenHash), gt(setupState.setupTokenExpires, now)))
  return !!r
}

/** The token in the file, when it is the stored, unexpired one (the CLI prints it rather than issuing a new one). */
export async function liveTokenFromFile(db: Db, file: string | null, now: Date): Promise<string | null> {
  const token = readTokenFile(file)
  if (!token) return null
  const [st] = await db.select().from(setupState).where(eq(setupState.id, 1))
  if (!st?.setupTokenHash || !st.setupTokenExpires || st.setupTokenExpires <= now) return null
  return sameBytes(st.setupTokenHash, setupTokenHash(token)) ? token : null
}

/**
 * Burns the token if it is the stored, unexpired one (one conditional update, so two racing exchanges cannot both
 * win). The hash comparison is a database equality on a SHA-256, so it reveals nothing useful about timing.
 */
export async function burnSetupToken(db: Db, token: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(setupState)
    .set({ setupTokenHash: null, setupTokenExpires: null })
    .where(and(eq(setupState.id, 1), eq(setupState.setupTokenHash, setupTokenHash(token)), gt(setupState.setupTokenExpires, now)))
    .returning({ id: setupState.id })
  return rows.length > 0
}

/** Setup is done: no token any more (Task 8's completion calls this). */
export async function clearSetupToken(db: Db, file: string | null): Promise<void> {
  await db.update(setupState).set({ setupTokenHash: null, setupTokenExpires: null }).where(eq(setupState.id, 1))
  removeTokenFile(file)
}
