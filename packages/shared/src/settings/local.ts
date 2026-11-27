import { z } from 'zod'
import { SettingsTestCheck } from './api.js'

/**
 * Setup and recovery before Keycloak works (installer proposal §4.1, §7, §8, §11): the setup token, the
 * break-glass admin and the `/recovery` API. Both use a cookie session (`yoda_setup` on /api/setup, `yoda_bg` on
 * /api/recovery) plus the `X-Yoda-CSRF` header on every non-GET request; the CSRF token comes back from the
 * session calls. Nothing here ever carries a stored secret: a TOTP seed and the recovery codes are shown once.
 */

/** 32 symbols without 0/O and 1/I, so a token read from a log is not mistyped (8.2). */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ' + '23456789'
/** The CSRF header for setup and recovery calls (8.3). */
export const CSRF_HEADER = 'x-yoda-csrf'

/** Upper-cased, with spaces and dashes dropped: the form a token or recovery code is compared in. */
export function normaliseCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/g, '')
}

export const BreakGlassUsername = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, 'must be 3-32 characters of a-z, 0-9, ., _ and -')

/** At least 14 characters (§4.2); a password is never trimmed. */
export const BreakGlassPassword = z.string().min(14).max(256)

/**
 * Why a break-glass password is refused, or null. Besides the length rule: not mostly one character, and not
 * containing the username (a small stand-in for a strength score; the spec's zxcvbn check is the wizard's).
 */
export function passwordIssue(username: string, password: string): 'too_short' | 'too_simple' | 'contains_username' | null {
  if (password.length < 14) return 'too_short'
  if (new Set(password).size < 6) return 'too_simple'
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'contains_username'
  return null
}

/**
 * A host name (no port; `[::1]` brackets allowed) that is this machine: `localhost`, a `*.localhost` name,
 * 127.0.0.0/8 or `::1`. The browser treats exactly these as a secure context over plain http, so Web Crypto (and
 * the portal's Keycloak sign-in) work there. Used by D3 (TOTP optional only on localhost) and D8.
 */
export function isLocalhostHost(host: string | null | undefined): boolean {
  if (!host) return false
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '::1'
}

/**
 * D8 (owner decision, 2026-11-27): the public URL must be https, unless its host is this machine
 * ({@link isLocalhostHost}: `localhost`, `*.localhost`, 127.0.0.0/8, `::1`), as through an SSH tunnel. A browser
 * refuses the Keycloak sign-in (PKCE needs Web Crypto) on plain http anywhere else, so nobody could sign in.
 * Any other scheme (`ftp:`, `ws:`, ...) is refused too: the schema accepts any URL, and only https serves the sign-in.
 * `https_required` when refused; null when fine or not a URL at all (the schema reports that).
 */
export function publicUrlIssue(url: string | null | undefined): 'https_required' | null {
  if (!url) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol === 'https:') return null
  return u.protocol === 'http:' && isLocalhostHost(u.hostname) ? null : 'https_required'
}

export const TotpCode = z.string().trim().regex(/^\d{6}$/, 'must be 6 digits')
/** A recovery code as typed (dashes and spaces allowed). */
export const RecoveryCodeInput = z.string().trim().min(8).max(40)

/** A cookie session's state as the page sees it. `insecure`: the cookie went out without `Secure` (plain HTTP, D8). */
export const LocalSession = z.object({
  csrf: z.string(),
  expiresAt: z.string(),
  idleExpiresAt: z.string(),
  insecure: z.boolean(),
})
export type LocalSession = z.infer<typeof LocalSession>

// ── Setup ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const SetupStatus = z.object({
  required: z.literal(true),
  /** The origin the browser reached core through (the portal's), to pre-fill the public URL. */
  detectedUrl: z.string(),
  https: z.boolean(),
  /** This browser holds a live setup session. */
  session: z.boolean(),
  /** TOTP is required for the break-glass admin: the public URL is not localhost (D3). */
  totpRequired: z.boolean(),
  steps: z.object({ admin: z.enum(['todo', 'done']) }),
})
export type SetupStatus = z.infer<typeof SetupStatus>

export const SetupSessionBody = z.object({ token: z.string().min(1).max(64) })

/** A new TOTP seed: the `otpauth://` URI for the QR code and the base32 secret for typing in. Shown once. */
export const TotpEnrolment = z.object({ uri: z.string(), secret: z.string() })
export type TotpEnrolment = z.infer<typeof TotpEnrolment>

export const SetupAdminBody = z.object({
  username: BreakGlassUsername,
  password: BreakGlassPassword,
  /** The current code of the seed from `POST /setup/totp`; required unless the public URL is localhost. */
  totpCode: TotpCode.optional(),
})

export const SetupAdminResult = z.object({
  username: z.string(),
  totpEnabled: z.boolean(),
  /** 10 single-use codes, shown this once. */
  recoveryCodes: z.array(z.string()),
  /** The setup session is rotated here: the new cookie is set, and this is its CSRF token. */
  session: LocalSession,
})
export type SetupAdminResult = z.infer<typeof SetupAdminResult>

/**
 * TOTP for the existing break-glass admin (created without it while the public URL was localhost, D3): the seed
 * from `POST /setup/totp`, confirmed with its current code and the admin's password.
 */
export const SetupTotpConfirmBody = z.object({ password: z.string().min(1).max(256), totpCode: TotpCode })
export const SetupTotpConfirmResult = z.object({ username: z.string(), totpEnabled: z.boolean(), session: LocalSession })
export type SetupTotpConfirmResult = z.infer<typeof SetupTotpConfirmResult>

// ── Recovery ───────────────────────────────────────────────────────────────────────────────────────────────────

export const RecoverySignInBody = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
  totpCode: TotpCode.optional(),
  recoveryCode: RecoveryCodeInput.optional(),
})

export const BreakGlassView = z.object({
  username: z.string(),
  totpEnabled: z.boolean(),
  /** A temporary password from `yoda-admin reset-break-glass`: change it before anything else. */
  mustChangePassword: z.boolean(),
  /** TOTP is required here and not enrolled (after a reset): enrol it before anything else. */
  mustEnrolTotp: z.boolean(),
  recoveryCodesLeft: z.number().int(),
})
export type BreakGlassView = z.infer<typeof BreakGlassView>

export const RecoverySession = LocalSession.extend({
  admin: BreakGlassView,
  /** Only the password and TOTP calls are open until the reset is finished. */
  restricted: z.boolean(),
  /**
   * The master key is wrong or missing (7.4): the session sees the status only (and may change a temporary
   * password); everything else, TOTP enrolment too, waits for the key to be fixed on the install host.
   */
  statusOnly: z.boolean(),
  /** New recovery codes, shown once, when this call finished a reset from the install host. */
  recoveryCodes: z.array(z.string()).optional(),
})
export type RecoverySession = z.infer<typeof RecoverySession>

export const OidcValues = z.object({
  issuer: z.string().url().transform((s) => s.replace(/\/+$/, '')),
  clientId: z.string().trim().min(1).max(200),
  jwksUrl: z
    .string()
    .url()
    .transform((s) => s.replace(/\/+$/, ''))
    .nullable(),
})
export type OidcValues = z.infer<typeof OidcValues>

/** The sign-in settings in effect (an unset issuer is null). */
export const OidcCurrent = z.object({ issuer: z.string().nullable(), clientId: z.string(), jwksUrl: z.string().nullable() })
export type OidcCurrent = z.infer<typeof OidcCurrent>

export const OidcPending = z.object({
  values: OidcValues,
  stagedAt: z.string(),
  stagedBy: z.string(),
  /** A test sign-in through these values passed (who signed in, when); Apply needs it. */
  testedAt: z.string().nullable(),
  testedUsername: z.string().nullable(),
})
export type OidcPending = z.infer<typeof OidcPending>

/** The values before the last apply; Rollback puts them back until `until` (7 days, 8.6). */
export const OidcRollback = z.object({ values: OidcCurrent, appliedAt: z.string(), until: z.string() })
export type OidcRollback = z.infer<typeof OidcRollback>

export const RecoveryStatus = z.object({
  masterKey: z.object({ status: z.enum(['ok', 'missing', 'malformed', 'mismatch']), keyId: z.string().nullable(), recovery: z.boolean() }),
  setup: z.enum(['required', 'done']),
  oidc: z.object({
    current: OidcCurrent,
    /** Set in the install host's env, so not changed here. */
    envLocked: z.array(z.string()),
    pending: OidcPending.nullable(),
    rollback: OidcRollback.nullable(),
  }),
  funMode: z.boolean(),
  breakGlass: BreakGlassView,
})
export type RecoveryStatus = z.infer<typeof RecoveryStatus>

/** Discovery, JWKS and client checks of the pending values (no sign-in). */
export const OidcCheckResult = z.object({ ok: z.boolean(), checks: z.array(SettingsTestCheck) })
export type OidcCheckResult = z.infer<typeof OidcCheckResult>

export const OidcSignInStart = z.object({ authorizeUrl: z.string(), redirectUri: z.string() })
export type OidcSignInStart = z.infer<typeof OidcSignInStart>

/** What the identity provider sent back to `/recovery` (query parameters). */
export const OidcCallbackBody = z.object({ code: z.string().min(1).max(4096), state: z.string().min(1).max(256) })

export const PasswordChangeBody = z.object({
  newPassword: BreakGlassPassword,
  /** The current second factor; not needed for a temporary password with no TOTP enrolled. */
  totpCode: TotpCode.optional(),
  recoveryCode: RecoveryCodeInput.optional(),
})

export const TotpConfirmBody = z.object({
  /** A code of the new seed. */
  code: TotpCode,
  /** The current second factor when TOTP is already enrolled. */
  currentTotpCode: TotpCode.optional(),
  recoveryCode: RecoveryCodeInput.optional(),
})

/** Portal admins as /recovery sees them (§7.4, T4): grant and revoke need the current second factor. */
export const RecoveryAdmins = z.object({
  admins: z.array(z.object({ username: z.string(), displayName: z.string(), lastSeenAt: z.string() })),
  /**
   * Usernames that become admin when a person with that username is first created (`oidc.bootstrapAdmins`): a
   * grant covers the same username under another identity provider. Used up at that first sign-in.
   */
  preGranted: z.array(z.string()),
  /** BOOTSTRAP_ADMINS is set in env: pre-grants are managed there. */
  preGrantLocked: z.boolean(),
})
export type RecoveryAdmins = z.infer<typeof RecoveryAdmins>

export const RecoveryAdminBody = z.object({
  username: z.string().trim().min(1).max(200),
  /** Revoke: taking admin from the last portal admin needs this (409 `last_admin` otherwise). */
  confirmLastAdmin: z.boolean().optional(),
  totpCode: TotpCode.optional(),
  recoveryCode: RecoveryCodeInput.optional(),
})
export type RecoveryAdminBody = z.infer<typeof RecoveryAdminBody>

/** For the banner on admin pages (§7.4): a break-glass session is open right now. */
export const RecoveryActivity = z.object({ active: z.boolean(), username: z.string().nullable(), since: z.string().nullable() })
export type RecoveryActivity = z.infer<typeof RecoveryActivity>

export const RecoveryCodesBody = z.object({ totpCode: TotpCode.optional(), recoveryCode: RecoveryCodeInput.optional() })
export const RecoveryCodesResult = z.object({ recoveryCodes: z.array(z.string()) })
export type RecoveryCodesResult = z.infer<typeof RecoveryCodesResult>

// ── Setup wizard (installer proposal §4.2, §8.1) ───────────────────────────────────────────────────────────────

/**
 * The wizard's steps in order (§4.2): 0 token, 1 organisation (with the default language), 2 break-glass admin,
 * 3 system check, 4 sign-in (OIDC), 5–8 optional (email, LINE, Telegram; GitLab, AI and backups), 9 recovery
 * kit, 10 claim admin and finish.
 */
export const SETUP_STEPS = ['token', 'organisation', 'admin', 'check', 'signin', 'email', 'line', 'telegram', 'more', 'kit', 'claim'] as const
export const SetupStepId = z.enum(SETUP_STEPS)
export type SetupStepId = z.infer<typeof SetupStepId>
/** Steps that may be skipped (they say where to find the settings later). */
export const OPTIONAL_SETUP_STEPS: readonly SetupStepId[] = ['email', 'line', 'telegram', 'more']
/** What completing setup checks in one transaction (8.1); the sign-in test is the claim's sign-in. */
export const REQUIRED_FOR_COMPLETION: readonly SetupStepId[] = ['organisation', 'admin', 'kit', 'claim']
/** The settings categories the wizard reads, saves and tests through the setup session. */
export const SETUP_CATEGORIES = ['general', 'signin', 'email', 'line', 'telegram', 'gitlab', 'ai', 'backups', 'storage'] as const

export const SetupStepState = z.enum(['todo', 'done', 'skipped'])
export type SetupStepState = z.infer<typeof SetupStepState>

/** Where the wizard stands, kept server-side (the setting rows are real), so a reload or a new token resumes. */
export const SetupProgress = z.object({
  installId: z.string(),
  steps: z.object(Object.fromEntries(SETUP_STEPS.map((s) => [s, SetupStepState])) as Record<SetupStepId, typeof SetupStepState>),
  /** TOTP is required for the break-glass admin (D3, from the saved public URL and this request's host). */
  totpRequired: z.boolean(),
  admin: z.object({ username: z.string(), totpEnabled: z.boolean() }).nullable(),
  /** The recovery kit was downloaded (the master key is not shown again after the re-issue window). */
  kitDownloadedAt: z.string().nullable(),
  /** This session downloaded the kit and may have it issued again (new codes, same key) until then; else null. */
  kitReissueUntil: z.string().nullable(),
  /** The break-glass admin has no TOTP, but the public URL saved since makes it required (D3). */
  adminNeedsTotp: z.boolean(),
  /** The person who signed in through OIDC at the claim step and became the first portal admin. */
  claimed: z.object({ username: z.string(), at: z.string() }).nullable(),
  /** Required steps not done yet; empty: setup can be completed. */
  missing: z.array(SetupStepId),
})
export type SetupProgress = z.infer<typeof SetupProgress>

/** Marks a step the server cannot see for itself: the system check viewed, an optional step done or skipped. */
export const SetupStepBody = z.object({ step: z.enum(['check', 'email', 'line', 'telegram', 'more']), state: z.enum(['done', 'skipped']) })
export type SetupStepBody = z.infer<typeof SetupStepBody>

/** The recovery kit (D7): one text file with the master key and fresh break-glass recovery codes. Shown once. */
export const RecoveryKit = z.object({
  filename: z.string(),
  content: z.string(),
  recoveryCodes: z.array(z.string()),
  downloadedAt: z.string(),
  /** Issued again in the same session (fresh codes; the earlier file's codes no longer work). */
  reissued: z.boolean(),
})
export type RecoveryKit = z.infer<typeof RecoveryKit>

/** The claim sign-in's checks; `username` became the first portal admin when `ok`. */
export const SetupClaimResult = OidcCheckResult.extend({ username: z.string().nullable() })
export type SetupClaimResult = z.infer<typeof SetupClaimResult>
