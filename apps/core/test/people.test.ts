import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDb, testDb } from './helpers.js'
import { auth, login, makeApp } from './support.js'

let app: FastifyInstance

describe('people API', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
    app = await makeApp()
  })
  afterEach(async () => {
    await app.close()
  })

  it('requester gets 403 on GET /people', async () => {
    const nurse = await login(app, 'nurse1')
    const res = await app.inject({ url: '/people', headers: auth(nurse) })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'forbidden' })
  })

  it('staff lists people sorted by displayName, with staff status', async () => {
    const zed = await login(app, 'zed', { staff: true, name: 'Zed' })
    await login(app, 'amy', { name: 'Amy' })
    await login(app, 'somchai', { staff: true, name: 'สมชาย' })
    const res = await app.inject({ url: '/people', headers: auth(zed) })
    expect(res.statusCode).toBe(200)
    const list = res.json()
    expect(list.map((p: { displayName: string }) => p.displayName)).toEqual(['Amy', 'Zed', 'สมชาย'])
    expect(list.map((p: { isStaff: boolean }) => p.isStaff)).toEqual([false, true, true])
  })

  it('non-admin staff gets 403 on PATCH /people/:id', async () => {
    const staff = await login(app, 'somchai', { staff: true })
    const res = await app.inject({
      method: 'PATCH',
      url: `/people/${staff.id}`,
      headers: auth(staff),
      payload: { skills: ['x'] },
    })
    expect(res.statusCode).toBe(403)
  })

  it('admin patches skills and staffOverride; /me reflects it', async () => {
    const admin = await login(app, 'boss')
    const target = await login(app, 'nurse1')
    const res = await app.inject({
      method: 'PATCH',
      url: `/people/${target.id}`,
      headers: auth(admin),
      payload: { skills: ['vue', 'his-lab'], staffOverride: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      id: target.id,
      skills: ['vue', 'his-lab'],
      staffOverride: true,
      isStaff: true,
    })
    const me = await app.inject({ url: '/me', headers: auth(target) })
    expect(me.json().isStaff).toBe(true)
  })

  it('PATCH unknown person is 404, bad body is 400', async () => {
    const admin = await login(app, 'boss')
    const missing = await app.inject({
      method: 'PATCH',
      url: '/people/00000000-0000-4000-8000-000000000000',
      headers: auth(admin),
      payload: { skills: [] },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({ error: 'not_found' })
    const bad = await app.inject({
      method: 'PATCH',
      url: `/people/${admin.id}`,
      headers: auth(admin),
      payload: { skills: [''] },
    })
    expect(bad.statusCode).toBe(400)
    const badId = await app.inject({
      method: 'PATCH',
      url: '/people/not-a-uuid',
      headers: auth(admin),
      payload: {},
    })
    expect(badId.statusCode).toBe(400)
  })

  describe('last admin protection', () => {
    const demote = (by: { token: string }, id: string) =>
      app.inject({
        method: 'PATCH',
        url: `/people/${id}`,
        headers: auth(by as never),
        payload: { isAdmin: false },
      })
    const promote = async (admin: Awaited<ReturnType<typeof login>>, id: string) =>
      app.inject({
        method: 'PATCH',
        url: `/people/${id}`,
        headers: auth(admin),
        payload: { isAdmin: true },
      })

    it('sole admin cannot demote self', async () => {
      const admin = await login(app, 'boss')
      const res = await demote(admin, admin.id)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'last_admin' })
      const me = await app.inject({ url: '/me', headers: auth(admin) })
      expect(me.json().isAdmin).toBe(true)
    })

    it('with two admins, one can demote the other', async () => {
      const boss = await login(app, 'boss')
      const second = await login(app, 'second')
      expect((await promote(boss, second.id)).statusCode).toBe(200)
      const res = await demote(boss, second.id)
      expect(res.statusCode).toBe(200)
      expect(res.json().isAdmin).toBe(false)
    })

    it('concurrent mutual demotion leaves exactly one admin', async () => {
      const boss = await login(app, 'boss')
      const second = await login(app, 'second')
      await promote(boss, second.id)
      // Hold the admin-change lock so both requests pass auth and queue behind it,
      // then release: they must serialize instead of both seeing "another admin exists".
      const db = await testDb()
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      let locked!: () => void
      const gotLock = new Promise<void>((r) => (locked = r))
      const holder = db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('people:admin-change'))`)
        locked()
        await held
      })
      await gotLock
      const both = Promise.all([demote(boss, second.id), demote(second, boss.id)])
      await new Promise((r) => setTimeout(r, 300))
      release()
      await holder
      const [a, b] = await both
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409])
      const rows = await (await testDb()).execute<{ n: string }>(
        sql`select count(*)::text as n from people where is_admin`,
      )
      expect(rows[0].n).toBe('1')
    })
  })
})
