import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { chromiumappRedirect } from '@yoda/shared'
import { cancelUrl, parseConnectQuery } from '../app/utils/extensionConnect'
import { forbiddenFor, isStaffPath } from '../app/utils/nav'

const EXT = 'hcnhkfonaflhcknbhcphbfgpdfmgmibm'
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const query = (o: Record<string, unknown> = {}) => ({ ext: EXT, redirect_uri: chromiumappRedirect(EXT), code_challenge: CHALLENGE, state: 'st-1', browser: 'Chrome 131 Windows', ...o })

const load = (f: string) => JSON.parse(readFileSync(new URL(`../i18n/locales/${f}`, import.meta.url), 'utf8'))
const lookup = (o: Record<string, unknown>, key: string): unknown =>
  key.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o)

describe('parseConnectQuery', () => {
  it('accepts the extension query', () => {
    expect(parseConnectQuery(query())).toEqual({
      ok: true,
      value: { ext: EXT, redirectUri: `https://${EXT}.chromiumapp.org/`, codeChallenge: CHALLENGE, state: 'st-1', browser: 'Chrome 131 Windows' },
    })
  })
  it.each([
    [{ ext: undefined }, 'missing'],
    [{ state: '' }, 'missing'],
    [{ code_challenge: 'short' }, 'missing'],
    [{ ext: 'not-an-id' }, 'bad_id'],
    [{ ext: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }, 'bad_id'],
    [{ redirect_uri: 'https://evil.example.org/' }, 'bad_redirect'],
    [{ redirect_uri: `https://${EXT}.chromiumapp.org/x` }, 'bad_redirect'],
    [{ redirect_uri: chromiumappRedirect('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') }, 'bad_redirect'],
  ])('%o → %s', (o, reason) => {
    expect(parseConnectQuery(query(o))).toEqual({ ok: false, reason })
  })
  it('a missing browser label falls back to Chrome', () => {
    const r = parseConnectQuery(query({ browser: undefined }))
    expect(r.ok && r.value.browser).toBe('Chrome')
  })
})

describe('cancelUrl', () => {
  it('keeps state', () => {
    const u = new URL(cancelUrl(chromiumappRedirect(EXT), 'st&1'))
    expect(u.origin).toBe(`https://${EXT}.chromiumapp.org`)
    expect(u.searchParams.get('error')).toBe('access_denied')
    expect(u.searchParams.get('state')).toBe('st&1')
  })
})

describe('the approve page', () => {
  it('nuxt.config.ts has the frame-ancestors rule for /extension/**', () => {
    const cfg = readFileSync(new URL('../nuxt.config.ts', import.meta.url), 'utf8')
    expect(cfg).toMatch(/'\/extension\/\*\*':\s*\{\s*headers:\s*\{[^}]*'Content-Security-Policy':\s*"frame-ancestors 'none'"[^}]*'X-Frame-Options':\s*'DENY'/)
  })
  it('every path refuses framing, not only /extension (case variants included)', () => {
    const cfg = readFileSync(new URL('../nuxt.config.ts', import.meta.url), 'utf8')
    expect(cfg).toMatch(/'\/\*\*':\s*\{\s*headers:\s*\{[^}]*"frame-ancestors 'none'"[^}]*'X-Frame-Options':\s*'DENY'/)
  })
  it('/extension/connect is not behind the staff guard: a requester gets the page and its own message', () => {
    expect(isStaffPath('/extension/connect')).toBe(false)
    expect(forbiddenFor({ id: 'x', username: 'n', displayName: 'n', email: null, isStaff: false, isAdmin: false }, '/extension/connect')).toBeNull()
  })
  it.each(['th.json', 'en.json'])('%s has the connect keys', (f) => {
    const l = load(f)
    for (const k of ['title', 'intro', 'origin', 'extensionId', 'browser', 'mayDo', 'mayReport', 'mayListProjects', 'onlyAfterConnect', 'approve', 'cancel', 'notAllowed', 'notStaff', 'badQuery', 'failed', 'done', 'signedInAs', 'backToExtension', 'rateLimited', 'disabled', 'framed', 'mayReadRules']) {
      expect(typeof lookup(l, `extension.connect.${k}`), k).toBe('string')
    }
  })
  it('uses the testids and never renders HTML', () => {
    const page = readFileSync(new URL('../app/pages/extension/connect.vue', import.meta.url), 'utf8')
    for (const id of ['connect-approve', 'connect-cancel', 'connect-error']) expect(page).toContain(`data-testid="${id}"`)
    expect(page).not.toContain('v-html')
    expect(page).toContain('location.replace')
    expect(page).toContain('window.top !== window.self')
    expect(page).toContain('redirectTo.startsWith(')
  })
})
