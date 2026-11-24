import { embedMany, streamText } from 'ai'
import type { AiUsage } from '@yoda/shared'
import { and, eq, gte, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { aiCalls, events, projects } from '../db/schema.js'
import type { LiveBus } from '../live/bus.js'
import { recordEvent, runWork } from '../work/context.js'
import { EMBEDDING_DIMENSIONS, parseModelId, type AiJob, type ModelSet } from './models.js'
import prices from './prices.json' with { type: 'json' }

export class AiRefused extends Error {
  constructor(public reason: 'no_ai' | 'budget_exceeded' | 'unpriced_model') {
    super(reason)
    this.name = 'AiRefused'
  }
}

export class AiFailed extends Error {
  constructor(public reason: string, message?: string) {
    super(message ?? reason)
    this.name = 'AiFailed'
  }
}

/**
 * Loggable one-line summary of an error. Never log AI SDK error objects themselves: they carry the request
 * body (project content) and response details.
 */
export function errorSummary(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const status = (err as { statusCode?: unknown }).statusCode
  return `${err.name}${typeof status === 'number' ? ` (${status})` : ''}: ${err.message}`
}

const MONTH_START = sql`date_trunc('month', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok'`
const WARN_RATIO = 0.8

const warnedModels = new Set<string>()

/** Max texts per provider embedding call (each batch is its own ai_calls row). */
export const EMBED_BATCH_SIZE = 64

const priceOf = (model: string) =>
  (prices as Record<string, { inputPerMTok: number; outputPerMTok: number } | undefined>)[model]

export const isPriced = (model: string): boolean => priceOf(model) !== undefined

/** The gateway only records events; it never enqueues jobs. */
const NO_JOBS = {
  send: async (): Promise<void> => {
    throw new Error('AiGateway does not enqueue jobs')
  },
}

export function costOf(model: string, inputTokens: number, outputTokens: number): string | null {
  const p = priceOf(model)
  if (!p) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model)
      console.warn(`ai: no price for model "${model}"; cost_usd will be null`)
    }
    return null
  }
  return ((inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000).toFixed(6)
}

/** Cost and call count for the current Asia/Bangkok calendar month. */
export async function monthUsage(db: Db, projectId: string): Promise<AiUsage> {
  const [row] = await db
    .select({
      month: sql<string>`to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM')`,
      cost: sql<string>`coalesce(sum(${aiCalls.costUsd}), 0)`,
      calls: sql<number>`count(${aiCalls.id})::int`,
      budget: sql<string | null>`(select ai_budget_usd from projects where id = ${projectId})`,
    })
    .from(aiCalls)
    .where(and(eq(aiCalls.projectId, projectId), gte(aiCalls.createdAt, MONTH_START)))
  return {
    month: row?.month ?? '',
    costUsd: Number(row?.cost ?? 0),
    budgetUsd: row?.budget == null ? null : Number(row.budget),
    calls: row?.calls ?? 0,
  }
}

export class AiGateway {
  constructor(
    private deps: { db: Db; bus: LiveBus; models: ModelSet },
    warn: (msg: string) => void = (m) => console.warn(m),
  ) {
    const unpriced = (['draft', 'fast', 'embed'] as const)
      .map((job) => deps.models.ids[job])
      .filter((id): id is string => id !== null && !isPriced(parseModelId(id).model))
    if (unpriced.length) {
      warn(
        `ai: no price in prices.json for ${[...new Set(unpriced)].join(', ')}: calls are logged with cost_usd null ` +
          'and refused for projects that have an AI budget (add the model to apps/core/src/ai/prices.json)',
      )
    }
  }

  async generateText(input: {
    job: 'draft' | 'fast'
    projectId: string | null
    taskId?: string | null
    system: string
    prompt: string
    maxOutputTokens?: number
    signal?: AbortSignal
  }): Promise<{ text: string; model: string }> {
    const { models } = this.deps
    const spec = models.ids[input.job]
    const lm = models[input.job]
    if (!spec || !lm) throw new AiFailed('not_configured')
    const { provider, model } = parseModelId(spec)
    await this.guard(input.projectId, input.taskId ?? null, model)

    let text: string
    let inTok: number
    let outTok: number
    let streamError: unknown
    try {
      const result = streamText({
        model: lm,
        system: input.system,
        prompt: input.prompt,
        maxOutputTokens: input.maxOutputTokens,
        maxRetries: 1,
        abortSignal: input.signal,
        onError: ({ error }) => {
          streamError = error
        },
      })
      text = await result.text
      const usage = await result.totalUsage
      if (streamError) throw streamError
      inTok = usage.inputTokens ?? 0
      outTok = usage.outputTokens ?? 0
    } catch (err) {
      const e = streamError ?? err
      const message = e instanceof Error ? e.message : String(e)
      await this.log(input, provider, model, null, null, false, message)
      throw new AiFailed('provider_error', message)
    }
    // Past this point errors (e.g. DB failures while logging) are not provider errors.
    if (!text.trim()) {
      // Billed even though unusable: keep tokens and cost.
      await this.log(input, provider, model, inTok, outTok, false, 'empty_output')
      throw new AiFailed('empty_output')
    }
    await this.log(input, provider, model, inTok, outTok, true, null)
    await this.warnIfNeeded(input.projectId, input.taskId ?? null)
    return { text, model }
  }

  async embed(input: { projectId: string | null; texts: string[] }): Promise<number[][] | null> {
    const { models } = this.deps
    const spec = models.ids.embed
    if (!models.embed || !spec) return null
    const { provider, model } = parseModelId(spec)
    const logInput = { job: 'embed' as AiJob, projectId: input.projectId, taskId: null }
    const out: number[][] = []
    // Batches keep each provider request bounded; the guard runs per batch so a budget hit mid-way stops.
    for (let i = 0; i < input.texts.length; i += EMBED_BATCH_SIZE) {
      await this.guard(input.projectId, null, model)
      let res: Awaited<ReturnType<typeof embedMany>>
      try {
        res = await embedMany({
          model: models.embed,
          values: input.texts.slice(i, i + EMBED_BATCH_SIZE),
          maxRetries: 1,
          providerOptions: { openai: { dimensions: EMBEDDING_DIMENSIONS } },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.log(logInput, provider, model, null, null, false, message)
        throw new AiFailed('provider_error', message)
      }
      const tokens = res.usage.tokens ?? 0
      if (res.embeddings.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
        await this.log(logInput, provider, model, tokens, 0, false, 'bad_dimensions')
        throw new AiFailed('bad_dimensions')
      }
      await this.log(logInput, provider, model, tokens, 0, true, null)
      out.push(...res.embeddings)
    }
    await this.warnIfNeeded(input.projectId, null)
    return out
  }

  private async log(
    input: { job: AiJob; projectId: string | null; taskId?: string | null },
    provider: string,
    model: string,
    inputTokens: number | null,
    outputTokens: number | null,
    ok: boolean,
    error: string | null,
  ): Promise<void> {
    await this.deps.db.insert(aiCalls).values({
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      job: input.job,
      provider,
      model,
      inputTokens,
      outputTokens,
      costUsd: inputTokens === null ? null : costOf(model, inputTokens, outputTokens ?? 0),
      ok,
      error,
    })
  }

  /**
   * Refuses (before any provider call) for noAi projects and exhausted budgets. A budgeted project also refuses
   * unpriced models: their calls cost null, which would silently disable the hard stop.
   */
  private async guard(projectId: string | null, taskId: string | null, model: string): Promise<void> {
    if (!projectId) return
    const [p] = await this.deps.db
      .select({ noAi: projects.noAi, budget: projects.aiBudgetUsd })
      .from(projects)
      .where(eq(projects.id, projectId))
    if (!p) return
    if (p.noAi) throw new AiRefused('no_ai')
    if (p.budget === null) return
    if (!isPriced(model)) throw new AiRefused('unpriced_model')
    const usage = await monthUsage(this.deps.db, projectId)
    if (usage.costUsd >= Number(p.budget)) {
      await this.eventOncePerMonth('ai.budget_exceeded', projectId, taskId, usage.costUsd, Number(p.budget))
      throw new AiRefused('budget_exceeded')
    }
  }

  private async warnIfNeeded(projectId: string | null, taskId: string | null): Promise<void> {
    if (!projectId) return
    const usage = await monthUsage(this.deps.db, projectId)
    if (usage.budgetUsd === null || usage.budgetUsd <= 0) return
    if (usage.costUsd >= usage.budgetUsd * WARN_RATIO) {
      await this.eventOncePerMonth('ai.budget_warning', projectId, taskId, usage.costUsd, usage.budgetUsd)
    }
  }

  private async eventOncePerMonth(
    type: 'ai.budget_warning' | 'ai.budget_exceeded',
    projectId: string,
    taskId: string | null,
    costUsd: number,
    budgetUsd: number,
  ): Promise<void> {
    await runWork({ ...this.deps, jobs: NO_JOBS }, { id: null, kind: 'system' }, async (ctx) => {
      // Serialize concurrent callers per project+type so the event is recorded once.
      await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${type}:${projectId}`}))`)
      const existing = await ctx.tx
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.projectId, projectId), eq(events.type, type), gte(events.createdAt, MONTH_START)))
        .limit(1)
      if (existing.length > 0) return
      await recordEvent(ctx, {
        type,
        projectId,
        workItemId: null,
        taskId,
        payload: { costUsd, budgetUsd },
      })
    })
  }
}
