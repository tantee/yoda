import { createHash } from 'node:crypto'
import { chromiumappRedirect, settingDef, type ExtensionSession, type ExtensionTokenResponse, type SettingKey } from '@yoda/shared'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extensionGrants, projectMembers, projectRepos, projects } from '../src/db/schema.js'
import type { SettingsStore } from '../src/settings/store.js'
import { resetDb, testDb } from './helpers.js'
import { auth, login, makeApp, type Who } from './support.js'

const EXT = 'mmcaeimamhfdkmmkfpgfijlhiepcjoje'
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')

/** A settings store stand-in: registry defaults plus the test's values; setup done; forced recovery switchable. */
function fakeStore(values: Partial<Record<SettingKey, unknown>> = {}) {
  return {
    values,
    recoveryForced: false,
    recovery: false,
    setupDone: true,
    keyStatus: 'ok',
    get: (k: SettingKey) => (Object.hasOwn(values, k) ? values[k] : settingDef(k).default),
    fromEnv: () => false,
    recoveryWritable: () => false,
  }
}

let app: FastifyInstance
let store: ReturnType<typeof fakeStore>

async function boot() {
  store = fakeStore({ 'extension.allowedIds': [EXT] })
  app = await makeApp({ settings: store as unknown as SettingsStore })
}

beforeEach(async () => {
  await resetDb(await testDb())
  await boot()
})
afterEach(async () => {
  await app.close()
})

type Res = Awaited<ReturnType<FastifyInstance['inject']>>
const post = (url: string, payload: unknown, headers: Record<string, string> = {}, ip = '10.1.0.1'): Promise<Res> =>
  app.inject({ method: 'POST', url, payload: payload as object, headers, remoteAddress: ip })
const get = (url: string, headers: Record<string, string> = {}): Promise<Res> => app.inject({ method: 'GET', url, headers })

const authorizeBody = (o: Record<string, unknown> = {}) => ({
  extensionId: EXT,
  redirectUri: chromiumappRedirect(EXT),
  codeChallenge: CHALLENGE,
  codeChallengeMethod: 'S256',
  state: 'st',
  browserLabel: 'Chrome 131 Windows',
  ...o,
})

async function code(who: Who): Promise<string> {
  const res = await post('/extension/authorize', authorizeBody(), auth(who))
  expect(res.statusCode, res.body).toBe(200)
  return new URL(res.json().redirectTo).searchParams.get('code')!
}

async function connect(who: Who, ip = '10.1.0.1'): Promise<ExtensionTokenResponse> {
  const res = await post('/extension/token', { grantType: 'authorization_code', code: await code(who), codeVerifier: VERIFIER, extensionId: EXT }, {}, ip)
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}

const xt = (t: ExtensionTokenResponse) => ({ authorization: `Bearer ${t.accessToken}` })
const refresh = (refreshToken: string, ip = '10.1.0.1') => post('/extension/token', { grantType: 'refresh_token', refreshToken }, {}, ip)

describe('connect', () => {
  it('authorize → token → session round trip for a staff member, with PKCE', async () => {
    const dev = await login(app, 'dev1', { staff: true, name: 'นักพัฒนา' })
    const res = await post('/extension/authorize', authorizeBody(), auth(dev))
    expect(res.statusCode).toBe(200)
    const redirect = new URL(res.json().redirectTo)
    expect(`${redirect.origin}/`).toBe(chromiumappRedirect(EXT))
    expect(redirect.searchParams.get('state')).toBe('st')

    const wrong = await post('/extension/token', { grantType: 'authorization_code', code: redirect.searchParams.get('code'), codeVerifier: 'x'.repeat(43), extensionId: EXT })
    expect(wrong.statusCode).toBe(401)
    expect(wrong.json()).toEqual({ error: 'unauthorized', reason: 'invalid_grant' })

    const t = await connect(dev)
    expect(t.person).toMatchObject({ id: dev.id, displayName: 'นักพัฒนา', isStaff: true })
    const s = await get('/extension/session', xt(t))
    expect(s.statusCode, s.body).toBe(200)
    const session = s.json() as ExtensionSession
    expect(session).toMatchObject({ apiVersion: 1, person: { id: dev.id }, latestExtension: null, policy: { videoOnProduction: false, logsOnProductionDefault: false, requireConfirm: true } })
    expect(session.limits).toMatchObject({ maxFiles: 8, maxReportBytes: 50 * 1024 * 1024, maxVideoSeconds: 30 })
    expect(session.instance.publicUrl).toBe('http://localhost:3000')

    const r = await refresh(t.refreshToken)
    expect(r.statusCode).toBe(200)
    expect((r.json() as ExtensionTokenResponse).grantId).toBe(t.grantId)
  })

  it('authorize is 401 without a Keycloak token and 401 with a yoda_xt_ token', async () => {
    const dev = await login(app, 'dev1', { staff: true })
    const t = await connect(dev)
    expect((await post('/extension/authorize', authorizeBody())).statusCode).toBe(401)
    expect((await post('/extension/authorize', authorizeBody(), xt(t))).statusCode).toBe(401)
  })

  it('authorize refuses requesters and unknown extension IDs', async () => {
    const req = await login(app, 'req1')
    expect((await post('/extension/authorize', authorizeBody(), auth(req))).json()).toEqual({ error: 'forbidden', reason: 'not_staff' })
    const dev = await login(app, 'dev1', { staff: true })
    const other = 'b'.repeat(32)
    const res = await post('/extension/authorize', authorizeBody({ extensionId: other, redirectUri: chromiumappRedirect(other) }), auth(dev))
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'forbidden', reason: 'extension_not_allowed' })
  })
})

describe('separation', () => {
  it('session refuses a Keycloak bearer, and /me and /projects refuse a yoda_xt_ token', async () => {
    const dev = await login(app, 'dev1', { staff: true })
    const t = await connect(dev)
    expect((await get('/extension/session', auth(dev))).statusCode).toBe(401)
    expect((await get('/extension/session')).statusCode).toBe(401)
    expect((await get('/me', xt(t))).statusCode).toBe(401)
    expect((await get('/projects', xt(t))).statusCode).toBe(401)
    expect((await post('/extension/revoke', {}, auth(dev))).statusCode).toBe(401)
  })
})

describe('modes', () => {
  it('all three modes answer 404 when extension.enabled=false, and grants are kept', async () => {
    const dev = await login(app, 'dev1', { staff: true })
    const t = await connect(dev)
    store.values['extension.enabled'] = false
    expect((await post('/extension/authorize', authorizeBody(), auth(dev))).json()).toEqual({ error: 'not_found' })
    expect((await refresh(t.refreshToken)).statusCode).toBe(404)
    expect((await get('/extension/session', xt(t))).statusCode).toBe(404)
    expect((await get('/extension/session')).statusCode).toBe(404)
    expect(await (await testDb()).select().from(extensionGrants)).toHaveLength(1)
    store.values['extension.enabled'] = true
    expect((await get('/extension/session', xt(t))).statusCode).toBe(200)
  })

  it('all three modes answer 503 recovery_mode in forced recovery mode', async () => {
    const dev = await login(app, 'dev1', { staff: true })
    const t = await connect(dev)
    store.recoveryForced = true
    for (const res of [await post('/extension/authorize', authorizeBody(), auth(dev)), await refresh(t.refreshToken), await get('/extension/session', xt(t))]) {
      expect(res.statusCode).toBe(503)
      expect(res.json()).toEqual({ error: 'recovery_mode' })
    }
  })
})

describe('limits', () => {
  it('5 failed code exchanges from one IP give 429 with retryAfter, and successful ones do not count', async () => {
    const dev = await login(app, 'dev1', { staff: true })
    for (let i = 0; i < 6; i++) await connect(dev, '10.2.0.1')
    const bad = { grantType: 'authorization_code', code: `yoda_xc_${'A'.repeat(43)}`, codeVerifier: VERIFIER, extensionId: EXT }
    for (let i = 0; i < 5; i++) expect((await post('/extension/token', bad, {}, '10.2.0.1')).statusCode).toBe(401)
    const good = { grantType: 'authorization_code', code: await code(dev), codeVerifier: VERIFIER, extensionId: EXT }
    const limited = await post('/extension/token', good, {}, '10.2.0.1')
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ error: 'rate_limited' })
    expect(limited.json().retryAfter).toBeGreaterThan(0)
    // Another address is not limited.
    expect((await post('/extension/token', good, {}, '10.2.0.2')).statusCode).toBe(200)
  })

  it('5 failed refreshes in one family give 429 for that family only; another family from the same IP still refreshes', async () => {
    const dev = await login(app, 'dev1', { staff: true })
    const a = await connect(dev)
    const b = await connect(dev)
    expect((await refresh(a.refreshToken)).statusCode).toBe(200)
    // The first reuse revokes family a; every later try fails too.
    for (let i = 0; i < 5; i++) {
      const r = await refresh(a.refreshToken)
      expect(r.statusCode).toBe(401)
      expect(r.json()).toEqual({ error: 'unauthorized', reason: 'revoked' })
    }
    const limited = await refresh(a.refreshToken)
    expect(limited.statusCode).toBe(429)
    expect(limited.json().retryAfter).toBeGreaterThan(0)
    expect((await refresh(b.refreshToken)).statusCode).toBe(200)
  })
})

describe('contents', () => {
  it('revoke ends the grant', async () => {
    const dev = await login(app, 'dev1', { staff: true })
    const t = await connect(dev)
    expect((await post('/extension/revoke', {}, xt(t))).statusCode).toBe(204)
    expect((await get('/extension/session', xt(t))).statusCode).toBe(401)
    expect((await refresh(t.refreshToken)).json()).toEqual({ error: 'unauthorized', reason: 'revoked' })
    const [g] = await (await testDb()).select().from(extensionGrants)
    expect(g).toMatchObject({ revokeReason: 'user', revokedBy: dev.id })
  })

  it('session lists only member projects (an admin sees only their member projects), with noAi and repos', async () => {
    const db = await testDb()
    const boss = await login(app, 'boss', { staff: true })
    const dev = await login(app, 'dev1', { staff: true })
    const [p1] = await db.insert(projects).values({ name: 'OPD', noAi: true }).returning()
    const [p2] = await db.insert(projects).values({ name: 'Lab' }).returning()
    const [p3] = await db.insert(projects).values({ name: 'Old', status: 'archived' }).returning()
    await db.insert(projectMembers).values([
      { projectId: p1!.id, personId: dev.id, roles: ['DEV'] },
      { projectId: p3!.id, personId: dev.id, roles: ['DEV'] },
      { projectId: p2!.id, personId: boss.id, roles: ['PM'] },
    ])
    await db.insert(projectRepos).values({ projectId: p1!.id, gitlabProjectId: 7, pathWithNamespace: 'his/opd-web', webUrl: 'https://gitlab.example.org/his/opd-web' })

    const devSession = (await get('/extension/session', xt(await connect(dev)))).json() as ExtensionSession
    expect(devSession.projects).toEqual([{ id: p1!.id, name: 'OPD', noAi: true, kinds: ['defect', 'bug_fix_request'], repos: ['his/opd-web'] }])
    const bossSession = (await get('/extension/session', xt(await connect(boss)))).json() as ExtensionSession
    expect(bossSession.projects.map((p) => p.id)).toEqual([p2!.id])
    expect(bossSession.projects[0]).toMatchObject({ noAi: false, repos: [] })
  })

  it('public-config reports extension.enabled', async () => {
    expect((await get('/public-config')).json().extension).toEqual({ enabled: true, apiVersion: 1, mediaRetentionDays: 180, logRetentionDays: 90 })
    store.values['extension.enabled'] = false
    expect((await get('/public-config')).json().extension).toEqual({ enabled: false, apiVersion: 1, mediaRetentionDays: 180, logRetentionDays: 90 })
  })

  it('a grant whose extension ID is no longer allowed is refused at once', async () => {
    const db = await testDb()
    const dev = await login(app, 'dev1', { staff: true })
    const t = await connect(dev)
    await db.update(extensionGrants).set({ extensionId: 'c'.repeat(32) }).where(eq(extensionGrants.id, t.grantId))
    expect((await get('/extension/session', xt(t))).statusCode).toBe(401)
  })
})
