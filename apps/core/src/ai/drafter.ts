import { eq } from 'drizzle-orm'
import type { AppDeps } from '../app.js'
import { tasks } from '../db/schema.js'
import { buildContextPack, renderContextPack } from '../knowledge/context-pack.js'
import { runWork } from '../work/context.js'
import { failAiTask, submitAiResult } from '../work/engine.js'
import { AiFailed, AiRefused, errorSummary } from './gateway.js'
import { SYSTEM_PROMPT } from './prompts.js'

/** Upper bound for one draft: long documents fit, a runaway generation does not run up the bill. */
export const DRAFT_MAX_OUTPUT_TOKENS = 16_000

export type DrafterDeps = Pick<AppDeps, 'db' | 'ai' | 'bus' | 'jobs' | 'config'>

export type DraftMeta = { confidence: 'high' | 'low'; missing: string[] }

/** Matched against the tail from the last `<!--`: only a note that ends the draft is the meta note. */
const META_NOTE = /^<!--\s*meta\b([\s\S]*?)-->\s*$/
const MAX_MISSING = 10
const MAX_MISSING_LENGTH = 200

/**
 * Splits the drafter's final `<!--meta {...}-->` note (see SYSTEM_PROMPT) from the draft. The note is always
 * stripped; a missing or unreadable one counts as high confidence with nothing missing.
 */
export function parseDraftMeta(raw: string): { text: string; meta: DraftMeta } {
  const fallback: DraftMeta = { confidence: 'high', missing: [] }
  const start = raw.lastIndexOf('<!--')
  const m = start >= 0 ? META_NOTE.exec(raw.slice(start)) : null
  if (!m) return { text: raw, meta: fallback }
  const text = raw.slice(0, start).trimEnd()
  try {
    const v = JSON.parse(m[1]!.trim()) as { confidence?: unknown; missing?: unknown }
    if (v === null || typeof v !== 'object') return { text, meta: fallback }
    const missing = Array.isArray(v.missing)
      ? v.missing
          .filter((x): x is string => typeof x === 'string')
          .map((x) => x.trim().slice(0, MAX_MISSING_LENGTH))
          .filter(Boolean)
          .slice(0, MAX_MISSING)
      : []
    return { text, meta: { confidence: v.confidence === 'low' ? 'low' : 'high', missing } }
  } catch {
    return { text, meta: fallback }
  }
}

/** Failures that retrying cannot fix: the task goes back to people at once with this reason. */
function permanentReason(err: unknown): string | null {
  // An unpriced model on a budgeted project is a configuration problem, not a budget one.
  if (err instanceof AiRefused) return err.reason === 'unpriced_model' ? 'ai_unavailable' : err.reason
  if (err instanceof AiFailed && err.reason === 'not_configured') return 'ai_unavailable'
  // The model answered but with nothing usable; asking again is unlikely to help and costs money.
  if (err instanceof AiFailed && err.reason === 'empty_output') return 'ai_failed'
  return null
}

const fail = (deps: DrafterDeps, taskId: string, reason: string) =>
  runWork(deps, { id: null, kind: 'system' }, (ctx) => failAiTask(ctx, taskId, reason))

/**
 * `draft-task` job handler: drafts a `draft-text` AI task from its context pack and submits the draft.
 * Skips silently unless the task still awaits the AI (a person may have taken it over). Transient failures
 * are rethrown for the queue to retry; on the final attempt the task is marked `ai_failed` instead.
 */
export async function runDraft(
  deps: DrafterDeps,
  taskId: string,
  run: { isFinalAttempt: boolean; signal?: AbortSignal } = { isFinalAttempt: true },
): Promise<void> {
  const [task] = await deps.db.select().from(tasks).where(eq(tasks.id, taskId))
  if (!task || task.state !== 'open' || task.executor !== 'ai' || task.assigneeId !== null) return
  try {
    const { pack, overBudget } = await buildContextPack(deps, taskId)
    const { text: raw, model } = await deps.ai.generateText({
      job: 'draft',
      projectId: task.projectId,
      taskId,
      system: SYSTEM_PROMPT,
      prompt: renderContextPack(pack),
      maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS,
      signal: run.signal,
    })
    const { text, meta } = parseDraftMeta(raw)
    // Only the note came back: nothing usable to show (same as an empty answer).
    if (!text.trim()) throw new AiFailed('empty_output', 'draft was empty after its meta note')
    await runWork(deps, { id: null, kind: 'ai' }, (ctx) => submitAiResult(ctx, taskId, text, { model, overBudget, ...meta }))
  } catch (err) {
    const reason = permanentReason(err)
    if (reason) return fail(deps, taskId, reason)
    if (!run.isFinalAttempt) throw err
    console.warn(`draft-task ${taskId}: giving up after the final attempt: ${errorSummary(err)}`)
    await fail(deps, taskId, 'ai_failed')
  }
}
