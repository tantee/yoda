import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import CodesOnce from '../app/components/recovery/CodesOnce.vue'
import TotpEnrol from '../app/components/recovery/TotpEnrol.vue'
import { formatCode, oidcCallback, oidcCallbackError, recoveryClient, recoveryError, sessionLost, isLastAdmin } from '../app/utils/recovery'
import { isLocalAuthPath } from '../app/utils/publicConfig'
import { render } from './support/render'

describe('recovery client', () => {
  it('calls /api/recovery with the cookie and sends the CSRF header on non-GET calls only', async () => {
    const fetcher = vi.fn(async () => ({ ok: true }))
    let csrf: string | null = 'csrf-token-1'
    const api = recoveryClient(fetcher, () => csrf)
    await api('/session')
    await api('/oidc/apply', { method: 'POST' })
    await api('/oidc/pending', { method: 'PUT', body: { issuer: 'https://sso.example.org/realms/x' } })
    csrf = null
    await api('/session', { method: 'POST', body: { username: 'admin' } })
    const calls = fetcher.mock.calls as unknown as [string, Record<string, unknown>][]
    expect(calls.map((c) => c[0])).toEqual(['/api/recovery/session', '/api/recovery/oidc/apply', '/api/recovery/oidc/pending', '/api/recovery/session'])
    expect(calls[0]![1]).toMatchObject({ method: 'GET', headers: {}, credentials: 'same-origin', cache: 'no-store' })
    expect(calls[1]![1].headers).toEqual({ 'x-yoda-csrf': 'csrf-token-1' })
    expect(calls[2]![1]).toMatchObject({ method: 'PUT', body: { issuer: 'https://sso.example.org/realms/x' } })
    expect(calls[3]![1].headers).toEqual({})
  })

  it('reads the provider answer from the URL', () => {
    expect(oidcCallback({ code: 'abc', state: 's1', session_state: 'x' })).toEqual({ code: 'abc', state: 's1' })
    expect(oidcCallback({ code: ['abc'], state: ['s1'] })).toEqual({ code: 'abc', state: 's1' })
    expect(oidcCallback({ code: 'abc' })).toBeNull()
    expect(oidcCallback({})).toBeNull()
    expect(oidcCallbackError({ error: 'access_denied' })).toBe(true)
    expect(oidcCallbackError({})).toBe(false)
  })

  it('words errors, with the wait for a lockout or a rate limit', () => {
    expect(recoveryError({ data: { error: 'invalid_credentials' } })).toEqual({ key: 'recovery.error.invalidCredentials' })
    expect(recoveryError({ data: { error: 'rate_limited', reason: 'locked', retryAfter: 125 } })).toEqual({ key: 'recovery.error.locked', named: { minutes: 3 } })
    expect(recoveryError({ data: { error: 'rate_limited', retryAfter: 10 } })).toEqual({ key: 'recovery.error.rateLimited', named: { minutes: 1 } })
    expect(isLastAdmin({ data: { error: 'invalid_state', reason: 'last_admin' } })).toBe(true)
    expect(isLastAdmin({ data: { error: 'invalid_state', reason: 'no_pending' } })).toBe(false)
    expect(recoveryError({ data: { error: 'forbidden', reason: 'secrets_unavailable' } })).toEqual({ key: 'recovery.error.secretsUnavailable' })
    expect(recoveryError({ data: { error: 'forbidden', reason: 'enrolment_required' } })).toEqual({ key: 'recovery.error.generic' })
    expect(recoveryError({ data: { error: 'nope' } })).toEqual({ key: 'recovery.error.generic' })
    expect(recoveryError(new Error('x'))).toEqual({ key: 'recovery.error.generic' })
    expect(sessionLost({ statusCode: 401, data: { error: 'unauthorized' } })).toBe(true)
    expect(sessionLost({ statusCode: 401, data: { error: 'invalid_credentials' } })).toBe(false)
    expect(sessionLost({ statusCode: 403, data: { error: 'csrf_failed' } })).toBe(false)
  })

  it('formats a typed recovery code in groups of four', () => {
    expect(formatCode('abcd efgh-jkl')).toBe('ABCD-EFGH-JKL')
    expect(formatCode('')).toBe('')
  })

  it('every error key and the page copy exist in th and en', () => {
    const th = JSON.parse(readFileSync(new URL('../i18n/locales/th.json', import.meta.url), 'utf8'))
    const en = JSON.parse(readFileSync(new URL('../i18n/locales/en.json', import.meta.url), 'utf8'))
    const get = (o: Record<string, unknown>, key: string) => key.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], o)
    const page = ['../app/pages/recovery.vue', '../app/components/recovery/CodesOnce.vue', '../app/components/recovery/TotpEnrol.vue', '../app/utils/recovery.ts']
      .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'))
      .join('\n')
    const keys = new Set([...page.matchAll(/'(recovery\.[a-zA-Z.]+)'/g)].map((m) => m[1]!))
    for (const k of ['ok', 'missing', 'malformed', 'mismatch']) keys.add(`recovery.status.key.${k}`)
    for (const k of ['required', 'done']) keys.add(`recovery.status.setupState.${k}`)
    expect(keys.size).toBeGreaterThan(40)
    for (const k of keys) {
      expect(typeof get(th, k), `th ${k}`).toBe('string')
      expect(typeof get(en, k), `en ${k}`).toBe('string')
    }
  })

  it('/recovery is a local page: no Keycloak, no default layout', () => {
    expect(isLocalAuthPath('/recovery')).toBe(true)
    const page = readFileSync(new URL('../app/pages/recovery.vue', import.meta.url), 'utf8')
    expect(page).toContain('definePageMeta({ layout: false })')
    expect(page).not.toMatch(/useApi|useMe|useLiveEvents|useUpload|\$keycloak/)
  })
})

describe('recovery components', () => {
  it('shows new recovery codes once, as a list', async () => {
    const html = await render(CodesOnce, { codes: ['ABCD-EFGH-JKLM-NPQR', 'STUV-WXYZ-2345-6789'] })
    expect(html).toContain('ABCD-EFGH-JKLM-NPQR')
    expect(html).toContain('recovery.codes.once')
    expect(html).toContain('data-testid="codes-copy"')
  })

  it('shows the TOTP QR code as an image and the secret in groups', async () => {
    const html = await render(TotpEnrol, { enrolment: { uri: 'otpauth://totp/Yoda:admin?secret=JBSWY3DPEHPK3PXP&issuer=Yoda', secret: 'JBSWY3DPEHPK3PXP' } })
    expect(html).toContain('data:image/svg+xml;utf8,')
    expect(html).toContain('JBSW Y3DP EHPK 3PXP')
    expect(html).not.toContain('<svg')
  })
})
