import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The pure parts of ops/backup (retention, URL parsing) and restore.sh's confirmation guard, run through bash.
const dir = fileURLToPath(new URL('../../../ops/backup/', import.meta.url))
const lib = `${dir}lib.sh`
/** CI installs bash (`.gitlab-ci.yml` test job); skip rather than fail where an image lacks it. */
const noBash = process.platform === 'win32' || spawnSync('bash', ['-c', 'true']).status !== 0

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

describe.skipIf(noBash)('ops/backup retention', () => {
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

describe.skipIf(noBash)('ops/backup database URL', () => {
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

describe.skipIf(noBash)('ops/backup restore.sh guard', () => {
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

describe.skipIf(noBash)('ops/backup scheduling and health', () => {
  it.each([
    ['today when it is still ahead', '1000 2000 88400 0', '2000'],
    ['tomorrow once today has passed', '2000 2000 88400 0', '88400'],
    ['tomorrow when the last run started within 60 s of today (clock stepped back)', '1990 2000 88400 1950', '88400'],
    ['today when the last run was longer ago', '1000 2000 88400 1900', '2000'],
  ])('picks %s', (_label, args, want) => {
    expect(bash(`source "${lib}"; pick_target ${args}`)).toMatchObject({ code: 0, stdout: `${want}\n` })
  })

  const counter = `n=0; flaky() { n=$((n + 1)); echo "call $n"; [ "$n" -gt "$FAILS" ]; }`

  it('retries a failed run and stops at the first success', () => {
    const r = bash(`source "${lib}"; ${counter}; FAILS=2; set -e; with_retries 3 0 flaky; echo done`)
    expect(r.code).toBe(0)
    expect(r.stdout.match(/call \d/g)).toEqual(['call 1', 'call 2', 'call 3'])
    expect(r.stdout.match(/retrying in 0s/g)).toHaveLength(2)
    expect(r.stdout).toContain('done')
  })

  it('gives up after the retries with the failing status', () => {
    const r = bash(`source "${lib}"; ${counter}; FAILS=99; set +e; with_retries 3 0 flaky; echo "status $?"`)
    expect(r.stdout.match(/call \d/g)).toHaveLength(4)
    expect(r.stdout).toContain('status 1')
  })

  it('keeps errexit working inside the retried command', () => {
    const r = bash(`source "${lib}"; step() { ( set -e; false; echo REACHED ); }; set +e; with_retries 0 0 step; echo "status $?"`)
    expect(r.stdout).not.toContain('REACHED')
    expect(r.stdout).toContain('status 1')
  })

  const day = 86_400
  it.each([
    ['a recent backup', `${2 * day} ${2 * day - 3600} ''`, 0, 'ok: last backup 1h ago'],
    ['a backup older than the limit', `${3 * day} ${3 * day - 27 * 3600} ''`, 1, 'stale: last backup 27h ago'],
    ['no backup yet, daemon just started', `${day} '' ${day - 600}`, 0, 'ok: no backup yet'],
    ['no backup, daemon started long ago', `${3 * day} '' ${day}`, 1, 'unhealthy: no backup'],
    ['no backup and no start record', `${day} '' ''`, 1, 'unhealthy: no backup'],
  ])('health with %s', (_label, args, code, out) => {
    expect(bash(`source "${lib}"; backup_health ${args} ${26 * 3600}`)).toMatchObject({ code, stdout: `${out}\n` })
  })
})

const hasFlock = spawnSync('sh', ['-c', 'command -v flock']).status === 0

// Fake pg_dump and rclone on PATH: pg_dump fails while $FAKE/fail-pg exists, else marks that it started,
// waits $FAKE_PG_SLEEP seconds and writes the dump; rclone `sync <src> <dst>` writes one object.
const fakes = `
F=$(mktemp -d); B=$(mktemp -d)
cat >"$F/pg_dump" <<'SH'
#!/usr/bin/env bash
echo x >>"$FAKE/pg-calls"
if [ -e "$FAKE/fail-pg" ]; then rm "$FAKE/fail-pg"; exit 1; fi
out=; while [ $# -gt 0 ]; do [ "$1" = --file ] && out=$2; shift; done
touch "$FAKE/pg-started"; sleep "\${FAKE_PG_SLEEP:-0}"; echo dump >"$out"
SH
cat >"$F/rclone" <<'SH'
#!/usr/bin/env bash
echo x >>"$FAKE/rclone-calls"
dst=\${@: -1}; mkdir -p "$dst"; echo object >"$dst/a.txt"
SH
chmod +x "$F/pg_dump" "$F/rclone"
export FAKE=$F PATH="$F:$PATH" BACKUP_DIR=$B BACKUP_STARTED_FILE=$F/started
export DATABASE_URL=postgres://u:p@db.example.org/yoda S3_ENDPOINT=http://s3.example.org S3_BUCKET=b S3_ACCESS_KEY=a S3_SECRET_KEY=s
calls() { [ -e "$FAKE/$1-calls" ] && wc -l <"$FAKE/$1-calls" | tr -d ' ' || echo 0; }
`

describe.skipIf(noBash || !hasFlock)('ops/backup lock and retry (fake pg_dump and rclone)', () => {
  it('lets only one of two concurrent backups run, leaving the first one intact', () => {
    const r = bash(`${fakes}
      FAKE_PG_SLEEP=2 bash "${dir}backup.sh" --now >"$F/a.log" 2>&1 & a=$!
      while [ ! -e "$F/pg-started" ]; do sleep 0.1; done
      bash "${dir}backup.sh" --now >"$F/b.log" 2>&1; echo "b=$?"
      wait $a; echo "a=$?"
      cat "$F/b.log"; ls -A "$B" | grep -v '^\\.lock$' | sed 's/[0-9]\\{8\\}-[0-9]\\{4\\}/STAMP/'
      echo "pg=$(calls pg)"`)
    expect(r.stdout).toContain('a=0')
    expect(r.stdout).toMatch(/b=[1-9]/)
    expect(r.stdout).toContain('another backup or restore is running')
    expect(r.stdout).toContain('latest\npg-STAMP.dump\nstorage-STAMP\n')
    expect(r.stdout).toContain('pg=1')
  })

  it('retries a failed scheduled run, stopping the failed attempt at its first error', () => {
    const r = bash(`${fakes}
      touch "$F/fail-pg"
      source "${dir}backup.sh"; setup_pg; setup_store; retries=3; retry_delay=0
      set +e; scheduled_run; echo "status=$?"
      echo "pg=$(calls pg) rclone=$(calls rclone)"; cat "$B/latest" >/dev/null && echo has-latest`)
    expect(r.stdout).toContain('status=0')
    expect(r.stdout).toContain('retrying in 0s (retry 1 of 3)')
    // The failed attempt never reached the storage mirror.
    expect(r.stdout).toContain('pg=2 rclone=1')
    expect(r.stdout).toContain('has-latest')
  })
})

describe.skipIf(noBash)('ops/backup bootstrap file', () => {
  const file = `F=$(mktemp); printf '# init\\nDATABASE_URL=postgres://yoda:gen%%3Apw@postgres:5432/yoda\\nS3_ACCESS_KEY=gen-ak\\nS3_SECRET_KEY=gen-sk\\nOTHER=$(touch /tmp/x)\\n' >"$F"; export YODA_BOOTSTRAP_FILE=$F`

  it('fills the database URL and S3 keys from the bootstrap volume, decoding as before', () => {
    const r = bash(`${file}; source "${lib}"; setup_pg; S3_ENDPOINT=http://s3.example.org S3_BUCKET=b setup_store
      printf '%s|%s|%s|%s|%s\\n' "$PGUSER" "$PGPASSWORD" "$PGHOST" "$RCLONE_CONFIG_STORE_ACCESS_KEY_ID" "$RCLONE_CONFIG_STORE_SECRET_ACCESS_KEY"
      [ -z "\${OTHER:-}" ] && echo no-other`)
    expect(r).toMatchObject({ code: 0, stdout: 'yoda|gen:pw|postgres|gen-ak|gen-sk\nno-other\n' })
  })

  it('lets env win', () => {
    const r = bash(`${file}; export DATABASE_URL=postgres://ext:pw@db.example.org/yoda S3_SECRET_KEY=env-sk; source "${lib}"; load_bootstrap_file
      printf '%s|%s|%s\\n' "$DATABASE_URL" "$S3_ACCESS_KEY" "$S3_SECRET_KEY"`)
    expect(r).toMatchObject({ code: 0, stdout: 'postgres://ext:pw@db.example.org/yoda|gen-ak|env-sk\n' })
  })

  it('fails on an unreadable file without printing a value', () => {
    const r = bash(`export YODA_BOOTSTRAP_FILE=/nonexistent/bootstrap.env S3_SECRET_KEY=hunter2; source "${lib}"; load_bootstrap_file; echo reached`)
    expect(r.code).not.toBe(0)
    expect(r.stdout).not.toContain('reached')
    expect(r.stderr).toContain('did the init service run?')
    expect(r.stderr).not.toContain('hunter2')
  })

  it('does nothing without YODA_BOOTSTRAP_FILE', () => {
    expect(bash(`source "${lib}"; load_bootstrap_file; echo "[\${DATABASE_URL:-}]"`)).toMatchObject({ code: 0, stdout: '[]\n' })
  })
})

describe.skipIf(noBash)('ops/backup settings from the database (System settings → Backups)', () => {
  const pick = (args: string, rows: string) => bash(`source "${lib}"; pick_backup_settings ${args}`, { input: rows })

  it.each([
    ['the database values', `'' '' 02:00 14`, 'backup.at\t03:30\nbackup.keepDays\t30\n', '03:30 30\n'],
    ['the defaults without rows', `'' '' 02:00 14`, '', '02:00 14\n'],
    ['env over the database', `04:00 7 02:00 14`, 'backup.at\t03:30\nbackup.keepDays\t30\n', '04:00 7\n'],
    ['env for one, the database for the other', `'' 7 02:00 14`, 'backup.at\t03:30\nbackup.keepDays\t30\n', '03:30 7\n'],
    ['the current values over an invalid row', `'' '' 01:15 9`, 'backup.at\t25:00\nbackup.keepDays\t0\n', '01:15 9\n'],
  ])('picks %s', (_label, args, rows, want) => {
    expect(pick(args, rows)).toMatchObject({ code: 0, stdout: want })
  })

  it('warns about an invalid database value without echoing it', () => {
    const r = pick(`'' '' 02:00 14`, 'backup.at\t$(touch /tmp/x)\nbackup.keepDays\t99999\n')
    expect(r.stdout).toBe('02:00 14\n')
    expect(r.stderr).toContain('ignoring an invalid backup.at')
    expect(r.stderr).toContain('ignoring an invalid backup.keepDays')
    expect(r.stderr).not.toContain('touch')
  })

  // A fake psql: prints $FAKE_ROWS (or fails while $FAKE/psql-fail exists) and records its arguments.
  const psql = `
F=$(mktemp -d)
cat >"$F/psql" <<'SH'
#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE/psql-args"
[ -e "$FAKE/psql-fail" ] && { echo 'psql: error: connection to server at "db" failed' >&2; exit 2; }
printf '%b' "$FAKE_ROWS"
SH
chmod +x "$F/psql"
export FAKE=$F PATH="$F:$PATH" PGPASSWORD=hunter2
`

  it('reads both keys with one psql query, the password only in PGPASSWORD', () => {
    const r = bash(`${psql} export FAKE_ROWS='backup.at\\t03:30\\nbackup.keepDays\\t30\\n'; source "${lib}"; db_backup_settings | pick_backup_settings '' '' 02:00 14; cat "$F/psql-args"`)
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^03:30 30\n/)
    expect(r.stdout).toContain("where key in ('backup.at', 'backup.keepDays')")
    expect(r.stdout).toContain('-v ON_ERROR_STOP=1')
    expect(r.stdout).not.toContain('hunter2')
  })

  it('refresh_settings applies a change, then keeps the values and warns once while the database is down', () => {
    const r = bash(`${psql} export FAKE_ROWS='backup.at\\t03:30\\nbackup.keepDays\\t30\\n' BACKUP_DIR=$(mktemp -d)
      source "${dir}backup.sh"
      refresh_settings; echo "1: $at $keep"
      touch "$F/psql-fail"; refresh_settings; refresh_settings; echo "2: $at $keep"
      rm "$F/psql-fail"; FAKE_ROWS='backup.at\\t05:00\\n'; refresh_settings; echo "3: $at $keep"`)
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('1: 03:30 30')
    expect(r.stdout).toContain('2: 03:30 30')
    expect(r.stdout).toContain('3: 05:00 30')
    expect(r.stdout.match(/cannot read the backup settings/g)).toHaveLength(1)
    expect(r.stdout).toContain('backup settings: daily at 03:30, keeping 30 days')
    expect(r.stdout).not.toContain('connection to server')
  })

  it('does not query the database when env sets both', () => {
    const r = bash(`${psql} export BACKUP_AT=04:00 BACKUP_KEEP_DAYS=7 BACKUP_DIR=$(mktemp -d)
      source "${dir}backup.sh"; refresh_settings; echo "$at $keep"; [ -e "$F/psql-args" ] && echo queried || echo none`)
    expect(r.stdout).toBe('04:00 7\nnone\n')
  })
})
