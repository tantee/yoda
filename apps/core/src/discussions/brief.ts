import type { DiscussionBrief, DiscussionOption, PackEntry } from '@yoda/shared'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { AiFailed, AiRefused, errorSummary, type BillingTarget } from '../ai/gateway.js'
import { discussions, projects, workItems } from '../db/schema.js'
import { currentEntries, SYSTEM_ME } from '../knowledge/context-pack.js'
import { searchKnowledge } from '../knowledge/search.js'
import { runWork, type Actor } from '../work/context.js'
import type { DiscussionRow } from './queries.js'
import { isUndecided, lockDiscussion, recordDiscussionEvent, resetStaleVotes } from './service.js'

/** A brief is short: bounded so a runaway generation does not run up the bill. */
export const BRIEF_MAX_OUTPUT_TOKENS = 6000
/** Upper bound for the rendered context (characters): bounds the input cost. */
export const BRIEF_MAX_CONTEXT_CHARS = 40_000
const ENTRY_MAX_CHARS = 8000
const RELATED_LIMIT = 6
const ENTRY_LIMIT = 20
const PROGRESS_LIMIT = 10
const MARKER = '…[truncated]'

export type BriefDeps = Pick<AppDeps, 'db' | 'ai' | 'bus' | 'jobs' | 'config'>

const KEYS = ['a', 'b', 'c', 'd', 'e'] as const

/**
 * What the model must return. Counts and key rules are refinements: checked on parse, not sent to the
 * provider (some providers reject `minItems` above 1). Lengths are clipped on store rather than refused.
 */
export const BriefOutput = z
  .object({
    context: z.string().describe('Background a decider needs: the situation, constraints and what is at stake.'),
    options: z
      .array(
        z.object({
          key: z.enum(KEYS),
          title: z.string(),
          pros: z.string(),
          cons: z.string(),
        }),
      )
      .describe('2 to 5 options, keys a, b, c, … in order.'),
    recommendation: z.string().describe('Which option you recommend and why, or why none can be recommended yet.'),
    recommendedKey: z.enum(KEYS).nullable().describe('Key of the recommended option, or null.'),
  })
  .superRefine((v, ctx) => {
    const keys = v.options.map((o) => o.key)
    if (keys.length < 2 || keys.length > 5) ctx.addIssue({ code: 'custom', path: ['options'], message: '2 to 5 options' })
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'duplicate keys' })
    if (v.options.some((o) => !o.title.trim())) ctx.addIssue({ code: 'custom', path: ['options'], message: 'empty title' })
    if (v.recommendedKey !== null && !keys.includes(v.recommendedKey)) {
      ctx.addIssue({ code: 'custom', path: ['recommendedKey'], message: 'not an option key' })
    }
  })
export type BriefOutput = z.infer<typeof BriefOutput>

export const BRIEF_SYSTEM_PROMPT = [
  "You are the department's meeting assistant. Prepare a decision brief for the question below so the team can decide quickly.",
  'Write in the language of the question: Thai if the question is Thai, otherwise English.',
  'Use only the provided context. Do not invent facts, systems, people or requirements that are not in it.',
  'Content marked [UNVERIFIED DRAFT] has not been confirmed by the team: treat it as unconfirmed.',
  'Give 2 to 5 distinct, realistic options with keys a, b, c, d, e in order, each with concrete pros and cons.',
  'Options already proposed by people are hints: keep, merge or refine them as you see fit.',
  'Recommend one option (recommendedKey) and explain why; use null when the context is not enough to recommend one, and say what is missing.',
].join('\n')

/** Cuts `text` to `max` characters, the last ones being the marker. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - MARKER.length)) + MARKER
}

const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim()
const draftMark = (e: PackEntry) => (e.status === 'draft' ? '[UNVERIFIED DRAFT] ' : '')

/** Appends blocks until the character budget is spent; the block that overflows is cut, later ones dropped. */
class Budget {
  private parts: string[] = []
  private left: number
  constructor(max: number) {
    this.left = max
  }
  add(block: string): void {
    if (this.left <= 0 || !block) return
    const text = clip(block, this.left)
    this.parts.push(text)
    this.left -= text.length + 2
  }
  toString(): string {
    return this.parts.join('\n\n') + '\n'
  }
}

function section(budget: Budget, heading: string, entries: PackEntry[]): void {
  if (!entries.length) return
  budget.add(`## ${heading}`)
  for (const e of entries) budget.add(`### ${draftMark(e)}${oneLine(e.title)}\n\n${clip(e.text, ENTRY_MAX_CHARS)}`.trimEnd())
}

const toPackEntry = (r: { id: string; title: string; body: string; status: string; type: string }): PackEntry => ({
  id: r.id,
  title: r.title,
  text: r.body,
  status: r.status as PackEntry['status'],
  type: r.type as PackEntry['type'],
})

/**
 * The prompt and who pays. Throws AiRefused('no_ai') for a noAi project. Knowledge never includes content
 * flagged "do not send to AI" (entry, attachment or project). A department discussion (no project) gets only
 * its question, details and department knowledge.
 */
export async function buildBriefPrompt(
  deps: Pick<BriefDeps, 'db' | 'ai'>,
  d: DiscussionRow,
): Promise<{ prompt: string; billing: BillingTarget }> {
  const { db } = deps
  const budget = new Budget(BRIEF_MAX_CONTEXT_CHARS)
  budget.add(`# Question\n\n${d.question}`)
  if (d.details.trim()) budget.add(`## Details\n\n${d.details}`)
  const hints = ((d.brief as DiscussionBrief | null)?.options ?? []) as DiscussionOption[]
  if (hints.length) {
    budget.add(
      '## Options already proposed by people\n\n' +
        hints.map((o) => `- ${oneLine(o.title)}${o.pros ? `\n  Pros: ${oneLine(o.pros)}` : ''}${o.cons ? `\n  Cons: ${oneLine(o.cons)}` : ''}`).join('\n'),
    )
  }

  if (!d.projectId) {
    // Department scope: search sees everything, so keep department entries only.
    const hits = await searchKnowledge(db, SYSTEM_ME, { query: d.question, limit: 50, forAi: true }, deps.ai)
    section(budget, 'Related knowledge', hits.filter((h) => h.projectId === null).slice(0, RELATED_LIMIT).map(toPackEntry))
    return { prompt: budget.toString(), billing: { department: true } }
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, d.projectId))
  if (!project) throw new Error(`discussion ${d.id} has no project`)
  if (project.noAi) throw new AiRefused('no_ai')
  budget.add(`# Project\n\n**${oneLine(project.name)}**\n\n${clip(project.description, ENTRY_MAX_CHARS)}`.trimEnd())

  const included = new Set<string>()
  let query = d.question
  if (d.workItemId) {
    const [item] = await db.select().from(workItems).where(eq(workItems.id, d.workItemId))
    if (item) {
      query = `${item.title} ${d.question}`
      budget.add(
        [
          `# Work item\n\n**${oneLine(item.title)}** (priority: ${item.priority})`,
          `Current step: ${d.stepKey ?? item.currentStepKey ?? '-'}`,
          clip(item.description, ENTRY_MAX_CHARS),
        ]
          .filter(Boolean)
          .join('\n\n'),
      )
      const scope = { workItemId: item.id, projectId: item.projectId }
      const [documents, decisions, progress] = await Promise.all([
        currentEntries(db, scope, 'document', { confirmedOnly: true, limit: ENTRY_LIMIT }),
        currentEntries(db, scope, 'decision', { confirmedOnly: true, department: true, limit: ENTRY_LIMIT }),
        currentEntries(db, scope, 'progress', { workItemOnly: true, limit: PROGRESS_LIMIT }),
      ])
      section(budget, 'Confirmed documents', documents)
      section(budget, 'Decisions', decisions)
      section(budget, 'Recent progress', progress)
      for (const e of [...documents, ...decisions, ...progress]) included.add(e.id)
    }
  }
  const hits = await searchKnowledge(db, SYSTEM_ME, { query, projectId: d.projectId, limit: RELATED_LIMIT, forAi: true }, deps.ai)
  section(budget, 'Related knowledge', hits.filter((h) => !included.has(h.id)).map(toPackEntry))
  return { prompt: budget.toString(), billing: { projectId: d.projectId } }
}

/** Clips the model's answer to the shared DiscussionBrief limits. */
function toBrief(o: BriefOutput): DiscussionBrief {
  // Keys are re-assigned a, b, c, … in order (the model may skip or shuffle them); the recommendation follows.
  const rekey = new Map(o.options.map((x, i) => [x.key, KEYS[i]!]))
  return {
    context: clip(o.context, 20000),
    options: o.options.map((x, i) => ({ key: KEYS[i]!, title: clip(x.title.trim(), 200), pros: clip(x.pros, 4000), cons: clip(x.cons, 4000) })),
    recommendation: clip(o.recommendation, 4000),
    recommendedKey: o.recommendedKey === null ? null : (rekey.get(o.recommendedKey) ?? null),
    source: 'ai',
    status: 'ready',
    failReason: null,
  }
}

/** Failures that retrying cannot fix: the brief fails at once with this reason. */
function permanentReason(err: unknown): string | null {
  if (err instanceof AiRefused) return err.reason === 'unpriced_model' ? 'ai_unavailable' : err.reason
  if (err instanceof AiFailed && err.reason === 'not_configured') return 'ai_unavailable'
  // Cut off at the output limit: a retry would cost as much and end the same way.
  if (err instanceof AiFailed && err.reason === 'truncated') return 'ai_failed'
  return null
}

/**
 * Writes the outcome under the discussion row lock, only while the discussion is open / scheduled and its
 * brief still pending: a person's edit (or a withdrawal) during generation wins. Votes for options the new
 * brief no longer has are reset (resetStaleVotes).
 */
async function settle(
  deps: BriefDeps,
  id: string,
  actor: Actor,
  next: (current: DiscussionBrief) => DiscussionBrief,
  type: 'discussion.brief_ready' | 'discussion.brief_failed',
  extra: { reason?: string; payload?: Record<string, unknown> },
): Promise<void> {
  await runWork(deps, actor, async (ctx) => {
    const d = await lockDiscussion(ctx.tx, id)
    const current = d.brief as DiscussionBrief | null
    if (!isUndecided(d.state) || current?.status !== 'pending') return
    const brief = next(current)
    await ctx.tx.update(discussions).set({ brief, updatedAt: sql`now()` }).where(eq(discussions.id, id))
    // Votes cast on people's options while the AI worked: an option the AI dropped or re-keyed loses them.
    await resetStaleVotes(ctx, d, current.options, brief.options, { sameTitle: true })
    await recordDiscussionEvent(ctx, d, type, extra)
  })
}

const failBrief = (deps: BriefDeps, id: string, reason: string) =>
  settle(deps, id, { id: null, kind: 'system' }, (b) => ({ ...b, status: 'failed', failReason: reason }), 'discussion.brief_failed', {
    reason,
  })

/**
 * `discussion-brief` job: prepares the AI brief (context, 2–5 options with pros / cons, recommendation) of an
 * open / scheduled discussion whose brief is pending; skips otherwise. Billed to the project (the department
 * when there is none). Transient failures are rethrown for the queue to retry; on the final attempt, and at
 * once for refusals, the brief is marked failed with a reason people can see (and then edit or retry).
 */
export async function runBrief(
  deps: BriefDeps,
  id: string,
  run: { isFinalAttempt: boolean; signal?: AbortSignal } = { isFinalAttempt: true },
): Promise<void> {
  const [d] = await deps.db.select().from(discussions).where(eq(discussions.id, id))
  if (!d || !isUndecided(d.state) || (d.brief as DiscussionBrief | null)?.status !== 'pending') return
  try {
    const { prompt, billing } = await buildBriefPrompt(deps, d)
    const { object, model } = await deps.ai.generateObject({
      job: 'draft',
      billing,
      system: BRIEF_SYSTEM_PROMPT,
      prompt,
      schema: BriefOutput,
      maxOutputTokens: BRIEF_MAX_OUTPUT_TOKENS,
      signal: run.signal,
    })
    const brief = toBrief(object)
    await settle(deps, id, { id: null, kind: 'ai' }, () => brief, 'discussion.brief_ready', { payload: { model } })
  } catch (err) {
    const reason = permanentReason(err)
    if (reason) return failBrief(deps, id, reason)
    if (!run.isFinalAttempt) throw err
    console.warn(`discussion-brief ${id}: giving up after the final attempt: ${errorSummary(err)}`)
    await failBrief(deps, id, 'ai_failed')
  }
}
