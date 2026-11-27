import { isLocalhostHost, type BreakGlassView } from '@yoda/shared'
import { and, count, eq, isNull, or, lt, sql } from 'drizzle-orm'
import type { AppDeps } from '../app.js'
import type { Db, Tx } from '../db/client.js'
import { localAdmins, localRecoveryCodes, people } from '../db/schema.js'
import { notify } from '../notifications/service.js'
import type { SettingsStore } from '../settings/store.js'
import { runWork, type WorkDeps } from '../work/context.js'
import { newRecoveryCode, recoveryCodeHash } from './codes.js'
import { hashPassword, verifyPassword } from './password.js'
import { verifyTotp } from './totp.js'

/**
 * The break-glass admin (installer proposal §7.2, §7.4; R1, R2, D3): a local account for /setup and /recovery
 * only. Password (argon2id) plus TOTP, or a single-use recovery code instead of the TOTP code. Five failed
 * sign-ins lock the account with exponential backoff (1 min doubling up to 1 h); an unknown username gets the same
 * answer, timing and backoff, so a sign-in never tells whether the account exists.
 */

export type AdminRow = typeof localAdmins.$inferSelect

export const RECOVERY_CODE_COUNT = 10
export const FAILURES_BEFORE_LOCK = 5
const MAX_LOCK_MS = 3_600_000

/** 0 below five failures, then 1 min, 2 min, 4 min, ... at most 1 h. */
export function lockoutMs(failures: number): number {
  if (failures < FAILURES_BEFORE_LOCK) return 0
  return Math.min(MAX_LOCK_MS, 60_000 * 2 ** (failures - FAILURES_BEFORE_LOCK))
}

/** localhost, `*.localhost`, 127.0.0.0/8 or ::1 (shared with the portal and the D8 public-URL rule). */
export { isLocalhostHost }

/** The URL's host is localhost (D3); a missing or unparseable URL is not. */
export function isLocalhostUrl(url: string | undefined | null): boolean {
  if (!url) return false
  try {
    return isLocalhostHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * D3, failing closed: TOTP is optional only when the public URL is set (not the registry default) to localhost AND
 * the request itself came to a localhost host name (`request.hostname`, from X-Forwarded-Host through the portal).
 * Without a request (the CLI), it is required.
 */
export function totpRequired(settings: SettingsStore, requestHost: string | null): boolean {
  const info = settings.info('org.publicUrl')
  const url = info.source === 'env' || info.source === 'db' ? (info.value as string | undefined) : undefined
  return !(isLocalhostUrl(url) && isLocalhostHost(requestHost))
}

export const totpAad = (adminId: string) => `local_admin.totp:${adminId}`
export const PENDING_TOTP_AAD = 'local_session.totp'

/** The admin's TOTP seed, or null (not enrolled, or the master key cannot open it). */
export function totpSeed(settings: SettingsStore, admin: AdminRow): string | null {
  if (!admin.totpEnabled || !admin.totpSecret || !admin.totpKeyId) return null
  return settings.open(totpAad(admin.id), admin.totpSecret, admin.totpKeyId)
}

export async function findAdmin(db: Db, username: string): Promise<AdminRow | undefined> {
  const [row] = await db.select().from(localAdmins).where(eq(localAdmins.username, username.trim().toLowerCase()))
  return row
}

export async function adminById(db: Db, id: string): Promise<AdminRow | undefined> {
  const [row] = await db.select().from(localAdmins).where(eq(localAdmins.id, id))
  return row
}

export async function firstAdmin(db: Db): Promise<AdminRow | undefined> {
  const [row] = await db.select().from(localAdmins).orderBy(localAdmins.createdAt).limit(1)
  return row
}

export async function codesLeft(db: Db, adminId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(localRecoveryCodes)
    .where(and(eq(localRecoveryCodes.adminId, adminId), isNull(localRecoveryCodes.usedAt)))
  return r?.n ?? 0
}

export async function adminView(db: Db, settings: SettingsStore, admin: AdminRow, requestHost: string | null): Promise<BreakGlassView> {
  return {
    username: admin.username,
    totpEnabled: admin.totpEnabled,
    mustChangePassword: admin.mustChangePassword,
    mustEnrolTotp: !admin.totpEnabled && totpRequired(settings, requestHost),
    recoveryCodesLeft: await codesLeft(db, admin.id),
  }
}

/** Replaces every recovery code of the admin with 10 new ones (in the caller's transaction); returns them once. */
export async function replaceRecoveryCodes(q: Db | Tx, settings: SettingsStore, adminId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => newRecoveryCode())
  const hashes = settings.withKey((mk) => codes.map((c) => recoveryCodeHash(mk, c)))
  if (!hashes) throw new MasterKeyUnavailable()
  await q.delete(localRecoveryCodes).where(eq(localRecoveryCodes.adminId, adminId))
  await q.insert(localRecoveryCodes).values(hashes.map((codeHash) => ({ adminId, codeHash })))
  return codes
}

/** The master key is missing or wrong: no TOTP seed or recovery code can be sealed or checked. */
export class MasterKeyUnavailable extends Error {
  constructor() {
    super('master key unavailable')
    this.name = 'MasterKeyUnavailable'
  }
}

/**
 * Creates the break-glass admin during setup, replacing an earlier one (setup is not done, and whoever holds the
 * setup token may redo the step). `totp` is a seed whose current code was already checked, with its step.
 */
export async function createAdmin(
  deps: Pick<AppDeps, 'db'> & { settings: SettingsStore },
  input: { username: string; password: string; totp: { seed: string; step: number } | null; now: Date },
  /** Runs first in the same transaction (the setup route locks `setup_state` and refuses after the kit, 8.1). */
  guard?: (tx: Tx) => Promise<void>,
): Promise<{ admin: AdminRow; codes: string[] }> {
  const passwordHash = await hashPassword(input.password)
  return deps.db.transaction(async (tx) => {
    if (guard) await guard(tx)
    await tx.delete(localAdmins)
    const [admin] = await tx
      .insert(localAdmins)
      .values({ username: input.username, passwordHash, createdAt: input.now, passwordChangedAt: input.now })
      .returning()
    let row = admin!
    if (input.totp) {
      const sealed = deps.settings.seal(totpAad(row.id), input.totp.seed)
      if (!sealed) throw new MasterKeyUnavailable()
      const [updated] = await tx
        .update(localAdmins)
        .set({ totpSecret: sealed.blob, totpKeyId: sealed.keyId, totpEnabled: true, totpLastStep: input.totp.step })
        .where(eq(localAdmins.id, row.id))
        .returning()
      row = updated!
    }
    const codes = await replaceRecoveryCodes(tx, deps.settings, row.id)
    return { admin: row, codes }
  })
}

/**
 * Accepts a TOTP code of the admin's seed once: the step is stored with a conditional update, so the same code
 * (or an older one) cannot be used again, even by two racing requests.
 */
export async function useTotp(db: Db, settings: SettingsStore, admin: AdminRow, code: string, now: Date): Promise<'ok' | 'invalid' | 'unavailable'> {
  const seed = totpSeed(settings, admin)
  if (!seed) return 'unavailable'
  const step = verifyTotp(seed, code, { now: now.getTime(), after: admin.totpLastStep })
  if (step === null) return 'invalid'
  const rows = await db
    .update(localAdmins)
    .set({ totpLastStep: step })
    .where(and(eq(localAdmins.id, admin.id), or(isNull(localAdmins.totpLastStep), lt(localAdmins.totpLastStep, step))))
    .returning({ id: localAdmins.id })
  return rows.length ? 'ok' : 'invalid'
}

/** Uses up one recovery code of the admin (looked up by its HMAC; a used code never counts again). */
export async function useRecoveryCode(db: Db, settings: SettingsStore, adminId: string, code: string, now: Date): Promise<'ok' | 'invalid' | 'unavailable'> {
  const hash = settings.withKey((mk) => recoveryCodeHash(mk, code))
  if (!hash) return 'unavailable'
  const rows = await db
    .update(localRecoveryCodes)
    .set({ usedAt: now })
    .where(and(eq(localRecoveryCodes.adminId, adminId), eq(localRecoveryCodes.codeHash, hash), isNull(localRecoveryCodes.usedAt)))
    .returning({ id: localRecoveryCodes.id })
  return rows.length ? 'ok' : 'invalid'
}

/** Resets the failure count after a successful second-factor check. */
export async function clearFailures(db: Db, adminId: string): Promise<void> {
  await db.update(localAdmins).set({ failedAttempts: 0, lockedUntil: null }).where(eq(localAdmins.id, adminId))
}

/** Checks the current second factor (TOTP code or recovery code) of an admin with TOTP enrolled. */
export async function checkSecondFactor(
  db: Db,
  settings: SettingsStore,
  admin: AdminRow,
  input: { totpCode?: string; recoveryCode?: string },
  now: Date,
): Promise<'ok' | 'missing' | 'invalid' | 'unavailable'> {
  if (!admin.totpEnabled) return 'ok'
  if (input.totpCode) return useTotp(db, settings, admin, input.totpCode, now)
  if (input.recoveryCode) return useRecoveryCode(db, settings, admin.id, input.recoveryCode, now)
  return 'missing'
}

export type SignInResult =
  /**
   * `password_keyless`: TOTP is enrolled but the master key cannot open it (wrong or missing key): the password
   * alone opens a status-only session (7.4), so the state can be seen and the fix is made on the host.
   */
  | { ok: true; admin: AdminRow; factor: 'totp' | 'recovery_code' | 'password' | 'password_keyless' }
  | {
      ok: false
      code: 'invalid_credentials' | 'locked' | 'second_factor_required' | 'invalid_code' | 'unavailable'
      retryAfter?: number
      /** This failure locked the (existing) account: the admins are told. */
      lockedNow?: AdminRow
    }

/**
 * Failed attempts of usernames that do not exist, in memory (one core process), so an unknown name locks out
 * like a real one and the answer never tells them apart.
 */
export class UnknownUserGuard {
  private failures = new Map<string, { n: number; lockedUntil: number }>()

  lockedFor(username: string, now: number): number {
    const f = this.failures.get(username)
    return f && f.lockedUntil > now ? f.lockedUntil - now : 0
  }

  fail(username: string, now: number): void {
    const n = (this.failures.get(username)?.n ?? 0) + 1
    this.failures.set(username, { n, lockedUntil: now + lockoutMs(n) })
    if (this.failures.size > 1000) for (const [k, v] of this.failures) if (v.lockedUntil < now) this.failures.delete(k)
  }
}

/** Counts a failed password or second-factor check; true when it (re)locks the account (five or more). */
export async function recordFailure(db: Db, admin: Pick<AdminRow, 'id'>, now: Date): Promise<boolean> {
  // One statement, so concurrent failures all count.
  const [row] = await db
    .update(localAdmins)
    .set({
      failedAttempts: sql`${localAdmins.failedAttempts} + 1`,
      lockedUntil: sql`case when ${localAdmins.failedAttempts} + 1 >= ${FAILURES_BEFORE_LOCK}
        then ${now.toISOString()}::timestamptz + make_interval(secs => least(${MAX_LOCK_MS / 1000}, 60 * power(2, ${localAdmins.failedAttempts} + 1 - ${FAILURES_BEFORE_LOCK})))
        else ${localAdmins.lockedUntil} end`,
    })
    .where(eq(localAdmins.id, admin.id))
    .returning({ failedAttempts: localAdmins.failedAttempts })
  return (row?.failedAttempts ?? 0) >= FAILURES_BEFORE_LOCK
}

/** Milliseconds the account stays locked, 0 when it is not. */
export function lockedForMs(admin: Pick<AdminRow, 'lockedUntil'>, now: Date): number {
  return admin.lockedUntil ? Math.max(0, admin.lockedUntil.getTime() - now.getTime()) : 0
}

/** Password, then the second factor when TOTP is enrolled. A locked account is refused before any check. */
export async function signIn(
  deps: Pick<AppDeps, 'db'> & { settings: SettingsStore },
  guard: UnknownUserGuard,
  input: { username: string; password: string; totpCode?: string; recoveryCode?: string; now: Date },
): Promise<SignInResult> {
  const { db, settings } = deps
  const username = input.username.trim().toLowerCase()
  const now = input.now
  const admin = await findAdmin(db, username)
  const lockedMs = admin ? lockedForMs(admin, now) : guard.lockedFor(username, now.getTime())
  if (lockedMs > 0) return { ok: false, code: 'locked', retryAfter: Math.ceil(lockedMs / 1000) }
  const passwordOk = await verifyPassword(admin?.passwordHash ?? null, input.password)
  if (!admin || !passwordOk) {
    if (admin && (await recordFailure(db, admin, now))) return { ok: false, code: 'invalid_credentials', lockedNow: admin }
    if (!admin) guard.fail(username, now.getTime())
    return { ok: false, code: 'invalid_credentials' }
  }
  let factor: 'totp' | 'recovery_code' | 'password' | 'password_keyless' = 'password'
  if (admin.totpEnabled && settings.secretsUnavailable) {
    // No second factor can be checked without the master key. The session this opens is status-only (the routes
    // refuse everything else while the key is unusable), and every portal admin is told of the sign-in.
    factor = 'password_keyless'
  } else if (admin.totpEnabled) {
    const r = await checkSecondFactor(db, settings, admin, input, now)
    if (r === 'missing') return { ok: false, code: 'second_factor_required' }
    if (r === 'unavailable') return { ok: false, code: 'unavailable' }
    if (r === 'invalid') {
      const lockedNow = await recordFailure(db, admin, now)
      return { ok: false, code: 'invalid_code', ...(lockedNow ? { lockedNow: admin } : {}) }
    }
    factor = input.totpCode ? 'totp' : 'recovery_code'
  }
  const [row] = await db
    .update(localAdmins)
    .set({ failedAttempts: 0, lockedUntil: null, lastUsedAt: now })
    .where(eq(localAdmins.id, admin.id))
    .returning()
  return { ok: true, admin: row!, factor }
}

export async function changePassword(db: Db, adminId: string, password: string, now: Date): Promise<void> {
  const passwordHash = await hashPassword(password)
  await db.update(localAdmins).set({ passwordHash, mustChangePassword: false, passwordChangedAt: now }).where(eq(localAdmins.id, adminId))
}

/** Enrols a new seed whose code was checked (step accepted). */
export async function setTotp(db: Db, settings: SettingsStore, adminId: string, seed: string, step: number): Promise<void> {
  const sealed = settings.seal(totpAad(adminId), seed)
  if (!sealed) throw new MasterKeyUnavailable()
  await db
    .update(localAdmins)
    .set({ totpSecret: sealed.blob, totpKeyId: sealed.keyId, totpEnabled: true, totpLastStep: step })
    .where(eq(localAdmins.id, adminId))
}

/**
 * `yoda-admin create-break-glass` (an env-based install, which never ran the wizard): the account with a temporary
 * password that must be changed at the first /recovery sign-in, where TOTP is enrolled and the recovery codes are
 * given. Refuses (null) when a break-glass account exists, in the same transaction that inserts it.
 */
export async function createBreakGlass(db: Db, username: string, now: Date): Promise<{ admin: AdminRow; password: string } | null> {
  const password = newRecoveryCode() + '-' + newRecoveryCode()
  const passwordHash = await hashPassword(password)
  return db.transaction(async (tx) => {
    // One at a time (the setup wizard's admin step takes the same lock).
    await tx.execute(sql`SELECT 1 FROM setup_state WHERE id = 1 FOR UPDATE`)
    const [existing] = await tx.select({ id: localAdmins.id }).from(localAdmins).limit(1)
    if (existing) return null
    const [admin] = await tx
      .insert(localAdmins)
      .values({ username, passwordHash, mustChangePassword: true, createdAt: now, passwordChangedAt: now })
      .returning()
    return { admin: admin!, password }
  })
}

/**
 * `yoda-admin reset-break-glass` (§7.4; host access is the root of trust): a new temporary password that must be
 * changed at the next sign-in, TOTP removed (enrolled again after sign-in), failures and lockout cleared. The
 * caller ends the admin's sessions, audits and notifies.
 */
export async function resetAdmin(db: Db, admin: AdminRow, now: Date): Promise<string> {
  const password = newRecoveryCode() + '-' + newRecoveryCode()
  const passwordHash = await hashPassword(password)
  await db
    .update(localAdmins)
    .set({
      passwordHash,
      mustChangePassword: true,
      totpSecret: null,
      totpKeyId: null,
      totpEnabled: false,
      totpLastStep: null,
      failedAttempts: 0,
      lockedUntil: null,
      passwordChangedAt: now,
    })
    .where(eq(localAdmins.id, admin.id))
  // The old codes may be what was lost or leaked; new ones come when the reset is finished at /recovery.
  await db.delete(localRecoveryCodes).where(eq(localRecoveryCodes.adminId, admin.id))
  return password
}


const BANGKOK = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' })

/**
 * Tells every portal admin that the break-glass account was used (§7.2): a `security_alert` notification in the
 * feed (and email when they have it). `what` is a short Thai phrase; nothing secret goes in.
 */
export async function notifyAdmins(
  deps: WorkDeps,
  e: { what: string; username: string; ip: string | null; at: Date; key: string },
): Promise<void> {
  await runWork(deps, { id: null, kind: 'system' }, async (ctx) => {
    const admins = await ctx.tx.select({ id: people.id }).from(people).where(eq(people.isAdmin, true))
    for (const { id } of admins) {
      await notify(ctx, {
        personId: id,
        kind: 'security_alert',
        title: `บัญชีฉุกเฉิน (break-glass) ${e.username}: ${e.what}`,
        body: `จาก ${e.ip ?? 'ไม่ทราบที่อยู่'} เมื่อ ${BANGKOK.format(e.at)} หากไม่ใช่คุณหรือทีมของคุณ ให้ตรวจสอบบันทึกการตั้งค่าทันที`,
        link: '/admin/settings/security',
        dedupeKey: `break-glass:${e.key}`,
      })
    }
  })
}
