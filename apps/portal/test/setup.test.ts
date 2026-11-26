import { readFileSync } from 'node:fs'
import { SETUP_STEPS, type SetupProgress, type SetupStepId, type SetupStepState } from '@yoda/shared'
import { describe, expect, it, vi } from 'vitest'
import { forwardedHeaders, trustedHops } from '../server/utils/forwarded'
import { isLocalAuthPath } from '../app/utils/publicConfig'
import {
  checkPublicUrl,
  currentStep,
  keycloakClientValues,
  nextStep,
  passwordAcceptable,
  passwordStrength,
  prevStep,
  reachable,
  resumeStep,
  setupClient,
  setupError,
  setupFinished,
  setupSessionLost,
  stepList,
  wizardProgress,
  tokenComplete,
  tokenGroups,
  tokenValue,
} from '../app/utils/setup'

function progress(done: Partial<Record<SetupStepId, SetupStepState>> = {}): SetupProgress {
  const steps = Object.fromEntries(SETUP_STEPS.map((s) => [s, done[s] ?? 'todo'])) as Record<SetupStepId, SetupStepState>
  return { installId: 'i-1', steps, totpRequired: true, admin: null, kitDownloadedAt: null, claimed: null, missing: ['organisation', 'admin', 'kit', 'claim'] }
}
const upTo = (last: SetupStepId, extra: Partial<Record<SetupStepId, SetupStepState>> = {}) =>
  progress({ ...Object.fromEntries(SETUP_STEPS.slice(0, SETUP_STEPS.indexOf(last) + 1).map((s) => [s, 'done'])), ...extra })

describe('setup client', () => {
  it('calls /api/setup with the cookie, the query, and the CSRF header on non-GET calls only', async () => {
    const fetcher = vi.fn(async () => ({ ok: true }))
    let csrf: string | null = 'csrf-1'
    const api = setupClient(fetcher, () => csrf)
    await api('/progress')
    await api('/settings', { query: { category: 'email' } })
    await api('/settings/general', { method: 'PUT', body: { changes: { 'org.name': 'x' } } })
    csrf = null
    await api('/session', { method: 'POST', body: { token: 'ABCD' } })
    const calls = fetcher.mock.calls as unknown as [string, Record<string, unknown>][]
    expect(calls.map((c) => c[0])).toEqual(['/api/setup/progress', '/api/setup/settings', '/api/setup/settings/general', '/api/setup/session'])
    expect(calls[0]![1]).toMatchObject({ method: 'GET', headers: {}, credentials: 'same-origin', cache: 'no-store' })
    expect(calls[1]![1]).toMatchObject({ query: { category: 'email' } })
    expect(calls[2]![1]).toMatchObject({ method: 'PUT', headers: { 'x-yoda-csrf': 'csrf-1' } })
    expect(calls[3]![1].headers).toEqual({})
  })
})

describe('wizard steps', () => {
  it('has the 11 steps of §4.2 in order, the optional ones marked', () => {
    expect(SETUP_STEPS).toEqual(['token', 'organisation', 'admin', 'check', 'signin', 'email', 'line', 'telegram', 'more', 'kit', 'claim'])
    const list = stepList(progress({ token: 'done' }), 'organisation')
    expect(list.filter((s) => s.optional).map((s) => s.id)).toEqual(['email', 'line', 'telegram', 'more'])
    expect(list.map((s) => s.number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(list.find((s) => s.id === 'organisation')!.mark).toBe('now')
    expect(list.find((s) => s.id === 'token')!.mark).toBe('done')
  })

  it('resumes at the first step neither done nor skipped', () => {
    expect(resumeStep(null)).toBe('token')
    expect(resumeStep(progress({ token: 'done' }))).toBe('organisation')
    expect(resumeStep(upTo('signin', { email: 'skipped', line: 'done' }))).toBe('telegram')
    expect(resumeStep(upTo('claim'))).toBe('claim')
  })

  it('opens a step only when every step before it is done or skipped; back is always open', () => {
    const p = upTo('organisation')
    expect(reachable(p, 'admin')).toBe(true)
    expect(reachable(p, 'check')).toBe(false)
    expect(reachable(p, 'claim')).toBe(false)
    expect(reachable(p, 'organisation')).toBe(true)
    expect(reachable(null, 'organisation')).toBe(false)
    const skipped = upTo('signin', { email: 'skipped', line: 'skipped', telegram: 'skipped', more: 'skipped' })
    expect(reachable(skipped, 'kit')).toBe(true)
    expect(reachable(skipped, 'claim')).toBe(false)
  })

  it('shows the step asked for in the URL only when it may be opened', () => {
    const p = upTo('admin')
    expect(currentStep(p, 'organisation')).toBe('organisation')
    expect(currentStep(p, 'kit')).toBe('check')
    expect(currentStep(p, 'nonsense')).toBe('check')
    expect(currentStep(p, 'token')).toBe('check')
    expect(currentStep(null, 'kit')).toBe('token')
  })

  it('moves forward and back, never back to the token', () => {
    expect(nextStep('signin')).toBe('email')
    expect(nextStep('claim')).toBeNull()
    expect(prevStep('admin')).toBe('organisation')
    expect(prevStep('organisation')).toBeNull()
    expect(wizardProgress('admin')).toEqual({ number: 2, of: 10, percent: 20 })
  })
})

describe('setup token boxes', () => {
  it('splits a pasted token into 5 groups of 4, ignoring case, dashes, spaces and confusable letters', () => {
    expect(tokenGroups('abcd-efgh-jklm-npqr-stuv')).toEqual(['ABCD', 'EFGH', 'JKLM', 'NPQR', 'STUV'])
    expect(tokenGroups(' ABCD EFGH JKLM NPQR STUV WXYZ')).toEqual(['ABCD', 'EFGH', 'JKLM', 'NPQR', 'STUV'])
    expect(tokenGroups('AB0O1I')).toEqual(['AB', '', '', '', ''])
    expect(tokenComplete(tokenGroups('ABCDEFGHJKLMNPQRSTUV'))).toBe(true)
    expect(tokenComplete(tokenGroups('ABCDEFGH'))).toBe(false)
    expect(tokenValue(tokenGroups('abcdefghjklmnpqrstuv'))).toBe('ABCD-EFGH-JKLM-NPQR-STUV')
  })
})

describe('public URL (D8)', () => {
  it('warns on plain http away from localhost, and when the browser reaches Yoda elsewhere', () => {
    expect(checkPublicUrl('https://portal.example.org/', 'https://portal.example.org')).toEqual({ invalid: false, plainHttp: false, mismatch: false, normalised: 'https://portal.example.org' })
    expect(checkPublicUrl('http://10.0.0.5:3000', 'http://10.0.0.5:3000')).toMatchObject({ plainHttp: true, mismatch: false })
    expect(checkPublicUrl('http://localhost:3000', 'http://localhost:3000')).toMatchObject({ plainHttp: false })
    expect(checkPublicUrl('http://127.0.0.1:3000', 'http://localhost:3000')).toMatchObject({ plainHttp: false, mismatch: true })
    expect(checkPublicUrl('https://portal.example.org', 'http://10.0.0.5:3000')).toMatchObject({ mismatch: true })
    for (const bad of ['portal.example.org', 'ftp://portal.example.org', 'https://portal.example.org/?x=1', 'https://u:p@portal.example.org', '']) {
      expect(checkPublicUrl(bad, '').invalid, bad).toBe(true)
    }
  })

  it('gives the Keycloak client values for the public URL', () => {
    expect(keycloakClientValues('https://portal.example.org/')).toEqual({ redirect: 'https://portal.example.org/*', postLogout: 'https://portal.example.org/*', webOrigin: 'https://portal.example.org' })
  })
})

describe('password strength (§4.2: score ≥ 3, 14+ characters)', () => {
  it('scores repeats, runs, words and the username low, and long mixed passwords high', () => {
    expect(passwordStrength('aaaaaaaaaaaaaaaa').score).toBeLessThan(2)
    expect(passwordStrength('abcdefghijklmnop').score).toBeLessThan(3)
    expect(passwordStrength('qwertyuiopasdfgh').score).toBeLessThan(3)
    expect(passwordStrength('Password12345678').score).toBeLessThan(3)
    expect(passwordStrength('P@ssw0rdP@ssw0rd').score).toBeLessThan(3)
    expect(passwordStrength('abcabcabcabcabc').warnings).toContain('repeat')
    expect(passwordStrength('somchai-somchai-x', 'somchai').warnings).toContain('username')
    expect(passwordStrength('river-copper-lantern-71').score).toBe(4)
    expect(passwordStrength('correct horse battery staple').score).toBe(4)
    expect(passwordStrength('Tq8#mZ2!vL').warnings).toContain('short')
  })

  it('accepts a password only when core would and it scores 3 or more', () => {
    expect(passwordAcceptable('admin', 'river-copper-lantern-71')).toBe(true)
    expect(passwordAcceptable('admin', 'short')).toBe(false)
    expect(passwordAcceptable('admin', 'xxadminxxadminxx')).toBe(false)
    expect(passwordAcceptable('admin', 'abcdefghijklmnop')).toBe(false)
  })
})

describe('setup errors', () => {
  it('words errors with what to do next', () => {
    expect(setupError({ data: { error: 'invalid_credentials' } })).toEqual({ key: 'setup.error.invalidToken' })
    expect(setupError({ data: { error: 'rate_limited', retryAfter: 600 } })).toEqual({ key: 'setup.error.rateLimited', named: { minutes: 10 } })
    expect(setupError({ data: { error: 'invalid_state', reason: 'kit_downloaded' } })).toEqual({ key: 'setup.error.kitDownloaded' })
    expect(setupError({ data: { error: 'invalid_state', reason: 'incomplete' } })).toEqual({ key: 'setup.error.incomplete' })
    expect(setupError({ data: { error: 'bad_request', reason: 'issuer_mismatch' } })).toEqual({ key: 'setup.error.provider' })
    expect(setupError(new Error('x'))).toEqual({ key: 'setup.error.generic' })
    expect(setupSessionLost({ statusCode: 401, data: { error: 'unauthorized' } })).toBe(true)
    expect(setupSessionLost({ statusCode: 403, data: { error: 'csrf_failed' } })).toBe(true)
    expect(setupSessionLost({ statusCode: 401, data: { error: 'invalid_credentials' } })).toBe(false)
    expect(setupFinished({ statusCode: 404 })).toBe(true)
  })
})

describe('portal proxy forwarded headers', () => {
  const base = { peer: '10.0.0.7', encrypted: false, headers: { host: 'portal.example.org', forwardedHost: 'evil.example.org', forwardedProto: 'https', forwardedFor: '1.2.3.4' } }

  it('with no outer proxy (hops = 1) sends its own scheme and Host, never the browser claim; always appends the peer', () => {
    expect(forwardedHeaders({ ...base, hops: 1 })).toEqual({ 'x-forwarded-for': '1.2.3.4, 10.0.0.7', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'portal.example.org' })
    expect(forwardedHeaders({ ...base, encrypted: true, hops: 1 })['x-forwarded-proto']).toBe('https')
    expect(forwardedHeaders({ peer: '10.0.0.7', encrypted: false, headers: {}, hops: 1 })).toEqual({ 'x-forwarded-for': '10.0.0.7', 'x-forwarded-proto': 'http', 'x-forwarded-host': '' })
  })

  it('behind a reverse proxy (hops > 1) passes its scheme and host on', () => {
    expect(forwardedHeaders({ ...base, hops: 2 })).toEqual({ 'x-forwarded-for': '1.2.3.4, 10.0.0.7', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example.org' })
    expect(forwardedHeaders({ ...base, headers: { host: 'portal.example.org' }, hops: 2 })['x-forwarded-host']).toBe('portal.example.org')
  })

  it('reads YODA_TRUSTED_PROXY_HOPS like core (1–5, else 1)', () => {
    expect([undefined, '', '0', '9', 'x', '2.5'].map(trustedHops)).toEqual([1, 1, 1, 1, 1, 1])
    expect(trustedHops('2')).toBe(2)
  })
})

describe('/setup page', () => {
  const files = [
    '../app/pages/setup.vue',
    '../app/utils/setup.ts',
    ...['StepFrame', 'StepToken', 'StepOrganisation', 'StepAdmin', 'StepCheck', 'StepSignin', 'StepSettings', 'StepKit', 'StepClaim', 'PasswordMeter', 'TokenInput'].map((c) => `../app/components/setup/${c}.vue`),
  ]
  const source = () => files.map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n')

  it('is a local page: no Keycloak, no default layout, nothing in browser storage', () => {
    expect(isLocalAuthPath('/setup')).toBe(true)
    const page = readFileSync(new URL('../app/pages/setup.vue', import.meta.url), 'utf8')
    expect(page).toContain('definePageMeta({ layout: false })')
    expect(source()).not.toMatch(/useApi\(|useMe\(|useLiveEvents|\$keycloak|localStorage|sessionStorage/)
  })

  it('every setup.* key it uses exists in th and en', () => {
    const th = JSON.parse(readFileSync(new URL('../i18n/locales/th.json', import.meta.url), 'utf8'))
    const en = JSON.parse(readFileSync(new URL('../i18n/locales/en.json', import.meta.url), 'utf8'))
    const get = (o: Record<string, unknown>, key: string) => key.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], o)
    const keys = new Set([...source().matchAll(/'(setup\.[a-zA-Z0-9.]+)'/g)].map((m) => m[1]!).filter((k) => !k.endsWith('.')))
    for (const s of SETUP_STEPS) keys.add(`setup.step.${s}`)
    for (const w of ['short', 'repeat', 'sequence', 'common', 'username']) keys.add(`setup.admin.warning.${w}`)
    for (const n of [0, 1, 2, 3, 4]) keys.add(`setup.admin.score.${n}`)
    expect(keys.size).toBeGreaterThan(60)
    for (const k of keys) {
      expect(typeof get(th, k), `th ${k}`).toBe('string')
      expect(typeof get(en, k), `en ${k}`).toBe('string')
    }
  })

  it('puts a data-testid on every button and input', () => {
    for (const f of files.filter((x) => x.endsWith('.vue'))) {
      const s = readFileSync(new URL(f, import.meta.url), 'utf8')
      for (const m of s.matchAll(/<(v-btn|v-text-field|v-checkbox|v-btn-toggle)\b[^>]*>/g)) expect(m[0], `${f}: ${m[0]}`).toMatch(/data-testid=|:data-testid=/)
    }
  })
})
