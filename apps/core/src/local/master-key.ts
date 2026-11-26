import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { and, eq, isNotNull, ne } from 'drizzle-orm'
import type { Db, Tx } from '../db/client.js'
import { localAdmins, localRecoveryCodes, localSessions, settings, setupState } from '../db/schema.js'
import { checkCanary, encodeMasterKey, makeCanary, rewrapBlob, rewrapEnvelope, SecretDecryptError, type MasterKey } from '../settings/crypto.js'
import type { SettingsStore } from '../settings/store.js'
import { MasterKeyUnavailable, RECOVERY_CODE_COUNT, totpAad, type AdminRow } from './break-glass.js'
import { newRecoveryCode, recoveryCodeHash } from './codes.js'
import { recoveryKitText } from './setup-progress.js'

/**
 * Master key rotation and the lost-key reset (installer proposal §3.5, §7.4), for `yoda-admin`. Host access is the
 * root of trust: these run in the core container, never from an HTTP route.
 *
 * Rotation, in one transaction under the `setup_state` row lock: every settings data key is unwrapped with the
 * current key (or the previous one, a rotation not finished) and wrapped again under the new key (the ciphertext
 * stays); every break-glass TOTP seed likewise; the recovery codes are replaced (they are HMACs keyed by the master
 * key, so they cannot be carried over: the new kit has the new codes); the setup and recovery sessions end (their
 * pending TOTP seeds are sealed with the old key); the canary is written with the new key; `master_key.rotated`
 * is audited (key ids and counts only). Anything the current keys cannot open stops the rotation, so nothing is
 * carried over unreadable. Audit fingerprints are keyed by the master key too: after a rotation the same value has
 * another fingerprint, so old and new audit rows cannot be compared.
 */

export type ActorLike = { personId?: string | null; label: string; source: string; ip?: string | null; requestId?: string | null }

export class RotationRefused extends Error {
  constructor(
    readonly code: 'key_unavailable' | 'setup_required' | 'key_changed' | 'unreadable' | 'no_previous' | 'not_mismatch',
    /** Setting keys or `local_admin:<username>` that could not be opened (never a value). */
    readonly items: string[] = [],
  ) {
    super(`master key rotation refused: ${code}${items.length ? ` (${items.join(', ')})` : ''}`)
    this.name = 'RotationRefused'
  }
}

export type RotationResult = {
  oldKeyId: string
  newKeyId: string
  secrets: number
  totpSeeds: number
  sessionsEnded: number
  /** The break-glass admin and its new recovery codes (the kit); null without an admin. */
  admin: { username: string; codes: string[] } | null
  dryRun: boolean
}

/** Rolls the dry run back after doing every step. */
class DryRun extends Error {
  constructor(readonly result: RotationResult) {
    super('dry run')
  }
}

async function newCodes(tx: Tx, mk: MasterKey, adminId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => newRecoveryCode())
  await tx.delete(localRecoveryCodes).where(eq(localRecoveryCodes.adminId, adminId))
  await tx.insert(localRecoveryCodes).values(codes.map((c) => ({ adminId, codeHash: recoveryCodeHash(mk, c) })))
  return codes
}

/** Re-wraps everything under `to` (see the module comment). `dryRun` does every step, then rolls back. */
export async function rotateMasterKey(
  deps: { db: Db; settings: SettingsStore },
  opts: { to: MasterKey; dryRun?: boolean; actor: ActorLike },
): Promise<RotationResult> {
  const store = deps.settings
  const keys = store.withKeyring((current, all) => ({ current, all }))
  if (!keys) throw new RotationRefused('key_unavailable')
  if (!store.setupDone) throw new RotationRefused('setup_required')
  const { current, all } = keys
  const to = opts.to
  try {
    return await deps.db.transaction(async (tx) => {
      const [st] = await tx.select().from(setupState).where(eq(setupState.id, 1)).for('update')
      // Another rotation (or a reset) since this process loaded its key.
      if (!st?.keyCanary || !checkCanary(current, st.keyCanary)) throw new RotationRefused('key_changed')
      const unreadable: string[] = []

      const rows = await tx.select().from(settings).where(isNotNull(settings.ciphertext)).for('update')
      const rewrapped: { key: string; keyId: string; wrappedDek: Buffer; dekNonce: Buffer }[] = []
      for (const r of rows) {
        try {
          const e = rewrapEnvelope(all, to, r.key, { keyId: r.keyId ?? '', wrappedDek: r.wrappedDek!, dekNonce: r.dekNonce!, nonce: r.nonce!, ciphertext: r.ciphertext! })
          rewrapped.push({ key: r.key, keyId: e.keyId, wrappedDek: e.wrappedDek, dekNonce: e.dekNonce })
        } catch (err) {
          if (!(err instanceof SecretDecryptError) && !(err instanceof TypeError)) throw err
          unreadable.push(r.key)
        }
      }

      const admins = await tx.select().from(localAdmins).orderBy(localAdmins.createdAt).for('update')
      const seeds: { id: string; blob: Buffer; keyId: string }[] = []
      for (const a of admins) {
        if (!a.totpSecret || !a.totpKeyId) continue
        try {
          seeds.push({ id: a.id, ...rewrapBlob(all, to, totpAad(a.id), a.totpSecret, a.totpKeyId) })
        } catch (err) {
          if (!(err instanceof SecretDecryptError)) throw err
          unreadable.push(`local_admin:${a.username}`)
        }
      }
      if (unreadable.length) throw new RotationRefused('unreadable', unreadable)

      for (const r of rewrapped) {
        await tx.update(settings).set({ keyId: r.keyId, wrappedDek: r.wrappedDek, dekNonce: r.dekNonce }).where(eq(settings.key, r.key))
      }
      for (const s of seeds) await tx.update(localAdmins).set({ totpSecret: s.blob, totpKeyId: s.keyId }).where(eq(localAdmins.id, s.id))
      const first: AdminRow | undefined = admins[0]
      let admin: RotationResult['admin'] = null
      for (const a of admins) {
        const codes = await newCodes(tx, to, a.id)
        if (a === first) admin = { username: a.username, codes }
      }
      const ended = await tx.delete(localSessions).returning({ id: localSessions.idHash })
      const canary = makeCanary(to)
      await tx.update(setupState).set({ keyCanary: canary.blob, keyCanaryKeyId: canary.keyId }).where(eq(setupState.id, 1))
      const result: RotationResult = {
        oldKeyId: current.id,
        newKeyId: to.id,
        secrets: rewrapped.length,
        totpSeeds: seeds.length,
        sessionsEnded: ended.length,
        admin,
        dryRun: !!opts.dryRun,
      }
      if (opts.dryRun) throw new DryRun(result)
      await store.audit(
        {
          action: 'master_key.rotated',
          actor: opts.actor,
          newValue: { oldKeyId: current.id, newKeyId: to.id, secrets: rewrapped.length, totpSeeds: seeds.length, recoveryCodesReplaced: !!admin },
          result: 'ok',
        },
        tx,
      )
      return result
    })
  } catch (err) {
    if (err instanceof DryRun) return { ...err.result, admin: err.result.admin ? { username: err.result.admin.username, codes: [] } : null }
    throw err
  }
}

/**
 * `rotate-master-key --finish`: re-wraps what is still under the previous key (a value a core wrote with the old
 * key during the rotation), then the caller deletes `<key file>.prev`. Returns how many rows it moved.
 */
export async function finishRotation(deps: { db: Db; settings: SettingsStore }, actor: ActorLike): Promise<{ previousKeyId: string; moved: number }> {
  const keys = deps.settings.withKeyring((current, all) => ({ current, all }))
  if (!keys) throw new RotationRefused('key_unavailable')
  const prev = keys.all.find((k) => k.id !== keys.current.id)
  if (!prev) throw new RotationRefused('no_previous')
  return deps.db.transaction(async (tx) => {
    let moved = 0
    const unreadable: string[] = []
    const rows = await tx.select().from(settings).where(and(isNotNull(settings.ciphertext), ne(settings.keyId, keys.current.id))).for('update')
    for (const r of rows) {
      try {
        const e = rewrapEnvelope(keys.all, keys.current, r.key, { keyId: r.keyId ?? '', wrappedDek: r.wrappedDek!, dekNonce: r.dekNonce!, nonce: r.nonce!, ciphertext: r.ciphertext! })
        await tx.update(settings).set({ keyId: e.keyId, wrappedDek: e.wrappedDek, dekNonce: e.dekNonce }).where(eq(settings.key, r.key))
        moved++
      } catch (err) {
        if (!(err instanceof SecretDecryptError) && !(err instanceof TypeError)) throw err
        unreadable.push(r.key)
      }
    }
    const admins = await tx.select().from(localAdmins).where(and(isNotNull(localAdmins.totpSecret), ne(localAdmins.totpKeyId, keys.current.id))).for('update')
    for (const a of admins) {
      try {
        const s = rewrapBlob(keys.all, keys.current, totpAad(a.id), a.totpSecret!, a.totpKeyId!)
        await tx.update(localAdmins).set({ totpSecret: s.blob, totpKeyId: s.keyId }).where(eq(localAdmins.id, a.id))
        moved++
      } catch (err) {
        if (!(err instanceof SecretDecryptError)) throw err
        unreadable.push(`local_admin:${a.username}`)
      }
    }
    if (unreadable.length) throw new RotationRefused('unreadable', unreadable)
    await deps.settings.audit({ action: 'master_key.rotation_finished', actor, newValue: { previousKeyId: prev.id, moved }, result: 'ok' }, tx)
    return { previousKeyId: prev.id, moved }
  })
}

/**
 * The master key was lost (§3.5 "Losing it"; T7): core has a key (init generated or the operator set one) that does
 * not open the canary. This accepts that key as the master key: every stored secret, TOTP seed and recovery code
 * the old key sealed is dropped (they cannot be opened by anyone), the sessions end, and the canary is written with
 * the loaded key. The dropped setting keys are returned (names only) so the admin knows what to enter again.
 */
export async function resetLostMasterKey(
  deps: { db: Db; settings: SettingsStore },
  opts: { key: MasterKey; actor: ActorLike },
): Promise<{ keyId: string; dropped: string[]; totpRemoved: number }> {
  if (deps.settings.keyStatus !== 'mismatch') throw new RotationRefused('not_mismatch')
  const mk = opts.key
  return deps.db.transaction(async (tx) => {
    const [st] = await tx.select().from(setupState).where(eq(setupState.id, 1)).for('update')
    if (st?.keyCanary && checkCanary(mk, st.keyCanary)) throw new RotationRefused('not_mismatch')
    const rows = await tx.select({ key: settings.key, keyId: settings.keyId }).from(settings).where(isNotNull(settings.ciphertext)).for('update')
    const dropped = rows.filter((r) => r.keyId !== mk.id).map((r) => r.key).sort()
    for (const key of dropped) await tx.delete(settings).where(eq(settings.key, key))
    const totp = await tx
      .update(localAdmins)
      .set({ totpSecret: null, totpKeyId: null, totpEnabled: false, totpLastStep: null })
      .where(and(isNotNull(localAdmins.totpSecret), ne(localAdmins.totpKeyId, mk.id)))
      .returning({ id: localAdmins.id })
    await tx.delete(localRecoveryCodes)
    await tx.delete(localSessions)
    const canary = makeCanary(mk)
    await tx.update(setupState).set({ keyCanary: canary.blob, keyCanaryKeyId: canary.keyId }).where(eq(setupState.id, 1))
    await deps.settings.audit({ action: 'master_key.reset', actor: opts.actor, newValue: { keyId: mk.id, dropped, totpRemoved: totp.length }, result: 'ok' }, tx)
    return { keyId: mk.id, dropped, totpRemoved: totp.length }
  })
}

/**
 * A new recovery kit (D7): the current master key and new recovery codes for the break-glass admin (the old codes
 * stop working). Audited by the caller; the kit text is the only place the key appears.
 */
export async function issueRecoveryKit(
  deps: { db: Db; settings: SettingsStore },
  opts: { admin: AdminRow; publicUrl: string; at: Date; codes?: string[]; key?: MasterKey },
): Promise<{ text: string; keyId: string; codes: string[] }> {
  const mk = opts.key ?? deps.settings.withKey((k) => k)
  if (!mk) throw new MasterKeyUnavailable()
  const codes = opts.codes ?? (await deps.db.transaction((tx) => newCodes(tx, mk, opts.admin.id)))
  const text = recoveryKitText({
    installId: deps.settings.installId,
    publicUrl: opts.publicUrl,
    keyId: mk.id,
    masterKey: encodeMasterKey(mk),
    username: opts.admin.username,
    codes,
    at: opts.at,
  })
  return { text, keyId: mk.id, codes }
}

// ── Key files (the bootstrap volume, init's layout: core/master-key 0600 and core/master-key.prev) ─────────────

function writeFile0600(path: string, value: string): void {
  const fd = openSync(path, 'w', 0o600)
  try {
    writeSync(fd, `${value}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Not every platform can fsync a directory.
  }
}

/** Step 1: the new key goes to `<file>.next` first, so it is on disk before the database names it. */
export function writeNextKey(file: string, mk: MasterKey): void {
  writeFile0600(`${file}.next`, encodeMasterKey(mk))
  fsyncDir(dirname(file))
}

/** Step 3 (after the commit): `<file>` becomes `<file>.prev`, `<file>.next` becomes `<file>`. */
export function promoteNextKey(file: string): void {
  renameSync(file, `${file}.prev`)
  renameSync(`${file}.next`, file)
  fsyncDir(dirname(file))
}

/** A rotation that did not commit (a dry run, a refusal): the `.next` file goes. */
export function dropNextKey(file: string): void {
  rmSync(`${file}.next`, { force: true })
}

export function dropPreviousKey(file: string): void {
  rmSync(`${file}.prev`, { force: true })
  fsyncDir(dirname(file))
}
