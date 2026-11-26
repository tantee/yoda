import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aiCalls, departmentSettings, projectMembers, projects } from '../src/db/schema.js'
import { resetDb, testDb } from './helpers.js'
import { auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let boss: Who
let pm: Who
let requester: Who
let projectId: string

beforeEach(async () => {
  const db = await testDb()
  await resetDb(db)
  app = await makeApp()
  boss = await login(app, 'boss')
  pm = await login(app, 'pm', { staff: true })
  requester = await login(app, 'req')
  const [p] = await db.insert(projects).values({ name: 'P' }).returning()
  projectId = p!.id
  await db.insert(projectMembers).values({ projectId, personId: pm.id, roles: ['PM'] })
})
afterEach(() => app.close())

describe('/admin/ai-settings', () => {
  it('admin reads and updates the department budget; usage counts project-less calls only', async () => {
    const db = await testDb()
    await db.insert(aiCalls).values([
      { projectId: null, job: 'fast', ok: true, costUsd: '0.014000' },
      { projectId: null, job: 'fast', ok: true, costUsd: '0.010000' },
      { projectId, job: 'draft', ok: true, costUsd: '3.000000' },
    ])
    const get = await app.inject({ url: '/admin/ai-settings', headers: auth(boss) })
    expect(get.statusCode).toBe(200)
    expect(get.json()).toMatchObject({ aiBudgetUsd: null, usage: { costUsd: 0.024, budgetUsd: null, calls: 2 } })
    expect(get.json().usage.month).toMatch(/^\d{4}-\d{2}$/)

    const patch = await app.inject({
      method: 'PATCH',
      url: '/admin/ai-settings',
      headers: auth(boss),
      payload: { aiBudgetUsd: 12.5 },
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json()).toMatchObject({ aiBudgetUsd: 12.5, usage: { budgetUsd: 12.5, calls: 2 } })
    const [row] = await db.select().from(departmentSettings)
    expect(row).toMatchObject({ id: 1, aiBudgetUsd: '12.50', updatedBy: boss.id })

    const clear = await app.inject({
      method: 'PATCH',
      url: '/admin/ai-settings',
      headers: auth(boss),
      payload: { aiBudgetUsd: null },
    })
    expect(clear.json()).toMatchObject({ aiBudgetUsd: null })
  })

  it('PM and requester get 403', async () => {
    for (const who of [pm, requester]) {
      expect((await app.inject({ url: '/admin/ai-settings', headers: auth(who) })).statusCode).toBe(403)
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/ai-settings',
        headers: auth(who),
        payload: { aiBudgetUsd: 1 },
      })
      expect(res.statusCode).toBe(403)
    }
    const [row] = await (await testDb()).select().from(departmentSettings)
    expect(row!.aiBudgetUsd).toBeNull()
  })

  it('accepts the numeric(12,2) maximum; rejects negative, missing, too large or sub-cent budgets with 400', async () => {
    const ok = await app.inject({
      method: 'PATCH',
      url: '/admin/ai-settings',
      headers: auth(boss),
      payload: { aiBudgetUsd: 9_999_999_999.99 },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().aiBudgetUsd).toBe(9_999_999_999.99)
    for (const payload of [{ aiBudgetUsd: -1 }, {}, { aiBudgetUsd: 10_000_000_000 }, { aiBudgetUsd: 9_999_999_999.999 }, { aiBudgetUsd: 0.015 }]) {
      const res = await app.inject({ method: 'PATCH', url: '/admin/ai-settings', headers: auth(boss), payload })
      expect(res.statusCode).toBe(400)
    }
  })
})

describe('fun mode (Task 9)', () => {
  it('is on by default; an admin switches it off and on without touching the budget', async () => {
    const get = await app.inject({ url: '/admin/ai-settings', headers: auth(boss) })
    expect(get.json()).toMatchObject({ funMode: true, aiBudgetUsd: null })

    await app.inject({ method: 'PATCH', url: '/admin/ai-settings', headers: auth(boss), payload: { aiBudgetUsd: 5 } })
    const off = await app.inject({ method: 'PATCH', url: '/admin/ai-settings', headers: auth(boss), payload: { funMode: false } })
    expect(off.statusCode).toBe(200)
    expect(off.json()).toMatchObject({ funMode: false, aiBudgetUsd: 5 })
    const [row] = await (await testDb()).select().from(departmentSettings)
    expect(row).toMatchObject({ funMode: false, aiBudgetUsd: '5.00', updatedBy: boss.id })

    // A budget change leaves fun mode as it is.
    const budget = await app.inject({ method: 'PATCH', url: '/admin/ai-settings', headers: auth(boss), payload: { aiBudgetUsd: 6 } })
    expect(budget.json()).toMatchObject({ funMode: false, aiBudgetUsd: 6 })
    const on = await app.inject({ method: 'PATCH', url: '/admin/ai-settings', headers: auth(boss), payload: { funMode: true } })
    expect(on.json()).toMatchObject({ funMode: true, aiBudgetUsd: 6 })
  })

  it('only admins can switch it; non-boolean values are rejected', async () => {
    for (const who of [pm, requester]) {
      const res = await app.inject({ method: 'PATCH', url: '/admin/ai-settings', headers: auth(who), payload: { funMode: false } })
      expect(res.statusCode).toBe(403)
    }
    const bad = await app.inject({ method: 'PATCH', url: '/admin/ai-settings', headers: auth(boss), payload: { funMode: 'no' } })
    expect(bad.statusCode).toBe(400)
    const [row] = await (await testDb()).select().from(departmentSettings)
    expect(row!.funMode).toBe(true)
  })

  it('GET /ui-config shows the switch read-only to every signed-in user, requesters included', async () => {
    for (const who of [boss, pm, requester]) {
      const res = await app.inject({ url: '/ui-config', headers: auth(who) })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ funMode: true })
    }
    await app.inject({ method: 'PATCH', url: '/admin/ai-settings', headers: auth(boss), payload: { funMode: false } })
    expect((await app.inject({ url: '/ui-config', headers: auth(requester) })).json()).toEqual({ funMode: false })
    expect((await app.inject({ url: '/ui-config' })).statusCode).toBe(401)
    // Read-only: there is no write route next to it.
    const put = await app.inject({ method: 'PATCH', url: '/ui-config', headers: auth(requester), payload: { funMode: true } })
    expect(put.statusCode).toBe(404)
  })
})
