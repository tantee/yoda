import { CSRF_HEADER } from '@yoda/shared'

/**
 * The /recovery page's plain logic (installer proposal §7.4, §8.3, §8.6). The page talks to core with the
 * `yoda_bg` cookie (HttpOnly, path /api/recovery) and the CSRF header; it never uses Keycloak or `useApi`.
 */

export type Fetcher = <T>(path: string, opts?: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown }) => Promise<T>

/** A cookie-session client for `/api/recovery/*`; every non-GET call carries the session's CSRF token. */
export function recoveryClient(fetcher: (url: string, opts: Record<string, unknown>) => Promise<unknown>, csrf: () => string | null): Fetcher {
  return async <T>(path: string, opts: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {}) => {
    const method = opts.method ?? 'GET'
    const token = csrf()
    const headers: Record<string, string> = method !== 'GET' && token ? { [CSRF_HEADER]: token } : {}
    return (await fetcher(`/api/recovery${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    })) as T
  }
}

/** The identity provider's answer in the /recovery URL after a test sign-in, or null. */
export function oidcCallback(query: Record<string, unknown>): { code: string; state: string } | null {
  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v)
  const code = one(query.code)
  const state = one(query.state)
  return typeof code === 'string' && code && typeof state === 'string' && state ? { code, state } : null
}

/** The provider refused or the person cancelled (`?error=...` on the way back). */
export function oidcCallbackError(query: Record<string, unknown>): boolean {
  return typeof query.error === 'string' && query.error !== ''
}

const ERRORS: Record<string, string> = {
  invalid_credentials: 'recovery.error.invalidCredentials',
  second_factor_required: 'recovery.error.secondFactorRequired',
  invalid_code: 'recovery.error.invalidCode',
  rate_limited: 'recovery.error.rateLimited',
  secrets_unavailable: 'recovery.error.secretsUnavailable',
  weak_password: 'recovery.error.weakPassword',
  csrf_failed: 'recovery.error.sessionExpired',
  unauthorized: 'recovery.error.sessionExpired',
  setup_required: 'recovery.error.setupRequired',
  setting_locked: 'recovery.error.settingLocked',
  invalid_state: 'recovery.error.invalidState',
  validation: 'recovery.error.validation',
}

/** The i18n key and values for a failed recovery call. */
export function recoveryError(e: unknown): { key: string; named?: Record<string, unknown> } {
  const data = (e as { data?: { error?: string; retryAfter?: number; reason?: string } })?.data
  const code = data?.error
  if (code === 'rate_limited' && data?.retryAfter) {
    return { key: data.reason === 'locked' ? 'recovery.error.locked' : 'recovery.error.rateLimited', named: { minutes: Math.max(1, Math.ceil(data.retryAfter / 60)) } }
  }
  // A status-only session (the master key is not usable) asked for more than the status.
  if (code === 'forbidden' && data?.reason === 'secrets_unavailable') return { key: 'recovery.error.secretsUnavailable' }
  if (code && ERRORS[code]) return { key: ERRORS[code]! }
  return { key: 'recovery.error.generic' }
}

/** Revoking the last portal admin was refused until confirmed. */
export function isLastAdmin(e: unknown): boolean {
  const data = (e as { data?: { error?: string; reason?: string } })?.data
  return data?.error === 'invalid_state' && data.reason === 'last_admin'
}

/** The session is gone (expired, signed out elsewhere, or a reset ended it): back to the sign-in form. */
export function sessionLost(e: unknown): boolean {
  const err = e as { statusCode?: number; status?: number; data?: { error?: string } }
  const status = err?.statusCode ?? err?.status
  return status === 401 && err?.data?.error === 'unauthorized'
}

/** A recovery code as typed: groups of four, upper case. */
export function formatCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '').match(/.{1,4}/g)?.join('-') ?? ''
}
