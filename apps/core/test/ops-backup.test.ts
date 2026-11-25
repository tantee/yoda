import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The pure parts of ops/backup (retention, URL parsing) and restore.sh's confirmation guard, run through bash.
const dir = fileURLToPath(new URL('../../../ops/backup/', import.meta.url))
const lib = `${dir}lib.sh`

function bash(script: string, opts: { input?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync('bash', ['-c', script], {
    input: opts.input ?? '',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...opts.env },
    encoding: 'utf8',
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function stamp(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
}

/** Backups for each of the `days` days up to and including `today` (YYYY-MM-DD), newest last. */
function backupsOver(today: string, days: number) {
  const end = new Date(`${today}T00:00:00Z`)
  const out: { day: string; names: string[] }[] = []
  for (let i = days - 1; i >= 0; i--) {
    const day = stamp(new Date(end.getTime() - i * 86_400_000))
    out.push({ day, names: [`pg-${day}-0200.dump`, `storage-${day}-0200`] })
  }
  return out
}

const expired = (keep: string, today: string, names: string[]) =>
  bash(`source "${lib}"; select_expired ${keep} ${today}`, { input: names.join('\n') + '\n' })

describe.skipIf(process.platform === 'win32')('ops/backup retention', () => {
  it.each([
    ['2026-11-25'],
    ['2026-03-05'], // crosses the end of February
    ['2026-01-03'], // crosses the year
    ['2028-03-01'], // crosses a leap day
  ])('selects exactly the backups older than 14 days over 20 days (today %s)', (today) => {
    const all = backupsOver(today, 20)
    const noise = ['latest', 'pg-garbage.dump', 'storage-20200101-0200.partial', 'notes.txt']
    const r = expired('14', stamp(new Date(`${today}T00:00:00Z`)), [...noise, ...all.flatMap((b) => b.names)])
    expect(r.code).toBe(0)
    // Ages 19..15 days are older than 14; the backup from exactly 14 days ago is kept.
    const want = all.slice(0, 5).flatMap((b) => b.names)
    expect(r.stdout.trim().split('\n')).toEqual(want)
  })

  it('selects nothing when every backup is recent', () => {
    const r = expired('14', '20261125', backupsOver('2026-11-25', 15).flatMap((b) => b.names))
    expect(r).toMatchObject({ code: 0, stdout: '' })
  })

  it.each([['0'], ['-3'], ['abc'], ['']])('refuses a keep of %j', (keep) => {
    const r = expired(`'${keep}'`, '20261125', ['pg-20200101-0200.dump'])
    expect(r.code).not.toBe(0)
    expect(r.stdout).toBe('')
  })
})

describe.skipIf(process.platform === 'win32')('ops/backup database URL', () => {
  it('turns DATABASE_URL into libpq variables, decoding the user and password', () => {
    const r = bash(
      `source "${lib}"; pg_env_from_url 'postgres://us%40er:p%3As%25s@db.example.org:6543/yoda_prod?sslmode=require'
       printf '%s|%s|%s|%s|%s|%s\\n' "$PGUSER" "$PGPASSWORD" "$PGHOST" "$PGPORT" "$PGDATABASE" "$PGSSLMODE"`,
    )
    expect(r).toMatchObject({ code: 0, stdout: 'us@er|p:s%s|db.example.org|6543|yoda_prod|require\n' })
  })

  it('defaults the port and accepts postgresql://', () => {
    const r = bash(`source "${lib}"; pg_env_from_url 'postgresql://yoda:pw@postgres/yoda'; echo "$PGPORT|$PGHOST|$PGDATABASE"`)
    expect(r).toMatchObject({ code: 0, stdout: '5432|postgres|yoda\n' })
  })

  it('rejects a URL it cannot read, without echoing it', () => {
    const r = bash(`source "${lib}"; pg_env_from_url 'mysql://u:hunter2@h/db'`)
    expect(r.code).not.toBe(0)
    expect(r.stderr).not.toContain('hunter2')
  })
})

describe.skipIf(process.platform === 'win32')('ops/backup restore.sh guard', () => {
  const restore = (env: Record<string, string>, stampArg = '20261125-0200') =>
    bash(`bash "${dir}restore.sh" ${stampArg}`, { env })

  it.each([[{}], [{ RESTORE_CONFIRM: 'no' }], [{ RESTORE_CONFIRM: 'YES ' }]])(
    'refuses to run without RESTORE_CONFIRM=yes (%j)',
    (env) => {
      const r = restore({ ...env, DATABASE_URL: 'postgres://u:p@127.0.0.1:1/none' })
      expect(r.code).not.toBe(0)
      expect(r.stderr).toContain('RESTORE_CONFIRM=yes')
    },
  )

  it('refuses a stamp that is not a backup name', () => {
    const r = restore({ RESTORE_CONFIRM: 'yes' }, "'../etc'")
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('stamp')
  })
})
