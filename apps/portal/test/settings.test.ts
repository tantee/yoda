import { readFileSync } from 'node:fs'
import { SETTINGS_TEST_CODES, SETTING_KEYS, SettingCategory, type SettingView, type SettingsAuditEntry } from '@yoda/shared'
import { describe, expect, it } from 'vitest'
import EnvLockChip from '../app/components/settings/EnvLockChip.vue'
import SecretField from '../app/components/settings/SecretField.vue'
import SettingField from '../app/components/settings/SettingField.vue'
import TestResult from '../app/components/settings/TestResult.vue'
import ApplyHint from '../app/components/settings/ApplyHint.vue'
import RestartBanner from '../app/components/settings/RestartBanner.vue'
import {
  LEGACY_SETTINGS_ROUTES,
  SETTINGS_PAGES,
  applyModes,
  applyReauthStash,
  auditLine,
  DETAIL_MAX,
  REAUTH_STASH_MAX_MS,
  boundSecretNotes,
  changedFieldErrors,
  checkDetails,
  checkLabelKey,
  draftChanges,
  enumOptions,
  fieldKind,
  fieldLabelKey,
  fieldRules,
  fromFormValue,
  initialDraft,
  lockedCount,
  pageForCategory,
  parseReauthStash,
  reauthStash,
  rebaseDraft,
  saveError,
  settingsPage,
  testCodeMessage,
  testValues,
  toFormValue,
  validateField,
  visibleSettings,
  webhookUrl,
} from '../app/utils/settings'
import { render } from './support/render'

function view(key: string, o: Partial<SettingView> = {}): SettingView {
  return {
    key,
    category: 'email',
    secret: false,
    apply: 'reconnect',
    source: 'default',
    locked: null,
    version: 0,
    updatedAt: null,
    updatedBy: null,
    writeSource: null,
    restartRequired: false,
    ...o,
  }
}
const secret = (key: string, set: boolean, o: Partial<SettingView> = {}) =>
  view(key, { secret: true, secretState: { set, hint: set ? 'a1b2' : null, unavailable: false, updatedAt: set ? '2026-11-24T03:02:00Z' : null, updatedBy: set ? { personId: 'p1', label: 'สมชาย ใจดี' } : null }, version: set ? 3 : 0, ...o })
const envLocked = (key: string, envName: string, value: unknown) => view(key, { source: 'env', envName, value, locked: { reason: 'env', envName } })

const EMAIL: SettingView[] = [
  view('smtp.host', { source: 'db', value: 'smtp.example.org', version: 2, boundSecrets: ['smtp.password'] }),
  view('smtp.port', { value: 587 }),
  view('smtp.secure', { value: false }),
  view('smtp.user', { source: 'db', value: 'yoda@example.org', version: 1 }),
  secret('smtp.password', true),
  view('smtp.from', { source: 'unset' }),
]

const flatten = (o: Record<string, unknown>, prefix = ''): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? Object.entries(flatten(v as Record<string, unknown>, `${prefix}${k}.`)) : [[`${prefix}${k}`, v]])))
const locale = (f: string) => flatten(JSON.parse(readFileSync(new URL(`../i18n/locales/${f}`, import.meta.url), 'utf8')))
const TH = locale('th.json')
const EN = locale('en.json')
const hasText = (key: string) => typeof TH[key] === 'string' && typeof EN[key] === 'string'

describe('settings pages', () => {
  it('one page per category (email, LINE and Telegram share the channels page), then the change log', () => {
    expect(SETTINGS_PAGES.map(p => p.id)).toEqual(['general', 'signin', 'ai', 'gitlab', 'channels', 'runners', 'backups', 'storage', 'security', 'audit'])
    const covered = SETTINGS_PAGES.flatMap(p => p.categories).sort()
    expect(covered).toEqual([...SettingCategory.options].sort())
    expect(pageForCategory('telegram')).toBe('channels')
    expect(settingsPage('nope')).toBeNull()
  })
  it('the old GitLab and channel pages point at their categories', () => {
    expect(LEGACY_SETTINGS_ROUTES).toEqual({ '/admin/gitlab': '/admin/settings/gitlab', '/admin/notifications': '/admin/settings/channels' })
    for (const page of ['gitlab', 'notifications']) {
      const src = readFileSync(new URL(`../app/pages/admin/${page}.vue`, import.meta.url), 'utf8')
      expect(src).toContain(`redirect: '${LEGACY_SETTINGS_ROUTES[`/admin/${page}`]}'`)
    }
  })
})

describe('fields by registry type', () => {
  it('derives the input from the schema', () => {
    expect(fieldKind('smtp.password')).toBe('secret')
    expect(fieldKind('smtp.secure')).toBe('bool')
    expect(fieldKind('smtp.port')).toBe('number')
    expect(fieldKind('org.defaultLocale')).toBe('enum')
    expect(fieldKind('oidc.bootstrapAdmins')).toBe('list')
    expect(fieldKind('gitlab.url')).toBe('url')
    expect(fieldKind('smtp.host')).toBe('text')
    expect(enumOptions('org.defaultLocale')).toEqual(['th', 'en'])
  })
  it('converts between form and API values; empty clears', () => {
    expect(toFormValue('number', 587)).toBe('587')
    expect(toFormValue('list', ['a', 'b'])).toBe('a, b')
    expect(toFormValue('text', undefined)).toBe('')
    expect(fromFormValue('number', '2525')).toBe(2525)
    expect(fromFormValue('list', 'a, b,,')).toEqual(['a', 'b'])
    expect(fromFormValue('text', '  ')).toBeNull()
    expect(fromFormValue('bool', false)).toBe(false)
  })
  it('validates with the registry schema', () => {
    expect(validateField('smtp.port', '70000')).toBeTruthy()
    expect(validateField('smtp.port', '2525')).toBeNull()
    expect(validateField('ai.modelDraft', 'claude')).toMatch(/provider:model/)
    expect(validateField('gitlab.url', '')).toBeNull()
  })
  it('locked settings never take input and carry their reason', () => {
    expect(fieldRules(envLocked('smtp.host', 'SMTP_HOST', 'smtp.example.org'))).toEqual({ editable: false, lock: { reason: 'env', envName: 'SMTP_HOST' } })
    expect(fieldRules(view('oidc.issuer', { locked: { reason: 'recovery_only' } }))).toEqual({ editable: false, lock: { reason: 'recovery_only', envName: null } })
    expect(fieldRules(EMAIL[0]!)).toEqual({ editable: true, lock: null })
    expect(lockedCount([envLocked('smtp.host', 'SMTP_HOST', 'x'), view('a', { locked: { reason: 'readonly' } }), EMAIL[1]!])).toBe(1)
  })
  it('hides bootstrap-only settings outside the read-only pages and orders the general page', () => {
    const general = [view('boot.port', { category: 'general', locked: { reason: 'bootstrap' } }), view('org.publicUrl', { category: 'general' }), view('org.name', { category: 'general' })]
    expect(visibleSettings('general', general).map(v => v.key)).toEqual(['org.name', 'org.publicUrl'])
    const storage = [view('storage.s3Bucket', { category: 'storage', locked: { reason: 'bootstrap' } })]
    expect(visibleSettings('storage', storage)).toHaveLength(1)
    expect(visibleSettings('signin', [view('oidc.bootstrapAdmins', { source: 'default' })])).toHaveLength(0)
    expect(visibleSettings('signin', [view('oidc.bootstrapAdmins', { source: 'env' })])).toHaveLength(1)
  })
  it('lists the apply modes of the editable settings', () => {
    expect(applyModes([view('a', { apply: 'restart' }), view('b', { apply: 'live' }), view('c', { apply: 'reconnect', locked: { reason: 'env' } })])).toEqual(['live', 'restart'])
  })
})

describe('form diff', () => {
  it('a fresh form has no changes and never holds a secret', () => {
    const d = initialDraft(EMAIL)
    expect(draftChanges(EMAIL, d)).toEqual({ changes: {}, versions: {} })
    expect(d.secrets['smtp.password']).toEqual({ mode: 'keep', value: '' })
    expect(JSON.stringify(d)).not.toContain('a1b2')
  })
  it('sends only edited keys, each with the version it loaded', () => {
    const d = initialDraft(EMAIL)
    d.values['smtp.port'] = '2525'
    d.values['smtp.user'] = ' yoda@example.org '
    d.values['smtp.from'] = 'Yoda <yoda@example.org>'
    expect(draftChanges(EMAIL, d)).toEqual({
      changes: { 'smtp.port': 2525, 'smtp.from': 'Yoda <yoda@example.org>' },
      versions: { 'smtp.port': 0, 'smtp.from': 0 },
    })
  })
  it('clearing a value sends null', () => {
    const d = initialDraft(EMAIL)
    d.values['smtp.user'] = ''
    expect(draftChanges(EMAIL, d).changes).toEqual({ 'smtp.user': null })
  })
  it('secrets: only a typed replacement or a clear of a set secret', () => {
    const d = initialDraft(EMAIL)
    d.secrets['smtp.password'] = { mode: 'replace', value: '' }
    expect(draftChanges(EMAIL, d).changes).toEqual({})
    d.secrets['smtp.password'] = { mode: 'replace', value: 'new-pass' }
    expect(draftChanges(EMAIL, d)).toEqual({ changes: { 'smtp.password': 'new-pass' }, versions: { 'smtp.password': 3 } })
    d.secrets['smtp.password'] = { mode: 'clear', value: '' }
    expect(draftChanges(EMAIL, d).changes).toEqual({ 'smtp.password': null })
    const unset = [secret('smtp.password', false)]
    expect(draftChanges(unset, { values: {}, secrets: { 'smtp.password': { mode: 'clear', value: '' } } }).changes).toEqual({})
  })
  it('ignores locked settings whatever the form holds', () => {
    const views = [envLocked('smtp.host', 'SMTP_HOST', 'smtp.example.org')]
    expect(draftChanges(views, { values: { 'smtp.host': 'evil.example.org' }, secrets: {} }).changes).toEqual({})
  })
  it('tests use the draft without clears', () => {
    const d = initialDraft(EMAIL)
    d.values['smtp.host'] = 'mail.example.org'
    d.values['smtp.user'] = ''
    d.secrets['smtp.password'] = { mode: 'replace', value: 'pw' }
    expect(testValues(EMAIL, d)).toEqual({ 'smtp.host': 'mail.example.org', 'smtp.password': 'pw' })
  })
  it('client errors only for edited keys', () => {
    const views = [view('smtp.port', { value: 'not-a-port' }), view('smtp.user')]
    const d = initialDraft(views)
    expect(changedFieldErrors(views, d)).toEqual({})
    d.values['smtp.port'] = '99999'
    expect(Object.keys(changedFieldErrors(views, d))).toEqual(['smtp.port'])
  })
  it('a partial reload keeps unsaved edits, typed secrets included, of keys still editable', () => {
    const d = initialDraft(EMAIL)
    d.values['smtp.user'] = 'other@example.org'
    d.secrets['smtp.password'] = { mode: 'replace', value: 'pw' }
    const reloaded = EMAIL.map(v => (v.key === 'smtp.user' ? { ...v, version: 2 } : v))
    const next = rebaseDraft(EMAIL, d, reloaded)
    expect(draftChanges(reloaded, next)).toEqual({ changes: { 'smtp.user': 'other@example.org', 'smtp.password': 'pw' }, versions: { 'smtp.user': 2, 'smtp.password': 3 } })
    const locked = EMAIL.map(v => (v.key === 'smtp.user' ? envLocked('smtp.user', 'SMTP_USER', 'yoda@example.org') : v))
    expect(draftChanges(locked, rebaseDraft(EMAIL, d, locked)).changes).toEqual({ 'smtp.password': 'pw' })
  })
  it('warns when moving an endpoint clears its stored secret', () => {
    const d = initialDraft(EMAIL)
    d.values['smtp.host'] = 'mail.example.org'
    expect(boundSecretNotes(EMAIL, d)).toEqual({ 'smtp.host': ['smtp.password'] })
    d.secrets['smtp.password'] = { mode: 'replace', value: 'pw' }
    expect(boundSecretNotes(EMAIL, d)).toEqual({})
  })
})

describe('save errors', () => {
  const err = (statusCode: number, data: Record<string, unknown>) => ({ statusCode, data })
  it('maps the API error codes', () => {
    expect(saveError(err(401, { error: 'reauth_required' }))).toEqual({ kind: 'reauth' })
    expect(saveError(err(409, { error: 'version_conflict', key: 'smtp.host', version: 4 }))).toEqual({ kind: 'conflict', key: 'smtp.host' })
    expect(saveError(err(409, { error: 'setting_locked', key: 'smtp.host', reason: 'env', envName: 'SMTP_HOST' }))).toEqual({ kind: 'locked', key: 'smtp.host', reason: 'env', envName: 'SMTP_HOST' })
    expect(saveError(err(422, { error: 'invalid_settings', issues: [{ key: 'smtp.port', message: 'x' }] }))).toEqual({ kind: 'invalid', issues: [{ key: 'smtp.port', message: 'x' }] })
    expect(saveError(err(429, { error: 'rate_limited', retryAfter: 12 }))).toEqual({ kind: 'rateLimited', retryAfter: 12 })
    expect(saveError(err(409, { error: 'secrets_unavailable', key: 'smtp.password' }))).toEqual({ kind: 'secretsUnavailable', key: 'smtp.password' })
    expect(saveError(err(401, { error: 'unauthorized' }))).toEqual({ kind: 'other' })
    expect(saveError(new TypeError('Failed to fetch'))).toEqual({ kind: 'other' })
  })
})

const NOW = Date.parse('2026-11-26T10:00:00Z')

describe('re-authentication stash', () => {
  it('keeps plain values and clears, never a secret value', () => {
    const d = initialDraft(EMAIL)
    d.values['smtp.host'] = 'mail.example.org'
    d.secrets['smtp.password'] = { mode: 'replace', value: 'super-secret-password' }
    const s = reauthStash('email', '/admin/settings/channels', EMAIL, d, 'save', NOW)
    const raw = JSON.stringify(s)
    expect(raw).not.toContain('super-secret-password')
    expect(s).toEqual({ category: 'email', path: '/admin/settings/channels', values: { 'smtp.host': 'mail.example.org' }, clears: [], secretsToRetype: ['smtp.password'], action: 'save', at: NOW })
    const back = applyReauthStash(EMAIL, parseReauthStash(raw, '/admin/settings/channels', NOW + 60_000)!)
    expect(back.values['smtp.host']).toBe('mail.example.org')
    expect(back.secrets['smtp.password']).toEqual({ mode: 'replace', value: '' })
  })
  it('restores clears, and drops keys that are locked now', () => {
    const d = initialDraft(EMAIL)
    d.secrets['smtp.password'] = { mode: 'clear', value: '' }
    d.values['smtp.user'] = 'other@example.org'
    const s = reauthStash('email', '/x', EMAIL, d, 'save', NOW)
    expect(s.clears).toEqual(['smtp.password'])
    const nowLocked = EMAIL.map(v => (v.key === 'smtp.user' ? envLocked('smtp.user', 'SMTP_USER', 'yoda@example.org') : v))
    const back = applyReauthStash(nowLocked, s)
    expect(back.values['smtp.user']).toBe('yoda@example.org')
    expect(back.secrets['smtp.password']!.mode).toBe('clear')
  })
  it('rejects junk', () => {
    expect(parseReauthStash(null, '/x')).toBeNull()
    expect(parseReauthStash('{', '/x')).toBeNull()
    expect(parseReauthStash('{"category":"email"}', '/x')).toBeNull()
  })
  it('is replayed only within 10 minutes and only on the page it came from', () => {
    const raw = JSON.stringify(reauthStash('email', '/admin/settings/channels', EMAIL, initialDraft(EMAIL), 'save', NOW))
    expect(parseReauthStash(raw, '/admin/settings/channels', NOW + REAUTH_STASH_MAX_MS)).not.toBeNull()
    expect(parseReauthStash(raw, '/admin/settings/channels', NOW + REAUTH_STASH_MAX_MS + 1)).toBeNull()
    expect(parseReauthStash(raw, '/admin/settings/channels', NOW - 120_000)).toBeNull()
    expect(parseReauthStash(raw, '/admin/settings/general', NOW)).toBeNull()
    const { at: _at, ...noTime } = JSON.parse(raw) as Record<string, unknown>
    expect(parseReauthStash(JSON.stringify(noTime), '/admin/settings/channels', NOW)).toBeNull()
  })
})

describe('test result codes', () => {
  it('maps codes to localized messages, with a fallback', () => {
    expect(testCodeMessage('timeout')).toEqual({ key: 'settings.test.code.timeout' })
    expect(testCodeMessage('http_404')).toEqual({ key: 'settings.test.code.http', named: { status: '404' } })
    expect(testCodeMessage('http_3xx')).toEqual({ key: 'settings.test.code.http', named: { status: '3xx' } })
    expect(testCodeMessage('something_new')).toEqual({ key: 'settings.test.code.failed' })
    expect(testCodeMessage(undefined)).toEqual({ key: 'settings.test.code.failed' })
    expect(checkLabelKey('model.draft')).toBe('settings.test.check.model_draft')
    expect(checkLabelKey('mystery')).toBe('settings.test.check.other')
  })
  it('maps SMTP reply codes like HTTP ones and cuts third-party details short', () => {
    expect(testCodeMessage('smtp_550')).toEqual({ key: 'settings.test.code.smtp', named: { status: '550' } })
    expect(testCodeMessage('smtp_error')).toEqual({ key: 'settings.test.code.smtp_error' })
    const long = 'x'.repeat(500)
    const [d] = checkDetails({ id: 'webhook', ok: false, ms: 1, detail: { lastError: long } })
    expect(d!.length).toBe(DETAIL_MAX)
    expect(d!.endsWith('…')).toBe(true)
    expect(checkDetails({ id: 'bot', ok: true, ms: 1, detail: { username: 'yoda_bot', scopes: ['api', 'read_user'] } })).toEqual(['username: yoda_bot', 'scopes: api, read_user'])
  })
  it('every code core can return is known and has th and en text', () => {
    const core = ['tests.ts', 'outbound.ts'].map(f => readFileSync(new URL(`../../core/src/settings/${f}`, import.meta.url), 'utf8')).join('\n')
    const found = new Set<string>()
    const patterns = [/fail\('([a-z_]+)'/g, /code: '([a-z_]+)'/g, /OutboundError\('([a-z_]+)'\)/g]
    for (const re of patterns) for (const m of core.matchAll(re)) found.add(m[1]!)
    // The SMTP error mapping returns codes; the OutboundCode union lists safeOutbound's.
    const smtp = /function smtpCode[\s\S]*?\n}\n/.exec(core)![0]
    for (const m of smtp.matchAll(/return '([a-z_]+)'/g)) found.add(m[1]!)
    const union = /export type OutboundCode =([\s\S]*?)\n\n/.exec(core)![1]!
    for (const m of union.matchAll(/'([a-z_]+)'/g)) found.add(m[1]!)
    // The numbered families are built with a template literal.
    expect(core).toContain('`http_${')
    expect(core).toContain('`smtp_${')
    expect(found.size).toBeGreaterThan(25)
    for (const c of found) expect(SETTINGS_TEST_CODES as readonly string[], `core code ${c}`).toContain(c)
    for (const c of [...SETTINGS_TEST_CODES, 'http_500', 'smtp_421']) {
      const key = testCodeMessage(c).key
      expect(key, c).not.toBe(c === 'failed' ? '' : 'settings.test.code.failed')
      expect(hasText(key), c).toBe(true)
    }
    for (const id of ['discovery', 'jwks', 'client', 'connect', 'send', 'bot', 'webhook', 'user', 'scopes', 'anthropic', 'openai', 'model.draft', 'model.fast', 'model.embed', 'config', 'bucket', 'x']) {
      expect(hasText(checkLabelKey(id)), id).toBe(true)
    }
  })
})

describe('audit lines', () => {
  const entry = (o: Partial<SettingsAuditEntry>): SettingsAuditEntry => ({
    id: 1, at: '2026-11-24T03:02:00Z', actor: { personId: 'p1', label: 'สมชาย' }, source: 'ui', action: 'set', key: 'smtp.port', category: 'email',
    oldValue: 465, newValue: 587, oldFp: null, newFp: null, result: null, ip: '10.0.0.1', requestId: 'r1', ...o,
  })
  it('plain values show old → new; secrets show fingerprints only', () => {
    expect(auditLine(entry({}))).toMatchObject({ actionKey: 'settings.audit.action.set', key: 'smtp.port', from: '465', to: '587', secret: false })
    const s = auditLine(entry({ key: 'smtp.password', oldValue: 'leak', newValue: 'leak', oldFp: '9f1cabcdef', newFp: '4be0abcdef' }))
    expect(s).toMatchObject({ from: 'fp:9f1c…', to: 'fp:4be0…', secret: true })
    expect(JSON.stringify(s)).not.toContain('leak')
  })
  it('test rows carry no values', () => {
    expect(auditLine(entry({ action: 'test', key: null, newValue: { test: 'smtp', category: 'email' }, result: 'ok' }))).toMatchObject({ actionKey: 'settings.audit.action.test', key: null, from: null, to: null, result: 'ok' })
    expect(auditLine(entry({ action: 'setup.completed' })).actionKey).toBe('settings.audit.action.setup_completed')
    expect(auditLine(entry({ action: 'weird' })).actionKey).toBe('settings.audit.action.other')
  })
})

describe('labels', () => {
  it('every registry setting, category, page and audit action has th and en text', () => {
    for (const k of SETTING_KEYS) expect(hasText(fieldLabelKey(k)), k).toBe(true)
    for (const c of SettingCategory.options) expect(hasText(`settings.category.${c}`), c).toBe(true)
    for (const p of SETTINGS_PAGES) expect(hasText(`settings.page.${p.id}`), p.id).toBe(true)
    for (const a of ['set', 'clear', 'import', 'derived', 'test', 'setup_completed', 'other']) expect(hasText(`settings.audit.action.${a}`), a).toBe(true)
    for (const r of ['env', 'bootstrap', 'readonly', 'recovery_only', 'bound_secret_in_env']) {
      expect(hasText(`settings.lock.${r}`), r).toBe(true)
      expect(hasText(`settings.lock.how.${r}`), r).toBe(true)
    }
    expect(hasText('nav.admin.settings')).toBe(true)
  })
  it('no message uses the vue-i18n special characters by accident', () => {
    for (const [k, v] of Object.entries(TH).concat(Object.entries(EN))) {
      if (!k.startsWith('settings.')) continue
      expect(String(v), k).not.toMatch(/[@|]/)
    }
  })
})

describe('webhookUrl', () => {
  it('prefers the public URL, else the current origin', () => {
    expect(webhookUrl('https://portal.example.org/', 'http://localhost:3000', '/api/webhooks/line')).toBe('https://portal.example.org/api/webhooks/line')
    expect(webhookUrl(undefined, 'http://localhost:3000', '/api/gitlab/webhook')).toBe('http://localhost:3000/api/gitlab/webhook')
  })
})

describe('SecretField', () => {
  it('a set secret shows only its state, hint and who set it: no input, no value', async () => {
    const html = await render(SecretField, { view: secret('smtp.password', true), modelValue: { mode: 'keep', value: '' } })
    expect(html).toContain('settings.secret.set')
    expect(html).toContain('···a1b2')
    expect(html).toContain('settings.source.savedBy(name=สมชาย ใจดี')
    expect(html).not.toContain('<input')
    expect(html).toContain('data-testid="secret-replace-smtp.password"')
    expect(html).toContain('data-testid="secret-clear-smtp.password"')
  })
  it('replace opens an empty password field, never prefilled', async () => {
    const html = await render(SecretField, { view: secret('smtp.password', true), modelValue: { mode: 'replace', value: '' } })
    const input = /<input[^>]*>/.exec(html)![0]
    expect(input).toContain('type="password"')
    expect(input).toContain('autocomplete="new-password"')
    expect(input).not.toMatch(/value="[^"]+"/)
  })
  it('an unset secret opens straight into an empty field', async () => {
    const html = await render(SecretField, { view: secret('line.accessToken', false), modelValue: { mode: 'keep', value: '' } })
    expect(html).toContain('type="password"')
    expect(html).toContain('settings.secret.writeOnly')
  })
  it('an env-locked secret has no actions and shows the lock chip', async () => {
    const v = secret('smtp.password', true, { source: 'env', locked: { reason: 'env', envName: 'SMTP_PASSWORD' } })
    const html = await render(SecretField, { view: v, modelValue: { mode: 'keep', value: '' } })
    expect(html).not.toContain('secret-replace')
    expect(html).not.toContain('secret-clear')
    expect(html).toContain('settings.lock.env(name=SMTP_PASSWORD)')
  })
  it('generatable secrets offer generate; clear shows the pending removal', async () => {
    expect(await render(SecretField, { view: secret('gitlab.webhookSecret', true), modelValue: { mode: 'keep', value: '' }, generatable: true })).toContain('secret-generate-gitlab.webhookSecret')
    expect(await render(SecretField, { view: secret('smtp.password', true), modelValue: { mode: 'clear', value: '' } })).toContain('settings.secret.willClear')
  })
})

describe('EnvLockChip and SettingField', () => {
  it('the chip names the variable and says how to change it', async () => {
    const html = await render(EnvLockChip, { reason: 'env', envName: 'SMTP_HOST' })
    expect(html).toContain('settings.lock.env(name=SMTP_HOST)')
    expect(html).toContain('title="settings.lock.how.env(name=SMTP_HOST)"')
  })
  it('an env-locked field is disabled and carries the chip and the how-to', async () => {
    const html = await render(SettingField, { view: envLocked('smtp.host', 'SMTP_HOST', 'smtp.example.org'), modelValue: 'smtp.example.org' })
    expect(/<input[^>]*>/.exec(html)![0]).toContain('disabled')
    expect(html).toContain('data-testid="env-lock-chip"')
    expect(html).toContain('data-testid="setting-lock-how"')
  })
  it('an editable field is enabled and shows where its value came from', async () => {
    const html = await render(SettingField, { view: view('smtp.user', { source: 'db', value: 'yoda@example.org', updatedAt: '2026-11-24T03:02:00Z', updatedBy: { personId: 'p1', label: 'สมชาย' } }), modelValue: 'yoda@example.org' })
    expect(/<input[^>]*>/.exec(html)![0]).not.toContain('disabled')
    expect(html).not.toContain('env-lock-chip')
    expect(html).toContain('settings.source.savedBy(name=สมชาย')
  })
  it('booleans render as a switch, numbers as a numeric field', async () => {
    expect(await render(SettingField, { view: view('smtp.secure', { value: true }), modelValue: true })).toContain('v-switch')
    expect(await render(SettingField, { view: view('smtp.port', { value: 587 }), modelValue: '587' })).toContain('type="number"')
  })
  it('shows a bound-secret note and the restart flag', async () => {
    const html = await render(SettingField, { view: view('smtp.host', { restartRequired: true }), modelValue: 'x', note: 'NOTE' })
    expect(html).toContain('NOTE')
    expect(html).toContain('settings.restart.field')
  })
})

describe('TestResult, ApplyHint, RestartBanner', () => {
  it('lists each check with the localized failure', async () => {
    const html = await render(TestResult, { result: { action: 'smtp', ok: false, checks: [{ id: 'connect', ok: false, ms: 1200, code: 'auth_rejected' }, { id: 'send', ok: true, ms: 30, detail: { to: 'x' } }] }, draft: true })
    expect(html).toContain('settings.test.failed')
    expect(html).toContain('settings.test.code.auth_rejected')
    expect(html).toContain('settings.test.seconds(s=1.2)')
    expect(html).toContain('settings.test.draftNote')
  })
  it('apply hints and the restart banner', async () => {
    expect(await render(ApplyHint, { mode: 'reconnect' })).toContain('settings.apply.reconnect')
    expect(await render(RestartBanner, { keys: ['ai.workers'] })).toContain('settings.restart.text(keys=settings.field.ai.workers.label)')
    expect(await render(RestartBanner, { keys: [] })).not.toContain('restart-banner')
  })
})
