import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
import { setupState as setupStateTable } from './db/schema.js'
import type { JobQueue } from './jobs/queue.js'
import { adminView, findAdmin, firstAdmin, MasterKeyUnavailable, notifyAdmins, resetAdmin } from './local/break-glass.js'
import {
  dropNextKey,
  dropPreviousKey,
  finishRotation,
  issueRecoveryKit,
  promoteNextKey,
  resetLostMasterKey,
  rotateMasterKey,
  rotationPreflight,
  RotationRefused,
  writeNextKey,
} from './local/master-key.js'
import { currentOidc, readOidcState } from './local/oidc-change.js'
import { revokeSessions } from './local/session.js'
import { issueSetupToken, liveTokenFromFile, setupTokenBanner } from './local/setup-token.js'
import { LiveBus } from './live/bus.js'
import { generateMasterKey, type MasterKey, type MasterKeyLoad } from './settings/crypto.js'
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
 * - `rotate-master-key [--dry-run]` (§3.5): a new master key; everything is re-wrapped in one transaction (see
 *   local/master-key.ts), the key file moves to `master-key.prev` and the new key takes its place, and the new
 *   recovery kit (the new key and new recovery codes) goes to stdout, the only output there, so
 *   `... yoda-admin rotate-master-key > kit.txt` captures it. `--finish` moves what is still under the previous
 *   key and deletes `master-key.prev`.
 * - `recovery-kit`: a new kit on stdout (the current key and new recovery codes; the old codes stop working).
 * - `reset-master-key --yes`: the key was lost; accept the loaded key, dropping what the old key sealed (7.4, T7).
 * - `recovery on|off`: force recovery mode (the portal shows only /recovery; the portal API answers 503).
 */

export type AdminCliDeps = {
  db: Db
  settings: SettingsStore
  config: Config
  tokenFile: string | null
  jobs: Pick<JobQueue, 'send'>
  /** The key file (YODA_MASTER_KEY_FILE) rotation rewrites; null when there is none. */
  keyFile?: string | null
  /** Where the loaded key came from; with `env`, rotation cannot change it and says so. */
  keySource?: 'env' | 'file' | null
  /** The key as loaded (also a wrong one: `reset-master-key`). */
  masterKey?: MasterKeyLoad
  /** Tests pass a fixed key. */
  generateKey?: () => MasterKey
  now?: () => Date
  out: (line: string) => void
  err: (line: string) => void
}

const USAGE = `usage: yoda-admin <command>
  setup-token [--new]                 print the setup token (a new one with --new, or when none is valid)
  reset-break-glass [--username <u>]  new temporary break-glass password; TOTP is enrolled again after sign-in
  status                              setup, master key, break-glass account and sign-in state
  rotate-master-key [--dry-run]       new master key; the new recovery kit goes to stdout (redirect it to a file)
                    [--allow-env-key] (needed when YODA_MASTER_KEY comes from the environment; restart after)
  rotate-master-key --finish          re-wrap what is left under the previous key, then delete master-key.prev
  recovery-kit                        a new recovery kit on stdout (new recovery codes; the old ones stop working)
  reset-master-key --yes              the master key is lost: keep the loaded key, drop the secrets it cannot open
  recovery on|off                     force recovery mode on or off (the portal shows only /recovery)`

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
      if (s.previousKeyId) deps.out(`previous master key: ${s.previousKeyId} (finish with: yoda-admin rotate-master-key --finish)`)
      if (s.recoveryForced) deps.out('recovery mode: forced on (yoda-admin recovery off ends it)')
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
    case 'rotate-master-key':
      return args.includes('--finish')
      ? finishCommand(deps)
      : rotateCommand(deps, { dryRun: args.includes('--dry-run'), allowEnvKey: args.includes('--allow-env-key'), now })
    case 'recovery-kit':
      return kitCommand(deps, now)
    case 'reset-master-key':
      return resetKeyCommand(deps, args.includes('--yes'))
    case 'recovery': {
      const on = args[0] === 'on' ? true : args[0] === 'off' ? false : null
      if (on === null) {
        deps.err(USAGE)
        return 1
      }
      const changed = await deps.settings.setRecoveryMode(on, CLI)
      deps.out(changed ? `Recovery mode is now ${on ? 'on: the portal shows only /recovery' : 'off'}.` : `Recovery mode was already ${on ? 'on' : 'off'}.`)
      if (changed) await notifyCli(deps, on ? 'เปิดโหมดกู้คืนจากเครื่องที่ติดตั้ง (yoda-admin recovery on)' : 'ปิดโหมดกู้คืน (yoda-admin recovery off)', `recovery.mode:${on}`, now)
      return 0
    }
    default:
      deps.err(USAGE)
      return command ? 1 : 0
  }
}

// Entry: `node dist/yoda-admin.js <command>` (the image's /usr/local/bin/yoda-admin wraps it).
const COMMANDS = new Set(['setup-token', 'reset-break-glass', 'status', 'rotate-master-key', 'recovery-kit', 'reset-master-key', 'recovery'])

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && !COMMANDS.has(process.argv[2] ?? '')) {
  // No database needed to say how to use it.
  console.error(USAGE)
  process.exit(process.argv[2] ? 1 : 0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { applyBootstrapFile, loadConfig } = await import('./config.js')
  const { createDb, pgClient } = await import('./db/client.js')
  const { takeMasterKeySetup } = await import('./settings/crypto.js')
  const { SettingsStore } = await import('./settings/store.js')
  const { resolveConfig } = await import('./settings/live.js')
  const { createPgBossQueue } = await import('./jobs/queue.js')
  const { setupTokenFile } = await import('./local/setup-token.js')
  applyBootstrapFile(process.env)
  const key = takeMasterKeySetup(process.env)
  const base = loadConfig(process.env)
  const db = createDb(base.databaseUrl)
  const quiet = { warn: (_o: object, m: string) => console.error(`settings: ${m}`), info: () => {} }
  const settings = await SettingsStore.open({ db, env: process.env, masterKey: key.masterKey, previousKey: key.previousKey, log: quiet })
  const config = resolveConfig(base, settings)
  // Only to queue notification deliveries (no workers here); without it the feed entries are still stored.
  let jobs: Pick<JobQueue, 'send'> & { stop?: () => Promise<void> } = { send: async () => {} }
  if (['reset-break-glass', 'rotate-master-key', 'recovery-kit', 'reset-master-key', 'recovery'].includes(process.argv[2] ?? '')) {
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
      keyFile: key.file,
      keySource: key.source,
      masterKey: key.masterKey,
      out: (l) => console.log(l),
      err: (l) => console.error(l),
    })
  } finally {
    await jobs.stop?.()
    await pgClient(db).end()
  }
  process.exit(code)
}

const refusal: Record<RotationRefused['code'], string> = {
  key_unavailable: 'The current master key is not usable (missing or wrong; see yoda-admin status). Put the right key back first, or, if it is lost, run yoda-admin reset-master-key --yes.',
  setup_required: 'Setup is not finished; the wizard\'s recovery kit carries the key. Finish setup first.',
  key_changed: 'The database names another master key than this process loaded (a rotation meanwhile?). Restart core and try again.',
  stale_key_file:
    'Core runs on the previous key (master-key.prev): the key file holds an older key, usually because .env still sets the old YODA_MASTER_KEY. Put the current key in .env (or remove the line), run dc up -d --no-build, then try again.',
  next_exists:
    'master-key.next already exists: an earlier rotation did not finish moving the key files. Check yoda-admin status; if the database names the key in master-key.next, finish by hand: mv master-key master-key.prev && mv master-key.next master-key (in /var/lib/yoda/core). If it does not, remove master-key.next. Then try again.',
  unreadable: 'Some stored values cannot be opened with the current or previous key; clear or re-enter them in System settings first:',
  no_previous: 'There is no previous master key to finish (no rotation in progress).',
  not_mismatch: 'The loaded master key is not the wrong key (it opens the key canary, or there is none): nothing to reset.',
}

function refused(deps: AdminCliDeps, err: unknown): number {
  if (!(err instanceof RotationRefused)) throw err
  deps.err(refusal[err.code])
  for (const item of err.items) deps.err(`  ${item}`)
  return 1
}

function publicUrlOf(settings: SettingsStore): string {
  try {
    return settings.get('org.publicUrl') ?? ''
  } catch {
    return ''
  }
}

/** Every portal admin is told (feed and email); a failure to tell them does not undo the change. */
async function notifyCli(deps: AdminCliDeps, what: string, key: string, now: Date, username = 'cli'): Promise<void> {
  try {
    await notifyAdmins({ db: deps.db, bus: new LiveBus(), jobs: deps.jobs, config: deps.config }, { what, username, ip: null, at: now, key: `${key}:${now.getTime()}` })
  } catch {
    deps.err('warning: the portal admins could not be notified (database or queue error); the change is done.')
  }
}

async function rotateCommand(deps: AdminCliDeps, opts: { dryRun: boolean; allowEnvKey: boolean; now: Date }): Promise<number> {
  const to = (deps.generateKey ?? generateMasterKey)()
  const file = deps.keySource === 'file' ? (deps.keyFile ?? null) : null
  // Nothing touches a file before these hold.
  try {
    rotationPreflight(deps.settings)
  } catch (err) {
    return refused(deps, err)
  }
  if (!opts.dryRun && deps.keySource === 'env' && !opts.allowEnvKey) {
    deps.err('The master key comes from YODA_MASTER_KEY in this process\'s environment, which rotation cannot change: core keeps')
    deps.err('using the old key, and every secret is unreadable to it, until YODA_MASTER_KEY holds the new key and core restarts.')
    deps.err('Run again with --allow-env-key when you can update the environment and restart core right after.')
    return 1
  }
  if (!opts.dryRun && deps.keySource !== 'env' && !file) {
    deps.err('No key file (YODA_MASTER_KEY_FILE) to write the new key to; refusing to rotate.')
    return 1
  }
  if (file && !opts.dryRun) {
    try {
      writeNextKey(file, to)
    } catch (err) {
      return refused(deps, err)
    }
  }
  let r
  try {
    r = await rotateMasterKey(deps, { to, dryRun: opts.dryRun, actor: CLI })
  } catch (err) {
    if (file && !opts.dryRun) dropNextKey(file)
    return refused(deps, err)
  }
  if (r.dryRun) {
    deps.err(`dry run: would re-wrap ${r.secrets} secret(s) and ${r.totpSeeds} TOTP seed(s) from key ${r.oldKeyId} to a new key, ${r.admin ? `replace the recovery codes of ${r.admin.username} ` : ''}and end ${r.sessionsEnded} setup/recovery session(s). Nothing was changed.`)
    return 0
  }
  // The kit first: whatever happens to the files now, the operator holds the new key.
  if (r.admin) {
    const admin = (await firstAdmin(deps.db))!
    const kit = await issueRecoveryKit(deps, { admin, publicUrl: publicUrlOf(deps.settings), at: opts.now, codes: r.admin.codes, key: to })
    deps.out(kit.text.trimEnd())
  } else {
    deps.out(`YODA MASTER KEY (key id ${to.id}): ${to.key.toString('base64')}`)
  }
  if (file) {
    try {
      promoteNextKey(file)
    } catch (err) {
      deps.err(`error: the database now uses key ${r.newKeyId}, but moving the key files failed (${(err as { code?: string }).code ?? 'error'}).`)
      deps.err(`  Fix by hand: mv ${file} ${file}.prev && mv ${file}.next ${file}   (the new key is also in the kit above)`)
      return 1
    }
    await deps.settings.broadcast().catch(() => {})
  }
  deps.err(`Master key rotated: ${r.oldKeyId} -> ${r.newKeyId}. ${r.secrets} secret(s) and ${r.totpSeeds} TOTP seed(s) re-wrapped; ${r.sessionsEnded} setup/recovery session(s) ended.`)
  deps.err('The recovery kit above (stdout) has the new key and new recovery codes: store it now; the old kit and codes no longer work.')
  if (deps.keySource === 'env') {
    deps.err('YODA_MASTER_KEY comes from the environment: put the new key in .env now (YODA_MASTER_KEY=<new key>), then dc up -d --no-build. Core uses the old key until then.')
  } else {
    deps.err(`Running core instances switch to the new key on their own (the old one stays as ${file}.prev, decrypt-only).`)
    deps.err('If .env sets YODA_MASTER_KEY, replace it with the new key now or remove the line: init copies .env over the key file on every start.')
  }
  deps.err('Audit fingerprints are keyed by the master key: changes before and after the rotation cannot be compared by fingerprint.')
  deps.err('When every core runs with the new key: yoda-admin rotate-master-key --finish')
  await notifyCli(deps, `หมุนเวียนกุญแจหลัก (master key) เป็น ${r.newKeyId}`, 'master_key.rotated', opts.now)
  return 0
}

async function finishCommand(deps: AdminCliDeps): Promise<number> {
  let r
  try {
    r = await finishRotation(deps, CLI)
  } catch (err) {
    return refused(deps, err)
  }
  if (deps.keyFile && deps.keySource === 'file') dropPreviousKey(deps.keyFile)
  deps.out(`Rotation finished: ${r.moved} value(s) moved off key ${r.previousKeyId}; ${deps.keyFile && deps.keySource === 'file' ? `${deps.keyFile}.prev deleted` : 'no key file to clean up'}. Restart core to drop the old key from memory.`)
  return 0
}

async function kitCommand(deps: AdminCliDeps, now: Date): Promise<number> {
  if (!deps.settings.setupDone) {
    deps.err('Setup is not finished; the wizard gives the recovery kit.')
    return 1
  }
  const admin = await firstAdmin(deps.db)
  if (!admin) {
    deps.err('No break-glass account exists.')
    return 1
  }
  let kit
  try {
    kit = await issueRecoveryKit(deps, {
      admin,
      publicUrl: publicUrlOf(deps.settings),
      at: now,
      audit: (tx, keyId) => deps.settings.audit({ action: 'break_glass.recovery_kit', actor: CLI, newValue: { keyId, username: admin.username }, result: 'ok' }, tx),
    })
  } catch (err) {
    if (!(err instanceof MasterKeyUnavailable)) throw err
    deps.err(refusal.key_unavailable)
    return 1
  }
  deps.out(kit.text.trimEnd())
  deps.err('New recovery kit above (stdout): the old recovery codes no longer work. Store it offline now.')
  await notifyCli(deps, 'สร้างชุดกู้คืน (recovery kit) ใหม่จากเครื่องที่ติดตั้ง', 'break_glass.recovery_kit', now, admin.username)
  return 0
}

async function resetKeyCommand(deps: AdminCliDeps, yes: boolean): Promise<number> {
  const loaded = deps.masterKey
  if (!loaded || loaded.status !== 'ok') {
    deps.err('No valid master key is loaded (see yoda-admin status); restart core so init generates one, or set YODA_MASTER_KEY.')
    return 1
  }
  if (!yes) {
    deps.err('This drops every stored secret the lost key encrypted (they are entered again in System settings), the')
    deps.err('break-glass TOTP and recovery codes. Requests, chats and files are not touched. Run again with --yes.')
    deps.err('If you still have the recovery kit, put its key back instead (docs/operations.md, section 4a).')
    return 1
  }
  let r
  try {
    r = await resetLostMasterKey(deps, { key: loaded.key, actor: CLI })
  } catch (err) {
    return refused(deps, err)
  }
  await deps.settings.broadcast().catch(() => {})
  deps.out(`Master key reset: key ${r.keyId} is now the master key. Dropped ${r.dropped.length} secret(s); enter them again in System settings:`)
  for (const k of r.dropped) deps.out(`  ${k}`)
  deps.out(`Break-glass TOTP removed (${r.totpRemoved}); recovery codes removed. Sign in at /recovery: a new password and TOTP are required first (new codes are shown then),`)
  deps.out('then run yoda-admin recovery-kit and store the new kit. Running core instances leave recovery on their own.')
  await notifyCli(deps, 'รีเซ็ตกุญแจหลัก (master key) หลังกุญแจเดิมสูญหาย ต้องใส่ความลับใหม่', 'master_key.reset', deps.now?.() ?? new Date())
  return 0
}
