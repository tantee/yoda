import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiFailed, AiGateway, AiRefused, EMBED_BATCH_SIZE, costOf, errorSummary } from '../src/ai/gateway.js'
import { buildModels } from '../src/ai/models.js'
import { buildApp } from '../src/app.js'
import { aiCalls, departmentSettings, events, notifications, people, projectMembers, projects } from '../src/db/schema.js'
import { MockEmbeddingModelV4, MockLanguageModelV4 } from 'ai/test'
import { tool, type ModelMessage } from 'ai'
import { z } from 'zod'
import { embeddingModel, failingModel, scriptedModel, textModel, turnStream } from './ai-mocks.js'
import { mockModels, resetDb, testDb, testDeps } from './helpers.js'
import { auth, login, type Who } from './support.js'

let projectId: string
const OPUS = 'anthropic:claude-opus-5-5'

async function gateway(models = mockModels()) {
  const deps = await testDeps()
  return new AiGateway({ db: deps.db, bus: deps.bus, models, config: deps.config })
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

describe('unpriced models', () => {
  const unpriced = () =>
    mockModels({ draft: textModel('mystery-1', 'x'), ids: { draft: 'openai:mystery-1', fast: OPUS, embed: null } })

  it('warns once at construction naming each unpriced configured model', async () => {
    const deps = await testDeps()
    const warns: string[] = []
    new AiGateway({ db: deps.db, bus: deps.bus, models: unpriced(), config: deps.config }, (w) => warns.push(w))
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('openai:mystery-1')
    expect(warns[0]).not.toContain('claude-opus-5-5')
    const quiet: string[] = []
    new AiGateway({ db: deps.db, bus: deps.bus, models: mockModels(), config: deps.config }, (w) => quiet.push(w))
    expect(quiet).toHaveLength(0)
  })

  it('a budgeted project refuses an unpriced model before any call', async () => {
    const db = await testDb()
    await db.update(projects).set({ aiBudgetUsd: '5.00' }).where(eq(projects.id, projectId))
    const models = unpriced()
    const g = await gateway(models)
    await expect(gen(g)).rejects.toMatchObject({ name: 'AiRefused', reason: 'unpriced_model' })
    expect((models.draft as ReturnType<typeof textModel>).doStreamCalls).toHaveLength(0)
    expect(await db.select().from(aiCalls)).toHaveLength(0)
    // Without a budget the call goes through (cost null), as before.
    await db.update(projects).set({ aiBudgetUsd: null }).where(eq(projects.id, projectId))
    expect(await gen(g)).toMatchObject({ text: 'x' })
  })
})

describe('AiGateway.generateText options', () => {
  it('passes maxOutputTokens and the abort signal to the model', async () => {
    const model = textModel('claude-opus-5-5', 'hi')
    const g = await gateway(mockModels({ draft: model }))
    const ac = new AbortController()
    await g.generateText({ job: 'draft', projectId, system: 's', prompt: 'p', maxOutputTokens: 16000, signal: ac.signal })
    expect(model.doStreamCalls[0]!.maxOutputTokens).toBe(16000)
    expect(model.doStreamCalls[0]!.abortSignal).toBeDefined()
  })

  it('an aborted signal fails the call as AiFailed(aborted) with a failed row', async () => {
    const g = await gateway(mockModels({ draft: textModel('claude-opus-5-5', 'hi') }))
    const ac = new AbortController()
    ac.abort()
    await expect(
      g.generateText({ job: 'draft', projectId, system: 's', prompt: 'p', signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AiFailed', reason: 'aborted' })
    const [row] = await (await testDb()).select().from(aiCalls)
    expect(row).toMatchObject({ ok: false, error: 'aborted' })
  })
})

describe('errorSummary', () => {
  it('keeps name, status code and message only', () => {
    const err = Object.assign(new Error('rate limited'), {
      name: 'AI_APICallError',
      statusCode: 429,
      requestBodyValues: { prompt: 'SECRET PROJECT CONTENT' },
    })
    expect(errorSummary(err)).toBe('AI_APICallError (429): rate limited')
    expect(errorSummary('x')).toBe('x')
  })
})

describe('AiGateway.embed', () => {
  it(`splits texts into batches of ${EMBED_BATCH_SIZE}, one ai_calls row each, vectors in order`, async () => {
    const db = await testDb()
    const emb = new MockEmbeddingModelV4({
      modelId: 'text-embedding-3-small',
      maxEmbeddingsPerCall: 2048,
      doEmbed: async ({ values }) => ({
        embeddings: values.map((v) => Array.from({ length: 1024 }, (_, k) => (k === 0 ? Number(v) : 0))),
        usage: { tokens: values.length },
        warnings: [],
      }),
    })
    const g = await gateway(mockModels({ embed: emb, ids: { draft: OPUS, fast: null, embed: 'openai:text-embedding-3-small' } }))
    const texts = Array.from({ length: 130 }, (_, i) => String(i))
    const out = await g.embed({ projectId, texts })
    expect(emb.doEmbedCalls.map((c) => c.values.length)).toEqual([64, 64, 2])
    expect(out).toHaveLength(130)
    expect(out!.map((v) => v[0])).toEqual(texts.map(Number))
    const rows = await db.select().from(aiCalls)
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.ok && r.job === 'embed')).toBe(true)
  })

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

describe('department AI budget (project-less calls)', () => {
  const setBudget = async (v: string | null) =>
    (await testDb()).update(departmentSettings).set({ aiBudgetUsd: v }).where(eq(departmentSettings.id, 1))
  const addAdmins = async () => {
    const db = await testDb()
    return db
      .insert(people)
      .values([
        { keycloakSub: 'sub-a1', username: 'a1', displayName: 'A1', isAdmin: true },
        { keycloakSub: 'sub-a2', username: 'a2', displayName: 'A2', isAdmin: true },
        { keycloakSub: 'sub-u', username: 'u', displayName: 'U' },
      ])
      .returning()
  }
  const deptNotes = async (suffix: 'warning' | 'exceeded') =>
    (await (await testDb()).select().from(notifications)).filter((n) => n.dedupeKey?.endsWith(`:${suffix}`))

  it('warns every admin once at 80% and refuses at 100% before contacting the provider', async () => {
    const [a1, a2] = await addAdmins()
    await setBudget('0.02')
    const model = textModel('claude-opus-5-5', 'x')
    const g = await gateway(mockModels({ draft: model }))

    await gen(g, null) // 0.014 = 70%
    expect(await deptNotes('warning')).toHaveLength(0)
    await gen(g, null) // 0.028 >= 80% (and >= 100%)
    const warnings = await deptNotes('warning')
    expect(warnings.map((n) => n.personId).sort()).toEqual([a1!.id, a2!.id].sort())
    expect(warnings[0]!.kind).toBe('budget_alert')
    expect(warnings[0]!.dedupeKey).toMatch(/^dept-ai-budget:\d{4}-\d{2}:warning$/)

    await expect(gen(g, null)).rejects.toMatchObject({ name: 'AiRefused', reason: 'budget_exceeded' })
    await expect(gen(g, null)).rejects.toBeInstanceOf(AiRefused)
    expect(model.doStreamCalls).toHaveLength(2)
    expect(await deptNotes('warning')).toHaveLength(2)
    const exceeded = await deptNotes('exceeded')
    expect(exceeded.map((n) => n.personId).sort()).toEqual([a1!.id, a2!.id].sort())
    // No project events for department billing.
    expect(await (await testDb()).select().from(events)).toHaveLength(0)
    // A project with its own (unset) budget is unaffected by the department stop.
    expect(await gen(g, projectId)).toMatchObject({ text: 'x' })
  })

  it('project-less embed is refused once the department budget is spent', async () => {
    const db = await testDb()
    await setBudget('0.01')
    await db.insert(aiCalls).values({ projectId: null, job: 'draft', ok: true, costUsd: '0.010000' })
    const emb = embeddingModel('text-embedding-3-small')
    const g = await gateway(mockModels({ embed: emb, ids: { draft: OPUS, fast: null, embed: 'openai:text-embedding-3-small' } }))
    await expect(g.embed({ projectId: null, texts: ['a'] })).rejects.toMatchObject({ reason: 'budget_exceeded' })
    expect(emb.doEmbedCalls).toHaveLength(0)
    // Project spend does not count toward the department budget.
    await setBudget('0.02')
    await db.insert(aiCalls).values({ projectId, job: 'draft', ok: true, costUsd: '5.000000' })
    expect(await g.embed({ projectId: null, texts: ['a'] })).toHaveLength(1)
  })

  it('an unpriced model is refused when the department budget is set', async () => {
    const models = mockModels({ draft: textModel('mystery-1', 'x'), ids: { draft: 'openai:mystery-1', fast: OPUS, embed: null } })
    const g = await gateway(models)
    expect(await gen(g, null)).toMatchObject({ text: 'x' }) // no budget: allowed, cost null
    await setBudget('5.00')
    await expect(gen(g, null)).rejects.toMatchObject({ reason: 'unpriced_model' })
    expect((models.draft as ReturnType<typeof textModel>).doStreamCalls).toHaveLength(1)
  })
})

describe('AiGateway.chat', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'hi' }]
  const echo = tool({
    description: 'Echo the text back',
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }) => ({ echoed: text }),
  })

  it('runs a tool then answers; one ai_calls row with total usage', async () => {
    const db = await testDb()
    const model = scriptedModel('claude-haiku-5-5', [{ toolCalls: [{ name: 'echo', input: { text: 'ping' } }] }, { text: 'answer' }])
    const g = await gateway(mockModels({ fast: model }))
    const out = await g.chat({ job: 'fast', billing: { projectId }, system: 's', messages, tools: { echo }, maxSteps: 5 })
    expect(out).toMatchObject({ text: 'answer', steps: 2, model: 'claude-haiku-5-5' })
    expect(out.toolCalls).toEqual([{ name: 'echo', input: { text: 'ping' }, output: { echoed: 'ping' } }])
    const rows = await db.select().from(aiCalls)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ok: true, job: 'fast', projectId, inputTokens: 2000, outputTokens: 1000 })
  })

  it('a throwing tool returns an error result to the model and the call still succeeds', async () => {
    const model = scriptedModel('claude-haiku-5-5', [{ toolCalls: [{ name: 'boom', input: {} }] }, { text: 'sorry' }])
    const boom = tool({
      inputSchema: z.object({}),
      execute: async (): Promise<string> => {
        throw new Error('tool exploded')
      },
    })
    const g = await gateway(mockModels({ fast: model }))
    const out = await g.chat({ job: 'fast', billing: { department: true }, system: 's', messages, tools: { boom }, maxSteps: 5 })
    expect(out.text).toBe('sorry')
    expect(out.toolCalls).toEqual([{ name: 'boom', input: {}, output: { error: 'tool exploded' } }])
    const second = model.doStreamCalls[1]!.prompt.at(-1) as { role: string; content: { type: string; output: { type: string; value: string } }[] }
    expect(second.role).toBe('tool')
    expect(second.content[0]!.output).toMatchObject({ type: 'error-text' })
    expect(second.content[0]!.output.value).toContain('tool exploded')
    const [row] = await (await testDb()).select().from(aiCalls)
    expect(row).toMatchObject({ ok: true, projectId: null })
  })

  it('stops after maxSteps when the model keeps calling tools', async () => {
    const model = scriptedModel('claude-haiku-5-5', [{ text: 'working', toolCalls: [{ name: 'echo', input: { text: 'x' } }] }])
    const g = await gateway(mockModels({ fast: model }))
    const out = await g.chat({ job: 'fast', billing: { department: true }, system: 's', messages, tools: { echo }, maxSteps: 2 })
    expect(model.doStreamCalls).toHaveLength(2)
    expect(out.steps).toBe(2)
    expect(out.toolCalls).toHaveLength(2)
    const [row] = await (await testDb()).select().from(aiCalls)
    expect(row).toMatchObject({ inputTokens: 2000, outputTokens: 1000 })
  })

  it('a step-limited run with no final text is a billed empty_output failure', async () => {
    const model = scriptedModel('claude-haiku-5-5', [{ toolCalls: [{ name: 'echo', input: { text: 'x' } }] }])
    const g = await gateway(mockModels({ fast: model }))
    await expect(
      g.chat({ job: 'fast', billing: { department: true }, system: 's', messages, tools: { echo }, maxSteps: 2 }),
    ).rejects.toMatchObject({ name: 'AiFailed', reason: 'empty_output' })
    const [row] = await (await testDb()).select().from(aiCalls)
    expect(row).toMatchObject({ ok: false, error: 'empty_output', inputTokens: 2000 })
  })

  it('aborted after the first step → AiFailed(aborted), completed steps logged as a failed row', async () => {
    const ac = new AbortController()
    const model = scriptedModel('claude-haiku-5-5', [{ text: 'partial', toolCalls: [{ name: 'stop', input: {} }] }, { text: 'never' }])
    const stop = tool({
      inputSchema: z.object({}),
      execute: async () => {
        ac.abort()
        return 'stopped'
      },
    })
    const g = await gateway(mockModels({ fast: model }))
    await expect(
      g.chat({ job: 'fast', billing: { projectId }, system: 's', messages, tools: { stop }, maxSteps: 5, signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AiFailed', reason: 'aborted' })
    expect(model.doStreamCalls).toHaveLength(1)
    const rows = await (await testDb()).select().from(aiCalls)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ok: false, error: 'aborted', inputTokens: 1000, outputTokens: 500 })
    expect(Number(rows[0]!.costUsd)).toBeGreaterThan(0)
  })

  it('a provider failure in a later step logs the tokens already billed', async () => {
    let n = 0
    const model = new MockLanguageModelV4({
      modelId: 'claude-haiku-5-5',
      doStream: async () => {
        if (n++ === 0) return { stream: turnStream({ toolCalls: [{ name: 'echo', input: { text: 'x' } }] }) }
        throw new Error('upstream died')
      },
    })
    const g = await gateway(mockModels({ fast: model }))
    await expect(
      g.chat({ job: 'fast', billing: { department: true }, system: 's', messages, tools: { echo }, maxSteps: 5 }),
    ).rejects.toMatchObject({ name: 'AiFailed', reason: 'provider_error' })
    const [row] = await (await testDb()).select().from(aiCalls)
    expect(row).toMatchObject({ ok: false, inputTokens: 1000, outputTokens: 500 })
    expect(row!.error).toContain('upstream died')
  })

  it('billed to a noAi project → AiRefused(no_ai) before contact', async () => {
    const db = await testDb()
    await db.update(projects).set({ noAi: true }).where(eq(projects.id, projectId))
    const model = scriptedModel('claude-haiku-5-5', [{ text: 'x' }])
    const g = await gateway(mockModels({ fast: model }))
    await expect(
      g.chat({ job: 'fast', billing: { projectId }, system: 's', messages, tools: { echo }, maxSteps: 3 }),
    ).rejects.toMatchObject({ name: 'AiRefused', reason: 'no_ai' })
    expect(model.doStreamCalls).toHaveLength(0)
    expect(await db.select().from(aiCalls)).toHaveLength(0)
  })

  it('provider errors become AiFailed(provider_error); missing model is not_configured', async () => {
    const g = await gateway(mockModels({ fast: failingModel('claude-haiku-5-5', 'upstream down') }))
    await expect(
      g.chat({ job: 'fast', billing: { projectId }, system: 's', messages, tools: { echo }, maxSteps: 3 }),
    ).rejects.toMatchObject({ name: 'AiFailed', reason: 'provider_error' })
    const [row] = await (await testDb()).select().from(aiCalls)
    expect(row).toMatchObject({ ok: false })
    const none = await gateway(mockModels({ fast: null, ids: { draft: OPUS, fast: null, embed: null } }))
    await expect(
      none.chat({ job: 'fast', billing: { projectId }, system: 's', messages, tools: {}, maxSteps: 1 }),
    ).rejects.toMatchObject({ reason: 'not_configured' })
  })

  it('a department-billed chat is refused when the department budget is spent', async () => {
    const db = await testDb()
    await db.update(departmentSettings).set({ aiBudgetUsd: '0.01' }).where(eq(departmentSettings.id, 1))
    await db.insert(aiCalls).values({ projectId: null, job: 'fast', ok: true, costUsd: '0.010000' })
    const model = scriptedModel('claude-haiku-5-5', [{ text: 'x' }])
    const g = await gateway(mockModels({ fast: model }))
    await expect(
      g.chat({ job: 'fast', billing: { department: true }, system: 's', messages, tools: {}, maxSteps: 1 }),
    ).rejects.toMatchObject({ reason: 'budget_exceeded' })
    expect(model.doStreamCalls).toHaveLength(0)
  })
})
