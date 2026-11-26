import { REQUIRED_FOR_COMPLETION, SETUP_STEPS, type SettingKey } from '@yoda/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp, type AppDeps } from '../src/app.js'
import type { Db } from '../src/db/client.js'
import { finishTestSignIn, startTestSignIn } from '../src/local/oidc-change.js'
import { missingSteps, oidcHash, parseProgress, recoveryKitFilename, recoveryKitText, stepStates, type ProgressFacts } from '../src/local/setup-progress.js'
import type { SettingsStore } from '../src/settings/store.js'
import { startFakeOidc, type FakeOidc } from './fake-oidc.js'
import { testConfig } from './helpers.js'
import { localJwks } from './jwt.js'

// The setup wizard's pure parts (installer proposal §4.2, §8.1) and its routes without a database. The full flow
// against Postgres is in setup-wizard.test.ts.

const facts = (over: Partial<ProgressFacts> = {}): ProgressFacts => ({
  session: true,
  organisation: false,
  admin: false,
  oidc: null,
  claimedIsAdmin: false,
  record: { marks: {} },
  ...over,
})

const OIDC = { issuer: 'https://sso.example.org/realms/hospital', clientId: 'yoda-portal', jwksUrl: null }

describe('setup progress', () => {
  it('reads every step from the real state or the record, in wizard order', () => {
    const s = stepStates(facts())
    expect(Object.keys(s)).toEqual([...SETUP_STEPS])
    expect(s).toMatchObject({ token: 'done', organisation: 'todo', admin: 'todo', check: 'todo', signin: 'todo', kit: 'todo', claim: 'todo' })
    expect(stepStates(facts({ session: false })).token).toBe('todo')
    const marked = stepStates(facts({ organisation: true, admin: true, record: { marks: { check: 'done', email: 'skipped', line: 'done' }, kitDownloadedAt: '2026-11-27T03:00:00Z' } }))
    expect(marked).toMatchObject({ organisation: 'done', admin: 'done', check: 'done', email: 'skipped', line: 'done', telegram: 'todo', kit: 'done' })
  })

  it('counts a sign-in test or a claim only for the sign-in values it ran with', () => {
    const hash = oidcHash(OIDC)!
    const other = oidcHash({ ...OIDC, clientId: 'other' })!
    expect(hash).not.toBe(other)
    expect(oidcHash({ ...OIDC, issuer: null })).toBeNull()
    expect(stepStates(facts({ oidc: hash, record: { marks: {}, oidcTested: { hash, at: 'x' } } })).signin).toBe('done')
    expect(stepStates(facts({ oidc: hash, record: { marks: {}, oidcTested: { hash: other, at: 'x' } } })).signin).toBe('todo')
    const claimed = { personId: 'p1', username: 'somchai', hash, at: 'x' }
    expect(stepStates(facts({ oidc: hash, claimedIsAdmin: true, record: { marks: {}, claimed } }))).toMatchObject({ signin: 'done', claim: 'done' })
    // Changed sign-in values, or an admin flag taken away since: claim again.
    expect(stepStates(facts({ oidc: other, claimedIsAdmin: true, record: { marks: {}, claimed } })).claim).toBe('todo')
    expect(stepStates(facts({ oidc: hash, claimedIsAdmin: false, record: { marks: {}, claimed } })).claim).toBe('todo')
  })

  it('needs organisation, admin, kit and claim to complete (8.1); optional steps never block', () => {
    expect(REQUIRED_FOR_COMPLETION).toEqual(['organisation', 'admin', 'kit', 'claim'])
    expect(missingSteps(stepStates(facts()))).toEqual(['organisation', 'admin', 'kit', 'claim'])
    const hash = oidcHash(OIDC)!
    const all = facts({
      organisation: true,
      admin: true,
      oidc: hash,
      claimedIsAdmin: true,
      record: { marks: {}, kitDownloadedAt: 'x', claimed: { personId: 'p', username: 'u', hash, at: 'x' } },
    })
    expect(missingSteps(stepStates(all))).toEqual([])
  })

  it('reads a damaged record as empty rather than failing', () => {
    expect(parseProgress(null)).toEqual({ marks: {} })
    expect(parseProgress({ marks: { check: 'nope' } })).toEqual({ marks: {} })
    expect(parseProgress({ marks: { check: 'done' }, kitDownloadedAt: '2026-11-27' })).toEqual({ marks: { check: 'done' }, kitDownloadedAt: '2026-11-27' })
  })
})

describe('recovery kit file (D7)', () => {
  it('holds the master key, the codes and what to do, in one text file', () => {
    const text = recoveryKitText({
      installId: '3f2a9c41-0000-4000-8000-000000000000',
      publicUrl: 'https://portal.example.org',
      keyId: 'kid-placeholder',
      masterKey: 'placeholder-master-key',
      username: 'admin',
      codes: ['AAAA-BBBB-CCCC-DDDD-EEEE', 'FFFF-GGGG-HHHH-JJJJ-KKKK'],
      at: new Date('2026-11-27T03:00:00Z'),
    })
    expect(text).toContain('placeholder-master-key')
    expect(text).toContain('Key id: kid-placeholder')
    expect(text).toContain(' 1. AAAA-BBBB-CCCC-DDDD-EEEE')
    expect(text).toContain(' 2. FFFF-GGGG-HHHH-JJJJ-KKKK')
    expect(text).toContain('/recovery')
    expect(text).toContain('yoda-admin reset-break-glass')
    expect(text).toContain('https://portal.example.org')
    expect(recoveryKitFilename('3f2a9c41-0000-4000-8000-000000000000')).toBe('yoda-recovery-kit-3f2a9c41.txt')
  })
})

describe('claim sign-in (fake provider)', () => {
  let idp: FakeOidc
  const policy = { allowLoopback: true }
  const someAdmins = { execute: async () => [{ admin: false, any: true }] } as unknown as Db
  const target = () => ({ values: { issuer: idp.issuer, clientId: 'yoda-portal', jwksUrl: null }, stagedAt: 'setup:x', stagedBy: 'setup', testedAt: null, testedUsername: null })

  beforeAll(async () => {
    idp = await startFakeOidc()
  })
  afterAll(() => idp.stop())

  async function claim(user: { username: string; groups?: string[] | null }, staffGroup = '/it-dev') {
    const t = target()
    const s = await startTestSignIn(t, { publicUrl: 'https://portal.example.org', policy, now: new Date(), redirectPath: '/setup' })
    expect(new URL(s.authorizeUrl).searchParams.get('redirect_uri')).toBe('https://portal.example.org/setup')
    const back = idp.authorize(s.authorizeUrl, user)
    return finishTestSignIn({ db: someAdmins, policy }, t, s.data, { ...back, now: new Date() }, { requireAdmin: false, staffGroup })
  }

  it('returns to /setup, skips the admin check (nobody is one yet) and checks the staff group', async () => {
    const r = await claim({ username: 'somchai' })
    expect(r.checks.map((c) => [c.id, c.ok])).toEqual([['state', true], ['token', true], ['jwks', true], ['id_token', true], ['access_token', true], ['staff', true]])
    expect(r).toMatchObject({ ok: true, username: 'somchai', claims: { preferred_username: 'somchai', sub: 'sub-somchai', groups: ['/it-dev'] } })
    expect(JSON.stringify(r.checks)).not.toMatch(/eyJ/)
  })

  it('fails for a person outside the staff group, or without a groups claim, and then gives no claims', async () => {
    const outside = await claim({ username: 'nurse1', groups: ['/ward'] })
    expect(outside.checks.find((c) => !c.ok)).toMatchObject({ id: 'staff', code: 'not_staff' })
    expect(outside).toMatchObject({ ok: false, claims: null })
    const none = await claim({ username: 'nurse1', groups: null })
    expect(none.checks.find((c) => !c.ok)?.code).toBe('groups_missing')
    expect(none.claims).toBeNull()
  })
})

describe('setup wizard routes without a database', () => {
  const done = { get: () => undefined, fromEnv: (k: SettingKey) => k === 'oidc.issuer', setupDone: true, recovery: false } as unknown as SettingsStore
  async function app(settings: SettingsStore) {
    const deps = { config: { ...testConfig(), devSkipSetup: false }, db: {}, jwks: localJwks, bus: {}, storage: {}, ai: {}, jobs: {}, gitlab: null, settings } as unknown as AppDeps
    return buildApp(deps)
  }

  it('answers 404 on every wizard route once setup is done (8.1: nothing to probe)', async () => {
    const a = await app(done)
    const routes: [string, string][] = [
      ['GET', '/setup/progress'], ['POST', '/setup/progress/step'], ['GET', '/setup/settings'], ['PUT', '/setup/settings/general'],
      ['POST', '/setup/settings/email/test'], ['POST', '/setup/settings/telegram/webhook'], ['POST', '/setup/settings/gitlab/generate/gitlab.webhookSecret'],
      ['POST', '/setup/check'], ['POST', '/setup/recovery-kit'], ['POST', '/setup/claim/start'], ['POST', '/setup/claim/callback'], ['POST', '/setup/complete'],
    ]
    for (const [method, url] of routes) {
      const res = await a.inject({ method: method as 'GET', url, payload: method === 'GET' ? undefined : {} })
      expect(res.statusCode, `${method} ${url}`).toBe(404)
    }
    await a.close()
  })
})
