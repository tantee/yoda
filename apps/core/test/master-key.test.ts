import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localAdmins, localRecoveryCodes, localSessions, settings, settingsAudit, setupState } from '../src/db/schema.js'
import { createAdmin, findAdmin, signIn, UnknownUserGuard } from '../src/local/break-glass.js'
import { newTotpSecret, totpCodeAt } from '../src/local/totp.js'
import { encodeMasterKey, encryptSecret, loadMasterKey, masterKey, type MasterKey, type MasterKeyLoad } from '../src/settings/crypto.js'
import { SettingsStore, type SettingActor } from '../src/settings/store.js'
import { runAdmin } from '../src/yoda-admin.js'
import { resetDb, testConfig, testDb } from './helpers.js'

// `yoda-admin rotate-master-key`, `--finish`, `recovery-kit`, `reset-master-key` and `recovery on|off` against the
// test database (installer proposal §3.5, §7.4). Obviously fake keys (repeated bytes) and placeholder values only.

const OLD = masterKey(Buffer.alloc(32, 0x31))
const NEW = masterKey(Buffer.alloc(32, 0x32))
const STRANGER = masterKey(Buffer.alloc(32, 0x33))
const ok = (k: MasterKey): MasterKeyLoad => ({ status: 'ok', key: k })
const ADMIN: SettingActor = { personId: null, label: 'สมชาย', source: 'ui' }
const BG_LOGIN = 'river-copper-lantern-71'
const quiet = () => ({ warn: vi.fn(), info: vi.fn() })

let dir: string
let keyFile: string
let clock: Date
let channel: string

async function open(key: MasterKey | null, opts: { previousKey?: MasterKey | null; loader?: boolean; log?: ReturnType<typeof quiet> } = {}) {
  return SettingsStore.open({
    db: await testDb(),
    env: {},
    masterKey: key ? ok(key) : { status: 'missing', reason: 'not set' },
    previousKey: opts.previousKey ?? null,
    ...(opts.loader ? { keyLoader: () => loadMasterKey({ YODA_MASTER_KEY_FILE: keyFile }) } : {}),
    log: opts.log ?? quiet(),
    channel,
  })
}

async function cli(store: SettingsStore, argv: string[], over: Partial<Parameters<typeof runAdmin>[1]> = {}) {
  const out: string[] = []
  const err: string[] = []
  const code = await runAdmin(argv, {
    db: await testDb(),
    settings: store,
    // As in production: setup counts as done only from the store (the wizard, or OIDC_ISSUER in env).
    config: { ...testConfig(), devSkipSetup: false },
    tokenFile: null,
    jobs: { send: async () => {} },
    keyFile,
    keySource: 'file',
    generateKey: () => NEW,
    now: () => clock,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

let seed: string
let codes: string[]

/** A finished install under OLD: two secrets, the break-glass admin with TOTP and codes, a recovery session. */
async function install(): Promise<SettingsStore> {
  const db = await testDb()
  await db.update(setupState).set({ setupCompletedAt: sql`now()`, setupCompletedSource: 'setup' }).where(eq(setupState.id, 1))
  const store = await open(OLD)
  await store.set('smtp.password', 'placeholder-smtp-password', ADMIN)
  await store.set('ai.anthropicApiKey', 'placeholder-second-value', ADMIN)
  seed = newTotpSecret()
  const r = await createAdmin({ db, settings: store }, { username: 'admin', password: BG_LOGIN, totp: { seed, step: Math.floor(clock.getTime() / 30_000) - 10 }, now: clock })
  codes = r.codes
  await db.insert(localSessions).values({ idHash: Buffer.alloc(32, 1), kind: 'recovery', adminId: r.admin.id, expiresAt: new Date(clock.getTime() + 3_600_000) })
  writeFileSync(keyFile, `${encodeMasterKey(OLD)}\n`, { mode: 0o600 })
  return store
}

const signInWith = async (store: SettingsStore, input: { totpCode?: string; recoveryCode?: string }) =>
  signIn({ db: await testDb(), settings: store }, new UnknownUserGuard(), { username: 'admin', password: BG_LOGIN, ...input, now: clock })

beforeEach(async () => {
  await resetDb(await testDb())
  dir = mkdtempSync(join(tmpdir(), 'yoda-mk-'))
  keyFile = join(dir, 'master-key')
  clock = new Date('2026-11-27T03:00:00Z')
  channel = `settings_test_${randomUUID().slice(0, 8)}`
})

describe('yoda-admin rotate-master-key', () => {
  it('re-wraps every secret and the TOTP seed under a new key in one go, replaces the codes, and prints the new kit', async () => {
    const store = await install()
    const db = await testDb()
    const before = await db.select().from(settings).where(eq(settings.key, 'smtp.password'))
    const r = await cli(store, ['rotate-master-key'])
    expect(r.code, r.err).toBe(0)

    // Files: the new key is the key file, the old one is kept as .prev, both 0600; nothing left in .next.
    expect(readFileSync(keyFile, 'utf8').trim()).toBe(encodeMasterKey(NEW))
    expect(readFileSync(`${keyFile}.prev`, 'utf8').trim()).toBe(encodeMasterKey(OLD))
    expect((statSync(keyFile).mode & 0o777).toString(8)).toBe('600')
    expect(existsSync(`${keyFile}.next`)).toBe(false)

    // Rows: same ciphertext, new key id and wrapped data key; the version (a value change) is untouched.
    const [after] = await db.select().from(settings).where(eq(settings.key, 'smtp.password'))
    expect(after!.keyId).toBe(NEW.id)
    expect(after!.ciphertext!.equals(before[0]!.ciphertext!)).toBe(true)
    expect(after!.wrappedDek!.equals(before[0]!.wrappedDek!)).toBe(false)
    expect(after!.version).toBe(before[0]!.version)
    const [admin] = await db.select().from(localAdmins)
    expect(admin!.totpKeyId).toBe(NEW.id)
    const [st] = await db.select().from(setupState)
    expect(st!.keyCanaryKeyId).toBe(NEW.id)
    expect(await db.select().from(localSessions)).toHaveLength(0)

    // The kit on stdout has the new key and 10 new codes; the old key and codes appear nowhere.
    expect(r.out).toContain('YODA RECOVERY KIT')
    expect(r.out).toContain(encodeMasterKey(NEW))
    expect(r.out).not.toContain(encodeMasterKey(OLD))
    const kitCodes = [...r.out.matchAll(/^ +\d+\. (\S+)$/gm)].map((m) => m[1]!)
    expect(kitCodes).toHaveLength(10)
    for (const c of codes) expect(kitCodes).not.toContain(c)
    expect(r.err).toContain('fingerprint')
    expect(r.err).not.toContain(encodeMasterKey(NEW))

    // Audited with key ids and counts only.
    const [audit] = await db.select().from(settingsAudit).where(eq(settingsAudit.action, 'master_key.rotated'))
    expect(audit).toMatchObject({ source: 'cli', newValue: { oldKeyId: OLD.id, newKeyId: NEW.id, secrets: 2, totpSeeds: 1, recoveryCodesReplaced: true } })
    expect(JSON.stringify(audit)).not.toContain(encodeMasterKey(NEW))

    // A core started with the new key reads everything; the TOTP seed is the same; only the new codes work.
    const next = await open(NEW, { previousKey: OLD })
    expect(next.keyStatus).toBe('ok')
    expect(next.get('smtp.password')).toBe('placeholder-smtp-password')
    expect(next.get('ai.anthropicApiKey')).toBe('placeholder-second-value')
    expect((await signInWith(next, { totpCode: totpCodeAt(seed, clock.getTime()) })).ok).toBe(true)
    expect(await signInWith(next, { recoveryCode: codes[0] })).toMatchObject({ ok: false, code: 'invalid_code' })
    expect((await signInWith(next, { recoveryCode: kitCodes[0] })).ok).toBe(true)
    // The old key alone no longer opens anything.
    expect((await open(OLD)).keyStatus).toBe('mismatch')
  })

  it('a running core switches to the new key on the next reload (the key file), keeping the old one decrypt-only', async () => {
    const running = await install()
    // The running core was started with the key file.
    const live = await open(OLD, { loader: true })
    await cli(running, ['rotate-master-key'])
    await live.load()
    expect(live.keyId).toBe(NEW.id)
    expect(live.previousKeyId).toBe(OLD.id)
    expect(live.get('smtp.password')).toBe('placeholder-smtp-password')
    // New writes use the new key.
    await live.set('smtp.password', 'placeholder-smtp-password-2', ADMIN)
    const [row] = await (await testDb()).select().from(settings).where(eq(settings.key, 'smtp.password'))
    expect(row!.keyId).toBe(NEW.id)
  })

  it('--dry-run does every step and rolls back: nothing changes, no key file is written', async () => {
    const store = await install()
    const db = await testDb()
    const rowsBefore = await db.select().from(settings)
    const r = await cli(store, ['rotate-master-key', '--dry-run'])
    expect(r.code, r.err).toBe(0)
    expect(r.err).toContain('would re-wrap 2 secret(s) and 1 TOTP seed(s)')
    expect(r.out).toBe('')
    expect(await db.select().from(settings)).toEqual(rowsBefore)
    expect(await db.select().from(localSessions)).toHaveLength(1)
    expect((await signInWith(store, { recoveryCode: codes[0] })).ok).toBe(true)
    expect(readFileSync(keyFile, 'utf8').trim()).toBe(encodeMasterKey(OLD))
    expect(existsSync(`${keyFile}.next`)).toBe(false)
    expect(existsSync(`${keyFile}.prev`)).toBe(false)
    expect(await db.select().from(settingsAudit).where(eq(settingsAudit.action, 'master_key.rotated'))).toHaveLength(0)
  })

  it('refuses, changing nothing, when a stored secret cannot be opened (names the key, never a value)', async () => {
    const store = await install()
    const db = await testDb()
    const e = encryptSecret(STRANGER, 'line.channelSecret', 'placeholder-line-secret')
    await db.insert(settings).values({ key: 'line.channelSecret', keyId: e.keyId, wrappedDek: e.wrappedDek, dekNonce: e.dekNonce, nonce: e.nonce, ciphertext: e.ciphertext, hint: null, source: 'ui' })
    const r = await cli(store, ['rotate-master-key'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('line.channelSecret')
    expect(r.err).not.toContain('placeholder')
    expect(readFileSync(keyFile, 'utf8').trim()).toBe(encodeMasterKey(OLD))
    expect(existsSync(`${keyFile}.next`)).toBe(false)
    const [row] = await db.select().from(settings).where(eq(settings.key, 'smtp.password'))
    expect(row!.keyId).toBe(OLD.id)
  })

  it('refuses before setup is done and with a wrong key, before writing any key file', async () => {
    const store = await open(OLD)
    expect((await cli(store, ['rotate-master-key'])).err).toContain('Setup is not finished')
    expect(existsSync(`${keyFile}.next`)).toBe(false)
    await install()
    const wrong = await open(STRANGER)
    const r = await cli(wrong, ['rotate-master-key'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('not usable')
    expect(existsSync(`${keyFile}.next`)).toBe(false)
  })

  it('never overwrites a master-key.next left by an unfinished rotation', async () => {
    const store = await install()
    writeFileSync(`${keyFile}.next`, `${encodeMasterKey(STRANGER)}\n`, { mode: 0o600 })
    const r = await cli(store, ['rotate-master-key'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('master-key.next already exists')
    expect(readFileSync(`${keyFile}.next`, 'utf8').trim()).toBe(encodeMasterKey(STRANGER))
    expect(readFileSync(keyFile, 'utf8').trim()).toBe(encodeMasterKey(OLD))
    const [st] = await (await testDb()).select().from(setupState)
    expect(st!.keyCanaryKeyId).toBe(OLD.id)
  })

  it('with YODA_MASTER_KEY from env: refuses without --allow-env-key; with it, rotates, prints the kit, says to update .env', async () => {
    const store = await install()
    const no = await cli(store, ['rotate-master-key'], { keySource: 'env' })
    expect(no.code).toBe(1)
    expect(no.err).toContain('--allow-env-key')
    expect(no.out).toBe('')
    const r = await cli(store, ['rotate-master-key', '--allow-env-key'], { keySource: 'env' })
    expect(r.code, r.err).toBe(0)
    expect(r.out).toContain(encodeMasterKey(NEW))
    expect(r.err).toContain('put the new key in .env')
    expect(readFileSync(keyFile, 'utf8').trim()).toBe(encodeMasterKey(OLD))
  })

  it('a core whose key file still has the old key but whose .prev has the new one (init with a stale .env) uses the new one', async () => {
    const store = await install()
    await cli(store, ['rotate-master-key'])
    const log = quiet()
    const stale = await open(OLD, { previousKey: NEW, log })
    expect(stale.keyStatus).toBe('ok')
    expect(stale.keyId).toBe(NEW.id)
    expect(stale.get('smtp.password')).toBe('placeholder-smtp-password')
    expect(log.warn.mock.calls.map((c) => c[1]).join('\n')).toContain('the previous key does')
    expect(stale.runsOnPreviousKey).toBe(true)
    // status says to fix the key file, not to run --finish (which refuses here).
    const st = (await cli(stale, ['status'])).out
    expect(st).toContain('key file: holds')
    expect(st).not.toContain('--finish')
    // .prev holds the only working key: neither --finish nor another rotation may touch it.
    writeFileSync(`${keyFile}.prev`, `${encodeMasterKey(NEW)}\n`, { mode: 0o600 })
    const fin = await cli(stale, ['rotate-master-key', '--finish'])
    expect(fin.code).toBe(1)
    expect(fin.err).toContain('Core runs on the previous key')
    expect(existsSync(`${keyFile}.prev`)).toBe(true)
    expect((await cli(stale, ['rotate-master-key'])).err).toContain('Core runs on the previous key')
    expect(existsSync(`${keyFile}.next`)).toBe(false)
  })

  it('--finish moves what a core wrote with the old key meanwhile, then deletes master-key.prev', async () => {
    const store = await install()
    // A core that has not switched yet (no key loader) writes with the old key after the rotation.
    const lagging = await open(OLD)
    await cli(store, ['rotate-master-key'])
    // Its write path still holds OLD (it booted before the canary changed): simulate it writing directly.
    const e = encryptSecret(OLD, 'smtp.password', 'placeholder-written-late')
    await (await testDb()).update(settings).set({ keyId: e.keyId, wrappedDek: e.wrappedDek, dekNonce: e.dekNonce, nonce: e.nonce, ciphertext: e.ciphertext }).where(eq(settings.key, 'smtp.password'))
    expect(lagging.keyId).toBe(OLD.id)
    const next = await open(NEW, { previousKey: OLD })
    expect(next.get('smtp.password')).toBe('placeholder-written-late')
    const r = await cli(next, ['rotate-master-key', '--finish'])
    expect(r.code, r.err).toBe(0)
    expect(r.out).toContain('1 value(s) moved')
    expect(existsSync(`${keyFile}.prev`)).toBe(false)
    expect((await open(NEW)).get('smtp.password')).toBe('placeholder-written-late')
    expect((await cli(await open(NEW), ['rotate-master-key', '--finish'])).err).toContain('no previous master key')
  })
})

describe('yoda-admin recovery-kit', () => {
  it('prints the current key and new codes (the old ones stop working); audited without the key', async () => {
    const store = await install()
    const r = await cli(store, ['recovery-kit'])
    expect(r.code, r.err).toBe(0)
    expect(r.out).toContain(encodeMasterKey(OLD))
    const kitCodes = [...r.out.matchAll(/^ +\d+\. (\S+)$/gm)].map((m) => m[1]!)
    expect(kitCodes).toHaveLength(10)
    expect((await signInWith(store, { recoveryCode: codes[0] })).ok).toBe(false)
    expect((await signInWith(store, { recoveryCode: kitCodes[0] })).ok).toBe(true)
    const [audit] = await (await testDb()).select().from(settingsAudit).where(eq(settingsAudit.action, 'break_glass.recovery_kit'))
    expect(audit).toMatchObject({ source: 'cli', newValue: { keyId: OLD.id, username: 'admin' } })
    // The codes and the audit row commit together: a failing audit leaves the old codes.
    const fresh = await cli(store, ['recovery-kit'])
    const before = await (await testDb()).select().from(localRecoveryCodes)
    vi.spyOn(store, 'audit').mockRejectedValueOnce(new Error('audit down'))
    await expect(cli(store, ['recovery-kit'])).rejects.toThrow('audit down')
    expect((await (await testDb()).select().from(localRecoveryCodes)).map((c) => c.id).sort()).toEqual(before.map((c) => c.id).sort())
    expect(fresh.code).toBe(0)
    expect(JSON.stringify(audit)).not.toContain(encodeMasterKey(OLD))
  })
})

describe('yoda-admin create-break-glass (an env-based install, I1)', () => {
  /** Set up from env: OIDC_ISSUER in env, the wizard never ran (setup_state not completed). */
  const envInstall = async () => {
    const store = await SettingsStore.open({ db: await testDb(), env: { OIDC_ISSUER: 'https://sso.example.org/realms/hospital' }, masterKey: ok(OLD), log: quiet(), channel })
    expect(store.setupDone).toBe(false)
    return store
  }

  it('creates the account with a temporary password; then the kit and rotation work there', async () => {
    const store = await envInstall()
    // Before: no account, so no kit (the gate is setupState, not the wizard's marker).
    const none = await cli(store, ['recovery-kit'])
    expect(none.code).toBe(1)
    expect(none.err).toContain('yoda-admin create-break-glass')

    const r = await cli(store, ['create-break-glass'])
    expect(r.code, r.err).toBe(0)
    const password = /^ {2}(\S+)$/m.exec(r.out)![1]!
    expect(r.out).toContain('Break-glass account admin created')
    expect(r.out).toContain('recovery-kit')
    const admin = (await findAdmin(await testDb(), 'admin'))!
    expect(admin).toMatchObject({ mustChangePassword: true, totpEnabled: false })
    expect(JSON.stringify(admin)).not.toContain(password)
    const [audit] = await (await testDb()).select().from(settingsAudit).where(eq(settingsAudit.action, 'break_glass.created'))
    expect(audit).toMatchObject({ source: 'cli', newValue: { username: 'admin' } })
    expect(JSON.stringify(audit)).not.toContain(password)
    // The temporary password signs in to /recovery, restricted to the password change and TOTP enrolment.
    const signed = await signIn({ db: await testDb(), settings: store }, new UnknownUserGuard(), { username: 'admin', password, now: clock })
    expect(signed).toMatchObject({ ok: true })

    // Only one.
    const again = await cli(store, ['create-break-glass', '--username', 'other'])
    expect(again.code).toBe(1)
    expect(again.err).toContain('already exists (admin)')

    const kit = await cli(store, ['recovery-kit'])
    expect(kit.code, kit.err).toBe(0)
    expect(kit.out).toContain(encodeMasterKey(OLD))
    const dry = await cli(store, ['rotate-master-key', '--dry-run'])
    expect(dry.code, dry.err).toBe(0)
  })

  it('refuses before setup is done, a bad username, and an unusable key', async () => {
    const pending = await open(OLD)
    expect((await cli(pending, ['create-break-glass'])).err).toContain('the setup wizard creates the break-glass account')
    const store = await envInstall()
    expect((await cli(store, ['create-break-glass', '--username', 'A B'])).err).toContain('Invalid username')
    const keyless = await SettingsStore.open({ db: await testDb(), env: { OIDC_ISSUER: 'https://sso.example.org/realms/hospital' }, masterKey: { status: 'missing', reason: 'not set' }, log: quiet(), channel })
    expect((await cli(keyless, ['create-break-glass'])).code).toBe(1)
    expect(await findAdmin(await testDb(), 'admin')).toBeUndefined()
  })
})

describe('yoda-admin reset-master-key (the key is lost)', () => {
  it('needs --yes; then keeps the loaded key, drops what it cannot open, and a running core leaves recovery', async () => {
    await install()
    const db = await testDb()
    // The bootstrap volume was lost: init generated another key.
    const running = await open(STRANGER)
    expect(running.keyStatus).toBe('mismatch')
    expect(running.recovery).toBe(true)
    const no = await cli(running, ['reset-master-key'], { masterKey: ok(STRANGER) })
    expect(no.code).toBe(1)
    expect(no.err).toContain('--yes')
    expect(await db.select().from(settings).where(eq(settings.key, 'smtp.password'))).toHaveLength(1)

    const r = await cli(running, ['reset-master-key', '--yes'], { masterKey: ok(STRANGER) })
    expect(r.code, r.err).toBe(0)
    expect(r.out).toContain('ai.anthropicApiKey')
    expect(r.out).toContain('smtp.password')
    expect(await db.select().from(settings).where(eq(settings.key, 'smtp.password'))).toHaveLength(0)
    const admin = (await findAdmin(db, 'admin'))!
    expect(admin).toMatchObject({ totpEnabled: false, totpSecret: null, mustChangePassword: true })
    expect(await db.select().from(localRecoveryCodes)).toHaveLength(0)
    const [audit] = await db.select().from(settingsAudit).where(eq(settingsAudit.action, 'master_key.reset'))
    expect(audit).toMatchObject({ source: 'cli', newValue: { keyId: STRANGER.id, dropped: ['ai.anthropicApiKey', 'smtp.password'], totpRemoved: 1 } })

    // The running core: its key now opens the canary.
    await running.load()
    expect(running.keyStatus).toBe('ok')
    expect(running.recovery).toBe(false)
    await running.set('smtp.password', 'placeholder-entered-again', ADMIN)
    expect((await open(STRANGER)).get('smtp.password')).toBe('placeholder-entered-again')
    // Not again: the key is not the wrong one any more.
    expect((await cli(running, ['reset-master-key', '--yes'], { masterKey: ok(STRANGER) })).code).toBe(1)
  })

  it('refuses with the right key', async () => {
    const store = await install()
    const r = await cli(store, ['reset-master-key', '--yes'], { masterKey: ok(OLD) })
    expect(r.code).toBe(1)
    expect(r.err).toContain('nothing to reset')
  })
})

describe('yoda-admin recovery on|off', () => {
  it('forces recovery mode, audited, and every instance sees it on the next reload', async () => {
    const store = await install()
    const other = await open(OLD)
    const r = await cli(store, ['recovery', 'on'])
    expect(r.code).toBe(0)
    expect(store.recoveryForced).toBe(true)
    expect(store.recovery).toBe(true)
    await other.load()
    expect(other.recoveryForced).toBe(true)
    expect((await cli(store, ['status'])).out).toContain('recovery mode: forced on')
    expect((await cli(store, ['recovery', 'on'])).out).toContain('already on')
    await cli(store, ['recovery', 'off'])
    expect(store.recoveryForced).toBe(false)
    const actions = (await (await testDb()).select().from(settingsAudit)).map((a) => a.action)
    expect(actions.filter((a) => a.startsWith('recovery.mode_'))).toEqual(['recovery.mode_on', 'recovery.mode_off'])
    expect((await cli(store, ['recovery', 'maybe'])).code).toBe(1)
  })
})
