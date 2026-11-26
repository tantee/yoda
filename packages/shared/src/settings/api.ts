import { z } from 'zod'
import { SettingCategory, SettingWriteSource } from './registry.js'

/**
 * The admin settings API (installer proposal §5.2, §11): what `GET /admin/settings` shows, what
 * `PUT /admin/settings/:category` takes, the test results and the audit page. A secret's value never appears in
 * any of these: only whether it is set, its hint (last 4 characters of a value of 20 or more) and who set it.
 */

export const SettingSourceView = z.enum(['env', 'db', 'default', 'unset'])
export type SettingSourceView = z.infer<typeof SettingSourceView>

/**
 * Why a setting cannot be changed here. `env`: set in the deploy host's env (`envName` names it);
 * `bootstrap`: env/bootstrap only (8.6); `readonly`: shown, never edited (filled by the system);
 * `recovery_only`: only from a recovery session (the OIDC issuer, client id and JWKS URL, 8.6);
 * `managed_on_host`: read by another container (portal, backup) that does not read the database yet, so it is
 * set on the install host (`envName` on `container`).
 */
export const SettingLockReason = z.enum(['env', 'bootstrap', 'readonly', 'recovery_only', 'managed_on_host'])
export type SettingLockReason = z.infer<typeof SettingLockReason>

export const SettingActorView = z.object({ personId: z.string().nullable(), label: z.string().nullable() })

export const SettingView = z.object({
  key: z.string(),
  category: SettingCategory,
  secret: z.boolean(),
  apply: z.enum(['live', 'reconnect', 'restart']),
  source: SettingSourceView,
  envName: z.string().optional(),
  locked: z.object({ reason: SettingLockReason, envName: z.string().optional(), container: z.string().optional() }).nullable(),
  /**
   * Env-locked settings only. `importable`: the env value is copied into the database on boot (D4), so removing
   * the variable keeps it; false for a secret when the master key is not usable or YODA_SETTINGS_IMPORT=false
   * (removing it then disconnects the service).
   */
  importable: z.boolean().optional(),
  /** Non-secrets only (absent when unset). */
  value: z.unknown().optional(),
  /** Secrets only. `unavailable`: stored, but the master key cannot decrypt it (recovery). */
  secretState: z
    .object({ set: z.boolean(), hint: z.string().nullable(), unavailable: z.boolean(), updatedAt: z.string().nullable(), updatedBy: SettingActorView.nullable() })
    .optional(),
  /** The row version for optimistic concurrency; 0 when nothing is stored. */
  version: z.number().int(),
  updatedAt: z.string().nullable(),
  updatedBy: SettingActorView.nullable(),
  writeSource: SettingWriteSource.nullable(),
  /** Restart-mode setting changed since core booted: the running process still uses the old value. */
  restartRequired: z.boolean(),
  /** The test action that checks it, if any. */
  test: z.string().optional(),
  /** Secrets cleared when this endpoint changes (8.6). */
  boundSecrets: z.array(z.string()).optional(),
})
export type SettingView = z.infer<typeof SettingView>

/** A note about a value in effect or just saved: `unpriced_model`, `embedding_model_changed`. */
export const SettingWarning = z.object({ key: z.string(), code: z.string(), count: z.number().optional() })
export type SettingWarning = z.infer<typeof SettingWarning>

export const MasterKeyView = z.object({
  status: z.enum(['ok', 'missing', 'malformed', 'mismatch']),
  keyId: z.string().nullable(),
  recovery: z.boolean(),
})
export type MasterKeyView = z.infer<typeof MasterKeyView>

export const SettingsCategoryView = z.object({ category: SettingCategory, settings: z.array(SettingView), test: z.string().nullable() })
export type SettingsCategoryView = z.infer<typeof SettingsCategoryView>

export const AdminSettingsResponse = z.object({
  masterKey: MasterKeyView,
  restartRequired: z.array(z.string()),
  categories: z.array(SettingsCategoryView),
  warnings: z.array(SettingWarning),
})
export type AdminSettingsResponse = z.infer<typeof AdminSettingsResponse>

/**
 * A partial save of one category: `changes[key]` is the new value, or null to clear it (back to the default;
 * for a secret, remove it). `versions[key]` is the version the form loaded (0 = nothing stored); a stale one is
 * 409 `version_conflict`.
 */
export const SettingsPutBody = z.object({
  changes: z.record(z.string(), z.unknown()).refine((c) => Object.keys(c).length > 0, { message: 'empty_patch' }),
  versions: z.record(z.string(), z.number().int().min(0)).optional(),
})
export type SettingsPutBody = z.infer<typeof SettingsPutBody>

export const SettingsPutResponse = z.object({
  applied: z.array(z.string()),
  /** Secrets cleared because their endpoint changed (8.6). */
  cleared: z.array(z.string()),
  restartRequired: z.array(z.string()),
  warnings: z.array(SettingWarning),
  category: SettingsCategoryView,
})
export type SettingsPutResponse = z.infer<typeof SettingsPutResponse>

export const SettingsTestAction = z.enum(['oidc', 'smtp', 'line', 'telegram', 'gitlab', 'ai', 'backup', 'storage'])
export type SettingsTestAction = z.infer<typeof SettingsTestAction>

/**
 * Draft values to test before saving: any of the category's keys. A secret left out uses the stored one, except
 * when an endpoint it is bound to differs from the saved one (then it must be given). `sendTo: 'self'` (email)
 * also sends a test message to the admin's own address.
 */
export const SettingsTestBody = z.object({
  values: z.record(z.string(), z.unknown()).default({}),
  sendTo: z.literal('self').optional(),
})
export type SettingsTestBody = z.infer<typeof SettingsTestBody>

/** One check: a short code on failure (`timeout`, `auth_rejected`, `http_404`, ...), never a server's content. */
export const SettingsTestCheck = z.object({
  id: z.string(),
  ok: z.boolean(),
  ms: z.number(),
  code: z.string().optional(),
  /** Short, safe facts only (a bot username, token scopes, a model count). */
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])).optional(),
})
export type SettingsTestCheck = z.infer<typeof SettingsTestCheck>

export const SettingsTestResult = z.object({
  action: SettingsTestAction,
  ok: z.boolean(),
  checks: z.array(SettingsTestCheck),
})
export type SettingsTestResult = z.infer<typeof SettingsTestResult>

export const SettingsAuditQuery = z.object({
  category: SettingCategory.optional(),
  key: z.string().optional(),
  /** The `nextCursor` of the previous page. */
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type SettingsAuditQuery = z.infer<typeof SettingsAuditQuery>

/** A secret's row carries fingerprints (HMAC, §5.4) only: never the value. */
export const SettingsAuditEntry = z.object({
  id: z.number(),
  at: z.string(),
  actor: SettingActorView,
  source: z.string(),
  action: z.string(),
  key: z.string().nullable(),
  category: SettingCategory.nullable(),
  oldValue: z.unknown().nullable(),
  newValue: z.unknown().nullable(),
  oldFp: z.string().nullable(),
  newFp: z.string().nullable(),
  result: z.string().nullable(),
  ip: z.string().nullable(),
  requestId: z.string().nullable(),
})
export type SettingsAuditEntry = z.infer<typeof SettingsAuditEntry>

export const SettingsAuditPage = z.object({ entries: z.array(SettingsAuditEntry), nextCursor: z.number().nullable() })
export type SettingsAuditPage = z.infer<typeof SettingsAuditPage>

/** `POST /admin/settings/telegram/webhook`: `dropPending` discards the updates Telegram holds (confirm first). */
export const TelegramWebhookBody = z.object({ dropPending: z.boolean().default(false) })
export type TelegramWebhookBody = z.infer<typeof TelegramWebhookBody>

/** `POST /admin/settings/:category/generate/:key`: the generated secret, shown this once. */
export const GeneratedSecret = z.object({ key: z.string(), value: z.string(), version: z.number() })
export type GeneratedSecret = z.infer<typeof GeneratedSecret>

/**
 * Every fixed result code a settings test can return (core `settings/tests.ts`, `settings/outbound.ts` and `local/oidc-change.ts`), so the
 * portal can word each one. `http_<status>` and `smtp_<reply code>` carry a number and are matched by pattern.
 * A portal test reads core's sources and fails when a new code is missing here.
 */
export const SETTINGS_TEST_CODES = [
  // outcomes
  'not_configured', 'secret_required', 'auth_rejected', 'invalid_response', 'failed', 'rejected', 'unreachable', 'invalid_config',
  // safeOutbound refusals and failures
  'invalid_url', 'scheme_not_allowed', 'https_required', 'blocked_host', 'blocked_address', 'blocked_port', 'dns_failed',
  'connect_failed', 'timeout', 'tls_failed', 'too_large',
  // per action
  'issuer_mismatch', 'no_keys', 'client_rejected', 'smtp_error', 'no_address', 'no_sender', 'webhook_not_registered',
  'missing_scope', 'model_not_found', 'provider_unavailable', 'no_embeddings',
  // the /recovery test sign-in of a pending OIDC change (core local/oidc-change.ts)
  'state_mismatch', 'expired', 'pending_changed', 'code_rejected', 'token_invalid', 'nonce_mismatch', 'azp_mismatch',
  'typ_mismatch', 'claims_missing', 'groups_missing', 'not_admin',
  // the setup wizard's system check and claim sign-in (core routes/setup-wizard.ts)
  'no_pgvector', 'not_staff',
] as const
export type SettingsTestCode = (typeof SETTINGS_TEST_CODES)[number]
