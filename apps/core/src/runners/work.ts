import type {
  AskHumanInput,
  ContextPack,
  DiscussionOption,
  KnowledgeSearchHit,
  ProgressInput,
  SearchInput,
  SubmitInput,
  WriteKnowledgeInput,
} from '@yoda/shared'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { AiRefused, type AiGateway } from '../ai/gateway.js'
import { invalidState, notFound } from '../auth/plugin.js'
import type { Tx } from '../db/client.js'
import { agentRuns, aiCalls, projectRepos, tasks, workItemRepos, workItems } from '../db/schema.js'
import { raiseFromRunnerTask } from '../discussions/service.js'
import { workItemShortId } from '../gitlab/webhook.js'
import { buildContextPack, PACK_MAX_CHARS, renderCode, renderContextPack, type RunCode } from '../knowledge/context-pack.js'
import { searchKnowledge } from '../knowledge/search.js'
import { createEntry } from '../knowledge/service.js'
import { notify } from '../notifications/service.js'
import { runWork, recordEvent, type WorkCtx } from '../work/context.js'
import { lockItem, submitRunnerResult, submitTask, type WorkItemRow } from '../work/engine.js'
import { canSeeProject } from '../work/queries.js'
import { asOwner, leaseFrom, lockRunTask, nowOf, requireLiveRun, type RunnerCtx, type RunnerDeps } from './claims.js'
import { endRun } from './records.js'

export type { RunCode }

/** Runner calls that read knowledge may embed the query. */
export type RunnerWorkDeps = RunnerDeps & { ai?: Pick<AiGateway, 'embed'> | null }

type TaskRow = typeof tasks.$inferSelect

const SLUG_MAX = 40
const NOTE_EXCERPT = 300

/**
 * The branch a runner pushes for a work item: `yoda/<first 8 hex of its id>-<slug>`, the slug being the title
 * in ASCII `a-z0-9-` (accents dropped, at most 40 characters), or `work` when nothing ASCII is left (Thai).
 */
export function branchFor(workItemId: string, title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '')
  return `yoda/${workItemShortId(workItemId)}-${slug || 'work'}`
}

async function runCode(db: RunnerDeps['db'], item: Pick<WorkItemRow, 'id' | 'title'>): Promise<RunCode> {
  const rows = await db
    .select({
      repoId: projectRepos.id,
      path: projectRepos.pathWithNamespace,
      webUrl: projectRepos.webUrl,
      defaultBranch: projectRepos.defaultBranch,
      issueIid: workItemRepos.issueIid,
      issueUrl: workItemRepos.issueUrl,
    })
    .from(workItemRepos)
    .innerJoin(projectRepos, eq(projectRepos.id, workItemRepos.repoId))
    .where(eq(workItemRepos.workItemId, item.id))
    .orderBy(asc(projectRepos.pathWithNamespace), asc(projectRepos.id))
  return { repos: rows, branch: branchFor(item.id, item.title) }
}

/**
 * The context pack of a live run's task, as the owner sees it (404 when the owner no longer sees the project;
 * 409 `no_ai` for a no-AI project), with the work item's repos, issues and branch, also rendered as `# Code`.
 */
export async function getContextPack(
  deps: RunnerWorkDeps,
  rc: RunnerCtx,
  runId: string,
): Promise<{ text: string; pack: ContextPack; code: RunCode }> {
  const run = await requireLiveRun(deps.db, rc, runId, nowOf(deps))
  const [row] = await deps.db
    .select({ projectId: tasks.projectId, item: workItems })
    .from(tasks)
    .innerJoin(workItems, eq(workItems.id, tasks.workItemId))
    .where(eq(tasks.id, run.taskId))
  if (!row || !(await canSeeProject(deps.db, rc.owner, row.projectId))) throw notFound()
  const code = await runCode(deps.db, row.item)
  // The code section counts toward the prompt budget.
  const maxChars = PACK_MAX_CHARS - renderCode(code).length - 1
  try {
    const { pack } = await buildContextPack(deps, run.taskId, { me: rc.owner, maxChars })
    return { text: renderContextPack(pack, code), pack, code }
  } catch (err) {
    if (err instanceof AiRefused && err.reason === 'no_ai') throw invalidState('no_ai')
    throw err
  }
}

/** Knowledge search as the owner, without anything flagged "do not send to AI". */
export async function searchForRunner(deps: RunnerWorkDeps, rc: RunnerCtx, input: SearchInput): Promise<KnowledgeSearchHit[]> {
  return searchKnowledge(deps.db, rc.owner, { ...input, forAi: true }, deps.ai)
}

/** A draft entry on the run's work item, written by `{ owner, ai }` (so attributed to the owner, on their behalf). */
async function writeDraft(
  ctx: WorkCtx,
  rc: RunnerCtx,
  task: Pick<TaskRow, 'id' | 'projectId' | 'workItemId'>,
  e: { type: WriteKnowledgeInput['type']; title: string; body: string },
): Promise<string> {
  return createEntry(ctx, rc.owner, {
    scope: 'work_item',
    projectId: task.projectId,
    workItemId: task.workItemId,
    ...e,
    noAi: false,
    status: 'draft',
    sourceKind: 'ai',
    sourceRef: task.id,
  })
}

/** Writes a draft knowledge entry on a live run's work item. */
export async function writeKnowledge(deps: RunnerDeps, rc: RunnerCtx, input: WriteKnowledgeInput): Promise<string> {
  const now = nowOf(deps)
  return runWork(deps, asOwner(rc), async (ctx) => {
    const { item, task } = await lockLiveRun(ctx.tx, rc, input.runId, now)
    if (!workable(rc, item, task)) throw invalidState('task_unavailable')
    return writeDraft(ctx, rc, task, { type: input.type, title: input.title, body: input.body })
  })
}

/**
 * Locks the run's task (global order), then the run row itself, which must still be live: one of this runner's,
 * `running`, its lease not passed. 409 `run_not_active` otherwise.
 */
export async function lockLiveRun(tx: Tx, rc: RunnerCtx, runId: string, now: Date): Promise<{ run: typeof agentRuns.$inferSelect; task: TaskRow; item: WorkItemRow }> {
  const ref = await requireLiveRun(tx, rc, runId, now)
  const task = await lockRunTask(tx, ref.taskId)
  const item = await lockItem(tx, task.workItemId)
  const [run] = await tx
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.runnerId, rc.runner.id), eq(agentRuns.state, 'running'), gt(agentRuns.leaseExpiresAt, now)))
    .for('update')
  if (!run) throw invalidState('run_not_active')
  return { run, task, item }
}

/** A progress note: a draft `progress` entry, the `run.progress` event (with an excerpt), and a longer lease. */
export async function postProgress(deps: RunnerDeps, rc: RunnerCtx, input: ProgressInput): Promise<string> {
  const now = nowOf(deps)
  return runWork(deps, asOwner(rc), async (ctx) => {
    const { run, task, item } = await lockLiveRun(ctx.tx, rc, input.runId, now)
    if (!workable(rc, item, task)) throw invalidState('task_unavailable')
    await ctx.tx.update(agentRuns).set({ heartbeatAt: now, leaseExpiresAt: leaseFrom(deps, now) }).where(eq(agentRuns.id, run.id))
    const entryId = await writeDraft(ctx, rc, task, { type: 'progress', title: 'ความคืบหน้า / Progress', body: input.note })
    await recordEvent(ctx, {
      type: 'run.progress',
      projectId: task.projectId,
      workItemId: task.workItemId,
      taskId: task.id,
      payload: { runId: run.id, runnerId: run.runnerId, note: [...input.note].slice(0, NOTE_EXCERPT).join('') },
    })
    return entryId
  })
}

/** May the run still finish (or ask about) its task: an unassigned AI task or the owner's own, on the current step. */
export function workable(rc: RunnerCtx, item: WorkItemRow, task: TaskRow): { ai: boolean } | null {
  const current =
    item.state === 'active' &&
    !task.supersededAt &&
    task.stepKey === item.currentStepKey &&
    (task.state === 'open' || task.state === 'in_progress')
  if (!current) return null
  if (task.executor === 'ai' && task.assigneeId === null) return { ai: true }
  if (task.assigneeId === rc.owner.id) {
    // Claims refuse these already; a result has no decision to give them.
    if (task.type === 'review' || task.type === 'approval') throw invalidState('needs_decision')
    return { ai: false }
  }
  return null
}

export type SubmitOutcome = 'accepted' | 'already_done' | 'task_unavailable'

/**
 * A live run's result. An unassigned AI task is accepted through the engine as `{ owner, ai }` (reason
 * `runner_result`); the owner's own task is submitted as the owner. The run becomes `succeeded`. When the task
 * was already accepted meanwhile (e.g. by an MR effect) the run also succeeds and the task is left alone; when it
 * was taken over, cancelled or superseded the run is `released`. Reported cost is logged to `ai_calls` (job
 * `runner`), so it counts toward the project's monthly budget, whatever the outcome.
 */
export async function submitResult(deps: RunnerDeps, rc: RunnerCtx, input: SubmitInput): Promise<{ outcome: SubmitOutcome }> {
  const now = nowOf(deps)
  return runWork(deps, asOwner(rc), async (ctx) => {
    const { tx } = ctx
    const [prior] = await tx.select().from(agentRuns).where(eq(agentRuns.id, input.runId))
    if (prior?.runnerId === rc.runner.id && prior.state === 'succeeded') return alreadySucceeded(ctx, prior, input)
    let live: Awaited<ReturnType<typeof lockLiveRun>>
    try {
      live = await lockLiveRun(tx, rc, input.runId, now)
    } catch (err) {
      // Read again after the locks: an MR effect may have ended the run while this submit waited for them.
      const [ended] = await tx.select().from(agentRuns).where(eq(agentRuns.id, input.runId))
      if (ended?.runnerId === rc.runner.id && ended.state === 'succeeded') return alreadySucceeded(ctx, ended, input)
      throw err
    }
    const { run, task, item } = live
    const how = workable(rc, item, task)
    let outcome: SubmitOutcome
    if (how?.ai) {
      const accepted = await submitRunnerResult(ctx, task.id, input.text, { model: input.usage?.model ?? null, runId: run.id })
      outcome = accepted ? 'accepted' : 'task_unavailable'
    } else if (how) {
      await submitTask(ctx, rc.owner, task.id, { text: input.text, attachmentIds: [] })
      outcome = 'accepted'
    } else {
      outcome = task.state === 'accepted' ? 'already_done' : 'task_unavailable'
    }
    const usage = input.usage ?? null
    if (outcome === 'task_unavailable') {
      await endRun(ctx, run.id, { state: 'released', event: 'run.released', reason: 'task_unavailable', set: { usage } })
    } else {
      await endRun(ctx, run.id, {
        state: 'succeeded',
        event: 'run.succeeded',
        reason: outcome === 'already_done' ? 'already_done' : null,
        set: { usage },
        reopen: false,
      })
    }
    await logRunnerCost(tx, task, usage)
    return { outcome }
  })
}

/** Reported cost goes to `ai_calls` (job `runner`), so it counts toward the project's monthly budget. */
async function logRunnerCost(tx: Tx, task: Pick<TaskRow, 'id' | 'projectId'>, usage: SubmitInput['usage'] | null): Promise<void> {
  if (usage?.costUsd === undefined) return
  await tx.insert(aiCalls).values({
    projectId: task.projectId,
    taskId: task.id,
    job: 'runner',
    provider: 'runner',
    model: usage.model,
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    costUsd: usage.costUsd.toFixed(6),
    ok: true,
    error: null,
  })
}

/**
 * A submit for a run that already succeeded (an MR effect accepted its task and ended it, or a retried submit):
 * `already_done`. Usage the runner reports is recorded once, when the run has none yet.
 */
async function alreadySucceeded(ctx: WorkCtx, prior: typeof agentRuns.$inferSelect, input: SubmitInput): Promise<{ outcome: SubmitOutcome }> {
  const task = await lockRunTask(ctx.tx, prior.taskId)
  const [run] = await ctx.tx.select().from(agentRuns).where(eq(agentRuns.id, prior.id)).for('update')
  if (input.usage && run && run.usage === null) {
    await ctx.tx.update(agentRuns).set({ usage: input.usage }).where(eq(agentRuns.id, run.id))
    await logRunnerCost(ctx.tx, task, input.usage)
  }
  return { outcome: 'already_done' }
}

/**
 * The runner asks a person: a discussion on the task, raised as the owner (`raiseFromTask` rules, see
 * `raiseFromRunnerTask`). Options given become a ready brief (keys a, b, …); without options the AI writes the
 * brief. The task goes back to `open`, parked on the discussion (runners skip it until it is decided or
 * withdrawn), and the run ends `parked`. Returns the discussion id.
 */
export async function askHuman(deps: RunnerDeps, rc: RunnerCtx, input: AskHumanInput): Promise<string> {
  const now = nowOf(deps)
  return runWork(deps, asOwner(rc), async (ctx) => {
    const { tx } = ctx
    const { run, task, item } = await lockLiveRun(tx, rc, input.runId, now)
    if (!workable(rc, item, task)) throw invalidState('task_unavailable')
    const options: DiscussionOption[] = (input.options ?? [])
      .map((o) => o.trim().slice(0, 200))
      .filter(Boolean)
      .map((title, i) => ({ key: String.fromCharCode(97 + i), title, pros: '', cons: '' }))
    const discussionId = await raiseFromRunnerTask(ctx, rc.owner, task.id, {
      question: input.question,
      details: input.details,
      priority: item.priority as 'low' | 'normal' | 'high' | 'urgent',
      options,
      requestBrief: options.length === 0,
    })
    await tx
      .update(tasks)
      .set({ parkedDiscussionId: discussionId, state: 'open', updatedAt: sql`now()` })
      .where(eq(tasks.id, task.id))
    await endRun(ctx, run.id, { state: 'parked', event: 'run.parked', reason: 'asked_human', payload: { discussionId }, reopen: false })
    // The PMs hear of a raise, never the raiser; the owner's own runner asked, so they are told too.
    await notify(ctx, {
      personId: rc.owner.id,
      kind: 'discussion',
      title: 'AI ของคุณมีคำถาม',
      body: input.question,
      link: `/discussions/${discussionId}`,
      dedupeKey: `runner-ask:${discussionId}`,
    })
    return discussionId
  })
}
