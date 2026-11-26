import {
  SETTING_KEYS,
  SettingCategory,
  isSettingKey,
  secretHint,
  settingDef,
  type SettingApply,
  type SettingDef,
  type SettingKey,
  type SettingValue,
  type SettingWriteSource,
} from '@yoda/shared'
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { ZodError } from 'zod'
import type { Db, Tx } from '../db/client.js'
import { settings, settingsAudit, setupState } from '../db/schema.js'
import {
  checkCanary,
  decryptSecret,
  encryptSecret,
  fingerprint,
  makeCanary,
  type MasterKey,
  type MasterKeyLoad,
} from './crypto.js'

/**
 * Settings resolved env > database > default (installer proposal §5.3, §6). Secrets are stored encrypted under
 * the master key and never leave the store except through `get`; `info`/`list` carry only whether a secret is
 * set and its hint. A missing or wrong master key is a recovery state, never a crash: stored secrets read as
 * `SecretsUnavailableError`, env values and non-secrets keep working.
 */

/** `missing`: no key configured; `malformed`: not base64 of 32 bytes; `mismatch`: fails the key canary. */
export type KeyStatus = 'ok' | 'missing' | 'malformed' | 'mismatch'
export type SettingSource = 'env' | 'db' | 'default' | 'unset'
/** Why a setting cannot be written here: set in env, bootstrap-only, or read-only in the UI. */
export type LockReason = 'env' | 'bootstrap' | 'readonly'

export type SettingActor = {
  personId?: string | null
  /** Display name, `break-glass:<user>`, `system` or `cli`. */
  label: string
  source: Extract<SettingWriteSource, 'ui' | 'setup' | 'cli' | 'recovery'>
  ip?: string | null
  requestId?: string | null
}

/** What may be shown about a setting: never a secret's value. */
export type SettingInfo = {
  key: SettingKey
  category: SettingCategory
  secret: boolean
  apply: SettingApply
  uiEditable: boolean
  envName?: string
  source: SettingSource
  lock: LockReason | null
  isSet: boolean
  /** Non-secrets only. */
  value?: unknown
  /** Secrets: the last 4 characters of a value of 20 or more, else null. */
  hint: string | null
  /** A stored secret that cannot be decrypted with the current master key. */
  unavailable: boolean
  version: number | null
  updatedAt: Date | null
  updatedBy: string | null
  updatedByLabel: string | null
  writeSource: SettingWriteSource | null
}

export type SettingsLog = {
  warn(obj: object, msg: string): void
  info(obj: object, msg: string): void
}

export class UnknownSettingError extends Error {
  constructor(readonly key: string) {
    super(`unknown setting ${key}`)
    this.name = 'UnknownSettingError'
  }
}

export class SettingLockedError extends Error {
  constructor(
    readonly key: SettingKey,
    readonly reason: LockReason,
  ) {
    super(`setting ${key} is locked (${reason})`)
    this.name = 'SettingLockedError'
  }
}

/** A stored secret is needed but the master key is missing, wrong, or not the row's key. Names no value. */
export class SecretsUnavailableError extends Error {
  constructor(
    readonly key: SettingKey,
    readonly keyId: string | null,
  ) {
    super(`secret ${key} is unavailable${keyId ? ` (row key ${keyId})` : ''}: master key missing or wrong`)
    this.name = 'SecretsUnavailableError'
  }
}

/** Moving an endpoint whose bound secret is set in env (it would follow the endpoint and cannot be cleared). */
export class BoundSecretInEnvError extends Error {
  constructor(
    readonly key: SettingKey,
    readonly secret: SettingKey,
  ) {
    super(`setting ${key} is bound to ${secret}, which is set in env`)
    this.name = 'BoundSecretInEnvError'
  }
}

export class SettingConflictError extends Error {
  constructor(
    readonly key: SettingKey,
    readonly version: number,
  ) {
    super(`setting ${key} changed (now version ${version})`)
    this.name = 'SettingConflictError'
  }
}

type Row = typeof settings.$inferSelect
export type AuditRow = typeof settingsAudit.$inferSelect

/** One write in `apply`: a new value, or null to clear the stored one; `expectedVersion` 0 = nothing stored. */
export type SettingChange = { key: SettingKey; value: unknown; expectedVersion?: number }

/** Endpoint key → the secrets bound to it (registry `boundTo`, 8.6). */
const BOUND_SECRETS = new Map<SettingKey, SettingKey[]>()
for (const k of SETTING_KEYS) for (const b of settingDef(k).boundTo ?? []) BOUND_SECRETS.set(b as SettingKey, [...(BOUND_SECRETS.get(b as SettingKey) ?? []), k])

/** Read-only settings the system fills itself (`setDerived`). */
const DERIVED_KEYS = new Set<SettingKey>(['telegram.botUsername'])

type Stored = {
  value?: unknown
  plaintext?: string
  unavailable: boolean
  rowKeyId: string | null
  hint: string | null
  source: SettingWriteSource
  version: number
  updatedAt: Date
  updatedBy: string | null
  updatedByLabel: string | null
}

const SYSTEM = { personId: null, label: 'system', ip: null, requestId: null } as const
const IMPORT_LOCK = sql`select pg_advisory_xact_lock(hashtext('yoda.settings.import'))`
/** The store keeps whether the master key is set, never the key itself. */
const NEVER_KEPT = new Set<SettingKey>(['security.masterKey'])

const consoleLog: SettingsLog = {
  warn: (obj, msg) => console.warn(`settings: ${msg}`, JSON.stringify(obj)),
  info: (obj, msg) => console.log(`settings: ${msg}`, JSON.stringify(obj)),
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The NOTIFY channel other instances listen on (§5.3); tests pass their own, since NOTIFY is database-wide. */
export const SETTINGS_CHANNEL = 'settings_changed'

/** Restart-mode settings the database can change (bootstrap-only ones never come from it). */
const RESTART_KEYS = SETTING_KEYS.filter((k) => settingDef(k).apply === 'restart' && !settingDef(k).bootstrapOnly)

export class SettingsStore {
  private rows = new Map<SettingKey, Stored>()
  private envValues = new Map<SettingKey, unknown>()
  private envSet = new Set<SettingKey>()
  private recoveryMode = false
  private storedSecrets = 0
  private state: { installId: string; setupDone: boolean } = { installId: '', setupDone: false }
  /** Restart-mode values as this process booted with them. */
  private bootValues = new Map<SettingKey, unknown>()
  private listeners = new Set<() => void>()
  /**
   * Read order: every `load()` and single-key `reload()` takes the next epoch before it reads. A read applies
   * only what no later-started read has applied already, so a full reload that began before a local write never
   * undoes it.
   */
  private epoch = 0
  private loadedAt = 0
  private keyLoadedAt = new Map<SettingKey, number>()

  private constructor(
    private readonly db: Db,
    private readonly env: NodeJS.ProcessEnv,
    private readonly mk: MasterKey | null,
    private status: KeyStatus,
    private readonly log: SettingsLog,
    /** The NOTIFY channel; payloads carry key names only, never values. */
    readonly channel: string,
  ) {}

  /**
   * Boot: check the master key against the canary (writing it on first use), parse env, import env into the
   * database (D4), load the snapshot, and mark an existing env-based install as set up (§6.5).
   */
  static async open(opts: {
    db: Db
    env: NodeJS.ProcessEnv
    masterKey: MasterKeyLoad
    log?: SettingsLog
    channel?: string
  }): Promise<SettingsStore> {
    const log = opts.log ?? consoleLog
    const mk = opts.masterKey.status === 'ok' ? opts.masterKey.key : null
    const status: KeyStatus = opts.masterKey.status
    if (opts.masterKey.status !== 'ok') log.warn({ reason: opts.masterKey.reason }, `master key ${opts.masterKey.status}`)
    else if (opts.masterKey.warning) log.warn({ keyId: opts.masterKey.key.id }, opts.masterKey.warning)
    const store = new SettingsStore(opts.db, opts.env, mk, status, log, opts.channel ?? SETTINGS_CHANNEL)
    store.parseEnv()
    await store.checkKey()
    await store.importFromEnv()
    await store.markUpgrade()
    for (const k of RESTART_KEYS) store.bootValues.set(k, store.get(k))
    return store
  }

  /** Called after every change to the snapshot (a write here, or a reload); returns the unsubscribe. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch (err) {
        this.log.warn({ err: err instanceof Error ? err.name : 'error' }, 'settings change handler failed')
      }
    }
  }

  /** Restart-mode settings whose value differs from the one this process booted with (registry order). */
  get restartRequiredKeys(): SettingKey[] {
    return RESTART_KEYS.filter((k) => !same(this.bootValues.get(k), this.get(k)))
  }

  /** A restart-mode setting changed since boot: the running process still uses the old value (banner, §9). */
  get restartRequired(): boolean {
    return this.restartRequiredKeys.length > 0
  }

  get keyStatus(): KeyStatus {
    return this.status
  }

  get keyId(): string | null {
    return this.status === 'ok' ? this.mk!.id : null
  }

  /** Env secrets are copied into the database on boot (D4): a usable master key and YODA_SETTINGS_IMPORT not false. */
  get importsSecrets(): boolean {
    return this.envValues.get('security.settingsImport') !== false && this.status === 'ok'
  }

  /** Stored secrets cannot be read or written (env secrets still work). */
  get secretsUnavailable(): boolean {
    return this.status !== 'ok'
  }

  /**
   * Recovery state (7.4): the key is wrong or malformed, or missing while the database holds secrets, or an
   * admin forced it. A canary alone does not: with nothing encrypted, there is nothing to recover.
   */
  get recovery(): boolean {
    if (this.recoveryMode || this.status === 'mismatch' || this.status === 'malformed') return true
    return this.status === 'missing' && this.storedSecrets > 0
  }

  get setupDone(): boolean {
    return this.state.setupDone
  }

  get installId(): string {
    return this.state.installId
  }

  /** The setting is set in env (and so locked there). */
  fromEnv(key: SettingKey): boolean {
    return this.envSet.has(key)
  }

  /** The resolved value; a stored secret that cannot be decrypted throws `SecretsUnavailableError`. */
  get<K extends SettingKey>(key: K): SettingValue<K> | undefined {
    const d = settingDef(key)
    if (this.envSet.has(key)) return this.envValues.get(key) as SettingValue<K> | undefined
    const s = d.bootstrapOnly ? undefined : this.rows.get(key)
    if (s) {
      if (s.unavailable) throw new SecretsUnavailableError(key, s.rowKeyId)
      return (d.secret ? s.plaintext : s.value) as SettingValue<K> | undefined
    }
    return d.default as SettingValue<K> | undefined
  }

  info(key: SettingKey): SettingInfo {
    const d = settingDef(key)
    const s = d.bootstrapOnly ? undefined : this.rows.get(key)
    const inEnv = this.envSet.has(key)
    const source: SettingSource = inEnv ? 'env' : s ? 'db' : d.default !== undefined ? 'default' : 'unset'
    const info: SettingInfo = {
      key,
      category: d.category,
      secret: d.secret,
      apply: d.apply,
      uiEditable: d.uiEditable,
      ...(d.envName ? { envName: d.envName } : {}),
      source,
      lock: this.lockOf(d),
      isSet: source !== 'unset',
      hint: null,
      unavailable: !inEnv && !!s?.unavailable,
      version: s?.version ?? null,
      updatedAt: s?.updatedAt ?? null,
      updatedBy: s?.updatedBy ?? null,
      updatedByLabel: s?.updatedByLabel ?? null,
      writeSource: s?.source ?? null,
    }
    if (d.secret) {
      // Bootstrap-only secrets (database URL, S3 keys, ...) never show even a hint.
      const env = this.envValues.get(key)
      info.hint = d.bootstrapOnly ? null : inEnv ? (typeof env === 'string' ? secretHint(env) : null) : (s?.hint ?? null)
    } else if (source !== 'unset') {
      info.value = this.get(key)
    }
    return info
  }

  list(category?: SettingCategory): SettingInfo[] {
    return SETTING_KEYS.filter((k) => !category || settingDef(k).category === category).map((k) => this.info(k))
  }

  /** Validates, writes and audits one setting; refuses env-locked, bootstrap-only and read-only settings. */
  async set(key: SettingKey, input: unknown, actor: SettingActor, opts: { expectedVersion?: number } = {}): Promise<SettingInfo> {
    await this.apply([{ key, value: input, expectedVersion: opts.expectedVersion }], actor)
    return this.info(key)
  }

  /** Removes the stored value (back to the default) and audits it. */
  async clear(key: SettingKey, actor: SettingActor, opts: { expectedVersion?: number } = {}): Promise<SettingInfo> {
    await this.apply([{ key, value: null, expectedVersion: opts.expectedVersion }], actor)
    return this.info(key)
  }

  /**
   * The internal write path for a read-only value the system derives (the Telegram bot username from `getMe`):
   * the UI lock does not apply, env and bootstrap locks still do. Audited as `system`.
   */
  async setDerived(key: SettingKey, value: unknown, actor: Omit<SettingActor, 'label' | 'personId'>): Promise<SettingInfo> {
    if (!DERIVED_KEYS.has(key)) throw new SettingLockedError(key, this.lockOf(settingDef(key)) ?? 'readonly')
    await this.apply([{ key, value }], { ...actor, personId: null, label: 'system' }, { derived: true })
    return this.info(key)
  }

  /**
   * Validates every change, then writes them all in one transaction (rows locked in key order, so two saves
   * cannot deadlock), each with its audit row, and one NOTIFY. `value: null` clears the stored value. A change
   * that leaves the stored row as it is (same value, or a clear of nothing) writes nothing and is not audited.
   * Any refusal (lock, stale version, validation) writes nothing.
   *
   * Credential-bound endpoints (8.6): when a change moves an endpoint away from its value in the locked row, the
   * secrets bound to it are cleared in the same transaction, unless the same call sets them. A bound secret set
   * in env cannot be cleared, so moving its endpoint is refused (`BoundSecretInEnvError`).
   */
  async apply(changes: SettingChange[], actor: SettingActor, opts: { derived?: boolean } = {}): Promise<{ changed: SettingKey[]; cleared: SettingKey[] }> {
    const plan = changes.map((c) => {
      const d = this.writable(c.key, opts.derived === true)
      if (c.value === null) return { d, c, value: null }
      // Every secret schema is a string schema, so a non-string secret is a ZodError (400) here.
      const value: unknown = d.schema.parse(c.value)
      if (d.secret && typeof value !== 'string') {
        throw new ZodError([{ code: 'custom', path: [c.key], message: 'secret must be a string' }])
      }
      return { d, c, value }
    })
    if (new Set(plan.map((p) => p.c.key)).size !== plan.length) throw new Error('duplicate setting in one change')
    const inPlan = new Set(plan.map((p) => p.c.key))
    const bound = new Map<SettingKey, SettingKey[]>()
    for (const p of plan) {
      const secrets = (BOUND_SECRETS.get(p.c.key) ?? []).filter((k) => !inPlan.has(k))
      for (const k of secrets) if (this.envSet.has(k)) throw new BoundSecretInEnvError(p.c.key, k)
      if (secrets.length) bound.set(p.c.key, secrets)
    }
    const setsSecret = plan.find((p) => p.d.secret && p.value !== null)
    const mk = setsSecret ? this.requireKey(setsSecret.c.key) : null
    const lockKeys = [...new Set([...inPlan, ...[...bound.values()].flat()])].sort()
    const changed: SettingKey[] = []
    const cleared: SettingKey[] = []
    await this.db.transaction(async (tx) => {
      const rows = new Map<SettingKey, Row | undefined>()
      for (const key of lockKeys) {
        const p = plan.find((x) => x.c.key === key)
        rows.set(key, await this.lockRow(tx, key, p?.c.expectedVersion))
      }
      for (const { d, c, value } of plan.sort((a, b) => (a.c.key < b.c.key ? -1 : 1))) {
        const cur = rows.get(c.key)
        // The endpoint's value in the locked row (not the snapshot, which another instance may have outrun).
        if (bound.has(c.key) && !same(this.rowValue(d, cur), value ?? d.default)) {
          for (const secret of bound.get(c.key)!) {
            const row = rows.get(secret)
            if (!row || cleared.includes(secret)) continue
            await tx.delete(settings).where(eq(settings.key, secret))
            await tx.insert(settingsAudit).values({ ...this.auditActor(actor), action: 'clear', key: secret, ...this.oldOf(settingDef(secret), row), newValue: null, newFp: null })
            cleared.push(secret)
          }
        }
        if (value === null) {
          if (!cur) continue
          await tx.delete(settings).where(eq(settings.key, c.key))
          await tx.insert(settingsAudit).values({ ...this.auditActor(actor), action: 'clear', key: c.key, ...this.oldOf(d, cur), newValue: null, newFp: null })
        } else {
          if (cur && (d.secret ? this.decryptRow(cur) === value : !cur.ciphertext && same(cur.value, value))) continue
          await this.write(tx, d, value, actor, opts.derived ? 'derived' : 'set', cur, d.secret ? mk : null)
        }
        changed.push(c.key)
      }
      if (changed.length || cleared.length) await this.notify(tx, [...changed, ...cleared])
    })
    for (const key of [...changed, ...cleared]) await this.reload(key)
    return { changed, cleared }
  }

  /** A row's non-secret value as stored (validated), else the default. */
  private rowValue(d: SettingDef, row: Row | undefined): unknown {
    if (!row || row.ciphertext) return d.default
    const parsed = d.schema.safeParse(row.value)
    return parsed.success ? parsed.data : d.default
  }

  /** A test run (§5.4): who, which action, the result code; never a value. */
  async recordTest(category: SettingCategory, action: string, result: string, actor: SettingActor): Promise<void> {
    await this.db.insert(settingsAudit).values({ ...this.auditActor(actor), action: 'test', key: null, newValue: { test: action, category }, result })
  }

  /** The audit log, newest first, `limit` rows before `cursor` (an id). Secret rows carry fingerprints only. */
  async auditPage(q: { category?: SettingCategory; key?: string; cursor?: number; limit: number }): Promise<{ rows: AuditRow[]; nextCursor: number | null }> {
    const where = []
    if (q.key) where.push(eq(settingsAudit.key, q.key))
    if (q.category) {
      const keys = SETTING_KEYS.filter((k) => settingDef(k).category === q.category)
      where.push(
        or(
          inArray(settingsAudit.key, keys as SettingKey[]),
          and(eq(settingsAudit.action, 'test'), sql`${settingsAudit.newValue}->>'category' = ${q.category}`),
        )!,
      )
    }
    if (q.cursor) where.push(lt(settingsAudit.id, q.cursor))
    const rows = await this.db
      .select()
      .from(settingsAudit)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(settingsAudit.id))
      .limit(q.limit + 1)
    const more = rows.length > q.limit
    const page = more ? rows.slice(0, q.limit) : rows
    return { rows: page, nextCursor: more ? page[page.length - 1]!.id : null }
  }

  /**
   * Tells every instance (this one too) which keys changed. Inside the write's transaction, so it is delivered on
   * commit only and the listener reads committed rows. Key names only: the payload limit is ~8000 bytes, and a
   * value (a secret above all) must never travel in it.
   */
  private async notify(tx: Tx, keys: SettingKey[]): Promise<void> {
    await tx.execute(sql`select pg_notify(${this.channel}, ${JSON.stringify(keys)})`)
  }

  /** Reads every row again (boot, and the NOTIFY listener in live.ts on every notification and reconnect). */
  async load(): Promise<void> {
    const started = ++this.epoch
    const rows = await this.db.select().from(settings)
    const [st] = await this.db.select().from(setupState).where(eq(setupState.id, 1))
    // A load that started later has already applied newer rows.
    if (started < this.loadedAt) return
    const next = new Map<SettingKey, Stored>()
    let secrets = 0
    for (const r of rows) {
      if (r.ciphertext) secrets++
      const s = this.decode(r)
      if (s) next.set(r.key as SettingKey, s)
    }
    // Keys re-read after this load started keep their newer entry.
    for (const [key, at] of this.keyLoadedAt) {
      if (at < started) continue
      const cur = this.rows.get(key)
      if (cur) next.set(key, cur)
      else next.delete(key)
    }
    this.loadedAt = started
    this.rows = next
    this.storedSecrets = secrets
    this.state = { installId: st?.installId ?? '', setupDone: !!st?.setupCompletedAt }
    this.recoveryMode = !!st?.recoveryMode
    this.changed()
  }

  private async reload(key: SettingKey): Promise<void> {
    const started = ++this.epoch
    const [r] = await this.db.select().from(settings).where(eq(settings.key, key))
    // A later full load or a later read of this key has applied a newer row.
    if (started < this.loadedAt || started < (this.keyLoadedAt.get(key) ?? 0)) return
    this.keyLoadedAt.set(key, started)
    const s = r ? this.decode(r) : undefined
    if (s) this.rows.set(key, s)
    else this.rows.delete(key)
    this.changed()
  }

  /** A row as a snapshot entry; an unknown or invalid one is skipped with a warning (a newer release's row). */
  private decode(r: Row): Stored | undefined {
    if (!isSettingKey(r.key)) {
      this.log.warn({ key: r.key }, 'unknown setting row ignored')
      return undefined
    }
    const d = settingDef(r.key)
    if (d.bootstrapOnly) return undefined
    const base = {
      unavailable: false,
      rowKeyId: r.keyId,
      hint: r.hint,
      source: r.source as SettingWriteSource,
      version: r.version,
      updatedAt: r.updatedAt,
      updatedBy: r.updatedBy,
      updatedByLabel: r.updatedByLabel,
    }
    if (d.secret) {
      if (!r.ciphertext) {
        this.log.warn({ key: r.key }, 'secret row without ciphertext ignored')
        return undefined
      }
      const plaintext = this.decryptRow(r)
      if (plaintext === null) {
        if (this.status === 'ok') this.log.warn({ key: r.key, keyId: r.keyId }, 'stored secret not decryptable')
        return { ...base, unavailable: true }
      }
      return { ...base, plaintext }
    }
    const parsed = d.schema.safeParse(r.value)
    if (!parsed.success) {
      this.log.warn({ key: r.key }, 'invalid stored value ignored; using the default')
      return undefined
    }
    return { ...base, value: parsed.data }
  }

  /** Never decrypts with a key that failed the canary. */
  private decryptRow(r: Row): string | null {
    if (this.status !== 'ok' || !r.ciphertext || !r.keyId || !r.wrappedDek || !r.dekNonce || !r.nonce) return null
    try {
      return decryptSecret(this.mk!, r.key, { keyId: r.keyId, wrappedDek: r.wrappedDek, dekNonce: r.dekNonce, nonce: r.nonce, ciphertext: r.ciphertext })
    } catch {
      return null
    }
  }

  private parseEnv(): void {
    const bad: string[] = []
    for (const key of SETTING_KEYS) {
      const d = settingDef(key)
      const raw = d.envName ? this.env[d.envName] : undefined
      if (raw === undefined || raw === '') continue
      if (NEVER_KEPT.has(key)) {
        this.envSet.add(key)
        continue
      }
      const parsed = d.schema.safeParse(raw)
      if (parsed.success) {
        this.envSet.add(key)
        this.envValues.set(key, parsed.data)
      } else if (d.scope === 'core') {
        bad.push(`${d.envName}: ${parsed.error.issues.map((i) => i.message).join(', ')}`)
      } else {
        this.log.warn({ envName: d.envName }, 'invalid env value ignored')
      }
    }
    if (bad.length) throw new Error(`Invalid environment: ${bad.join('; ')}`)
  }

  /** Canary check: a key that fails it is `mismatch`; the first good key writes it (unless rows name another key). */
  private async checkKey(): Promise<void> {
    await this.db.insert(setupState).values({ id: 1 }).onConflictDoNothing()
    if (this.status !== 'ok') return
    const mk = this.mk!
    await this.db.transaction(async (tx) => {
      const [st] = await tx.select().from(setupState).where(eq(setupState.id, 1)).for('update')
      if (st?.keyCanary) {
        if (!checkCanary(mk, st.keyCanary)) {
          this.status = 'mismatch'
          this.log.warn({ keyId: mk.id, canaryKeyId: st.keyCanaryKeyId }, 'master key does not match the key canary; recovery state')
        }
        return
      }
      const [other] = await tx
        .select({ key: settings.key })
        .from(settings)
        .where(and(isNotNull(settings.ciphertext), ne(settings.keyId, mk.id)))
        .limit(1)
      if (other) {
        this.status = 'mismatch'
        this.log.warn({ keyId: mk.id }, 'stored secrets use another master key; recovery state')
        return
      }
      const canary = makeCanary(mk)
      await tx.update(setupState).set({ keyCanary: canary.blob, keyCanaryKeyId: canary.keyId }).where(eq(setupState.id, 1))
    })
  }

  /**
   * §6.2: every env value of a non-bootstrap setting is copied into the database (source `import`) when it
   * differs from the stored one. Secrets need a good master key and are skipped with YODA_SETTINGS_IMPORT=false.
   * Ends by reloading the snapshot, so the store reflects the database afterwards.
   */
  async importFromEnv(): Promise<SettingKey[]> {
    const importSecrets = this.importsSecrets
    const keys = SETTING_KEYS.filter((k) => {
      const d = settingDef(k)
      return this.envSet.has(k) && !d.bootstrapOnly && (!d.secret || importSecrets)
    })
    const changed: SettingKey[] = []
    if (!keys.length) {
      await this.load()
      return changed
    }
    await this.db.transaction(async (tx) => {
      await tx.execute(IMPORT_LOCK)
      for (const key of keys) {
        const d = settingDef(key)
        const value = this.envValues.get(key)
        const [cur] = await tx.select().from(settings).where(eq(settings.key, key)).for('update')
        if (cur && (d.secret ? this.decryptRow(cur) === value : !cur.ciphertext && same(cur.value, value))) continue
        await this.write(tx, d, value, { ...SYSTEM, source: 'import' }, 'import', cur, d.secret ? this.mk : null)
        changed.push(key)
      }
      if (changed.length) await this.notify(tx, changed)
    })
    if (changed.length) this.log.info({ keys: changed }, 'imported from env')
    await this.load()
    return changed
  }

  /** §6.5: an install with env sign-in config and existing data (an admin or a project) skips the wizard. */
  private async markUpgrade(): Promise<void> {
    if (this.state.setupDone || !this.envSet.has('oidc.issuer')) return
    const [r] = await this.db.execute<{ has: boolean }>(
      sql`select (exists (select 1 from people where is_admin) or exists (select 1 from projects)) as has`,
    )
    if (!r?.has) return
    const done = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(setupState)
        .set({ setupCompletedAt: sql`now()`, setupCompletedSource: 'upgrade' })
        .where(and(eq(setupState.id, 1), isNull(setupState.setupCompletedAt)))
        .returning({ id: setupState.id })
      if (!rows.length) return false
      await tx.insert(settingsAudit).values({ ...this.auditActor({ ...SYSTEM, source: 'upgrade' }), action: 'setup.completed' })
      return true
    })
    if (done) this.log.info({}, 'existing install: setup marked done (upgrade)')
    this.state = { ...this.state, setupDone: true }
  }

  private writable(key: SettingKey, derived = false): SettingDef {
    if (!isSettingKey(key)) throw new UnknownSettingError(key)
    const d = settingDef(key)
    const lock = this.lockOf(d)
    if (lock && !(derived && lock === 'readonly' && DERIVED_KEYS.has(key))) throw new SettingLockedError(key, lock)
    return d
  }

  private lockOf(d: SettingDef): LockReason | null {
    if (d.bootstrapOnly) return 'bootstrap'
    if (this.envSet.has(d.key as SettingKey)) return 'env'
    if (!d.uiEditable) return 'readonly'
    return null
  }

  private requireKey(key: SettingKey): MasterKey {
    if (this.status !== 'ok') throw new SecretsUnavailableError(key, null)
    return this.mk!
  }

  private async lockRow(tx: Tx, key: SettingKey, expectedVersion: number | undefined): Promise<Row | undefined> {
    const [cur] = await tx.select().from(settings).where(eq(settings.key, key)).for('update')
    if (expectedVersion !== undefined && (cur?.version ?? 0) !== expectedVersion) throw new SettingConflictError(key, cur?.version ?? 0)
    return cur
  }

  private oldOf(d: SettingDef, cur: Row | undefined): { oldValue: unknown; oldFp: string | null } {
    if (!cur) return { oldValue: null, oldFp: null }
    if (!d.secret) return { oldValue: cur.value ?? null, oldFp: null }
    const plain = this.decryptRow(cur)
    return { oldValue: null, oldFp: plain !== null && this.mk ? fingerprint(this.mk, d.key, plain) : null }
  }

  private auditActor(actor: { personId?: string | null; label: string; source: string; ip?: string | null; requestId?: string | null }) {
    return {
      actorPerson: actor.personId ?? null,
      actorLabel: actor.label,
      source: actor.source,
      ip: actor.ip ?? null,
      requestId: actor.requestId ?? null,
    }
  }

  /** Upserts the row (version + 1) and appends its audit row, in the caller's transaction. */
  private async write(
    tx: Tx,
    d: SettingDef,
    value: unknown,
    actor: { personId?: string | null; label: string; source: SettingWriteSource; ip?: string | null; requestId?: string | null },
    action: 'set' | 'import' | 'derived',
    cur: Row | undefined,
    mk: MasterKey | null,
  ): Promise<void> {
    const key = d.key
    const who = { source: actor.source, updatedBy: actor.personId ?? null, updatedByLabel: actor.label, updatedAt: sql`now()` }
    let fields
    let newFp: string | null = null
    if (d.secret) {
      const plain = value as string
      const e = encryptSecret(mk!, key, plain)
      fields = { value: null, keyId: e.keyId, wrappedDek: e.wrappedDek, dekNonce: e.dekNonce, nonce: e.nonce, ciphertext: e.ciphertext, hint: secretHint(plain) }
      newFp = fingerprint(mk!, key, plain)
    } else {
      fields = { value: value as object, keyId: null, wrappedDek: null, dekNonce: null, nonce: null, ciphertext: null, hint: null }
    }
    await tx
      .insert(settings)
      .values({ key, ...fields, ...who })
      .onConflictDoUpdate({ target: settings.key, set: { ...fields, ...who, version: sql`${settings.version} + 1` } })
    await tx.insert(settingsAudit).values({
      ...this.auditActor(actor),
      action,
      key,
      ...this.oldOf(d, cur),
      newValue: d.secret ? null : (value as object),
      newFp,
    })
  }
}
