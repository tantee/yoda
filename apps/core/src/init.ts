import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The one-shot `init` service (installer proposal §3.2, spike R3): fills the `yoda-bootstrap` volume before
 * postgres, rustfs, migrate, core and backup start. Layout (init runs as root):
 *
 *   <dir>                          0750 root:10500
 *     postgres-password            0640 root:10500  postgres (POSTGRES_PASSWORD_FILE, read as root)
 *     s3-access-key, s3-secret-key 0640 root:10500  rustfs (RUSTFS_*_FILE, group_add 10500)
 *     bootstrap.env                0640 root:10500  core, migrate, backup: DATABASE_URL and S3_* (no master key)
 *     install-id                   0644
 *     core/                        0700 1000:1000   core only
 *       master-key                 0600 1000:1000
 *
 * Per value: env set → written to the file (env wins; existing `.env` installs flow through unchanged); file
 * exists → kept; neither → generated. bootstrap.env is derived again on every run. It refuses (exit 1) when the
 * Postgres data directory already holds a database but its password is unknown. Never prints a value.
 */

export const BOOTSTRAP_GID = 10500
/** The `node` user of the core image. */
export const CORE_UID = 1000

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** Random characters from A-Z a-z 0-9 (no quoting needed in a URL or a shell), without modulo bias. */
export function randomAlnum(length: number, bytes: (n: number) => Buffer = randomBytes): string {
  let out = ''
  while (out.length < length) {
    for (const b of bytes(length * 2)) {
      // 248 = 62 * 4: values at or above it would favour the first characters.
      if (b < 248 && out.length < length) out += ALNUM[b % 62]
    }
  }
  return out
}

export type InitOptions = {
  /** The bootstrap volume (`/var/lib/yoda`). */
  dir: string
  /** The Postgres data volume mounted read-only (`/probe/pgdata`); absent = no check. */
  pgdata?: string
  env: NodeJS.ProcessEnv
  /** Ownership changes; a no-op unless running as root (tests record the calls). */
  chown?: (path: string, uid: number, gid: number) => void
  log?: (line: string) => void
  random?: { alnum(n: number): string; key(): string; uuid(): string }
}

export class InitRefusedError extends Error {}

type Secret = { file: string; envName: string; generate: () => string; uid: number; gid: number; mode: number }

const defaultChown = (path: string, uid: number, gid: number) => {
  if (process.getuid?.() === 0) chownSync(path, uid, gid)
}

function readValue(path: string): string | null {
  if (!existsSync(path)) return null
  const v = readFileSync(path, 'utf8').trim()
  return v || null
}

/** Atomic write (temp file + rename) with the mode and owner set before the file appears. */
function writeValue(path: string, value: string, mode: number, own: (p: string) => void): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, value, { mode })
  chmodSync(tmp, mode)
  own(tmp)
  renameSync(tmp, path)
}

export function runInit(opts: InitOptions): { generated: string[]; fromEnv: string[]; kept: string[] } {
  const { dir, env } = opts
  const chown = opts.chown ?? defaultChown
  const log = opts.log ?? ((l: string) => console.log(l))
  const random = opts.random ?? { alnum: (n: number) => randomAlnum(n), key: () => randomBytes(32).toString('base64'), uuid: randomUUID }
  const core = join(dir, 'core')
  const result = { generated: [] as string[], fromEnv: [] as string[], kept: [] as string[] }

  // 3.3: a database whose password nobody knows. Generating one would lock core out of it for good.
  const pgPasswordFile = join(dir, 'postgres-password')
  if (opts.pgdata && existsSync(join(opts.pgdata, 'PG_VERSION')) && !env.POSTGRES_PASSWORD && !readValue(pgPasswordFile)) {
    throw new InitRefusedError(
      'init: an existing database was found but its password is unknown; restore /var/lib/yoda from your recovery kit or set POSTGRES_PASSWORD',
    )
  }

  for (const [k, v] of Object.entries(env)) {
    if (['POSTGRES_PASSWORD', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'YODA_MASTER_KEY', 'POSTGRES_USER', 'POSTGRES_DB'].includes(k) && v && /[\r\n]/.test(v)) {
      throw new InitRefusedError(`init: ${k} must be a single line`)
    }
  }

  mkdirSync(dir, { recursive: true })
  chmodSync(dir, 0o750)
  chown(dir, 0, BOOTSTRAP_GID)
  mkdirSync(core, { recursive: true })
  chmodSync(core, 0o700)
  chown(core, CORE_UID, CORE_UID)

  const shared = { uid: 0, gid: BOOTSTRAP_GID, mode: 0o640 }
  const secrets: Secret[] = [
    { file: 'postgres-password', envName: 'POSTGRES_PASSWORD', generate: () => random.alnum(32), ...shared },
    { file: 's3-access-key', envName: 'S3_ACCESS_KEY', generate: () => random.alnum(20), ...shared },
    { file: 's3-secret-key', envName: 'S3_SECRET_KEY', generate: () => random.alnum(40), ...shared },
    { file: 'core/master-key', envName: 'YODA_MASTER_KEY', generate: () => random.key(), uid: CORE_UID, gid: CORE_UID, mode: 0o600 },
  ]
  const values: Record<string, string> = {}
  for (const s of secrets) {
    const path = join(dir, s.file)
    const own = (p: string) => chown(p, s.uid, s.gid)
    const current = readValue(path)
    const fromEnv = env[s.envName]?.trim()
    if (fromEnv) {
      if (current !== fromEnv) writeValue(path, fromEnv, s.mode, own)
      values[s.envName] = fromEnv
      result.fromEnv.push(s.file)
      log(`init: ${s.file} from ${s.envName}`)
    } else if (current) {
      values[s.envName] = current
      result.kept.push(s.file)
    } else {
      values[s.envName] = s.generate()
      writeValue(path, values[s.envName]!, s.mode, own)
      result.generated.push(s.file)
      log(`init: generated ${s.file}`)
    }
    // Repair modes and owners on every run (a restored volume, a hand edit).
    chmodSync(path, s.mode)
    own(path)
  }

  const idPath = join(dir, 'install-id')
  if (!readValue(idPath)) {
    writeValue(idPath, random.uuid(), 0o644, (p) => chown(p, 0, 0))
    log('init: generated install-id')
  }

  // Derived again on every run, so a changed POSTGRES_USER / POSTGRES_DB or env value applies.
  const user = env.POSTGRES_USER || 'yoda'
  const db = env.POSTGRES_DB || 'yoda'
  const url = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(values.POSTGRES_PASSWORD!)}@postgres:5432/${encodeURIComponent(db)}`
  const lines = [
    '# Written by the init service on every start; do not edit (set the values in .env instead).',
    `DATABASE_URL=${url}`,
    `S3_ACCESS_KEY=${values.S3_ACCESS_KEY}`,
    `S3_SECRET_KEY=${values.S3_SECRET_KEY}`,
    '',
  ]
  writeValue(join(dir, 'bootstrap.env'), lines.join('\n'), 0o640, (p) => chown(p, 0, BOOTSTRAP_GID))
  log('init: bootstrap volume ready')
  return result
}

// Entry: `node dist/init.js` (the compose `init` service, as root).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    runInit({ dir: process.env.YODA_BOOTSTRAP_DIR || '/var/lib/yoda', pgdata: process.env.YODA_PGDATA_PROBE || '/probe/pgdata', env: process.env })
  } catch (err) {
    console.error(err instanceof InitRefusedError ? err.message : `init: failed (${(err as { code?: string }).code ?? (err as Error).name})`)
    process.exit(1)
  }
}
