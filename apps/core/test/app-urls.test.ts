import type { AppUrl } from '@yoda/shared'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { projects } from '../src/db/schema.js'
import { appUrlRules } from '../src/projects/app-urls.js'
import { productionRulesForPerson } from '../src/extension/mappings.js'
import { makeProject } from './defect-fixtures.js'
import { resetDb, testDb } from './helpers.js'
import { auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let admin: Who
let pm: Who
let qc: Who
let outsider: Who
let projectId: string

beforeEach(async () => {
  await resetDb(await testDb())
  app = await makeApp()
  admin = await login(app, 'boss')
  pm = await login(app, 'pm', { staff: true })
  qc = await login(app, 'qc', { staff: true })
  outsider = await login(app, 'outsider', { staff: true })
  projectId = await makeProject(app, admin, 'OPD', [
    [pm, ['PM']],
    [qc, ['QC']],
  ])
})
afterEach(async () => {
  await app.close()
})

const put = (who: Who, urls: unknown[], id = projectId) =>
  app.inject({ method: 'PUT', url: `/projects/${id}/app-urls`, headers: auth(who), payload: { urls } })
const get = (who: Who, id = projectId) => app.inject({ url: `/projects/${id}/app-urls`, headers: auth(who) })

const urls = [
  { pattern: 'https://opd.example.org/*', environment: 'production', production: true },
  { pattern: 'https://*.review.example.org/*', environment: 'review', production: false },
]

describe('project application URLs', () => {
  it('PM replaces the list; members read; non-members 404; non-PM 403', async () => {
    const res = await put(pm, urls)
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json() as AppUrl[]).map((u) => [u.pattern, u.environment, u.production])).toEqual([
      ['https://*.review.example.org/*', 'review', false],
      ['https://opd.example.org/*', 'production', true],
    ])
    expect((await get(qc)).json()).toEqual(res.json())
    expect((await get(admin)).statusCode).toBe(200)
    expect((await get(outsider)).statusCode).toBe(404)
    expect((await put(outsider, urls)).statusCode).toBe(404)
    expect((await put(qc, urls)).statusCode).toBe(403)

    // Replacing keeps nothing of the old list.
    const again = await put(admin, [{ pattern: 'http://localhost:3000/*', production: false }])
    expect((again.json() as AppUrl[]).map((u) => [u.pattern, u.environment])).toEqual([['http://localhost:3000/*', null]])
    expect((await put(pm, [])).json()).toEqual([])
  })

  it('invalid pattern is 400 with the index', async () => {
    const res = await put(pm, [urls[0], { pattern: 'not a pattern', production: false }])
    expect(res.statusCode).toBe(400)
    expect(res.json().issues[0].path).toEqual(['urls', 1, 'pattern'])
    expect((await get(pm)).json()).toEqual([])
  })

  it('a too broad pattern and a duplicate are 400 with the index', async () => {
    const broad = await put(pm, [{ pattern: 'https://*/*', production: false }])
    expect(broad.statusCode).toBe(400)
    expect(broad.json().issues[0].path).toEqual(['urls', 0, 'pattern'])
    const dup = await put(pm, [urls[0], urls[0]])
    expect(dup.statusCode).toBe(400)
    expect(dup.json().issues[0].path).toEqual(['urls', 1, 'pattern'])
    expect((await put(pm, Array.from({ length: 51 }, (_, i) => ({ pattern: `https://a${i}.example.org/*`, production: false })))).statusCode).toBe(400)
  })

  it('a host differing only in case is the same pattern: stored lowercase, and a duplicate', async () => {
    const res = await put(pm, [{ pattern: 'HTTPS://OPD.Example.org/Path/*', production: false }])
    expect((res.json() as AppUrl[])[0]!.pattern).toBe('https://opd.example.org/Path/*')
    const dup = await put(pm, [
      { pattern: 'https://opd.example.org/*', production: false },
      { pattern: 'https://OPD.example.org/*', production: true },
    ])
    expect(dup.statusCode).toBe(400)
    expect(dup.json().issues[0].path).toEqual(['urls', 1, 'pattern'])
  })

  it('an admin gets 404 for an unknown project, and a requester 403', async () => {
    expect((await get(admin, '00000000-0000-4000-8000-000000000099')).statusCode).toBe(404)
    expect((await put(admin, urls, '00000000-0000-4000-8000-000000000099')).statusCode).toBe(404)
    const nurse = await login(app, 'nurse')
    expect((await get(nurse)).statusCode).toBe(403)
  })

  it('two PUTs at once both finish; the last one wins', async () => {
    const [a, b] = await Promise.all([put(pm, [urls[0]]), put(admin, [urls[1]])])
    expect([a.statusCode, b.statusCode]).toEqual([200, 200])
    expect((await get(pm)).json()).toHaveLength(1)
  })

  it('appUrlRules gives app_url mapping rules; productionRulesForPerson gives the production patterns of member projects', async () => {
    await put(pm, urls)
    const other = await makeProject(app, admin, 'Lab', [[pm, ['PM']]])
    await put(pm, [{ pattern: 'https://lab.example.org/*', environment: 'production', production: true }], other)

    const rules = await appUrlRules(await testDb(), [projectId])
    expect(rules).toEqual([
      { pattern: 'https://*.review.example.org/*', projectId, environment: 'review', production: false, source: 'app_url', build: null },
      { pattern: 'https://opd.example.org/*', projectId, environment: 'production', production: true, source: 'app_url', build: null },
    ])
    expect(await appUrlRules(await testDb(), [])).toEqual([])
    expect((await productionRulesForPerson(await testDb(), pm.id)).sort()).toEqual(['https://lab.example.org/*', 'https://opd.example.org/*'])
    expect(await productionRulesForPerson(await testDb(), qc.id)).toEqual(['https://opd.example.org/*'])
    expect(await productionRulesForPerson(await testDb(), outsider.id)).toEqual([])
    // An archived project's production sites still refuse video.
    await (await testDb()).update(projects).set({ status: 'archived' }).where(eq(projects.id, other))
    expect((await productionRulesForPerson(await testDb(), pm.id)).sort()).toEqual(['https://lab.example.org/*', 'https://opd.example.org/*'])
  })
})
