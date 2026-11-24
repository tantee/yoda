import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDb, testDb } from './helpers.js'
import { auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let admin: Who
let somchai: Who
let other: Who
let nurse: Who

const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })

async function createProject(name = 'ระบบรายงานแล็บ') {
  const res = await call(admin, 'POST', '/projects', { name })
  return res.json() as { id: string }
}

describe('projects API', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
    app = await makeApp()
    admin = await login(app, 'boss')
    somchai = await login(app, 'somchai', { staff: true, name: 'สมชาย' })
    other = await login(app, 'other', { staff: true })
    nurse = await login(app, 'nurse1')
  })
  afterEach(async () => {
    await app.close()
  })

  it('requester gets 403 on projects routes', async () => {
    expect((await call(nurse, 'GET', '/projects')).statusCode).toBe(403)
    expect((await call(nurse, 'POST', '/projects', { name: 'x' })).statusCode).toBe(403)
  })

  it('non-admin staff gets 403 on POST /projects', async () => {
    const res = await call(somchai, 'POST', '/projects', { name: 'x' })
    expect(res.statusCode).toBe(403)
  })

  it('admin creates a project (Thai name trimmed, defaults)', async () => {
    const res = await call(admin, 'POST', '/projects', { name: ' ระบบรายงานแล็บ ' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ name: 'ระบบรายงานแล็บ', autonomy: 'propose', noAi: false })
    const list = await call(admin, 'GET', '/projects')
    expect(list.json()[0].name).toBe('ระบบรายงานแล็บ')
  })

  it('membership controls visibility', async () => {
    const p = await createProject()
    const put = await call(admin, 'PUT', `/projects/${p.id}/members/${somchai.id}`, {
      roles: ['PM', 'DEV'],
    })
    expect(put.statusCode).toBe(200)
    expect(put.json().members).toEqual([
      { personId: somchai.id, displayName: 'สมชาย', roles: ['PM', 'DEV'] },
    ])
    expect((await call(somchai, 'GET', '/projects')).json().map((x: { id: string }) => x.id)).toEqual([p.id])
    expect((await call(somchai, 'GET', `/projects/${p.id}`)).statusCode).toBe(200)
    expect((await call(other, 'GET', '/projects')).json()).toEqual([])
    const hidden = await call(other, 'GET', `/projects/${p.id}`)
    expect(hidden.statusCode).toBe(404)
    expect(hidden.json()).toEqual({ error: 'not_found' })
    expect((await call(admin, 'GET', `/projects/${p.id}`)).statusCode).toBe(200)
  })

  it('PM can add members; DEV-only member cannot', async () => {
    const p = await createProject()
    await call(admin, 'PUT', `/projects/${p.id}/members/${somchai.id}`, { roles: ['PM', 'DEV'] })
    const add = await call(somchai, 'PUT', `/projects/${p.id}/members/${other.id}`, { roles: ['BA'] })
    expect(add.statusCode).toBe(200)
    await call(somchai, 'PUT', `/projects/${p.id}/members/${other.id}`, { roles: ['DEV'] })
    const denied = await call(other, 'PUT', `/projects/${p.id}/members/${nurse.id}`, { roles: ['QC'] })
    expect(denied.statusCode).toBe(403)
    expect((await call(other, 'DELETE', `/projects/${p.id}/members/${somchai.id}`)).statusCode).toBe(403)
  })

  it('PUT validates roles and ids', async () => {
    const p = await createProject()
    const url = `/projects/${p.id}/members/${somchai.id}`
    expect((await call(admin, 'PUT', url, { roles: [] })).statusCode).toBe(400)
    expect((await call(admin, 'PUT', url, { roles: ['CEO'] })).statusCode).toBe(400)
    const noPerson = await call(admin, 'PUT', `/projects/${p.id}/members/00000000-0000-4000-8000-000000000000`, { roles: ['DEV'] })
    expect(noPerson.statusCode).toBe(404)
    const noProject = await call(admin, 'PUT', `/projects/00000000-0000-4000-8000-000000000000/members/${somchai.id}`, { roles: ['DEV'] })
    expect(noProject.statusCode).toBe(404)
  })

  it('cannot remove the last PM while others remain', async () => {
    const p = await createProject()
    await call(admin, 'PUT', `/projects/${p.id}/members/${somchai.id}`, { roles: ['PM'] })
    await call(admin, 'PUT', `/projects/${p.id}/members/${other.id}`, { roles: ['BA'] })
    const res = await call(admin, 'DELETE', `/projects/${p.id}/members/${somchai.id}`)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'last_pm' })
    // Demoting the last PM is blocked too.
    const demote = await call(admin, 'PUT', `/projects/${p.id}/members/${somchai.id}`, { roles: ['DEV'] })
    expect(demote.statusCode).toBe(409)
    // Removing a non-PM works; then the sole remaining PM can be removed.
    expect((await call(admin, 'DELETE', `/projects/${p.id}/members/${other.id}`)).statusCode).toBe(204)
    expect((await call(admin, 'DELETE', `/projects/${p.id}/members/${somchai.id}`)).statusCode).toBe(204)
  })

  it('DELETE of a non-member is 404', async () => {
    const p = await createProject()
    expect((await call(admin, 'DELETE', `/projects/${p.id}/members/${other.id}`)).statusCode).toBe(404)
  })
})
