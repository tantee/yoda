import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyBootstrapFile, parseBootstrapEnv } from '../src/config.js'
import { BOOTSTRAP_GID, CORE_UID, InitRefusedError, randomAlnum, runInit, validMasterKey } from '../src/init.js'

// The `init` service against a temp directory: never overwrites, env wins, refuses an unknown database password,
// prints no value. Ownership is recorded (the test does not run as root).
let root: string
let dir: string
let pgdata: string
let owners: Map<string, string>
let logs: string[]

const mode = (p: string) => statSync(join(dir, p)).mode & 0o777
const read = (p: string) => readFileSync(join(dir, p), 'utf8')
const run = (env: NodeJS.ProcessEnv = {}) =>
  runInit({ dir, pgdata, env, chown: (p, uid, gid) => owners.set(p.replace(`${dir}/`, '').replace(/\.tmp$/, ''), `${uid}:${gid}`), log: (l) => logs.push(l) })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yoda-init-'))
  dir = join(root, 'yoda')
  pgdata = join(root, 'pgdata')
  mkdirSync(pgdata)
  owners = new Map()
  logs = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('init (bootstrap volume)', () => {
  it('generates every value on a fresh install, with the R3 layout', () => {
    const r = run()
    expect(r.generated).toEqual(['postgres-password', 's3-access-key', 's3-secret-key', 'core/master-key'])
    expect(read('postgres-password')).toMatch(/^[A-Za-z0-9]{32}$/)
    expect(read('s3-access-key')).toMatch(/^[A-Za-z0-9]{20}$/)
    expect(read('s3-secret-key')).toMatch(/^[A-Za-z0-9]{40}$/)
    expect(Buffer.from(read('core/master-key'), 'base64')).toHaveLength(32)
    // The install id lives in the database (setup_state), not in the volume.
    expect(existsSync(join(dir, 'install-id'))).toBe(false)
    expect(statSync(dir).mode & 0o777).toBe(0o750)
    expect(mode('core')).toBe(0o700)
    for (const f of ['postgres-password', 's3-access-key', 's3-secret-key', 'bootstrap.env']) {
      expect(mode(f), f).toBe(0o640)
      expect(owners.get(f), f).toBe(`0:${BOOTSTRAP_GID}`)
    }
    expect(mode('core/master-key')).toBe(0o600)
    expect(owners.get('core/master-key')).toBe(`${CORE_UID}:${CORE_UID}`)
    expect(owners.get('core')).toBe(`${CORE_UID}:${CORE_UID}`)
    expect(owners.get(dir)).toBe(`0:${BOOTSTRAP_GID}`)
  })

  it('writes bootstrap.env with DATABASE_URL and the S3 keys, never the master key', () => {
    run({ POSTGRES_USER: 'yoda', POSTGRES_DB: 'yoda' })
    const env = parseBootstrapEnv(read('bootstrap.env'))
    expect(Object.keys(env).sort()).toEqual(['DATABASE_URL', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'])
    expect(env.DATABASE_URL).toBe(`postgres://yoda:${read('postgres-password')}@postgres:5432/yoda`)
    expect(env.S3_ACCESS_KEY).toBe(read('s3-access-key'))
    expect(read('bootstrap.env')).not.toContain(read('core/master-key'))
  })

  it('is idempotent: a second run keeps every value', () => {
    run()
    const before = ['postgres-password', 's3-access-key', 's3-secret-key', 'core/master-key', 'bootstrap.env'].map(read)
    logs = []
    const r = run()
    expect(r.generated).toEqual([])
    expect(r.kept).toEqual(['postgres-password', 's3-access-key', 's3-secret-key', 'core/master-key'])
    expect(['postgres-password', 's3-access-key', 's3-secret-key', 'core/master-key', 'bootstrap.env'].map(read)).toEqual(before)
    expect(logs).toEqual(['init: bootstrap volume ready'])
  })

  it('lets env win and copies it into the volume (an existing .env install upgrading)', () => {
    run()
    writeFileSync(join(pgdata, 'PG_VERSION'), '17\n')
    const env = { POSTGRES_PASSWORD: 'pg-from-env', S3_ACCESS_KEY: 'access-from-env', S3_SECRET_KEY: 'secret-from-env', YODA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), POSTGRES_USER: 'u@x', POSTGRES_DB: 'db' }
    const r = run(env)
    expect(r.fromEnv).toEqual(['postgres-password', 's3-access-key', 's3-secret-key', 'core/master-key'])
    expect(read('postgres-password')).toBe('pg-from-env')
    expect(read('core/master-key')).toBe(env.YODA_MASTER_KEY)
    expect(parseBootstrapEnv(read('bootstrap.env'))).toEqual({
      DATABASE_URL: 'postgres://u%40x:pg-from-env@postgres:5432/db',
      S3_ACCESS_KEY: 'access-from-env',
      S3_SECRET_KEY: 'secret-from-env',
    })
    expect(mode('postgres-password')).toBe(0o640)
  })

  it('keeps a replaced value in <file>.prev (same mode and owner), never overwriting a third value, and says so without the value', () => {
    run()
    const firstKey = read('core/master-key')
    const firstPg = read('postgres-password')
    const k2 = Buffer.alloc(32, 2).toString('base64')
    logs = []
    run({ YODA_MASTER_KEY: k2, POSTGRES_PASSWORD: 'pg-two' })
    expect(read('core/master-key')).toBe(k2)
    expect(read('core/master-key.prev')).toBe(firstKey)
    expect(mode('core/master-key.prev')).toBe(0o600)
    expect(owners.get('core/master-key.prev')).toBe(`${CORE_UID}:${CORE_UID}`)
    expect(read('postgres-password.prev')).toBe(firstPg)
    expect(mode('postgres-password.prev')).toBe(0o640)
    expect(owners.get('postgres-password.prev')).toBe(`0:${BOOTSTRAP_GID}`)
    expect(logs).toContain('init: core/master-key replaced by YODA_MASTER_KEY; the previous value is kept in core/master-key.prev')
    for (const v of [firstKey, k2, firstPg, 'pg-two']) expect(logs.join('\n')).not.toContain(v)
    // Same env again: nothing replaced, the prev stays.
    logs = []
    run({ YODA_MASTER_KEY: k2, POSTGRES_PASSWORD: 'pg-two' })
    expect(logs.some((l) => l.includes('replaced'))).toBe(false)
    expect(read('core/master-key.prev')).toBe(firstKey)
    // A third value would overwrite the .prev that keeps the first one: refused, and nothing is written.
    expect(() => run({ YODA_MASTER_KEY: Buffer.alloc(32, 3).toString('base64'), POSTGRES_PASSWORD: 'pg-two' })).toThrow(
      /YODA_MASTER_KEY would replace core\/master-key, but core\/master-key.prev already keeps an earlier replaced value/,
    )
    expect(() => run({ YODA_MASTER_KEY: k2, POSTGRES_PASSWORD: 'pg-three' })).toThrow(/postgres-password.prev already keeps/)
    expect([read('core/master-key'), read('core/master-key.prev'), read('postgres-password'), read('postgres-password.prev')]).toEqual([k2, firstKey, 'pg-two', firstPg])
    // Going back to the .prev value swaps the two (a stale .env after a rotation): both values stay.
    run({ YODA_MASTER_KEY: firstKey })
    expect([read('core/master-key'), read('core/master-key.prev')]).toEqual([firstKey, k2])
    // Once the .prev is removed, a new replacement works again.
    rmSync(join(dir, 'postgres-password.prev'))
    run({ POSTGRES_PASSWORD: 'pg-three' })
    expect([read('postgres-password'), read('postgres-password.prev')]).toEqual(['pg-three', 'pg-two'])
    // Nothing to keep on a fresh install from env.
    rmSync(dir, { recursive: true })
    run({ POSTGRES_PASSWORD: 'pg-env' })
    expect(existsSync(join(dir, 'postgres-password.prev'))).toBe(false)
  })

  it('treats a whitespace-only POSTGRES_PASSWORD as unset for the refusal', () => {
    writeFileSync(join(pgdata, 'PG_VERSION'), '17\n')
    expect(() => run({ POSTGRES_PASSWORD: '   ' })).toThrow(/password is unknown/)
  })

  it('refuses a symlink or a directory where a value file belongs', () => {
    run()
    const target = join(root, 'elsewhere')
    writeFileSync(target, 'x')
    rmSync(join(dir, 's3-secret-key'))
    symlinkSync(target, join(dir, 's3-secret-key'))
    expect(() => run()).toThrow('init: s3-secret-key is not a regular file; remove it and run init again')
    expect(readFileSync(target, 'utf8')).toBe('x')
    rmSync(join(dir, 's3-secret-key'))
    symlinkSync(target, join(dir, 'core/master-key.prev'))
    expect(() => run()).toThrow(/core\/master-key.prev is not a regular file/)
  })

  it('refuses a stored value of more than one line', () => {
    run()
    writeFileSync(join(dir, 's3-access-key'), 'ak\nDATABASE_URL=postgres://evil')
    expect(() => run()).toThrow('init: s3-access-key holds more than one line; fix or remove it')
  })

  it('refuses a YODA_MASTER_KEY that is not base64 of 32 bytes, naming no value', () => {
    for (const bad of ['not base64!', Buffer.alloc(16).toString('base64')]) {
      expect(() => run({ YODA_MASTER_KEY: bad })).toThrow('init: YODA_MASTER_KEY must be base64 of 32 bytes (e.g. `openssl rand -base64 32`)')
    }
    expect(validMasterKey(Buffer.alloc(32, 9).toString('base64'))).toBe(true)
    expect(validMasterKey(Buffer.alloc(32, 250).toString('base64url'))).toBe(true)
  })

  it('refuses when a database exists but its password is unknown, and writes nothing', () => {
    writeFileSync(join(pgdata, 'PG_VERSION'), '17\n')
    expect(() => run()).toThrow(InitRefusedError)
    expect(() => run()).toThrow(/existing database was found but its password is unknown/)
    // It points to the kit's bootstrap values and to the reset procedure.
    expect(() => run()).toThrow(/POSTGRES_PASSWORD, S3_ACCESS_KEY, S3_SECRET_KEY and YODA_MASTER_KEY from section 3 of your recovery kit/)
    expect(() => run()).toThrow(/reset the Postgres password \(docs\/operations.md, section 4a, "Lost bootstrap volume"\)/)
    expect(() => statSync(dir)).toThrow()
  })

  it('accepts an existing database when the password is in env or already in the volume', () => {
    run()
    writeFileSync(join(pgdata, 'PG_VERSION'), '17\n')
    expect(() => run()).not.toThrow()
    rmSync(dir, { recursive: true })
    expect(() => run({ POSTGRES_PASSWORD: 'known' })).not.toThrow()
  })

  it('repairs modes on every run', () => {
    run()
    chmodSync(join(dir, 'core/master-key'), 0o644)
    run()
    expect(mode('core/master-key')).toBe(0o600)
  })

  it('never prints a value', () => {
    const env = { POSTGRES_PASSWORD: 'pg-secret-value', S3_SECRET_KEY: 'secret-from-env' }
    run(env)
    const out = logs.join('\n')
    for (const v of [...Object.values(env), read('s3-access-key'), read('core/master-key')]) expect(out).not.toContain(v)
    expect(out).toContain('init: generated core/master-key')
    expect(out).toContain('init: postgres-password from POSTGRES_PASSWORD')
  })

  it('refuses a multi-line env value (it would corrupt bootstrap.env)', () => {
    expect(() => run({ S3_ACCESS_KEY: 'a\nDATABASE_URL=postgres://evil' })).toThrow(/S3_ACCESS_KEY must be a single line/)
  })

  it('draws passwords from A-Z a-z 0-9 only, without bias toward the first characters', () => {
    const s = randomAlnum(62 * 200)
    expect(s).toMatch(/^[A-Za-z0-9]+$/)
    expect(new Set(s).size).toBe(62)
    // Bytes 248..255 are skipped: an all-255 source alone never produces a character.
    let calls = 0
    expect(randomAlnum(4, (n) => (calls++ ? Buffer.alloc(n, 1) : Buffer.alloc(n, 255)))).toBe('BBBB')
  })
})

describe('applyBootstrapFile (core and migrate read the bootstrap volume)', () => {
  const file = 'DATABASE_URL=postgres://yoda:pw@postgres:5432/yoda\nS3_ACCESS_KEY=ak\nS3_SECRET_KEY=sk\n'

  it('fills DATABASE_URL and the S3 keys when env leaves them unset or empty', () => {
    const env: NodeJS.ProcessEnv = { YODA_BOOTSTRAP_FILE: '/var/lib/yoda/bootstrap.env', DATABASE_URL: '' }
    applyBootstrapFile(env, () => file)
    expect(env).toMatchObject({ DATABASE_URL: 'postgres://yoda:pw@postgres:5432/yoda', S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk' })
  })

  it('never replaces a value set in env', () => {
    const env: NodeJS.ProcessEnv = { YODA_BOOTSTRAP_FILE: '/x', DATABASE_URL: 'postgres://ext:pw@db.example.org/yoda', S3_ACCESS_KEY: 'env-ak' }
    applyBootstrapFile(env, () => file)
    expect(env).toMatchObject({ DATABASE_URL: 'postgres://ext:pw@db.example.org/yoda', S3_ACCESS_KEY: 'env-ak', S3_SECRET_KEY: 'sk' })
  })

  it('does nothing without YODA_BOOTSTRAP_FILE, and does not read the file when env has everything', () => {
    const env: NodeJS.ProcessEnv = {}
    applyBootstrapFile(env, () => file)
    expect(env).toEqual({})
    const full = { YODA_BOOTSTRAP_FILE: '/x', DATABASE_URL: 'a', S3_ACCESS_KEY: 'b', S3_SECRET_KEY: 'c' }
    applyBootstrapFile(full, () => {
      throw new Error('read')
    })
  })

  it('names the missing file without any value', () => {
    const env: NodeJS.ProcessEnv = { YODA_BOOTSTRAP_FILE: '/var/lib/yoda/bootstrap.env', S3_SECRET_KEY: 'hunter2' }
    const err = Object.assign(new Error('nope'), { code: 'ENOENT' })
    expect(() => applyBootstrapFile(env, () => { throw err })).toThrow('YODA_BOOTSTRAP_FILE: cannot read /var/lib/yoda/bootstrap.env (ENOENT); did the init service run?')
  })

  it('parses KEY=value lines literally (no quotes, no expansion), skipping comments', () => {
    expect(parseBootstrapEnv('# c\nA=1\n\nB=$(rm -rf /)\nbad line\nC="q"\n')).toEqual({ A: '1', B: '$(rm -rf /)', C: '"q"' })
  })
})
