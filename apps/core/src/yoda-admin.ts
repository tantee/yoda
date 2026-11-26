import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
import { setupState as setupStateTable } from './db/schema.js'
import type { JobQueue } from './jobs/queue.js'
import { adminView, findAdmin, firstAdmin, notifyAdmins, resetAdmin } from './local/break-glass.js'
import { currentOidc, readOidcState } from './local/oidc-change.js'
import { revokeSessions } from './local/session.js'
import { issueSetupToken, liveTokenFromFile, setupTokenBanner } from './local/setup-token.js'
import { LiveBus } from './live/bus.js'
import type { SettingsStore } from './settings/store.js'
import { setupState } from './setup-state.js'

/**
 * `yoda-admin` (installer proposal §7.4, §11): host-side commands, run in the core container
 * (`docker compose exec core yoda-admin <command>`). Host access is the root of trust here. Each command that
 * changes something is audited with source `cli`; nothing prints a stored secret.
 *
 * - `setup-token [--new]`: prints the current setup token (from the 0600 file), or issues a new one when there is
 *   none, it expired, or `--new` is given. Only while setup is not done.
 * - `reset-break-glass [--username <name>]`: a new temporary password (printed once); TOTP is removed and must be
 *   enrolled again after signing in; sessions end; portal admins are notified.
 * - `status`: setup state, master key state, break-glass account, setup token and sign-in settings.
 */

export type AdminCliDeps = {
  db: Db
  settings: SettingsStore
  config: Config
  tokenFile: string | null
  jobs: Pick<JobQueue, 'send'>
  now?: () => Date
  out: (line: string) => void
  err: (line: string) => void
}

const USAGE = `usage: yoda-admin <command>
  setup-token [--new]                 print the setup token (a new one with --new, or when none is valid)
  reset-break-glass [--username <u>]  new temporary break-glass password; TOTP is enrolled again after sign-in
  status                              setup, master key, break-glass account and sign-in state`

const CLI = { personId: null, label: 'cli', source: 'cli' } as const

export async function runAdmin(argv: string[], deps: AdminCliDeps): Promise<number> {
  const [command, ...args] = argv
  const now = deps.now?.() ?? new Date()
  const state = setupState(deps.config, deps.settings)
  switch (command) {
    case 'setup-token': {
      if (state === 'done') {
        deps.err('Setup is already done; there is no setup token.')
        return 1
      }
      const fresh = args.includes('--new')
      const current = fresh ? null : await liveTokenFromFile(deps.db, deps.tokenFile, now)
      if (current) {
        const [st] = await deps.db.select().from(setupStateTable).where(eq(setupStateTable.id, 1))
        deps.out(setupTokenBanner(current, st!.setupTokenExpires!))
        return 0
      }
      await issueSetupToken(deps.db, { file: deps.tokenFile, now, log: deps.out, warn: deps.err })
      await deps.settings.audit({ action: 'setup.token_issued', actor: CLI })
      return 0
    }
    case 'reset-break-glass': {
      const i = args.indexOf('--username')
      const admin = i >= 0 && args[i + 1] ? await findAdmin(deps.db, args[i + 1]!) : await firstAdmin(deps.db)
      if (!admin) {
        deps.err('No break-glass account exists (it is created in the setup wizard).')
        return 1
      }
      const password = await resetAdmin(deps.db, admin, now)
      await revokeSessions(deps.db, { adminId: admin.id })
      await deps.settings.audit({ action: 'break_glass.reset', actor: CLI, newValue: { username: admin.username } })
      try {
        await notifyAdmins({ db: deps.db, bus: new LiveBus(), jobs: deps.jobs, config: deps.config }, {
          what: 'ถูกรีเซ็ตรหัสผ่านจากเครื่องที่ติดตั้ง (yoda-admin reset-break-glass)',
          username: admin.username,
          ip: null,
          at: now,
          key: `break_glass.reset:${now.getTime()}`,
        })
      } catch {
        deps.err('warning: the portal admins could not be notified (database or queue error); the reset is done.')
      }
      deps.out(`Break-glass account ${admin.username}: temporary password (shown once):`)
      deps.out(`  ${password}`)
      deps.out('Sign in at /recovery, then choose a new password and enrol TOTP again. Other sessions were ended.')
      return 0
    }
    case 'status': {
      const s = deps.settings
      const [st] = await deps.db.select().from(setupStateTable).where(eq(setupStateTable.id, 1))
      const admin = await firstAdmin(deps.db)
      const { pending, rollback } = await readOidcState(deps.db)
      const oidc = currentOidc(deps.config, s)
      deps.out(`setup: ${state}`)
      deps.out(`master key: ${s.keyStatus}${s.keyId ? ` (id ${s.keyId})` : ''}${s.recovery ? ', recovery state' : ''}`)
      if (state === 'required') {
        const live = st?.setupTokenHash && st.setupTokenExpires && st.setupTokenExpires > now
        deps.out(`setup token: ${live ? `valid until ${st!.setupTokenExpires!.toISOString()}` : 'none (run: yoda-admin setup-token)'}`)
      }
      if (admin) {
        const v = await adminView(deps.db, s, admin, null)
        const locked = admin.lockedUntil && admin.lockedUntil > now ? `, locked until ${admin.lockedUntil.toISOString()}` : ''
        deps.out(`break-glass: ${v.username}, TOTP ${v.totpEnabled ? 'on' : 'off'}, ${v.recoveryCodesLeft} recovery codes left${v.mustChangePassword ? ', temporary password' : ''}${locked}`)
      } else {
        deps.out('break-glass: none')
      }
      deps.out(`sign-in: issuer ${oidc.issuer ?? '(not set)'}, client ${oidc.clientId}${oidc.jwksUrl ? `, JWKS ${oidc.jwksUrl}` : ''}`)
      if (pending) deps.out(`sign-in change pending: issuer ${pending.values.issuer}, ${pending.testedAt ? `tested by ${pending.testedUsername}` : 'not tested'}`)
      if (rollback && new Date(rollback.until) > now) deps.out(`rollback available until ${rollback.until}`)
      return 0
    }
    default:
      deps.err(USAGE)
      return command ? 1 : 0
  }
}

// Entry: `node dist/yoda-admin.js <command>` (the image's /usr/local/bin/yoda-admin wraps it).
const COMMANDS = new Set(['setup-token', 'reset-break-glass', 'status'])

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && !COMMANDS.has(process.argv[2] ?? '')) {
  // No database needed to say how to use it.
  console.error(USAGE)
  process.exit(process.argv[2] ? 1 : 0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { applyBootstrapFile, loadConfig } = await import('./config.js')
  const { createDb, pgClient } = await import('./db/client.js')
  const { takeMasterKey } = await import('./settings/crypto.js')
  const { SettingsStore } = await import('./settings/store.js')
  const { resolveConfig } = await import('./settings/live.js')
  const { createPgBossQueue } = await import('./jobs/queue.js')
  const { setupTokenFile } = await import('./local/setup-token.js')
  applyBootstrapFile(process.env)
  const masterKey = takeMasterKey(process.env)
  const base = loadConfig(process.env)
  const db = createDb(base.databaseUrl)
  const quiet = { warn: (_o: object, m: string) => console.error(`settings: ${m}`), info: () => {} }
  const settings = await SettingsStore.open({ db, env: process.env, masterKey, log: quiet })
  const config = resolveConfig(base, settings)
  // Only to queue notification deliveries (no workers here); without it the feed entries are still stored.
  let jobs: Pick<JobQueue, 'send'> & { stop?: () => Promise<void> } = { send: async () => {} }
  if (process.argv[2] === 'reset-break-glass') {
    try {
      jobs = await createPgBossQueue(base.databaseUrl, 1)
    } catch {
      console.error('warning: job queue unavailable; email notifications are not sent')
    }
  }
  let code = 1
  try {
    code = await runAdmin(process.argv.slice(2), {
      db,
      settings,
      config,
      tokenFile: setupTokenFile(process.env),
      jobs,
      out: (l) => console.log(l),
      err: (l) => console.error(l),
    })
  } finally {
    await jobs.stop?.()
    await pgClient(db).end()
  }
  process.exit(code)
}
