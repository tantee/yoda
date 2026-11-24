import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { SignJWT, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, type AppDeps } from '../src/app.js'
import { requireAdmin, requireStaff } from '../src/auth/plugin.js'
import { people } from '../src/db/schema.js'
import { signToken, TEST_CLIENT_ID, TEST_ISSUER } from './jwt.js'
import { resetDb, testDb, testDeps } from './helpers.js'

let app: FastifyInstance | undefined

async function makeApp(mutate?: (d: AppDeps) => AppDeps): Promise<FastifyInstance> {
  const deps = await testDeps()
  app = await buildApp(mutate ? mutate(deps) : deps)
  return app
}

function me(a: FastifyInstance, token?: string) {
  return a.inject({
    url: '/me',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

async function peopleCount(): Promise<number> {
  const db = await testDb()
  const [row] = await db.execute<{ count: string }>(sql`select count(*)::text as count from people`)
  return Number(row.count)
}

const now = () => Math.floor(Date.now() / 1000)

describe('auth', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
  })
  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  describe('rejects bad tokens with 401 and creates no person', () => {
    const base = { sub: 'bad', preferred_username: 'mallory' }

    it('no Authorization header', async () => {
      const a = await makeApp()
      const res = await me(a)
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ error: 'unauthorized' })
    })

    it('non-Bearer scheme / garbage token', async () => {
      const a = await makeApp()
      const basic = await a.inject({ url: '/me', headers: { authorization: 'Basic abc' } })
      expect(basic.statusCode).toBe(401)
      const garbage = await me(a, 'not.a.jwt')
      expect(garbage.statusCode).toBe(401)
      expect(garbage.json()).toEqual({ error: 'unauthorized' })
    })

    it('expired token', async () => {
      const a = await makeApp()
      const res = await me(a, await signToken({ ...base, iat: now() - 600, exp: now() - 60 }))
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ error: 'unauthorized' })
    })

    it('wrong issuer', async () => {
      const a = await makeApp()
      const res = await me(a, await signToken({ ...base, iss: 'http://evil' }))
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ error: 'unauthorized' })
    })

    it('wrong client (azp)', async () => {
      const a = await makeApp()
      const res = await me(a, await signToken({ ...base, azp: 'other-client' }))
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ error: 'unauthorized' })
    })

    it('missing azp', async () => {
      const a = await makeApp()
      const res = await me(a, await signToken({ ...base, azp: undefined }))
      expect(res.statusCode).toBe(401)
    })

    it('Keycloak ID token (typ ID) instead of access token', async () => {
      const a = await makeApp()
      const res = await me(a, await signToken({ ...base, typ: 'ID' }))
      expect(res.statusCode).toBe(401)
    })

    it('token without exp', async () => {
      const a = await makeApp()
      const res = await me(a, await signToken({ ...base, exp: undefined }))
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ error: 'unauthorized' })
    })

    it('unknown route without a token', async () => {
      const a = await makeApp()
      const res = await a.inject({ url: '/nope' })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ error: 'unauthorized' })
    })

    it('signed by an unknown key', async () => {
      const a = await makeApp()
      const { privateKey } = await generateKeyPair('RS256')
      const forged = await new SignJWT({
        ...base,
        iss: TEST_ISSUER,
        azp: TEST_CLIENT_ID,
        exp: now() + 300,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .sign(privateKey)
      const res = await me(a, forged)
      expect(res.statusCode).toBe(401)
    })

    it('valid signature but missing sub / preferred_username', async () => {
      const a = await makeApp()
      expect((await me(a, await signToken({ preferred_username: 'x' }))).statusCode).toBe(401)
      expect((await me(a, await signToken({ sub: 'x' }))).statusCode).toBe(401)
    })

    afterEach(async () => {
      expect(await peopleCount()).toBe(0)
    })
  })

  it('accepts lowercase bearer scheme', async () => {
    const a = await makeApp()
    const token = await signToken({ sub: 'lc1', preferred_username: 'lower' })
    const res = await a.inject({ url: '/me', headers: { authorization: `bearer ${token}` } })
    expect(res.statusCode).toBe(200)
    expect(res.json().username).toBe('lower')
  })

  it('/health stays unauthenticated', async () => {
    const a = await makeApp()
    const res = await a.inject({ url: '/health' })
    expect(res.statusCode).toBe(200)
  })

  it('staff with Thai name', async () => {
    const a = await makeApp()
    const token = await signToken({
      sub: 's1',
      preferred_username: 'somchai',
      name: 'สมชาย ใจดี',
      email: 'somchai@example.test',
      groups: ['/it-dev'],
    })
    const res = await me(a, token)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({
      username: 'somchai',
      displayName: 'สมชาย ใจดี',
      email: 'somchai@example.test',
      isStaff: true,
      isAdmin: false,
    })
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/)
    const db = await testDb()
    const [row] = await db.select().from(people).where(eq(people.keycloakSub, 's1'))
    expect(row.displayName).toBe('สมชาย ใจดี')
  })

  it('requester with incomplete profile falls back to username', async () => {
    const a = await makeApp()
    const res = await me(a, await signToken({ sub: 's2', preferred_username: 'nurse1' }))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      username: 'nurse1',
      displayName: 'nurse1',
      email: null,
      isStaff: false,
      isAdmin: false,
    })
  })

  it('blank name falls back to username', async () => {
    const a = await makeApp()
    const res = await me(a, await signToken({ sub: 's3', preferred_username: 'ext1', name: '   ' }))
    expect(res.json().displayName).toBe('ext1')
  })

  it('staff status is recomputed per request from groups', async () => {
    const a = await makeApp()
    const first = await me(a, await signToken({ sub: 's1', preferred_username: 'somchai', groups: ['/it-dev'] }))
    expect(first.json().isStaff).toBe(true)
    const second = await me(a, await signToken({ sub: 's1', preferred_username: 'somchai', groups: [] }))
    expect(second.statusCode).toBe(200)
    expect(second.json().isStaff).toBe(false)
    expect(second.json().id).toBe(first.json().id)
    expect(await peopleCount()).toBe(1)
  })

  it('staff_override = true grants staff without the group', async () => {
    const db = await testDb()
    await db.insert(people).values({
      keycloakSub: 's4',
      username: 'contractor',
      displayName: 'Contractor',
      staffOverride: true,
    })
    const a = await makeApp()
    const res = await me(a, await signToken({ sub: 's4', preferred_username: 'contractor' }))
    expect(res.json().isStaff).toBe(true)
  })

  it('staff_override = false revokes staff despite the group', async () => {
    const db = await testDb()
    await db.insert(people).values({
      keycloakSub: 's5',
      username: 'revoked',
      displayName: 'Revoked',
      staffOverride: false,
    })
    const a = await makeApp()
    const res = await me(a, await signToken({ sub: 's5', preferred_username: 'revoked', groups: ['/it-dev'] }))
    expect(res.json().isStaff).toBe(false)
  })

  it('BOOTSTRAP_ADMINS makes the first login an admin (and staff)', async () => {
    const a = await makeApp((d) => ({ ...d, config: { ...d.config, bootstrapAdmins: ['somchai'] } }))
    const res = await me(a, await signToken({ sub: 's1', preferred_username: 'somchai' }))
    expect(res.json()).toMatchObject({ isAdmin: true, isStaff: true })
  })

  it('two simultaneous first requests create exactly one person', async () => {
    const a = await makeApp()
    const token = await signToken({ sub: 'new-sub', preferred_username: 'racer' })
    const [r1, r2] = await Promise.all([me(a, token), me(a, token)])
    expect(r1.statusCode).toBe(200)
    expect(r2.statusCode).toBe(200)
    expect(r1.json().id).toBe(r2.json().id)
    expect(await peopleCount()).toBe(1)
  })

  describe('guards', () => {
    async function guardedApp(mutate?: (d: AppDeps) => AppDeps) {
      const a = await makeApp(mutate)
      a.get('/staff-only', async (req) => {
        requireStaff(req)
        return { ok: true }
      })
      a.get('/admin-only', async (req) => {
        requireAdmin(req)
        return { ok: true }
      })
      return a
    }
    const get = (a: FastifyInstance, url: string, token: string) =>
      a.inject({ url, headers: { authorization: `Bearer ${token}` } })

    it('requester gets 403 on staff and admin routes', async () => {
      const a = await guardedApp()
      const t = await signToken({ sub: 'r1', preferred_username: 'nurse1' })
      for (const url of ['/staff-only', '/admin-only']) {
        const res = await get(a, url, t)
        expect(res.statusCode).toBe(403)
        expect(res.json()).toEqual({ error: 'forbidden' })
      }
    })

    it('staff passes staff guard but not admin guard', async () => {
      const a = await guardedApp()
      const t = await signToken({ sub: 'st1', preferred_username: 'dev1', groups: ['/it-dev'] })
      expect((await get(a, '/staff-only', t)).statusCode).toBe(200)
      const res = await get(a, '/admin-only', t)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ error: 'forbidden' })
    })

    it('admin passes both guards even without the staff group', async () => {
      const a = await guardedApp((d) => ({ ...d, config: { ...d.config, bootstrapAdmins: ['boss'] } }))
      const t = await signToken({ sub: 'ad1', preferred_username: 'boss' })
      expect((await get(a, '/staff-only', t)).statusCode).toBe(200)
      expect((await get(a, '/admin-only', t)).statusCode).toBe(200)
    })

    it('unauthenticated request to guarded route is 401', async () => {
      const a = await guardedApp()
      const res = await a.inject({ url: '/staff-only' })
      expect(res.statusCode).toBe(401)
    })
  })
})
