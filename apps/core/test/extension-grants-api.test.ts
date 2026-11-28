import { createHash } from 'node:crypto'
import { chromiumappRedirect, ExtensionGrant, settingDef, type ExtensionTokenResponse, type SettingKey } from '@yoda/shared'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extensionGrants } from '../src/db/schema.js'
import type { SettingsStore } from '../src/settings/store.js'
import { resetDb, testDb } from './helpers.js'
import { auth, login, makeApp, type Who } from './support.js'

const EXT = 'mmcaeimamhfdkmmkfpgfijlhiepcjoje'
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const DAY = 86_400_000

let app: FastifyInstance

beforeEach(async () => {
  await resetDb(await testDb())
  const values: Partial<Record<SettingKey, unknown>> = { 'extension.allowedIds': [EXT] }
  const store = {
    recoveryForced: false,
    recovery: false,
    setupDone: true,
    get: (k: SettingKey) => (Object.hasOwn(values, k) ? values[k] : settingDef(k).default),
    fromEnv: () => false,
    recoveryWritable: () => false,
  }
  app = await makeApp({ settings: store as unknown as SettingsStore })
})
afterEach(async () => {
  await app.close()
})

type Res = Awaited<ReturnType<FastifyInstance['inject']>>
const call = (who: Who | null, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}): Promise<Res> =>
  app.inject({ method, url, ...(payload ? { payload } : {}), headers: { ...(who ? auth(who) : {}), ...headers }, remoteAddress: '10.3.0.1' })

async function connect(who: Who, browserLabel = 'Chrome 131 Windows'): Promise<ExtensionTokenResponse> {
  const a = await call(who, 'POST', '/extension/authorize', {
    extensionId: EXT,
    redirectUri: chromiumappRedirect(EXT),
    codeChallenge: createHash('sha256').update(VERIFIER).digest('base64url'),
    codeChallengeMethod: 'S256',
    state: 's',
    browserLabel,
  })
  const code = new URL(a.json().redirectTo).searchParams.get('code')!
  const t = await call(null, 'POST', '/extension/token', { grantType: 'authorization_code', code, codeVerifier: VERIFIER, extensionId: EXT })
  expect(t.statusCode, t.body).toBe(200)
  return t.json()
}

const session = (t: ExtensionTokenResponse) => call(null, 'GET', '/extension/session', undefined, { authorization: `Bearer ${t.accessToken}` })

describe('connected browsers API', () => {
  it('a person lists and revokes only their own grants', async () => {
    const dev = await login(app, 'dev1', { staff: true })
    const qa = await login(app, 'qa1', { staff: true })
    const first = await connect(dev, 'Edge 131 Windows')
    const second = await connect(dev, 'Chrome 131 macOS')
    const theirs = await connect(qa)

    const list = (await call(dev, 'GET', '/me/extension-grants')).json() as ExtensionGrant[]
    expect(list.map((g) => g.id)).toEqual([second.grantId, first.grantId])
    expect(list.map((g) => ExtensionGrant.parse(g))).toHaveLength(2)
    expect(list[0]).toMatchObject({ extensionId: EXT, browserLabel: 'Chrome 131 macOS', revokedAt: null, revokeReason: null, lastIp: '10.3.0.1', person: { id: dev.id, displayName: 'dev1' } })

    expect((await call(dev, 'DELETE', `/me/extension-grants/${theirs.grantId}`)).statusCode).toBe(404)
    expect((await session(theirs)).statusCode).toBe(200)
    expect((await call(dev, 'DELETE', `/me/extension-grants/00000000-0000-4000-8000-000000000000`)).statusCode).toBe(404)

    expect((await call(dev, 'DELETE', `/me/extension-grants/${first.grantId}`)).statusCode).toBe(204)
    expect((await session(first)).statusCode).toBe(401)
    const after = (await call(dev, 'GET', '/me/extension-grants')).json() as ExtensionGrant[]
    expect(after.find((g) => g.id === first.grantId)).toMatchObject({ revokeReason: 'user' })
    expect(after.find((g) => g.id === first.grantId)!.revokedAt).not.toBeNull()

    // Revoked grants stay listed for 30 days.
    const db = await testDb()
    await db.update(extensionGrants).set({ revokedAt: new Date(Date.now() - 31 * DAY) }).where(eq(extensionGrants.id, first.grantId))
    expect(((await call(dev, 'GET', '/me/extension-grants')).json() as ExtensionGrant[]).map((g) => g.id)).toEqual([second.grantId])
  })

  it('staff non-admins get 403 on /admin/extension-grants', async () => {
    const dev = await login(app, 'dev1', { staff: true })
    const t = await connect(dev)
    expect((await call(dev, 'GET', '/admin/extension-grants')).statusCode).toBe(403)
    expect((await call(dev, 'DELETE', `/admin/extension-grants/${t.grantId}`)).statusCode).toBe(403)
    expect((await call(dev, 'POST', '/admin/extension-grants/revoke-all')).statusCode).toBe(403)
    expect((await session(t)).statusCode).toBe(200)
  })

  it('an admin lists everyone, active only on request, and revokes one', async () => {
    const boss = await login(app, 'boss', { staff: true })
    const dev = await login(app, 'dev1', { staff: true })
    const a = await connect(dev)
    const b = await connect(dev)
    expect((await call(dev, 'DELETE', `/me/extension-grants/${a.grantId}`)).statusCode).toBe(204)

    const all = (await call(boss, 'GET', '/admin/extension-grants')).json() as ExtensionGrant[]
    expect(all.map((g) => g.id)).toEqual([b.grantId, a.grantId])
    expect(all[0]!.person).toEqual({ id: dev.id, displayName: 'dev1' })
    const active = (await call(boss, 'GET', '/admin/extension-grants?active=1')).json() as ExtensionGrant[]
    expect(active.map((g) => g.id)).toEqual([b.grantId])

    expect((await call(boss, 'DELETE', `/admin/extension-grants/${b.grantId}`)).statusCode).toBe(204)
    expect((await session(b)).statusCode).toBe(401)
    const [row] = await (await testDb()).select().from(extensionGrants).where(eq(extensionGrants.id, b.grantId))
    expect(row).toMatchObject({ revokeReason: 'admin', revokedBy: boss.id })
    expect((await call(boss, 'DELETE', `/admin/extension-grants/00000000-0000-4000-8000-000000000000`)).statusCode).toBe(404)
  })

  it('revoke-all revokes every active grant and the old tokens stop working', async () => {
    const boss = await login(app, 'boss', { staff: true })
    const dev = await login(app, 'dev1', { staff: true })
    const qa = await login(app, 'qa1', { staff: true })
    const tokens = [await connect(dev), await connect(qa), await connect(boss)]
    await call(qa, 'DELETE', `/me/extension-grants/${tokens[1]!.grantId}`)
    const res = await call(boss, 'POST', '/admin/extension-grants/revoke-all')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ revoked: 2 })
    for (const t of tokens) expect((await session(t)).statusCode).toBe(401)
    for (const t of tokens) {
      const r = await call(null, 'POST', '/extension/token', { grantType: 'refresh_token', refreshToken: t.refreshToken })
      expect(r.json()).toEqual({ error: 'unauthorized', reason: 'revoked' })
    }
    const rows = await (await testDb()).select().from(extensionGrants)
    expect(rows.filter((r) => r.revokeReason === 'admin_all')).toHaveLength(2)
  })

  it('no hash or token appears in any response', async () => {
    const boss = await login(app, 'boss', { staff: true })
    const dev = await login(app, 'dev1', { staff: true })
    const t = await connect(dev)
    const [row] = await (await testDb()).select().from(extensionGrants)
    const bodies = [
      (await call(dev, 'GET', '/me/extension-grants')).body,
      (await call(boss, 'GET', '/admin/extension-grants')).body,
      (await call(boss, 'GET', '/admin/extension-grants?active=1')).body,
      (await session(t)).body,
    ]
    for (const body of bodies) {
      for (const secret of [t.accessToken, t.refreshToken, row!.accessHash!, row!.familyId, createHash('sha256').update(t.refreshToken).digest('hex')]) {
        expect(body).not.toContain(secret)
      }
      expect(body).not.toMatch(/yoda_x[ctr]_/)
      expect(body).not.toMatch(/"(accessHash|familyId|hash|codeHash)"/)
    }
  })
})
