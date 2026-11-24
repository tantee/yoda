import { eq } from 'drizzle-orm'
import type { AppDeps } from '../app.js'
import { tasks } from '../db/schema.js'
import { buildContextPack, renderContextPack } from '../knowledge/context-pack.js'
import { runWork } from '../work/context.js'
import { failAiTask, submitAiResult } from '../work/engine.js'
import { AiFailed, AiRefused } from './gateway.js'
import { SYSTEM_PROMPT } from './prompts.js'

export type DrafterDeps = Pick<AppDeps, 'db' | 'ai' | 'bus' | 'jobs'>

/** Failures that retrying cannot fix: the task goes back to people at once with this reason. */
function permanentReason(err: unknown): string | null {
  if (err instanceof AiRefused) return err.reason
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
  run: { isFinalAttempt: boolean } = { isFinalAttempt: true },
): Promise<void> {
  const [task] = await deps.db.select().from(tasks).where(eq(tasks.id, taskId))
  if (!task || task.state !== 'open' || task.executor !== 'ai' || task.assigneeId !== null) return
  try {
    const { pack, overBudget } = await buildContextPack(deps, taskId)
    const { text, model } = await deps.ai.generateText({
      job: 'draft',
      projectId: task.projectId,
      taskId,
      system: SYSTEM_PROMPT,
      prompt: renderContextPack(pack),
    })
    await runWork(deps, { id: null, kind: 'ai' }, (ctx) => submitAiResult(ctx, taskId, text, { model, overBudget }))
  } catch (err) {
    const reason = permanentReason(err)
    if (reason) return fail(deps, taskId, reason)
    if (!run.isFinalAttempt) throw err
    console.warn(`draft-task ${taskId}: giving up after the final attempt`, err)
    await fail(deps, taskId, 'ai_failed')
  }
}
