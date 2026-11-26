import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockEmbeddingModelV4 } from 'ai/test'
import type { KnowledgeEntry, KnowledgeSearchHit, Me } from '@yoda/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { AiGateway } from '../src/ai/gateway.js'
import type { AppDeps } from '../src/app.js'
import { aiCalls, attachments, events, knowledgeChunks, knowledgeEntries, people, projects } from '../src/db/schema.js'
import { InlineJobQueue, type JobName } from '../src/jobs/queue.js'
import { LiveBus } from '../src/live/bus.js'
import { searchKnowledge } from '../src/knowledge/search.js'
import { mockModels, resetDb, testConfig, testDb } from './helpers.js'
import { auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let admin: Who
let pm: Who
let dev: Who
let outsider: Who
let nurse: Who

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })

const drain = async () => {
  if (app.deps.jobs instanceof InlineJobQueue) await app.deps.jobs.drain()
}

async function meOf(w: Who): Promise<Me> {
  const [p] = await app.deps.db.select().from(people).where(eq(people.id, w.id))
  return { id: p!.id, username: p!.username, displayName: p!.displayName, email: p!.email, isAdmin: p!.isAdmin, isStaff: true }
}

async function newProject(): Promise<string> {
  const created = await call(admin, 'POST', '/projects', { name: 'ระบบรายงานแล็บ' })
  const { id } = created.json() as { id: string }
  for (const [who, roles] of [[pm, ['PM']], [dev, ['DEV']]] as [Who, string[]][]) {
    expect((await app.inject({ method: 'PUT', url: `/projects/${id}/members/${who.id}`, headers: auth(admin), payload: { roles } })).statusCode).toBe(200)
  }
  return id
}

async function create(who: Who, body: Record<string, unknown>): Promise<KnowledgeEntry> {
  const res = await call(who, 'POST', '/knowledge', body)
  expect(res.statusCode).toBe(201)
  return res.json() as KnowledgeEntry
}

/** One-hot vectors keyed by topic words, so a query and an entry can share an exact vector. */
function topicEmbedder() {
  const topics = [['ห้องแล็บ', 'หัวข้อเอ'], ['วัคซีน', 'หัวข้อบี']]
  return new MockEmbeddingModelV4({
    modelId: 'mock-embed',
    doEmbed: async ({ values }) => ({
      embeddings: values.map((v) => {
        const i = topics.findIndex((words) => words.some((w) => v.includes(w)))
        return Array.from({ length: 1024 }, (_, k) => (k === (i < 0 ? 1023 : i) ? 1 : 0))
      }),
      usage: { tokens: 10 },
      warnings: [],
    }),
  })
}

async function gatewayWith(embed: MockEmbeddingModelV4): Promise<AiGateway> {
  const models = mockModels({ embed, ids: { draft: 'anthropic:claude-opus-5-5', fast: 'anthropic:claude-haiku-5-5', embed: 'openai:mock-embed' } })
  return new AiGateway({ db: await testDb(), bus: new LiveBus(), models, config: testConfig() })
}

/** Uploads a UTF-8 .txt as `dev`; returns the attachment id. */
async function uploadTxt(a: FastifyInstance, projectId: string, name: string, text: string): Promise<string> {
  const b = '----yodaTestBoundary'
  const payload = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from(text, 'utf8'),
    Buffer.from(`\r\n--${b}--\r\n`),
  ])
  const up = await a.inject({
    method: 'POST',
    url: `/projects/${projectId}/attachments`,
    headers: { ...auth(dev), 'content-type': `multipart/form-data; boundary=${b}` },
    payload,
  })
  expect(up.statusCode).toBe(201)
  return (up.json() as { id: string }).id
}

async function removeStored(attIds: string[]): Promise<void> {
  for (const id of attIds) {
    const [row] = await app.deps.db.select().from(attachments).where(eq(attachments.id, id))
    if (row) await app.deps.storage.remove(row.storageKey).catch(() => {})
  }
}

async function setup(overrides: Partial<AppDeps> = {}) {
  app = await makeApp(overrides)
  admin = await login(app, 'boss')
  pm = await login(app, 'pm1', { staff: true })
  dev = await login(app, 'dev1', { staff: true, name: 'สมชาย' })
  outsider = await login(app, 'out1', { staff: true })
  nurse = await login(app, 'nurse1')
}

describe('knowledge API', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
  })
  afterEach(async () => {
    await drain()
    await app.close()
  })

  it('versions an entry on update; the superseded version is listed but not searched', async () => {
    await setup()
    const p = await newProject()
    const v1 = await create(dev, { scope: 'project', projectId: p, type: 'fact', title: 'ค่าปกติโพแทสเซียม', body: 'เครื่องวัดรุ่นโบราณ' })
    expect(v1).toMatchObject({ version: 1, status: 'confirmed', sourceKind: 'person', createdById: dev.id, createdByName: 'สมชาย' })

    const upd = await call(pm, 'PATCH', `/knowledge/${v1.id}`, { body: 'เครื่องใหม่ยี่ห้อเอบีซี' })
    expect(upd.statusCode).toBe(200)
    const v2 = upd.json() as KnowledgeEntry
    expect(v2).toMatchObject({ lineageId: v1.lineageId, version: 2, title: 'ค่าปกติโพแทสเซียม', status: 'confirmed' })
    expect(v2.id).not.toBe(v1.id)

    // Updating a superseded version is refused.
    expect((await call(pm, 'PATCH', `/knowledge/${v1.id}`, { body: 'x' })).statusCode).toBe(409)

    const versions = (await call(dev, 'GET', `/knowledge/${v2.id}/versions`)).json() as (KnowledgeEntry & { supersededAt: string | null })[]
    expect(versions.map((v) => v.version)).toEqual([1, 2])
    expect(versions[0]!.supersededAt).not.toBeNull()
    expect(versions[1]!.supersededAt).toBeNull()
    expect((await call(dev, 'GET', `/knowledge/${v1.id}`)).json()).toMatchObject({ id: v1.id, version: 1 })

    await drain()
    const oldHits = (await call(dev, 'GET', `/knowledge/search?q=${encodeURIComponent('รุ่นโบราณ')}&projectId=${p}`)).json() as KnowledgeSearchHit[]
    expect(oldHits).toEqual([])
    const newHits = (await call(dev, 'GET', `/knowledge/search?q=${encodeURIComponent('ยี่ห้อเอบีซี')}&projectId=${p}`)).json() as KnowledgeSearchHit[]
    expect(newHits.map((h) => h.id)).toEqual([v2.id])

    const list = (await call(dev, 'GET', `/knowledge?projectId=${p}`)).json() as KnowledgeEntry[]
    expect(list.map((e) => e.id)).toEqual([v2.id])

    const evs = await app.deps.db.select().from(events).where(eq(events.projectId, p))
    expect(evs.map((e) => e.type).filter((t) => t.startsWith('knowledge.'))).toEqual(['knowledge.created', 'knowledge.updated'])
  })

  it('finds a Thai entry by a short Thai trigram query with no embedding model, before and after chunking', async () => {
    await setup()
    const p = await newProject()
    const e = await create(dev, { scope: 'project', projectId: p, type: 'document', title: 'ตารางผลแล็บผู้ป่วยนอก', body: 'รายละเอียดการส่งตรวจ' })
    await create(dev, { scope: 'project', projectId: p, type: 'fact', title: 'นโยบายการลา', body: 'วันหยุดพักผ่อนประจำปี' })
    // Embedding job not yet run: no chunks, still findable via title/body.
    const before = (await call(dev, 'GET', `/knowledge/search?q=${encodeURIComponent('ผลแล็บ')}&projectId=${p}`)).json() as KnowledgeSearchHit[]
    expect(before.map((h) => h.id)).toEqual([e.id])

    await drain()
    const chunks = await app.deps.db.select().from(knowledgeChunks).where(eq(knowledgeChunks.entryId, e.id))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text).toBe('ตารางผลแล็บผู้ป่วยนอก\n\nรายละเอียดการส่งตรวจ')
    expect(chunks[0]!.embedding).toBeNull()
    const after = (await call(dev, 'GET', `/knowledge/search?q=${encodeURIComponent('ผลแล็บ')}`)).json() as KnowledgeSearchHit[]
    expect(after.map((h) => h.id)).toEqual([e.id])
    expect(after[0]!.snippet).toContain('ตารางผลแล็บผู้ป่วยนอก')
    expect(after[0]!.score).toBeGreaterThan(0)
  })

  it('ranks the entry whose chunk vector equals the query vector first', async () => {
    await setup({ ai: await gatewayWith(topicEmbedder()) })
    const p = await newProject()
    const lab = await create(dev, { scope: 'project', projectId: p, type: 'fact', title: 'ห้องแล็บชั้นสอง', body: 'เปิดแปดโมง' })
    const vax = await create(dev, { scope: 'project', projectId: p, type: 'fact', title: 'วัคซีนไข้หวัดใหญ่', body: 'ฉีดเดือนพฤษภาคม' })
    await drain()
    const [c] = await app.deps.db.select().from(knowledgeChunks).where(eq(knowledgeChunks.entryId, vax.id))
    expect(c!.embedding).toHaveLength(1024)

    const hits = (await call(dev, 'GET', `/knowledge/search?q=${encodeURIComponent('หัวข้อบี')}&projectId=${p}`)).json() as KnowledgeSearchHit[]
    expect(hits[0]!.id).toBe(vax.id)
    const hits2 = (await call(dev, 'GET', `/knowledge/search?q=${encodeURIComponent('หัวข้อเอ')}&projectId=${p}`)).json() as KnowledgeSearchHit[]
    expect(hits2[0]!.id).toBe(lab.id)
  })

  it('switching a project noAi off re-embeds its entries whose chunks lack vectors (not noAi entries)', async () => {
    await setup({ ai: await gatewayWith(topicEmbedder()) })
    const p = await newProject()
    expect((await call(admin, 'PATCH', `/projects/${p}`, { noAi: true })).statusCode).toBe(200)
    const plain = await create(dev, { scope: 'project', projectId: p, type: 'fact', title: 'ห้องแล็บชั้นสอง', body: 'เปิดแปดโมง' })
    const secret = await create(dev, { scope: 'project', projectId: p, type: 'fact', title: 'วัคซีน', body: 'ลับ', noAi: true })
    await drain()
    const vectors = async (entryId: string) =>
      (await app.deps.db.select().from(knowledgeChunks).where(eq(knowledgeChunks.entryId, entryId))).map((c) => c.embedding)
    expect(await vectors(plain.id)).toEqual([null])
    expect(await vectors(secret.id)).toEqual([null])

    expect((await call(admin, 'PATCH', `/projects/${p}`, { noAi: false })).statusCode).toBe(200)
    await drain()
    const [v] = await vectors(plain.id)
    expect(v).toHaveLength(1024)
    expect(await vectors(secret.id)).toEqual([null])
  })

  it('never embeds noAi entries; forAi excludes noAi entries, noAi attachments and noAi projects', async () => {
    const embedded: string[] = []
    await setup({
      ai: await gatewayWith(new MockEmbeddingModelV4({
        modelId: 'mock-embed',
        doEmbed: async ({ values }) => {
          embedded.push(...values)
          return { embeddings: values.map(() => Array.from({ length: 1024 }, () => 0.1)), usage: { tokens: 1 }, warnings: [] }
        },
      })),
    })
    const p = await newProject()
    const secret = await create(dev, { scope: 'project', projectId: p, type: 'fact', title: 'รหัสผ่านระบบแล็บ', body: 'ความลับ', noAi: true })
    const open = await create(dev, { scope: 'project', projectId: p, type: 'fact', title: 'คู่มือระบบแล็บ', body: 'เปิดเผยได้' })
    await drain()
    expect(embedded.some((t) => t.includes('ความลับ'))).toBe(false)
    expect(embedded.some((t) => t.includes('เปิดเผยได้'))).toBe(true)
    const [sc] = await app.deps.db.select().from(knowledgeChunks).where(eq(knowledgeChunks.entryId, secret.id))
    expect(sc!.embedding).toBeNull()

    const me = await meOf(dev)
    const all = await searchKnowledge(app.deps.db, me, { query: 'ระบบแล็บ', projectId: p }, app.deps.ai)
    expect(all.map((h) => h.id).sort()).toEqual([secret.id, open.id].sort())
    const forAi = await searchKnowledge(app.deps.db, me, { query: 'ระบบแล็บ', projectId: p, forAi: true }, app.deps.ai)
    expect(forAi.map((h) => h.id)).toEqual([open.id])

    // An entry whose attachment is noAi is excluded even if the entry flag is not set.
    const [att] = await app.deps.db
      .insert(attachments)
      .values({ projectId: p, storageKey: `k-${Date.now()}`, fileName: 'ระบบแล็บ.txt', contentType: 'text/plain', sizeBytes: 1, noAi: true, uploadedBy: dev.id })
      .returning()
    await app.deps.db.update(knowledgeEntries).set({ attachmentId: att!.id }).where(eq(knowledgeEntries.id, open.id))
    expect(await searchKnowledge(app.deps.db, me, { query: 'ระบบแล็บ', projectId: p, forAi: true })).toEqual([])
    await app.deps.db.update(knowledgeEntries).set({ attachmentId: null }).where(eq(knowledgeEntries.id, open.id))

    // A noAi project: nothing for AI, but still searchable by people.
    await app.deps.db.update(projects).set({ noAi: true }).where(eq(projects.id, p))
    expect(await searchKnowledge(app.deps.db, me, { query: 'ระบบแล็บ', projectId: p, forAi: true }, app.deps.ai)).toEqual([])
    expect((await searchKnowledge(app.deps.db, me, { query: 'ระบบแล็บ', projectId: p }, app.deps.ai)).length).toBe(2)
  })

  it('retries a failing embedding and, after the final attempt, keeps chunks without vectors', async () => {
    let calls = 0
    await setup({
      ai: await gatewayWith(new MockEmbeddingModelV4({
        modelId: 'mock-embed',
        doEmbed: async () => {
          calls++
          throw new Error('provider down')
        },
      })),
    })
    const p = await newProject()
    const warn = console.warn
    console.warn = () => {}
    try {
      const e = await create(dev, { scope: 'project', projectId: p, type: 'fact', title: 'ตารางเวรพยาบาล', body: 'เวรดึก' })
      await drain()
      const chunks = await app.deps.db.select().from(knowledgeChunks).where(eq(knowledgeChunks.entryId, e.id))
      expect(chunks).toHaveLength(1)
      expect(chunks[0]!.embedding).toBeNull()
    } finally {
      console.warn = warn
    }
    // 3 attempts; the gateway's own maxRetries: 1 makes 2 provider calls per attempt.
    expect(calls).toBeGreaterThanOrEqual(3)
    const failed = await app.deps.db.select().from(aiCalls).where(eq(aiCalls.projectId, p))
    expect(failed.map((c) => c.ok)).toEqual([false, false, false])
  })

  it('enforces visibility and write permissions', async () => {
    await setup()
    const p = await newProject()
    const projEntry = await create(dev, { scope: 'project', projectId: p, type: 'decision', title: 'ใช้ PostgreSQL', body: '' })
    const dept = await create(admin, { scope: 'department', type: 'fact', title: 'เวลาทำการ', body: 'แปดโมงถึงสี่โมง' })
    expect(dept).toMatchObject({ scope: 'department', projectId: null })

    expect((await call(outsider, 'GET', `/knowledge/${projEntry.id}`)).statusCode).toBe(404)
    expect((await call(outsider, 'GET', `/knowledge/${projEntry.id}/versions`)).statusCode).toBe(404)
    expect((await call(outsider, 'PATCH', `/knowledge/${projEntry.id}`, { title: 'x' })).statusCode).toBe(404)
    expect((await call(outsider, 'GET', `/knowledge/${dept.id}`)).statusCode).toBe(200)
    expect((await call(outsider, 'GET', `/knowledge?projectId=${p}`)).statusCode).toBe(404)
    const outsiderList = (await call(outsider, 'GET', '/knowledge')).json() as KnowledgeEntry[]
    expect(outsiderList.map((e) => e.id)).toEqual([dept.id])
    const outsiderHits = (await call(outsider, 'GET', `/knowledge/search?q=${encodeURIComponent('PostgreSQL')}`)).json() as KnowledgeSearchHit[]
    expect(outsiderHits).toEqual([])

    for (const [m, u, b] of [
      ['GET', '/knowledge', undefined],
      ['GET', `/knowledge/search?q=x`, undefined],
      ['GET', `/knowledge/${dept.id}`, undefined],
      ['GET', `/knowledge/${dept.id}/versions`, undefined],
      ['POST', '/knowledge', { scope: 'department', type: 'fact', title: 'x' }],
      ['PATCH', `/knowledge/${dept.id}`, { title: 'x' }],
      ['POST', `/knowledge/${dept.id}/confirm`, undefined],
    ] as const) {
      expect((await call(nurse, m, u, b)).statusCode).toBe(403)
    }

    expect((await call(dev, 'POST', '/knowledge', { scope: 'department', type: 'fact', title: 'x' })).statusCode).toBe(403)
    expect((await call(dev, 'PATCH', `/knowledge/${dept.id}`, { title: 'x' })).statusCode).toBe(403)
    expect((await call(outsider, 'POST', '/knowledge', { scope: 'project', projectId: p, type: 'fact', title: 'x' })).statusCode).toBe(404)
    expect((await call(dev, 'POST', '/knowledge', { scope: 'project', type: 'fact', title: 'x' })).statusCode).toBe(400)

    // Department entries record no events.
    const deptEvents = await app.deps.db.select().from(events)
    expect(deptEvents.filter((e) => e.type.startsWith('knowledge.')).map((e) => e.projectId)).toEqual([p])
  })

  it('pages the list with limit and offset and reports the total in x-total-count', async () => {
    await setup()
    const p = await newProject()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push((await create(dev, { scope: 'project', projectId: p, type: 'fact', title: `ข้อเท็จจริง ${i}`, body: '' })).id)
    await create(dev, { scope: 'project', projectId: p, type: 'decision', title: 'การตัดสินใจ', body: '' })
    const newestFirst = [...ids].reverse()

    const first = await call(dev, 'GET', `/knowledge?projectId=${p}&type=fact&limit=2`)
    expect(first.statusCode).toBe(200)
    expect(first.headers['x-total-count']).toBe('5')
    expect((first.json() as KnowledgeEntry[]).map((e) => e.id)).toEqual(newestFirst.slice(0, 2))
    const last = await call(dev, 'GET', `/knowledge?projectId=${p}&type=fact&limit=2&offset=4`)
    expect(last.headers['x-total-count']).toBe('5')
    expect((last.json() as KnowledgeEntry[]).map((e) => e.id)).toEqual(newestFirst.slice(4))
    const past = await call(dev, 'GET', `/knowledge?projectId=${p}&type=fact&limit=2&offset=10`)
    expect(past.json()).toEqual([])
    expect(past.headers['x-total-count']).toBe('5')

    // Without paging: everything (up to the default cap), total over all types.
    const all = await call(dev, 'GET', `/knowledge?projectId=${p}`)
    expect((all.json() as KnowledgeEntry[]).length).toBe(6)
    expect(all.headers['x-total-count']).toBe('6')

    // Bounds.
    for (const q of ['limit=0', 'limit=201', 'offset=-1', 'limit=x']) {
      expect((await call(dev, 'GET', `/knowledge?projectId=${p}&${q}`)).statusCode).toBe(400)
    }
    // Same visibility: an outsider still gets 404, a requester 403.
    expect((await call(outsider, 'GET', `/knowledge?projectId=${p}&limit=2`)).statusCode).toBe(404)
    expect((await call(nurse, 'GET', `/knowledge?projectId=${p}&limit=2`)).statusCode).toBe(403)
    // The total counts only visible entries.
    expect((await call(outsider, 'GET', '/knowledge?limit=1')).headers['x-total-count']).toBe('0')
  })

  it('work-item entries record events with the work item id; AI drafts are confirmed by a person', async () => {
    await setup()
    const p = await newProject()
    const wi = await call(dev, 'POST', `/projects/${p}/work-items`, { title: 'แก้รายงานแล็บ', templateKey: 'bug-fix' })
    const workItemId = (wi.json() as { id: string }).id
    const e = await create(dev, { scope: 'work_item', workItemId, type: 'memory', title: 'บันทึกการแก้ไข', body: 'ตรวจแล้ว' })
    expect(e).toMatchObject({ scope: 'work_item', projectId: p, workItemId })

    const { createEntry } = await import('../src/knowledge/service.js')
    const { runWork } = await import('../src/work/context.js')
    const draftId = await runWork(app.deps, { id: null, kind: 'system' }, (ctx) =>
      createEntry(ctx, null, { scope: 'work_item', workItemId, type: 'progress', title: 'ร่างโดย AI', body: 'ร่าง', noAi: false, sourceKind: 'ai' }),
    )
    const draft = (await call(dev, 'GET', `/knowledge/${draftId}`)).json() as KnowledgeEntry
    expect(draft).toMatchObject({ status: 'draft', sourceKind: 'ai', version: 1 })
    expect((await call(dev, 'GET', `/knowledge?workItemId=${workItemId}&status=draft`)).json().map((x: KnowledgeEntry) => x.id)).toEqual([draftId])

    const conf = await call(pm, 'POST', `/knowledge/${draftId}/confirm`)
    expect(conf.statusCode).toBe(200)
    expect(conf.json()).toMatchObject({ status: 'confirmed', version: 2, lineageId: draft.lineageId, sourceKind: 'ai' })
    expect((await call(pm, 'POST', `/knowledge/${(conf.json() as KnowledgeEntry).id}/confirm`)).statusCode).toBe(409)

    const evs = await app.deps.db.select().from(events).where(eq(events.workItemId, workItemId))
    expect(evs.map((x) => x.type).filter((t) => t.startsWith('knowledge.'))).toEqual(['knowledge.created', 'knowledge.created', 'knowledge.confirmed'])
  })

  it('a .txt upload creates a confirmed document entry; PATCH noAi propagates to it', async () => {
    await setup()
    const p = await newProject()
    const attId = await uploadTxt(app, p, 'ผลแล็บ.txt', 'ผลแล็บของผู้ป่วยนอก ปกติ')
    try {
      const [entry] = await app.deps.db.select().from(knowledgeEntries).where(eq(knowledgeEntries.attachmentId, attId))
      expect(entry).toMatchObject({
        type: 'document', scope: 'project', projectId: p, status: 'confirmed', sourceKind: 'upload',
        title: 'ผลแล็บ.txt', body: 'ผลแล็บของผู้ป่วยนอก ปกติ', noAi: false, createdBy: dev.id,
      })
      await drain()
      const hits = (await call(dev, 'GET', `/knowledge/search?q=${encodeURIComponent('ผู้ป่วยนอก')}&projectId=${p}`)).json() as KnowledgeSearchHit[]
      expect(hits.map((h) => h.attachmentId)).toEqual([attId])

      expect((await call(dev, 'PATCH', `/attachments/${attId}`, { noAi: true })).statusCode).toBe(200)
      const [after] = await app.deps.db
        .select()
        .from(knowledgeEntries)
        .where(and(eq(knowledgeEntries.attachmentId, attId), isNull(knowledgeEntries.supersededAt)))
      expect(after).toMatchObject({ id: entry!.id, noAi: true, version: 1 })
    } finally {
      await removeStored([attId])
    }
  })

  it("clearing an attachment's noAi never clears the entry's noAi; embeddings follow the effective flag", async () => {
    const embedded: string[] = []
    await setup({
      ai: await gatewayWith(new MockEmbeddingModelV4({
        modelId: 'mock-embed',
        doEmbed: async ({ values }) => {
          embedded.push(...values)
          return { embeddings: values.map(() => Array.from({ length: 1024 }, () => 0.1)), usage: { tokens: 1 }, warnings: [] }
        },
      })),
    })
    const p = await newProject()
    const own = await uploadTxt(app, p, 'ลับเฉพาะ.txt', 'รายชื่อผู้ป่วยลับเฉพาะ')
    const plain = await uploadTxt(app, p, 'ทั่วไป.txt', 'คู่มือทั่วไปเปิดเผยได้')
    try {
      await drain()
      const current = async (attId: string) => {
        const [e] = await app.deps.db
          .select()
          .from(knowledgeEntries)
          .where(and(eq(knowledgeEntries.attachmentId, attId), isNull(knowledgeEntries.supersededAt)))
        const chunks = await app.deps.db.select().from(knowledgeChunks).where(eq(knowledgeChunks.entryId, e!.id))
        return { entry: e!, chunks }
      }
      // The entry itself is marked noAi (new version).
      const before = await current(own)
      expect((await call(dev, 'PATCH', `/knowledge/${before.entry.id}`, { noAi: true })).statusCode).toBe(200)
      await drain()

      for (const flag of [true, false]) {
        for (const att of [own, plain]) expect((await call(dev, 'PATCH', `/attachments/${att}`, { noAi: flag })).statusCode).toBe(200)
        await drain()
      }

      const o = await current(own)
      expect(o.entry).toMatchObject({ noAi: true, version: 2 })
      expect(o.chunks.length).toBeGreaterThan(0)
      expect(o.chunks.every((c) => c.embedding === null)).toBe(true)
      // Setting the attachment flag copied `true` onto the plain entry; clearing it left that in place
      // (safe default). A person clears the entry flag explicitly, and then it is embedded again.
      const pl = await current(plain)
      expect(pl.entry.noAi).toBe(true)
      expect(pl.chunks.every((c) => c.embedding === null)).toBe(true)
      expect((await call(dev, 'PATCH', `/knowledge/${pl.entry.id}`, { noAi: false })).statusCode).toBe(200)
      await drain()
      const pl2 = await current(plain)
      expect(pl2.entry.noAi).toBe(false)
      expect(pl2.chunks.length).toBeGreaterThan(0)
      expect(pl2.chunks.every((c) => c.embedding !== null)).toBe(true)

      const me = await meOf(dev)
      const forAi = await searchKnowledge(app.deps.db, me, { query: 'ลับเฉพาะ', projectId: p, forAi: true })
      expect(forAi).toEqual([])
      const people = await searchKnowledge(app.deps.db, me, { query: 'ลับเฉพาะ', projectId: p })
      expect(people.map((h) => h.id)).toEqual([o.entry.id])
      // Only the first, pre-flag version's text was ever embedded.
      expect(embedded.filter((t) => t.includes('ลับเฉพาะ'))).toHaveLength(1)
    } finally {
      await removeStored([own, plain])
    }
  })

  it('two apps in one file keep their own deps for the upload hook', async () => {
    const sentA: string[] = []
    const sentB: string[] = []
    const spy = (log: string[]) => ({
      send: async (name: JobName, d: { id: string }) => void log.push(`${name}:${d.id}`),
      work: async () => {},
      stop: async () => {},
      started: () => true,
    })
    const appA = await makeApp({ jobs: spy(sentA) })
    app = await makeApp({ jobs: spy(sentB) })
    try {
      admin = await login(app, 'boss')
      pm = await login(app, 'pm1', { staff: true })
      dev = await login(app, 'dev1', { staff: true })
      const p = await newProject()
      const attId = await uploadTxt(appA, p, 'a.txt', 'ข้อความ')
      try {
        const [e] = await app.deps.db.select().from(knowledgeEntries).where(eq(knowledgeEntries.attachmentId, attId))
        expect(sentA).toEqual([`embed-entry:${e!.id}`])
        expect(sentB).toEqual([])
      } finally {
        await removeStored([attId])
      }
    } finally {
      await appA.close()
    }
  })
})

describe('InlineJobQueue', () => {
  it('retries a throwing handler up to the final attempt and then swallows the error', async () => {
    const q = new InlineJobQueue()
    const runs: { attempt: number; isFinalAttempt: boolean }[] = []
    await q.work('embed-entry', async (run) => {
      runs.push({ attempt: run.attempt, isFinalAttempt: run.isFinalAttempt })
      throw new Error('boom')
    })
    await q.send('embed-entry', { id: 'x' })
    await q.drain()
    expect(runs).toEqual([
      { attempt: 1, isFinalAttempt: false },
      { attempt: 2, isFinalAttempt: false },
      { attempt: 3, isFinalAttempt: true },
    ])

    let n = 0
    await q.work('draft-task', async () => {
      if (++n < 2) throw new Error('once')
    })
    await q.send('draft-task', { id: 'y' })
    await q.drain()
    expect(n).toBe(2)
  })
})
