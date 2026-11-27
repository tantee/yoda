import { CSRF_HEADER, OPTIONAL_SETUP_STEPS, SETUP_STEPS, normaliseCode, passwordIssue, publicUrlIssue, type ProxyStatus, type SetupProgress, type SetupStepId } from '@yoda/shared'

/**
 * The /setup wizard's plain logic (installer proposal §4.2, §4.3, §8): the cookie-session client, the step order
 * and which steps may be opened, the token boxes, the public URL checks (D8) and the password strength meter.
 * The page talks to core with the `yoda_setup` cookie (HttpOnly, path /api/setup) and the CSRF header; it never
 * uses Keycloak or `useApi`, and keeps nothing in browser storage (progress lives in core).
 */

export type SetupFetcher = <T>(
  path: string,
  opts?: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; query?: Record<string, unknown> },
) => Promise<T>

/** A cookie-session client for `/api/setup/*`; every non-GET call carries the session's CSRF token. */
export function setupClient(fetcher: (url: string, opts: Record<string, unknown>) => Promise<unknown>, csrf: () => string | null): SetupFetcher {
  return async <T>(path: string, opts: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; query?: Record<string, unknown> } = {}) => {
    const method = opts.method ?? 'GET'
    const token = csrf()
    const headers: Record<string, string> = method !== 'GET' && token ? { [CSRF_HEADER]: token } : {}
    return (await fetcher(`/api/setup${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(opts.query ? { query: opts.query } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    })) as T
  }
}

// ── Steps ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const WIZARD_STEPS: readonly SetupStepId[] = SETUP_STEPS
export const isOptionalStep = (s: SetupStepId) => OPTIONAL_SETUP_STEPS.includes(s)
/** The number the step list shows (the token is 0, the claim 10). */
export const stepNumber = (s: SetupStepId) => WIZARD_STEPS.indexOf(s)
export const LAST_STEP = WIZARD_STEPS.length - 1

export function isSetupStep(v: unknown): v is SetupStepId {
  return typeof v === 'string' && (WIZARD_STEPS as readonly string[]).includes(v)
}

const passed = (p: SetupProgress, s: SetupStepId) => p.steps[s] === 'done' || p.steps[s] === 'skipped'

/** The first step that is neither done nor skipped (where a reload resumes); the claim when all are. */
export function resumeStep(p: SetupProgress | null): SetupStepId {
  if (!p) return 'token'
  return WIZARD_STEPS.find((s) => !passed(p, s)) ?? 'claim'
}

/**
 * A step may be opened when every step before it is done or skipped: the public URL is saved before the admin
 * (TOTP-required follows it, D3), sign-in before the claim, and so on. Going back is always allowed.
 */
export function reachable(p: SetupProgress | null, s: SetupStepId): boolean {
  if (s === 'token') return true
  if (!p) return false
  return WIZARD_STEPS.slice(0, stepNumber(s)).every((x) => passed(p, x))
}

/** The step to show: the one asked for (`?step=`) when it may be opened, else where the wizard resumes. */
export function currentStep(p: SetupProgress | null, asked: unknown): SetupStepId {
  if (!p) return 'token'
  if (isSetupStep(asked) && asked !== 'token' && reachable(p, asked)) return asked
  return resumeStep(p)
}

export const nextStep = (s: SetupStepId): SetupStepId | null => WIZARD_STEPS[stepNumber(s) + 1] ?? null
/** Back never goes to the token step (the session is already open). */
export const prevStep = (s: SetupStepId): SetupStepId | null => (stepNumber(s) > 1 ? WIZARD_STEPS[stepNumber(s) - 1]! : null)

export type StepMark = 'done' | 'now' | 'skipped' | 'todo'

/** The step list (done ✓, current, skipped, upcoming), in order. */
export function stepList(p: SetupProgress | null, current: SetupStepId): { id: SetupStepId; mark: StepMark; optional: boolean; number: number; open: boolean }[] {
  return WIZARD_STEPS.map((id) => ({
    id,
    number: stepNumber(id),
    optional: isOptionalStep(id),
    mark: id === current ? 'now' : p?.steps[id] === 'done' ? 'done' : p?.steps[id] === 'skipped' ? 'skipped' : 'todo',
    open: id !== current && id !== 'token' && reachable(p, id),
  }))
}

/** "Step 2 of 10" and the bar on phones. */
export function wizardProgress(s: SetupStepId): { number: number; of: number; percent: number } {
  const n = stepNumber(s)
  return { number: n, of: LAST_STEP, percent: Math.round((n / LAST_STEP) * 100) }
}

// ── Token ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const TOKEN_GROUPS = 5
export const TOKEN_GROUP_LENGTH = 4
const TOKEN_ALLOWED = /[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g

/** What was typed or pasted into the token boxes, as 5 groups of 4 (case and dashes ignored, 8.2). */
export function tokenGroups(input: string): string[] {
  const clean = normaliseCode(input).replace(TOKEN_ALLOWED, '').slice(0, TOKEN_GROUPS * TOKEN_GROUP_LENGTH)
  return Array.from({ length: TOKEN_GROUPS }, (_, i) => clean.slice(i * TOKEN_GROUP_LENGTH, (i + 1) * TOKEN_GROUP_LENGTH))
}

/** Typing into box `i`: only that box changes (the others keep what they have). */
export function typedInto(groups: string[], i: number, typed: string): string[] {
  const own = tokenGroups(typed)[0]!
  return groups.map((g, j) => (j === i ? own : g))
}

/** A paste into box `i`: the boxes before it stay, the pasted token fills from `i` on and replaces the rest. */
export function pastedInto(groups: string[], i: number, text: string): string[] {
  return tokenGroups(groups.slice(0, i).join('') + text)
}

/** The bits of an InputEvent `pasteLikeText` reads (kept structural for tests). */
export type InputLike = { inputType: string; data: string | null; dataTransfer: { getData(type: string): string } | null }

const PASTE_LIKE = new Set(['insertFromPaste', 'insertFromDrop', 'insertReplacementText', 'insertFromYank'])

/**
 * The text of a `beforeinput` that puts in more than a keystroke (a drop, autofill or a spelling replacement, a
 * paste the `paste` handler missed), so the box treats it as a paste; null for typing.
 */
export function pasteLikeText(e: InputLike): string | null {
  if (!PASTE_LIKE.has(e.inputType)) return null
  const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? e.dataTransfer?.getData('text') ?? ''
  return text ? text : null
}

export const tokenComplete = (groups: string[]) => groups.length === TOKEN_GROUPS && groups.every((g) => g.length === TOKEN_GROUP_LENGTH)
export const tokenValue = (groups: string[]) => groups.join('-')

// ── Public URL (D8: https, or this machine: localhost, *.localhost, 127.0.0.0/8, ::1) ─────────────────────────────────────────────────────────────────────────────────────────────

export type UrlCheck = {
  /** Not an http(s) URL with a host and nothing after the path. */
  invalid: boolean
  /**
   * D8 (owner decision, 2026-11-27): plain http on a host that is not this machine. Refused, here and by core
   * (`https_required`): the browser allows the Keycloak sign-in only on https or localhost.
   */
  httpsRequired: boolean
  /** The browser reaches Yoda at another address than the one entered (§4.2 step 1 test). */
  mismatch: boolean
  /** The URL without a trailing slash, as core stores it. */
  normalised: string
}

export function checkPublicUrl(input: string, browserOrigin: string): UrlCheck {
  const raw = input.trim()
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { invalid: true, httpsRequired: false, mismatch: false, normalised: raw }
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.search || u.hash || u.username || u.password) {
    return { invalid: true, httpsRequired: false, mismatch: false, normalised: raw }
  }
  const normalised = raw.replace(/\/+$/, '')
  return {
    invalid: false,
    httpsRequired: publicUrlIssue(normalised) === 'https_required',
    mismatch: !!browserOrigin && u.origin !== browserOrigin,
    normalised,
  }
}

/** The redirect, post-logout and web-origin values to paste into the Keycloak client (§4.2 step 4). */
export function keycloakClientValues(publicUrl: string): { redirect: string; postLogout: string; webOrigin: string } {
  let origin = publicUrl.replace(/\/+$/, '')
  try {
    origin = new URL(publicUrl).origin
  } catch {
    // shown as typed
  }
  return { redirect: `${origin}/*`, postLogout: `${origin}/*`, webOrigin: origin }
}

// ── Password strength (§4.2 step 2: score ≥ 3 and 14+ characters) ──────────────────────────────────────────────

/**
 * Words a break-glass password must not lean on. A small stand-in for zxcvbn's dictionaries (its packages add
 * megabytes for one form): with the 14-character minimum, guessable passwords are mostly words, runs and repeats.
 */
const COMMON = [
  'password', 'passwort', 'qwerty', 'azerty', 'admin', 'administrator', 'letmein', 'welcome', 'iloveyou', 'monkey',
  'dragon', 'secret', 'changeme', 'default', 'login', 'master', 'root', 'yoda', 'hospital', 'keycloak', 'break',
  'glass', 'recovery', 'sunshine', 'football', 'baseball', 'princess', 'superman', 'trustno1', 'abc123', 'test',
]
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' }
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890']

export type StrengthWarning = 'short' | 'repeat' | 'sequence' | 'common' | 'username'
export type Strength = { score: 0 | 1 | 2 | 3 | 4; bits: number; warnings: StrengthWarning[] }

function pool(pw: string): number {
  let n = 0
  if (/[a-z]/.test(pw)) n += 26
  if (/[A-Z]/.test(pw)) n += 26
  if (/[0-9]/.test(pw)) n += 10
  if (/[^A-Za-z0-9]/.test(pw)) n += 33
  return Math.max(n, 10)
}

const adjacent = (a: string, b: string) => {
  if (Math.abs(a.charCodeAt(0) - b.charCodeAt(0)) === 1) return true
  return KEYBOARD_ROWS.some((row) => {
    const i = row.indexOf(a)
    return i >= 0 && (row[i + 1] === b || row[i - 1] === b)
  })
}

/** The smallest unit the password repeats (`abcabcabc` → `abc`), or the password itself. */
function repeatedUnit(pw: string): string {
  for (let len = 1; len <= pw.length / 2; len++) {
    if (pw.length % len === 0 && pw.slice(0, len).repeat(pw.length / len) === pw) return pw.slice(0, len)
  }
  return pw
}

/**
 * An estimate of how guessable a password is, on zxcvbn's 0–4 scale (log2 of the guesses: below 10, 20, 26.6 and
 * 33.2 bits are 0–3). Each character costs log2 of its character pool, a repeat of the one before half a bit, the
 * next in a run (abc, 321, qwe) one bit; a dictionary word or the username costs 6 bits as a whole, and a password
 * made of one repeated unit costs that unit plus the count.
 */
export function passwordStrength(password: string, username = ''): Strength {
  const warnings = new Set<StrengthWarning>()
  if (password.length < 14) warnings.add('short')
  const unit = repeatedUnit(password)
  const pw = unit
  const per = Math.log2(pool(password))
  const cost = Array.from(pw, (ch, i) => {
    if (i === 0) return per
    const prev = pw[i - 1]!
    if (ch === prev) {
      warnings.add('repeat')
      return 0.5
    }
    if (adjacent(prev.toLowerCase(), ch.toLowerCase())) {
      if (i >= 2 && adjacent(pw[i - 2]!.toLowerCase(), prev.toLowerCase())) warnings.add('sequence')
      return 1
    }
    return per
  })
  const plain = Array.from(pw.toLowerCase(), (c) => LEET[c] ?? c).join('')
  const words = [...COMMON, ...(username.trim().length >= 3 ? [username.trim().toLowerCase()] : [])]
  for (const w of words) {
    let at = plain.indexOf(w)
    while (at >= 0) {
      warnings.add(w === username.trim().toLowerCase() ? 'username' : 'common')
      for (let i = at; i < at + w.length; i++) cost[i] = i === at ? 6 : 0
      at = plain.indexOf(w, at + w.length)
    }
  }
  let bits = cost.reduce((a, b) => a + b, 0)
  if (unit.length < password.length) {
    warnings.add('repeat')
    bits += Math.log2(password.length / unit.length)
  }
  const score = bits < 10 ? 0 : bits < 20 ? 1 : bits < 26.6 ? 2 : bits < 33.2 ? 3 : 4
  return { score, bits: Math.round(bits * 10) / 10, warnings: [...warnings] }
}

/**
 * The wizard's rule: core's minimum (14+, not too simple, no username) and a strength score of 3 or more: zxcvbn's
 * when it is loaded (`score`), else the estimator's.
 */
export function passwordAcceptable(username: string, password: string, score?: number): boolean {
  return passwordIssue(username, password) === null && (score ?? passwordStrength(password, username).score) >= 3
}

// ── Errors ──────────────────────────────────────────────────────────────────────────────────────────────────────

const ERRORS: Record<string, string> = {
  invalid_credentials: 'setup.error.invalidToken',
  rate_limited: 'setup.error.rateLimited',
  csrf_failed: 'setup.error.csrfFailed',
  unauthorized: 'setup.error.sessionExpired',
  weak_password: 'setup.error.weakPassword',
  second_factor_required: 'setup.error.totpRequired',
  invalid_code: 'setup.error.invalidCode',
  secrets_unavailable: 'setup.error.secretsUnavailable',
  setting_locked: 'setup.error.settingLocked',
  invalid_settings: 'setup.error.invalidSettings',
  not_found: 'setup.error.done',
}

const STATES: Record<string, string> = {
  kit_downloaded: 'setup.error.kitDownloaded',
  incomplete: 'setup.error.incomplete',
  no_issuer: 'setup.error.noIssuer',
  no_admin: 'setup.error.noAdmin',
  totp_enabled: 'setup.error.totpEnabled',
}

/** The i18n key and values for a failed setup call. */
export function setupError(e: unknown): { key: string; named?: Record<string, unknown> } {
  const data = (e as { data?: { error?: string; retryAfter?: number; reason?: string; issues?: { key?: string; message?: string }[] } })?.data
  const code = data?.error
  // D8: core refuses a plain-http public URL away from this machine (on save and on complete).
  if (code === 'invalid_settings' && Array.isArray(data?.issues) && data.issues.some(i => i?.message === 'https_required')) return { key: 'setup.error.httpsRequired' }
  if (code === 'rate_limited') return { key: 'setup.error.rateLimited', named: { minutes: Math.max(1, Math.ceil((data?.retryAfter ?? 60) / 60)) } }
  if (code === 'invalid_state' && data?.reason && STATES[data.reason]) return { key: STATES[data.reason]! }
  if (code === 'bad_request' && data?.reason) return { key: 'setup.error.provider' }
  if (code && ERRORS[code]) return { key: ERRORS[code]! }
  return { key: 'setup.error.generic' }
}

/** The setup session is gone (expired, or setup was finished elsewhere): back to the token step. */
export function setupSessionLost(e: unknown): boolean {
  const err = e as { statusCode?: number; status?: number; data?: { error?: string } }
  const status = err?.statusCode ?? err?.status
  return (status === 401 && err?.data?.error === 'unauthorized') || (status === 403 && err?.data?.error === 'csrf_failed')
}

/** Setup was completed (every /setup route is 404 then, 8.1). */
export function setupFinished(e: unknown): boolean {
  const err = e as { statusCode?: number; status?: number }
  return (err?.statusCode ?? err?.status) === 404
}

// ── Built-in HTTPS proxy (docs/operations.md, section 4b) ──────────────────────────────────────────────────────

const DAY_MS = 86_400_000

/**
 * How the presented certificate stands: `expired`; `soon` only for the organisation's own files (fewer than 30 days
 * left: someone has to replace them), since Caddy renews internal and ACME certificates itself (an internal one
 * lives hours); `ok` otherwise, or null without a certificate.
 */
export function proxyCertState(s: ProxyStatus, now: Date): 'ok' | 'soon' | 'expired' | null {
  const to = s.certificate?.validTo ? new Date(s.certificate.validTo).getTime() : Number.NaN
  if (Number.isNaN(to)) return null
  if (to <= now.getTime()) return 'expired'
  if (s.certMode === 'files' && to - now.getTime() < 30 * DAY_MS) return 'soon'
  return 'ok'
}
