import { REQUIRED_FOR_COMPLETION, SETUP_STEPS, type SettingKey } from '@yoda/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { buildApp, outerProxyHint, trustProxy, type AppDeps } from '../src/app.js'
import { isHttps, originAllowed } from '../src/local/session.js'
import type { Db } from '../src/db/client.js'
import { finishTestSignIn, startTestSignIn } from '../src/local/oidc-change.js'
import { claimHash, kitBootstrapValues, missingSteps, oidcHash, parseProgress, recoveryKitFilename, recoveryKitText, stepStates, type ProgressFacts } from '../src/local/setup-progress.js'
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
  claim: null,
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

  it('counts a sign-in test or a claim only for the sign-in values (and, for the claim, the staff group) it ran with', () => {
    const hash = oidcHash(OIDC)!
    const other = oidcHash({ ...OIDC, clientId: 'other' })!
    expect(hash).not.toBe(other)
    expect(oidcHash({ ...OIDC, issuer: null })).toBeNull()
    expect(stepStates(facts({ oidc: hash, record: { marks: {}, oidcTested: { hash, at: 'x' } } })).signin).toBe('done')
    expect(stepStates(facts({ oidc: hash, record: { marks: {}, oidcTested: { hash: other, at: 'x' } } })).signin).toBe('todo')
    const ch = claimHash(OIDC, '/it-dev')!
    expect(ch).not.toBe(claimHash(OIDC, '/other-group'))
    expect(claimHash({ ...OIDC, issuer: null }, '/it-dev')).toBeNull()
    const claimed = { personId: 'p1', username: 'somchai', hash: ch, at: 'x', grantedAdmin: true }
    expect(stepStates(facts({ oidc: hash, claim: ch, claimedIsAdmin: true, record: { marks: {}, claimed } }))).toMatchObject({ signin: 'done', claim: 'done' })
    // Changed sign-in values or staff group, or an admin flag taken away since: claim again.
    expect(stepStates(facts({ oidc: other, claim: claimHash({ ...OIDC, clientId: 'other' }, '/it-dev'), claimedIsAdmin: true, record: { marks: {}, claimed } })).claim).toBe('todo')
    expect(stepStates(facts({ oidc: hash, claim: claimHash(OIDC, '/other-group'), claimedIsAdmin: true, record: { marks: {}, claimed } })).claim).toBe('todo')
    expect(stepStates(facts({ oidc: hash, claim: ch, claimedIsAdmin: false, record: { marks: {}, claimed } })).claim).toBe('todo')
  })

  it('needs organisation, admin, kit and claim to complete (8.1); optional steps never block', () => {
    expect(REQUIRED_FOR_COMPLETION).toEqual(['organisation', 'admin', 'kit', 'claim'])
    expect(missingSteps(stepStates(facts()))).toEqual(['organisation', 'admin', 'kit', 'claim'])
    const hash = claimHash(OIDC, '/it-dev')!
    const all = facts({
      organisation: true,
      admin: true,
      oidc: oidcHash(OIDC),
      claim: hash,
      claimedIsAdmin: true,
      record: { marks: {}, kitDownloadedAt: 'x', claimed: { personId: 'p', username: 'u', hash, at: 'x', grantedAdmin: true } },
    })
    expect(missingSteps(stepStates(all))).toEqual([])
  })

  it('reads a damaged record as empty rather than failing', () => {
    expect(parseProgress(null)).toEqual({ marks: {} })
    expect(parseProgress({ marks: { check: 'nope' } })).toEqual({ marks: {} })
    expect(parseProgress({ marks: { check: 'done' }, kitDownloadedAt: '2026-11-27' })).toEqual({ marks: { check: 'done' }, kitDownloadedAt: '2026-11-27' })
    // Claims recorded before `grantedAdmin` existed count as granted by the claim.
    expect(parseProgress({ claimed: { personId: 'p', username: 'u', hash: 'h', at: 'x' } }).claimed?.grantedAdmin).toBe(true)
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
    // No bootstrap values given: no section 3.
    expect(text).not.toContain('3. BOOTSTRAP VALUES')
  })

  it('carries the Postgres password and the storage keys of the bundled services, labelled (I2)', () => {
    const bootstrap = kitBootstrapValues({ databaseUrl: 'postgres://yoda:pg%2Fplaceholder@postgres:5432/yoda', s3Endpoint: 'http://rustfs:9000', s3AccessKey: 'access-placeholder', s3SecretKey: 'secret-placeholder' })
    expect(bootstrap).toEqual({ postgresUser: 'yoda', postgresPassword: 'pg/placeholder', s3AccessKey: 'access-placeholder', s3SecretKey: 'secret-placeholder', postgresExternal: false, s3External: false })
    const text = recoveryKitText({ installId: 'i', publicUrl: '', keyId: 'k', masterKey: 'placeholder-master-key', username: 'admin', codes: [], at: new Date(0), bootstrap })
    const section = text.slice(text.indexOf('3. BOOTSTRAP VALUES'))
    expect(section).toContain('POSTGRES_PASSWORD=pg/placeholder\n')
    expect(section).toContain('S3_ACCESS_KEY=access-placeholder\n')
    expect(section).toContain('S3_SECRET_KEY=secret-placeholder\n')
    expect(section).toContain('YODA_MASTER_KEY=placeholder-master-key\n')
    expect(section).toContain('section 4a')
    expect(section).not.toContain('external service')
    // The default user is not repeated; another one is.
    expect(section).not.toContain('POSTGRES_USER=')
    expect(recoveryKitText({ installId: 'i', publicUrl: '', keyId: 'k', masterKey: 'm', username: 'a', codes: [], at: new Date(0), bootstrap: kitBootstrapValues({ databaseUrl: 'postgres://hosp:x@postgres/yoda' }) })).toContain('POSTGRES_USER=hosp\n')
  })

  it('leaves out the credentials of an external Postgres or S3 (managed outside Yoda)', () => {
    const both = kitBootstrapValues({ databaseUrl: 'postgres://hosp:db-placeholder@db.example.org:5432/yoda', s3Endpoint: 'https://s3.example.org', s3AccessKey: 'ext-access', s3SecretKey: 'ext-secret' })
    expect(both).toMatchObject({ postgresPassword: null, s3AccessKey: null, s3SecretKey: null, postgresExternal: true, s3External: true })
    const text = recoveryKitText({ installId: 'i', publicUrl: '', keyId: 'k', masterKey: 'm', username: 'a', codes: [], at: new Date(0), bootstrap: both })
    expect(text).toContain('Postgres: external service — credentials managed outside Yoda')
    expect(text).toContain('Storage (S3): external service — credentials managed outside Yoda')
    for (const v of ['db-placeholder', 'ext-access', 'ext-secret', 'POSTGRES_PASSWORD=', 'S3_ACCESS_KEY=']) expect(text).not.toContain(v)
    // Mixed: bundled Postgres, external bucket.
    const mixed = recoveryKitText({ installId: 'i', publicUrl: '', keyId: 'k', masterKey: 'm', username: 'a', codes: [], at: new Date(0), bootstrap: kitBootstrapValues({ databaseUrl: 'postgres://yoda:pg-placeholder@postgres:5432/yoda', s3Endpoint: 'https://s3.example.org', s3AccessKey: 'ext-access', s3SecretKey: 'ext-secret' }) })
    expect(mixed).toContain('POSTGRES_PASSWORD=pg-placeholder\n')
    expect(mixed).toContain('Storage (S3): external service')
    expect(mixed).not.toContain('ext-secret')
    expect(kitBootstrapValues({ databaseUrl: 'not a url' })).toMatchObject({ postgresPassword: null, postgresExternal: true })
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
    // Keycloak leaves the claim out for a person in no group: a staff failure, not a token failure.
    const none = await claim({ username: 'nurse1', groups: null })
    expect(none.checks.find((c) => !c.ok)).toMatchObject({ id: 'staff', code: 'not_staff_no_groups' })
    expect(none.checks.find((c) => c.id === 'access_token')?.ok).toBe(true)
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

describe('scheme and origin through the portal (Task 8 review)', () => {
  async function probe() {
    const a = Fastify({ trustProxy: trustProxy(1) })
    a.get('/t', async (request) => ({ https: isHttps(request), origin: originAllowed(request, 'https://portal.example.org'), host: request.host }))
    return a
  }

  it('reads https from the portal (an internal peer) and allows the https origin', async () => {
    const a = await probe()
    const res = await a.inject({ url: '/t', remoteAddress: '172.18.0.5', headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'portal.example.org', 'x-forwarded-for': '10.0.0.9', origin: 'https://portal.example.org' } })
    expect(res.json()).toEqual({ https: true, origin: true, host: 'portal.example.org' })
    // The public URL's origin is allowed even when the host the request names differs (a LAN name).
    const lan = await a.inject({ url: '/t', remoteAddress: '172.18.0.5', headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'yoda.lan', 'x-forwarded-for': '10.0.0.9', origin: 'https://portal.example.org' } })
    expect(lan.json()).toMatchObject({ https: true, origin: true })
    const foreign = await a.inject({ url: '/t', remoteAddress: '172.18.0.5', headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'portal.example.org', origin: 'https://evil.example.org' } })
    expect(foreign.json().origin).toBe(false)
    // Plain http and an https origin do not match.
    const plain = await a.inject({ url: '/t', remoteAddress: '172.18.0.5', headers: { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'yoda.lan', origin: 'https://yoda.lan' } })
    expect(plain.json()).toMatchObject({ https: false, origin: false })
    await a.close()
  })

  it('ignores X-Forwarded-Proto from a peer that is not internal', async () => {
    const a = await probe()
    const res = await a.inject({ url: '/t', remoteAddress: '203.0.113.7', headers: { 'x-forwarded-proto': 'https' } })
    expect(res.json().https).toBe(false)
    await a.close()
  })

  it('spots a proxy in front of the portal while hops is 1', () => {
    expect(outerProxyHint('172.18.0.5', '10.0.0.9', 1)).toBe(false)
    expect(outerProxyHint('172.18.0.5', '10.0.0.9, 172.18.0.7', 1)).toBe(true)
    expect(outerProxyHint('172.18.0.5', ['10.0.0.9', '172.18.0.7'], 1)).toBe(true)
    expect(outerProxyHint('172.18.0.5', '10.0.0.9, 172.18.0.7', 2)).toBe(false)
    expect(outerProxyHint('203.0.113.7', '10.0.0.9, 172.18.0.7', 1)).toBe(false)
    expect(outerProxyHint('172.18.0.5', undefined, 1)).toBe(false)
  })
})
