import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiFailed, AiGateway, AiRefused, costOf } from '../src/ai/gateway.js'
import { buildModels } from '../src/ai/models.js'
import { buildApp } from '../src/app.js'
import { aiCalls, events, projectMembers, projects } from '../src/db/schema.js'
import { embeddingModel, failingModel, textModel } from './ai-mocks.js'
import { mockModels, resetDb, testDb, testDeps } from './helpers.js'
import { auth, login, type Who } from './support.js'

let projectId: string
const OPUS = 'anthropic:claude-opus-5-5'

async function gateway(models = mockModels()) {
  const deps = await testDeps()
  return new AiGateway({ db: deps.db, bus: deps.bus, models })
}
const gen = (g: AiGateway, pid: string | null = projectId) =>
  g.generateText({ job: 'draft', projectId: pid, system: 's', prompt: 'p' })

beforeEach(async () => {
  const db = await testDb()
  await resetDb(db)
  const [p] = await db.insert(projects).values({ name: 'P' }).returning()
  projectId = p!.id
})

describe('AiGateway.generateText', () => {
  it('returns text and logs a priced ok row', async () => {
    const db = await testDb()
    const model = textModel('claude-opus-5-5', 'hello')
    const g = await gateway(mockModels({ draft: model }))
    expect(await gen(g)).toEqual({ text: 'hello', model: 'claude-opus-5-5' })
    const rows = await db.select().from(aiCalls)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ok: true, job: 'draft', provider: 'anthropic', inputTokens: 1000, outputTokens: 500, projectId })
    expect(Number(rows[0]!.costUsd)).toBeCloseTo(0.014, 6)
  })

  it('wraps provider errors as AiFailed and logs a failed row', async () => {
    const db = await testDb()
    const g = await gateway(mockModels({ draft: failingModel('claude-opus-5-5', 'boom upstream') }))
    await expect(gen(g)).rejects.toMatchObject({ name: 'AiFailed', reason: 'provider_error' })
    const rows = await db.select().from(aiCalls)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ok: false, costUsd: null })
    expect(rows[0]!.error).toContain('boom upstream')
  })

  it('empty output logs a billed failed row and throws AiFailed(empty_output)', async () => {
    const db = await testDb()
    const g = await gateway(mockModels({ draft: textModel('claude-opus-5-5', '') }))
    await expect(gen(g)).rejects.toMatchObject({ reason: 'empty_output' })
    const [row] = await db.select().from(aiCalls)
    expect(row).toMatchObject({ ok: false, error: 'empty_output', inputTokens: 1000, outputTokens: 500 })
    expect(Number(row!.costUsd)).toBeCloseTo(0.014, 6)
  })

  it('a failing success-log insert propagates and is not a provider_error', async () => {
    const g = await gateway()
    const spy = vi.spyOn(g as never, 'log' as never).mockRejectedValue(new Error('db down') as never)
    const err = await gen(g).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(AiFailed)
    expect((err as Error).message).toBe('db down')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('unavailable model throws not_configured without a row', async () => {
    const db = await testDb()
    const g = await gateway(mockModels({ draft: null, ids: { draft: null, fast: null, embed: null } }))
    await expect(gen(g)).rejects.toMatchObject({ reason: 'not_configured' })
    expect(await db.select().from(aiCalls)).toHaveLength(0)
  })

  it('noAi project is refused without calling the model or logging', async () => {
    const db = await testDb()
    await db.update(projects).set({ noAi: true }).where(eq(projects.id, projectId))
    const model = textModel('claude-opus-5-5', 'x')
    const g = await gateway(mockModels({ draft: model }))
    await expect(gen(g)).rejects.toMatchObject({ name: 'AiRefused', reason: 'no_ai' })
    expect(model.doStreamCalls).toHaveLength(0)
    expect(await db.select().from(aiCalls)).toHaveLength(0)
  })

  it('budget: warns once at 80%, refuses at 100% with a single exceeded event', async () => {
    const db = await testDb()
    await db.update(projects).set({ aiBudgetUsd: '0.02' }).where(eq(projects.id, projectId))
    const model = textModel('claude-opus-5-5', 'x')
    const g = await gateway(mockModels({ draft: model }))
    const count = async (type: string) =>
      (await db.select().from(events).where(and(eq(events.projectId, projectId), eq(events.type, type as never)))).length

    await gen(g) // 0.014 = 70%
    expect(await count('ai.budget_warning')).toBe(0)
    await gen(g) // 0.028 >= 80%
    expect(await count('ai.budget_warning')).toBe(1)
    const [w] = await db.select().from(events).where(eq(events.type, 'ai.budget_warning'))
    expect(w).toMatchObject({ actorKind: 'system', actorId: null })
    expect(w!.payload).toMatchObject({ budgetUsd: 0.02 })

    await expect(gen(g)).rejects.toMatchObject({ reason: 'budget_exceeded' })
    expect(model.doStreamCalls).toHaveLength(2)
    await expect(gen(g)).rejects.toBeInstanceOf(AiRefused)
    expect(model.doStreamCalls).toHaveLength(2)
    expect(await count('ai.budget_exceeded')).toBe(1)
    expect(await count('ai.budget_warning')).toBe(1)
  })

  it('unknown model logs null cost', async () => {
    const db = await testDb()
    const g = await gateway(
      mockModels({ draft: textModel('mystery-1', 'x'), ids: { draft: 'openai:mystery-1', fast: null, embed: null } }),
    )
    await gen(g)
    const [row] = await db.select().from(aiCalls)
    expect(row!.costUsd).toBeNull()
    expect(costOf('mystery-1', 1, 1)).toBeNull()
  })
})

describe('AiGateway.embed', () => {
  it('returns null with no embedding model', async () => {
    const g = await gateway()
    expect(await g.embed({ projectId, texts: ['a'] })).toBeNull()
  })

  it('returns vectors from the embedding model and logs usage', async () => {
    const db = await testDb()
    const emb = embeddingModel('text-embedding-3-small')
    const g = await gateway(mockModels({ embed: emb, ids: { draft: OPUS, fast: null, embed: 'openai:text-embedding-3-small' } }))
    const out = await g.embed({ projectId, texts: ['a', 'b'] })
    expect(out).toHaveLength(2)
    expect(out![0]).toHaveLength(1024)
    expect(emb.doEmbedCalls[0]!.providerOptions).toMatchObject({ openai: { dimensions: 1024 } })
    const [row] = await db.select().from(aiCalls)
    expect(row).toMatchObject({ job: 'embed', ok: true, inputTokens: 20 })
  })
})

describe('embed dimensions and buildModels', () => {
  it('rejects wrong-sized vectors with bad_dimensions', async () => {
    const db = await testDb()
    const g = await gateway(
      mockModels({
        embed: embeddingModel('text-embedding-3-small', 3),
        ids: { draft: OPUS, fast: null, embed: 'openai:text-embedding-3-small' },
      }),
    )
    await expect(g.embed({ projectId, texts: ['a'] })).rejects.toMatchObject({ reason: 'bad_dimensions' })
    const [row] = await db.select().from(aiCalls)
    expect(row).toMatchObject({ ok: false, error: 'bad_dimensions' })
  })

  it('warns when the embedding model is anthropic', async () => {
    const warns: string[] = []
    const cfg = { ...(await testDeps()).config, anthropicApiKey: 'k', aiEmbeddingModel: 'anthropic:x' }
    const m = buildModels(cfg, (w) => warns.push(w))
    expect(m.embed).toBeNull()
    expect(warns.filter((w) => w.includes('no embedding models'))).toHaveLength(1)
  })
})

describe('GET /projects/:id/ai-usage', () => {
  let app: FastifyInstance
  let member: Who
  let outsider: Who
  let requester: Who
  beforeEach(async () => {
    const db = await testDb()
    app = await buildApp(await testDeps())
    await login(app, 'boss')
    member = await login(app, 'mem', { staff: true })
    outsider = await login(app, 'out', { staff: true })
    requester = await login(app, 'req')
    await db.insert(projectMembers).values({ projectId, personId: member.id, roles: ['PM'] })
    await db.update(projects).set({ aiBudgetUsd: '5.00' }).where(eq(projects.id, projectId))
    await db.insert(aiCalls).values([
      { projectId, job: 'draft', ok: true, costUsd: '0.014000' },
      { projectId, job: 'draft', ok: true, costUsd: '0.010000' },
    ])
  })
  afterEach(() => app.close())

  it('returns month usage to a member', async () => {
    const res = await app.inject({ url: `/projects/${projectId}/ai-usage`, headers: auth(member) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ costUsd: 0.024, budgetUsd: 5, calls: 2 })
    expect(body.month).toMatch(/^\d{4}-\d{2}$/)
  })

  it('404 for non-member staff, 403 for requester', async () => {
    expect((await app.inject({ url: `/projects/${projectId}/ai-usage`, headers: auth(outsider) })).statusCode).toBe(404)
    expect((await app.inject({ url: `/projects/${projectId}/ai-usage`, headers: auth(requester) })).statusCode).toBe(403)
  })
})
