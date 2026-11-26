import { SETTINGS, SETTINGS_TEST_CODES, isSettingKey, type MasterKeyView, type SettingCategory, type SettingView, type SettingsAuditEntry, type SettingsTestCheck } from '@yoda/shared'
import type { ZodTypeAny } from 'zod'

/**
 * The admin settings pages (installer proposal §5.2, mockup `installer-admin-settings.html`): one rail item, a
 * category list, and per category a form built from the registry. Everything here is pure so it can be tested.
 */

export type SettingsPageId = 'general' | 'signin' | 'ai' | 'gitlab' | 'channels' | 'runners' | 'backups' | 'storage' | 'security' | 'audit'
export type SettingsPage = { id: SettingsPageId; icon: string; categories: SettingCategory[] }

/** The category list, in the mockup's order. Email, LINE and Telegram share one page (notification channels). */
export const SETTINGS_PAGES: SettingsPage[] = [
  { id: 'general', icon: 'mdi-domain', categories: ['general'] },
  { id: 'signin', icon: 'mdi-login', categories: ['signin'] },
  { id: 'ai', icon: 'mdi-robot-outline', categories: ['ai'] },
  { id: 'gitlab', icon: 'mdi-source-branch', categories: ['gitlab'] },
  { id: 'channels', icon: 'mdi-bell-cog-outline', categories: ['email', 'line', 'telegram'] },
  { id: 'runners', icon: 'mdi-server-network-outline', categories: ['runners'] },
  { id: 'backups', icon: 'mdi-backup-restore', categories: ['backups'] },
  { id: 'storage', icon: 'mdi-database-outline', categories: ['storage'] },
  { id: 'security', icon: 'mdi-shield-key-outline', categories: ['security'] },
  { id: 'audit', icon: 'mdi-history', categories: [] },
]

export const SETTINGS_HOME = '/admin/settings/general'
export const settingsPath = (id: SettingsPageId) => `/admin/settings/${id}`

export function settingsPage(id: string | undefined): SettingsPage | null {
  return SETTINGS_PAGES.find(p => p.id === id) ?? null
}

/** The page a category's settings live on. */
export function pageForCategory(category: SettingCategory): SettingsPageId {
  return SETTINGS_PAGES.find(p => p.categories.includes(category))?.id ?? 'general'
}

/** The old admin pages, now categories of the settings page (D5). */
export const LEGACY_SETTINGS_ROUTES: Record<string, string> = {
  '/admin/gitlab': settingsPath('gitlab'),
  '/admin/notifications': settingsPath('channels'),
}

// --- Fields ---------------------------------------------------------------------------------------------------

export type FieldKind = 'secret' | 'bool' | 'number' | 'enum' | 'list' | 'url' | 'text'

type Def = { typeName?: string; schema?: ZodTypeAny; values?: string[]; type?: ZodTypeAny; checks?: { kind: string }[] }
const defOf = (s: ZodTypeAny) => s._def as Def

/** The innermost schema: preprocess / transform / refine wrappers removed. */
function unwrap(s: ZodTypeAny): ZodTypeAny {
  let cur = s
  for (let i = 0; i < 8 && defOf(cur).typeName === 'ZodEffects' && defOf(cur).schema; i++) cur = defOf(cur).schema!
  return cur
}

/** How a setting is edited, from its registry schema. */
export function fieldKind(key: string): FieldKind {
  if (!isSettingKey(key)) return 'text'
  const def = SETTINGS[key]
  if (def.secret) return 'secret'
  const inner = unwrap(def.schema as ZodTypeAny)
  const d = defOf(inner)
  switch (d.typeName) {
    case 'ZodBoolean': return 'bool'
    case 'ZodNumber': return 'number'
    case 'ZodEnum': return 'enum'
    case 'ZodArray': return 'list'
    case 'ZodString': return d.checks?.some(c => c.kind === 'url') ? 'url' : 'text'
    default: return 'text'
  }
}

/** The choices of an enum setting (`org.defaultLocale`). */
export function enumOptions(key: string): string[] {
  if (!isSettingKey(key)) return []
  const d = defOf(unwrap(SETTINGS[key].schema as ZodTypeAny))
  return d.typeName === 'ZodEnum' ? [...(d.values ?? [])] : []
}

/** Validates one form value with the registry schema: null when fine, else the schema's message. */
export function validateField(key: string, form: FormValue): string | null {
  if (!isSettingKey(key) || form === '' || form === null) return null
  const r = (SETTINGS[key].schema as ZodTypeAny).safeParse(fromFormValue(fieldKind(key), form))
  return r.success ? null : (r.error.issues[0]?.message ?? 'invalid')
}

export const fieldLabelKey = (key: string) => `settings.field.${key}.label`
export const fieldHelpKey = (key: string) => `settings.field.${key}.help`

/** Bootstrap-only settings (8.6) are shown only on the read-only pages; elsewhere they are noise. */
const READ_ONLY_PAGES: SettingCategory[] = ['storage', 'security']
const GENERAL_ORDER = ['org.name', 'org.nameEn', 'org.line', 'org.publicUrl', 'org.defaultLocale', 'org.runnerDocsUrl', 'work.dailyTaskCap']

/** The settings a category section shows, in order. */
export function visibleSettings(category: SettingCategory, views: SettingView[]): SettingView[] {
  const shown = views.filter((v) => {
    if (READ_ONLY_PAGES.includes(category)) return true
    if (isSettingKey(v.key) && SETTINGS[v.key].bootstrapOnly) return false
    // Deprecated (§6.6): only shown while env still sets it.
    if (v.key === 'oidc.bootstrapAdmins') return v.source === 'env'
    return true
  })
  if (category !== 'general') return shown
  const rank = (k: string) => (GENERAL_ORDER.includes(k) ? GENERAL_ORDER.indexOf(k) : GENERAL_ORDER.length)
  return [...shown].sort((a, b) => rank(a.key) - rank(b.key))
}

export type FieldLock = {
  reason: string
  envName: string | null
  /** The container that reads it (`managed_on_host`). */
  container: string | null
  /** i18n key of the "how to change it" text, which depends on the key's state. */
  howKey: string
}

export type FieldRules = {
  /** The input takes changes. */
  editable: boolean
  /** The lock chip to show ("กำหนดโดย environment: VAR"), or null. */
  lock: FieldLock | null
}

/** Locks whose "how to change it" text also shows under the field (the others say enough in the chip). */
export const SHOW_HOW = ['env', 'managed_on_host']

export const LOCK_REASONS = ['env', 'bootstrap', 'readonly', 'recovery_only', 'managed_on_host', 'bound_secret_in_env']

/**
 * How a locked setting is changed. An env lock depends on what removing the variable would do: the prod compose
 * file may still pass it (a default), and a secret that was not imported (no usable master key, or
 * YODA_SETTINGS_IMPORT=false) is lost, disconnecting the service. A host-managed setting without a variable is
 * not read by anything yet.
 */
export function lockHowKey(reason: string, opts: { envName?: string | null; secret?: boolean; importable?: boolean; composeDefault?: boolean } = {}): string {
  if (reason === 'env') {
    if (opts.composeDefault) return 'settings.lock.how.envCompose'
    if (opts.secret && opts.importable === false) return 'settings.lock.how.envNotKept'
    return 'settings.lock.how.env'
  }
  if (reason === 'managed_on_host') return opts.envName ? 'settings.lock.how.managed_on_host' : 'settings.lock.how.managed_on_host_unused'
  return `settings.lock.how.${LOCK_REASONS.includes(reason) ? reason : 'readonly'}`
}

/** The named values of a lock's texts: the variable, and the container when there is one. */
export const lockNamed = (l: { envName?: string | null; container?: string | null }) => ({ name: l.envName ?? '', ...(l.container ? { container: l.container } : {}) })

/** Locked settings (env, bootstrap, read-only, recovery-only, managed on the host) never take input. */
export function fieldRules(v: SettingView): FieldRules {
  if (!v.locked) return { editable: true, lock: null }
  const envName = v.locked.envName ?? (v.locked.reason === 'managed_on_host' ? null : v.envName) ?? null
  const howKey = lockHowKey(v.locked.reason, { envName, secret: v.secret, importable: v.importable, composeDefault: v.composeDefault })
  return { editable: false, lock: { reason: v.locked.reason, envName, container: v.locked.container ?? null, howKey } }
}

/** A secret that is not locked still cannot be saved, replaced or cleared here while the master key is unusable. */
export const secretBlocked = (v: SettingView, keyStatus: MasterKeyView['status'] | null | undefined) =>
  v.secret && !v.locked && !!keyStatus && keyStatus !== 'ok'

/**
 * The master key banner: none when the key is fine; information for an install that keeps every secret in env
 * (no key, nothing stored: nothing is lost); an error in recovery (a wrong key, or stored secrets it cannot read).
 */
export function masterKeyAlert(mk: MasterKeyView | null | undefined): { type: 'info' | 'error'; key: string } | null {
  if (!mk || mk.status === 'ok') return null
  if (mk.status === 'missing' && !mk.recovery) return { type: 'info', key: 'settings.security.keyAlert.missingEnvOnly' }
  return { type: 'error', key: `settings.security.keyAlert.${mk.status}` }
}

/**
 * Where a value shown under the field came from: saved here, imported from env on boot (D4: it stays in effect
 * after the variable is removed), or the default. Nothing for locked settings (the lock says it).
 */
export function sourceKind(v: SettingView): 'imported' | 'saved' | 'default' | null {
  if (v.locked) return null
  if (v.source === 'db' && v.updatedAt) return v.writeSource === 'import' ? 'imported' : 'saved'
  if (v.source === 'default') return 'default'
  return null
}

/** Env-locked settings in a page's categories, for the count next to the category name. */
export function lockedCount(views: SettingView[]): number {
  return views.filter(v => v.locked?.reason === 'env').length
}

/** The apply modes a section's editable settings use, in a fixed order (live, reconnect, restart). */
export function applyModes(views: SettingView[]): SettingView['apply'][] {
  const editable = views.filter(v => !v.locked)
  return (['live', 'reconnect', 'restart'] as const).filter(m => editable.some(v => v.apply === m))
}

/** The hints a category shows: the backup container re-reads its settings every minute, so `live` reads `minute` there. */
export function categoryApplyModes(category: string, views: SettingView[]): (SettingView['apply'] | 'minute')[] {
  return applyModes(views).map(m => (category === 'backups' && m === 'live' ? 'minute' : m))
}

// --- Drafts ---------------------------------------------------------------------------------------------------

/** What an input holds: text for text, numbers, lists and enums; a boolean for switches. */
export type FormValue = string | boolean | null
/** A secret is never loaded into the form: it is kept, replaced with a typed value, or cleared. */
export type SecretDraft = { mode: 'keep' | 'replace' | 'clear'; value: string }
export type SectionDraft = { values: Record<string, FormValue>; secrets: Record<string, SecretDraft> }

export function toFormValue(kind: FieldKind, value: unknown): FormValue {
  if (kind === 'bool') return value === undefined || value === null ? null : value === true || value === 'true'
  if (value === undefined || value === null) return ''
  if (kind === 'list') return Array.isArray(value) ? value.join(', ') : String(value)
  return String(value)
}

/** The value sent to the API; null clears the setting (back to its default). */
export function fromFormValue(kind: FieldKind, form: FormValue): unknown {
  if (kind === 'bool') return form === null ? null : form === true
  const s = typeof form === 'string' ? form.trim() : ''
  if (s === '') return null
  if (kind === 'number') return /^-?\d+$/.test(s) ? Number(s) : s
  if (kind === 'list') return s.split(',').map(x => x.trim()).filter(Boolean)
  return s
}

export function initialDraft(views: SettingView[]): SectionDraft {
  const draft: SectionDraft = { values: {}, secrets: {} }
  for (const v of views) {
    if (v.secret) draft.secrets[v.key] = { mode: 'keep', value: '' }
    else draft.values[v.key] = toFormValue(fieldKind(v.key), v.value)
  }
  return draft
}

const same = (a: FormValue, b: FormValue) => (typeof a === 'string' && typeof b === 'string' ? a.trim() === b.trim() : a === b)

export type DraftChanges = { changes: Record<string, unknown>; versions: Record<string, number> }

/**
 * The partial save body: only edited, editable keys, each with the version the form loaded (409 when stale).
 * A secret goes in only when replaced with a typed value, or cleared while set.
 */
export function draftChanges(views: SettingView[], draft: SectionDraft): DraftChanges {
  const out: DraftChanges = { changes: {}, versions: {} }
  for (const v of views) {
    if (v.locked) continue
    if (v.secret) {
      const s = draft.secrets[v.key]
      if (s?.mode === 'replace' && s.value.trim() !== '') out.changes[v.key] = s.value.trim()
      else if (s?.mode === 'clear' && v.secretState?.set) out.changes[v.key] = null
      else continue
    } else {
      const kind = fieldKind(v.key)
      const form = draft.values[v.key] ?? toFormValue(kind, undefined)
      if (same(form, toFormValue(kind, v.value))) continue
      out.changes[v.key] = fromFormValue(kind, form)
    }
    out.versions[v.key] = v.version
  }
  return out
}

/**
 * Client-side schema errors of the edited keys only: a stored value the form did not touch (say, from an older
 * release) never blocks saving the rest.
 */
export function changedFieldErrors(views: SettingView[], draft: SectionDraft): Record<string, string> {
  const { changes } = draftChanges(views, draft)
  const out: Record<string, string> = {}
  for (const v of views) {
    if (v.secret || !(v.key in changes)) continue
    const msg = validateField(v.key, draft.values[v.key] ?? '')
    if (msg) out[v.key] = msg
  }
  return out
}

/**
 * A fresh form for reloaded settings that keeps the admin's unsaved edits (typed secrets included) of keys that
 * are still editable. Used when only part of the page reloads (a generated secret), never after a save.
 */
export function rebaseDraft(oldViews: SettingView[], oldDraft: SectionDraft, newViews: SettingView[]): SectionDraft {
  const next = initialDraft(newViews)
  const { changes } = draftChanges(oldViews, oldDraft)
  for (const v of newViews) {
    if (v.locked || !(v.key in changes)) continue
    if (v.secret && oldDraft.secrets[v.key]) next.secrets[v.key] = { ...oldDraft.secrets[v.key]! }
    else if (!v.secret && v.key in oldDraft.values) next.values[v.key] = oldDraft.values[v.key]!
  }
  return next
}

export const dirtyCount = (views: SettingView[], draft: SectionDraft) => Object.keys(draftChanges(views, draft).changes).length

/**
 * Draft values for a test (it runs against the unsaved form, §5.2): edited values and typed secrets. Cleared
 * values are left out, so the test uses what is in effect.
 */
export function testValues(views: SettingView[], draft: SectionDraft): Record<string, unknown> {
  const { changes } = draftChanges(views, draft)
  return Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== null))
}

/**
 * Endpoints being moved whose stored secret will be cleared by the save (8.6), unless a new one is typed:
 * `{ 'smtp.host': ['smtp.password'] }`.
 */
export function boundSecretNotes(views: SettingView[], draft: SectionDraft): Record<string, string[]> {
  const { changes } = draftChanges(views, draft)
  const byKey = new Map(views.map(v => [v.key, v]))
  const out: Record<string, string[]> = {}
  for (const v of views) {
    if (!v.boundSecrets?.length || !(v.key in changes)) continue
    const lost = v.boundSecrets.filter(s => byKey.get(s)?.secretState?.set && !byKey.get(s)?.locked && !(s in changes))
    if (lost.length) out[v.key] = lost
  }
  return out
}

/**
 * Endpoints being moved whose bound secret is set by env: core refuses the save (`bound_secret_in_env`), so the
 * form says so before saving instead of promising a clear: `{ 'gitlab.url': { secret: 'gitlab.token', envName } }`.
 */
export function boundSecretsInEnv(views: SettingView[], draft: SectionDraft): Record<string, { secret: string; envName: string | null }> {
  const { changes } = draftChanges(views, draft)
  const byKey = new Map(views.map(v => [v.key, v]))
  const out: Record<string, { secret: string; envName: string | null }> = {}
  for (const v of views) {
    if (!v.boundSecrets?.length || !(v.key in changes)) continue
    const inEnv = v.boundSecrets.map(s => byKey.get(s)).find(s => s?.source === 'env')
    if (inEnv) out[v.key] = { secret: inEnv.key, envName: inEnv.envName ?? inEnv.locked?.envName ?? null }
  }
  return out
}

// --- Saving and re-authentication -------------------------------------------------------------------------------

export type SaveError =
  | { kind: 'reauth' }
  | { kind: 'conflict'; key: string | null }
  | { kind: 'locked'; key: string | null; reason: string | null; envName: string | null }
  | { kind: 'invalid'; issues: { key: string; message: string }[] }
  | { kind: 'rateLimited'; retryAfter: number | null }
  | { kind: 'secretsUnavailable'; key: string | null }
  | { kind: 'other' }

type ApiError = { statusCode?: number; status?: number; data?: Record<string, unknown> }

/** What a failed save (or generate / webhook call) means for the form. */
export function saveError(e: unknown): SaveError {
  const err = (e ?? {}) as ApiError
  const status = err.statusCode ?? err.status
  const d = err.data ?? {}
  const str = (x: unknown) => (typeof x === 'string' ? x : null)
  switch (d.error) {
    case 'reauth_required': return { kind: 'reauth' }
    case 'version_conflict': return { kind: 'conflict', key: str(d.key) }
    case 'setting_locked': return { kind: 'locked', key: str(d.key), reason: str(d.reason), envName: str(d.envName) }
    case 'invalid_settings': return { kind: 'invalid', issues: Array.isArray(d.issues) ? (d.issues as { key: string; message: string }[]) : [] }
    case 'rate_limited': return { kind: 'rateLimited', retryAfter: typeof d.retryAfter === 'number' ? d.retryAfter : null }
    case 'secrets_unavailable': return { kind: 'secretsUnavailable', key: str(d.key) }
  }
  if (status === 429) return { kind: 'rateLimited', retryAfter: null }
  return { kind: 'other' }
}

/**
 * Kept in sessionStorage across the re-authentication redirect: which form, its edited plain values and the
 * secrets it clears. Secret values are never kept: `secretsToRetype` names the ones the admin must type again.
 */
export type ReauthStash = {
  category: SettingCategory
  path: string
  values: Record<string, FormValue>
  clears: string[]
  secretsToRetype: string[]
  /**
   * The versions the form had loaded for the edited keys. The replay sends these, not the versions loaded after
   * the redirect, so a change someone made meanwhile is a 409 conflict instead of being overwritten.
   */
  versions: Record<string, number>
  /** Saved automatically on return when nothing needs retyping. */
  action: 'save' | 'generate' | 'webhook'
  /** When it was kept (ms); a stash older than REAUTH_STASH_MAX_MS is dropped. */
  at: number
}

export const REAUTH_STASH_KEY = 'yoda.settings.reauth'
/** Re-authentication is good for 10 minutes (core's `auth_time` window): an older stash is never replayed. */
export const REAUTH_STASH_MAX_MS = 10 * 60 * 1000

export function reauthStash(
  category: SettingCategory,
  path: string,
  views: SettingView[],
  draft: SectionDraft,
  action: ReauthStash['action'] = 'save',
  now = Date.now(),
): ReauthStash {
  const { changes, versions } = draftChanges(views, draft)
  const values: Record<string, FormValue> = {}
  const clears: string[] = []
  const secretsToRetype: string[] = []
  for (const v of views) {
    if (!(v.key in changes)) continue
    if (v.secret) {
      if (changes[v.key] === null) clears.push(v.key)
      else secretsToRetype.push(v.key)
    } else {
      values[v.key] = draft.values[v.key] ?? null
    }
  }
  return { category, path, values, clears, secretsToRetype, versions, action, at: now }
}

/**
 * The stash to replay on this page, or null: it must parse, be no older than 10 minutes (nor from the future),
 * and belong to the path the admin is on. Anything else is discarded without saving.
 */
export function parseReauthStash(raw: string | null, path: string, now = Date.now()): ReauthStash | null {
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as ReauthStash
    if (!s || typeof s.category !== 'string' || !s.values || typeof s.values !== 'object' || !Array.isArray(s.clears) || !Array.isArray(s.secretsToRetype)) return null
    if (!s.versions || typeof s.versions !== 'object' || Object.values(s.versions).some(v => typeof v !== 'number')) return null
    if (typeof s.at !== 'number' || now - s.at > REAUTH_STASH_MAX_MS || s.at - now > 60_000) return null
    if (s.path !== path) return null
    return s
  } catch {
    return null
  }
}

/** The stash applied to a freshly loaded form: plain values restored, clears re-marked, secrets left to retype. */
export function applyReauthStash(views: SettingView[], stash: ReauthStash): SectionDraft {
  const draft = initialDraft(views)
  const known = new Set(views.filter(v => !v.locked).map(v => v.key))
  for (const [k, val] of Object.entries(stash.values)) if (known.has(k) && k in draft.values) draft.values[k] = val
  for (const k of stash.clears) if (known.has(k) && draft.secrets[k]) draft.secrets[k] = { mode: 'clear', value: '' }
  for (const k of stash.secretsToRetype) if (known.has(k) && draft.secrets[k]) draft.secrets[k] = { mode: 'replace', value: '' }
  return draft
}

/**
 * The save body of a replay: the edited keys carry the versions kept in the stash (what the admin saw before
 * signing in again), so a concurrent change gets 409 `version_conflict`. Keys edited only after the return keep
 * the versions loaded now.
 */
export function replayChanges(changes: DraftChanges, stash: Pick<ReauthStash, 'versions'> | null): DraftChanges {
  if (!stash) return changes
  const versions = { ...changes.versions }
  for (const k of Object.keys(changes.changes)) if (Object.hasOwn(stash.versions, k)) versions[k] = stash.versions[k]!
  return { changes: changes.changes, versions }
}

// --- Tests ------------------------------------------------------------------------------------------------------

const KNOWN_CODES = new Set<string>(SETTINGS_TEST_CODES)

/** A test result code as an i18n key and its named values (`http_404` → the HTTP line with status 404). */
export function testCodeMessage(code: string | undefined): { key: string; named?: Record<string, string> } {
  if (!code) return { key: 'settings.test.code.failed' }
  const http = /^http_(\d{3})$/.exec(code)
  if (http) return { key: 'settings.test.code.http', named: { status: http[1]! } }
  if (code === 'http_3xx') return { key: 'settings.test.code.http', named: { status: '3xx' } }
  const smtp = /^smtp_(\d{3})$/.exec(code)
  if (smtp) return { key: 'settings.test.code.smtp', named: { status: smtp[1]! } }
  return { key: KNOWN_CODES.has(code) ? `settings.test.code.${code}` : 'settings.test.code.failed' }
}

const KNOWN_CHECKS = new Set(['discovery', 'jwks', 'client', 'connect', 'send', 'bot', 'webhook', 'user', 'scopes', 'anthropic', 'openai', 'model_draft', 'model_fast', 'model_embed', 'config', 'bucket', 'state', 'token', 'id_token', 'access_token', 'admin', 'staff', 'db', 'pgvector', 'queue'])

/** A check id (`model.draft`) as the i18n key of its label. */
export function checkLabelKey(id: string): string {
  const k = id.replace(/\./g, '_')
  return KNOWN_CHECKS.has(k) ? `settings.test.check.${k}` : 'settings.test.check.other'
}

/** Longest detail shown: some facts come from a third party (a bot's last error), so they are cut short. */
export const DETAIL_MAX = 200

/** Safe detail facts of a check as short "name: value" strings (bot username, scopes, model count). */
export function checkDetails(c: SettingsTestCheck): string[] {
  if (!c.detail) return []
  return Object.entries(c.detail)
    .filter(([, v]) => v !== null && v !== '')
    .map(([k, v]) => {
      const text = `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`
      return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text
    })
}

// --- Audit ------------------------------------------------------------------------------------------------------

/** A shortened fingerprint (`fp:9f1c…`), the only trace a secret leaves in the log. */
export const shortFp = (fp: string | null) => (fp ? `fp:${fp.slice(0, 4)}…` : null)

function showValue(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export type AuditLine = {
  /** i18n key of the verb (`settings.audit.action.set`). */
  actionKey: string
  key: string | null
  from: string | null
  to: string | null
  /** A test's result (`ok` or the first failing code). */
  result: string | null
  secret: boolean
}

const ACTIONS = new Set(['set', 'clear', 'import', 'derived', 'test', 'setup.completed'])

/** One audit row as display parts; secrets show fingerprints only. */
export function auditLine(e: SettingsAuditEntry): AuditLine {
  const secret = !!e.key && isSettingKey(e.key) && SETTINGS[e.key].secret
  const action = ACTIONS.has(e.action) ? e.action.replace('.', '_') : 'other'
  const isTest = e.action === 'test'
  return {
    actionKey: `settings.audit.action.${action}`,
    key: isTest ? null : e.key,
    from: isTest ? null : secret ? shortFp(e.oldFp) : showValue(e.oldValue),
    to: isTest ? null : secret ? shortFp(e.newFp) : showValue(e.newValue),
    result: e.result,
    secret,
  }
}

/** The test name of a test row (`smtp`, `telegram.webhook`). */
export function auditTestName(e: SettingsAuditEntry): string | null {
  const v = e.newValue as { test?: unknown } | null
  return e.action === 'test' && v && typeof v.test === 'string' ? v.test : null
}

/** The icon of a category's card. */
export const CATEGORY_ICONS: Record<SettingCategory, string> = {
  general: 'mdi-domain',
  signin: 'mdi-login',
  ai: 'mdi-robot-outline',
  gitlab: 'mdi-source-branch',
  email: 'mdi-email-outline',
  line: 'mdi-chat-outline',
  telegram: 'mdi-send-outline',
  runners: 'mdi-server-network-outline',
  backups: 'mdi-backup-restore',
  storage: 'mdi-database-outline',
  security: 'mdi-shield-key-outline',
}

/** Where a service posts to the portal: under the public URL when set, else the address the admin is using. */
export function webhookUrl(publicUrl: unknown, origin: string, path: string): string {
  const base = typeof publicUrl === 'string' && publicUrl.trim() ? publicUrl.trim() : origin
  return `${base.replace(/\/+$/, '')}${path}`
}
