import { ACTIVE_TASK_STATES, type Me, type TaskResult, type TaskState, type WorkflowTemplateDef, type WorkItemCreate } from '@yoda/shared'
import { and, asc, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm'
import {
  commentRequired,
  decisionRequired,
  forbidden,
  HttpError,
  invalidState,
  notFound,
  notMember,
} from '../auth/plugin.js'
import type { Db, Tx } from '../db/client.js'
import {
  attachments,
  conversations,
  discussions,
  projectRepos,
  workItemRepos,
  events,
  knowledgeEntries,
  people,
  projectMembers,
  projects,
  proposals,
  tasks,
  workItems,
} from '../db/schema.js'
import { createProposal, supersedePending } from '../proposals/service.js'
import { confirmEntry, createEntry } from '../knowledge/service.js'
import { withdrawItemDiscussions } from '../discussions/service.js'
import { lockProject } from '../projects/access.js'
import { latestTemplate, templateById } from '../workflow/seed.js'
import { recordEvent, type WorkCtx } from './context.js'
import { checkAdvanceGuards, guardText, type GuardTrip } from './guards.js'
import { createTaskAttempt } from './tasks.js'
import {
  notifyChangesRequested,
  notifyRequestEnded,
  notifyTaskAssigned,
} from '../notifications/service.js'

const ACTIVE_STATES: readonly TaskState[] = ACTIVE_TASK_STATES
const isActive = (state: string) => (ACTIVE_STATES as readonly string[]).includes(state)

export type WorkItemRow = typeof workItems.$inferSelect
type TaskRow = typeof tasks.$inferSelect

// Lock order everywhere: project row (only work item creation and member removal), then work_items row
// FOR NO KEY UPDATE, then the task row. Serialising on the work item is what makes concurrent sibling
// completions advance a step once. NO KEY UPDATE (not FOR UPDATE) still excludes other work item lockers
// but not the FOR KEY SHARE that FK checks take: a path holding a discussion lock that inserts an event
// referencing the item must not wait on the item lock, or it deadlocks against decide/withdraw (item, then
// discussion).

export async function lockItem(tx: Tx, workItemId: string): Promise<WorkItemRow> {
  const [row] = await tx.select().from(workItems).where(eq(workItems.id, workItemId)).for('no key update')
  if (!row) throw notFound()
  return row
}

/** Locks the task's work item, then the task itself; both rows are re-read under the lock. */
async function lockTask(tx: Tx, taskId: string): Promise<{ item: WorkItemRow; task: TaskRow }> {
  // work_item_id never changes, so an unlocked read is enough to find which item to lock.
  const [ref] = await tx.select({ workItemId: tasks.workItemId }).from(tasks).where(eq(tasks.id, taskId))
  if (!ref) throw notFound()
  const item = await lockItem(tx, ref.workItemId)
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update')
  if (!task) throw notFound()
  return { item, task }
}

export async function memberRoles(tx: Db | Tx, projectId: string, personId: string): Promise<string[] | null> {
  const [row] = await tx
    .select({ roles: projectMembers.roles })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.personId, personId)))
  return row?.roles ?? null
}

export async function isPmOrAdmin(tx: Tx, me: Me, projectId: string): Promise<boolean> {
  if (me.isAdmin) return true
  return (await memberRoles(tx, projectId, me.id))?.includes('PM') ?? false
}

/**
 * May `me` act on (start / submit) this task they are assigned to? Project members and admins may; anyone
 * else only on a REQUESTER task assigned to them (a requester is not a project member). Returns whether the
 * requester path was used.
 */
async function requireCanActOn(tx: Tx, me: Me, task: TaskRow): Promise<{ asRequester: boolean }> {
  if (task.assigneeId !== me.id) throw forbidden()
  if (me.isAdmin || (await memberRoles(tx, task.projectId, me.id))) return { asRequester: false }
  if (task.role === 'REQUESTER') return { asRequester: true }
  throw forbidden()
}

export async function definitionOf(tx: Tx, item: WorkItemRow): Promise<WorkflowTemplateDef> {
  const def = await templateById(tx, item.templateId)
  if (!def) throw new Error(`workflow template ${item.templateId} missing`)
  return def
}

export async function createWorkItem(
  ctx: WorkCtx,
  me: Me,
  projectId: string,
  input: WorkItemCreate,
): Promise<string> {
  const { tx } = ctx
  // Waits for any in-flight member removal, so the new item's tasks never go to a departing member.
  await lockProject(tx, projectId, 'share')
  if (!me.isAdmin && !(await memberRoles(tx, projectId, me.id))) throw notFound()
  const ownerId = input.ownerId ?? me.id
  if (!(await memberRoles(tx, projectId, ownerId))) throw notMember()
  // Any person may be the requester (staff or not); they need not be a project member.
  const requesterId = input.requesterId ?? null
  if (requesterId) {
    const [p] = await tx.select({ id: people.id }).from(people).where(eq(people.id, requesterId))
    if (!p) throw notFound()
  }
  const template = await latestTemplate(tx, input.templateKey)
  if (!template) throw notFound()

  const [row] = await tx
    .insert(workItems)
    .values({
      projectId,
      templateId: template.id,
      title: input.title,
      description: input.description,
      priority: input.priority,
      ownerId,
      requesterId,
      createdBy: me.id,
    })
    .returning({ id: workItems.id })
  const workItemId = row!.id
  // Every repo linked to the project so far; the PM can narrow the set until the Dev step starts.
  const repos = await tx.select({ id: projectRepos.id }).from(projectRepos).where(eq(projectRepos.projectId, projectId))
  if (repos.length) await tx.insert(workItemRepos).values(repos.map((r) => ({ workItemId, repoId: r.id })))
  await recordEvent(ctx, { type: 'work_item.created', projectId, workItemId, taskId: null })
  await startWorkItem(ctx, workItemId)
  return workItemId
}

export async function startWorkItem(ctx: WorkCtx, workItemId: string): Promise<void> {
  const item = await lockItem(ctx.tx, workItemId)
  const def = await definitionOf(ctx.tx, item)
  await ctx.tx
    .update(workItems)
    .set({ currentStepKey: def.steps[0]!.key, updatedAt: sql`now()` })
    .where(eq(workItems.id, workItemId))
  await progressWorkItem(ctx, workItemId)
}

export type StepStatus = {
  def: WorkflowTemplateDef
  step: WorkflowTemplateDef['steps'][number]
  next: WorkflowTemplateDef['steps'][number] | undefined
  /** Latest current (not superseded) attempt per task key. */
  latest: Map<string, TaskRow>
  /** Latest attempt per task key, superseded ones included (attempt numbers never repeat). */
  lastAttempt: Map<string, TaskRow>
  active: Set<string>
  satisfied: (key: string) => boolean
  /** Every task of the current step is accepted (latest attempt). */
  complete: boolean
  /** Open or scheduled discussions on the item: while any exist the step does not advance. */
  openDiscussions: number
}

/**
 * Open / scheduled discussions linked to the work item. Read under the work item lock: raising, deciding and
 * withdrawing a linked discussion all hold that lock, so the count cannot change until the caller commits.
 */
export async function openDiscussionCount(tx: Tx, workItemId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(discussions)
    .where(and(eq(discussions.workItemId, workItemId), inArray(discussions.state, ['open', 'scheduled'])))
  return row?.n ?? 0
}

/** Where the (locked, active) work item stands on its current step. */
async function stepStatus(tx: Tx, item: WorkItemRow): Promise<StepStatus> {
  const def = await definitionOf(tx, item)
  const stepIndex = def.steps.findIndex((s) => s.key === item.currentStepKey)
  if (stepIndex < 0) throw new Error(`work item ${item.id} has unknown step ${item.currentStepKey}`)
  const step = def.steps[stepIndex]!
  const next = def.steps[stepIndex + 1]
  const rows = await tx.select().from(tasks).where(eq(tasks.workItemId, item.id))
  const latest = new Map<string, TaskRow>()
  const lastAttempt = new Map<string, TaskRow>()
  const active = new Set<string>()
  for (const r of rows) {
    const last = lastAttempt.get(r.templateTaskKey)
    if (!last || r.attempt > last.attempt) lastAttempt.set(r.templateTaskKey, r)
    if (isActive(r.state)) active.add(r.templateTaskKey)
    if (r.supersededAt) continue
    const cur = latest.get(r.templateTaskKey)
    if (!cur || r.attempt > cur.attempt) latest.set(r.templateTaskKey, r)
  }
  const satisfied = (key: string) => latest.get(key)?.state === 'accepted'
  const complete = step.tasks.every((t) => satisfied(t.key))
  // Only a finished step can be held back, so the count is read only then.
  const openDiscussions = complete ? await openDiscussionCount(tx, item.id) : 0
  return { def, step, next, latest, lastAttempt, active, satisfied, complete, openDiscussions }
}

/**
 * Moves the locked work item from `status.step` to the next step (or completes it after the last step).
 * The caller re-runs progressWorkItem to create the new step's tasks.
 */
async function advanceStep(ctx: WorkCtx, item: WorkItemRow, status: StepStatus): Promise<void> {
  const { tx } = ctx
  const { step, next } = status
  const base = { projectId: item.projectId, workItemId: item.id, taskId: null }
  await recordEvent(ctx, {
    type: 'work_item.step_advanced',
    ...base,
    payload: { from: step.key, to: next?.key ?? null },
  })
  if (!next) {
    await tx
      .update(workItems)
      .set({ state: 'done', currentStepKey: null, updatedAt: sql`now()` })
      .where(eq(workItems.id, item.id))
    await recordEvent(ctx, { type: 'work_item.done', ...base })
    await notifyRequestEnded(ctx, item, 'done')
    // Nothing left to decide for a finished item (e.g. a pending raise_discussion); work item lock held.
    await supersedePending(ctx, item.id)
    // The secretary reacts in its own job, after this transaction (and its locks) are released.
    ctx.jobs.push({ name: 'secretary-event', id: item.id })
    return
  }
  await tx.update(workItems).set({ currentStepKey: next.key, updatedAt: sql`now()` }).where(eq(workItems.id, item.id))
}

export async function progressWorkItem(ctx: WorkCtx, workItemId: string): Promise<void> {
  const { tx } = ctx
  for (;;) {
    const item = await lockItem(tx, workItemId)
    if (item.state !== 'active') return
    const status = await stepStatus(tx, item)
    const { step, next, latest, lastAttempt, active, satisfied } = status

    if (status.complete) {
      // An open discussion holds the finished step: no advance, no proposal, no guard check. Deciding or
      // withdrawing it re-runs this (resumeAfterDiscussion), so the item continues exactly once.
      if (status.openDiscussions > 0) return
      // `propose` projects confirm each step advance: a pending proposal waits for the PM (decideProposal
      // advances on accept). `auto-assign` projects advance directly unless a guard rail trips, which makes
      // it the same proposal with the guard's reason. The last step always completes the work item directly.
      if (next) {
        const autonomy = await projectAutonomy(tx, item.projectId)
        const guard = autonomy === 'auto-assign' ? await checkAdvanceGuards(tx, item, step, next) : null
        if (autonomy === 'propose' || guard) {
          await proposeStepAdvance(ctx, item, step.key, next.key, guard)
          return
        }
      }
      await advanceStep(ctx, item, status)
      if (!next) return
      continue
    }

    for (const t of step.tasks) {
      if (satisfied(t.key) || active.has(t.key) || !t.dependsOn.every(satisfied)) continue
      const prev = latest.get(t.key)
      const prevText = prev?.state === 'rejected' ? (prev.result as { text?: string } | null)?.text : undefined
      // After a reopen the superseded attempt still names who did it last.
      const last = lastAttempt.get(t.key)
      await createTaskAttempt(ctx, {
        workItemId,
        projectId: item.projectId,
        stepKey: step.key,
        task: t,
        attempt: (last?.attempt ?? 0) + 1,
        feedback: prevText && prevText.trim() ? prevText : null,
        assigneeHint: last?.assigneeId ?? null,
        executor: t.type === 'ai' ? 'ai' : 'human',
      })
    }
    return
  }
}

async function projectAutonomy(tx: Tx, projectId: string): Promise<string> {
  const [row] = await tx.select({ autonomy: projects.autonomy }).from(projects).where(eq(projects.id, projectId))
  return row?.autonomy ?? 'propose'
}

/**
 * Creates the work item's `step_advance` proposal unless one is pending. Runs under the work item lock, which
 * every creator holds, so the check cannot race (the partial unique index backs it up).
 */
async function proposeStepAdvance(
  ctx: WorkCtx,
  item: WorkItemRow,
  fromStep: string,
  toStep: string,
  guard: GuardTrip | null = null,
): Promise<void> {
  const [pending] = await ctx.tx
    .select({ id: proposals.id })
    .from(proposals)
    .where(and(eq(proposals.workItemId, item.id), eq(proposals.kind, 'step_advance'), eq(proposals.state, 'pending')))
  if (pending) return
  await createProposal(
    { ...ctx, actorKind: 'system' },
    {
      projectId: item.projectId,
      workItemId: item.id,
      kind: 'step_advance',
      summary: '',
      reason: guard ? guardText(guard) : '',
      payload: guard
        ? { fromStep, toStep, guard: guard.reason, ...(guard.detail ? { guardDetail: guard.detail } : {}) }
        : { fromStep, toStep },
      onBehalfOf: null,
    },
  )
}

/**
 * Accepting a `step_advance` proposal (work item locked by the caller): the advance still applies only while
 * the item is active, on `fromStep`, with every task of that step accepted and `toStep` next. Returns the
 * step status to pass to applyStepAdvance, or null when the situation changed. A step held by an open
 * discussion → 409 `invalid_state` (a pending proposal stays pending until the discussion ends).
 */
export async function stepAdvanceReady(
  tx: Tx,
  item: WorkItemRow,
  fromStep: unknown,
  toStep: unknown,
): Promise<StepStatus | null> {
  if (item.state !== 'active' || item.currentStepKey !== fromStep) return null
  const status = await stepStatus(tx, item)
  if (!status.complete || !status.next) return null
  // `toStep` undefined: a direct advance to whatever step is next.
  if (toStep !== undefined && status.next.key !== toStep) return null
  if (status.openDiscussions > 0) throw invalidState()
  return status
}

/** Advances the item as checked by stepAdvanceReady and creates the next step's tasks. */
export async function applyStepAdvance(ctx: WorkCtx, item: WorkItemRow, status: StepStatus): Promise<void> {
  await advanceStep(ctx, item, status)
  await progressWorkItem(ctx, item.id)
}

/**
 * PM/admin: advances a work item whose current step is finished, without (or instead of) a proposal: the way
 * out after a step_advance proposal was rejected. Re-checked under the work item lock; 409 when not ready.
 * A pending step_advance proposal is superseded.
 */
export async function advanceWorkItem(ctx: WorkCtx, me: Me, workItemId: string): Promise<void> {
  const { tx } = ctx
  const item = await lockItem(tx, workItemId)
  if (!(await isPmOrAdmin(tx, me, item.projectId))) throw forbidden()
  const status = await stepAdvanceReady(tx, item, item.currentStepKey, undefined)
  if (!status) throw invalidState()
  await supersedePending(ctx, workItemId, 'step_advance')
  await applyStepAdvance(ctx, item, status)
}

/**
 * PM/admin: sends an active work item back to `stepKey`, an earlier step of its template (else 422
 * `invalid_state`; 409 when the item is no longer active), e.g. after the requester asked for changes on the
 * delivery. Under the work item lock: rejects every active task from `stepKey` on (reason `reopened`),
 * supersedes every attempt of `stepKey` and later steps (they must be done again), moves the item to
 * `stepKey`, and creates new attempts of that step's root tasks (no `dependsOn`) carrying the requester's
 * latest change request as feedback and the previous attempt's assignee as hint. Pending step_advance
 * proposals are superseded.
 */
export async function reopenWorkItem(ctx: WorkCtx, me: Me, workItemId: string, stepKey: string): Promise<void> {
  const { tx } = ctx
  const item = await lockItem(tx, workItemId)
  if (!(await isPmOrAdmin(tx, me, item.projectId))) throw forbidden()
  if (item.state !== 'active') throw invalidState()
  const def = await definitionOf(tx, item)
  const current = def.steps.findIndex((s) => s.key === item.currentStepKey)
  const target = def.steps.findIndex((s) => s.key === stepKey)
  // Not an earlier step: a bad request about this item's template rather than a race.
  if (current < 0 || target < 0 || target >= current) throw new HttpError(422, { error: 'invalid_state' })
  const base = { projectId: item.projectId, workItemId, taskId: null }
  // The steps they were raised on are redone: whatever they asked is moot.
  await withdrawItemDiscussions(ctx, workItemId, 'work_item_reopened')

  const rejected = await tx
    .update(tasks)
    .set({ state: 'rejected', updatedAt: sql`now()` })
    .where(
      and(
        eq(tasks.workItemId, workItemId),
        inArray(tasks.state, [...ACTIVE_STATES]),
        // Current and later steps (from the target on, in case an earlier step still had one open).
        inArray(tasks.stepKey, def.steps.slice(target).map((s) => s.key)),
      ),
    )
    .returning({ id: tasks.id })
  rejected.sort((a, b) => a.id.localeCompare(b.id))
  for (const r of rejected) await recordEvent(ctx, { type: 'task.rejected', ...base, taskId: r.id, reason: 'reopened' })
  await supersedePending(ctx, workItemId, 'step_advance')

  // Everything from the target step on is redone: earlier attempts no longer satisfy their step.
  await tx
    .update(tasks)
    .set({ supersededAt: sql`now()` })
    .where(
      and(
        eq(tasks.workItemId, workItemId),
        isNull(tasks.supersededAt),
        inArray(tasks.stepKey, def.steps.slice(target).map((s) => s.key)),
      ),
    )
  await tx.update(workItems).set({ currentStepKey: stepKey, updatedAt: sql`now()` }).where(eq(workItems.id, workItemId))
  await recordEvent(ctx, { type: 'work_item.reopened', ...base, payload: { from: item.currentStepKey, to: stepKey } })

  const [change] = await tx
    .select({ result: tasks.result })
    .from(tasks)
    .where(
      and(
        eq(tasks.workItemId, workItemId),
        eq(tasks.role, 'REQUESTER'),
        eq(tasks.state, 'rejected'),
        sql`${tasks.result}->>'decision' = 'changes'`,
      ),
    )
    .orderBy(desc(tasks.updatedAt), desc(tasks.id))
    .limit(1)
  const comment = change?.result?.text?.trim() ? change.result.text : null

  const step = def.steps[target]!
  for (const t of step.tasks.filter((x) => x.dependsOn.length === 0)) {
    const [prev] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.workItemId, workItemId), eq(tasks.templateTaskKey, t.key)))
      .orderBy(desc(tasks.attempt))
      .limit(1)
    await createTaskAttempt(ctx, {
      workItemId,
      projectId: item.projectId,
      stepKey: step.key,
      task: t,
      attempt: (prev?.attempt ?? 0) + 1,
      feedback: comment,
      assigneeHint: prev?.assigneeId ?? null,
      // A task a person took over from the AI stays with people.
      executor: (prev?.executor as 'ai' | 'human' | undefined) ?? (t.type === 'ai' ? 'ai' : 'human'),
    })
  }
  await progressWorkItem(ctx, workItemId)
}

export async function startTask(ctx: WorkCtx, me: Me, taskId: string): Promise<void> {
  const { task } = await lockTask(ctx.tx, taskId)
  await requireCanActOn(ctx.tx, me, task)
  if (task.state !== 'open') throw invalidState()
  await ctx.tx.update(tasks).set({ state: 'in_progress', updatedAt: sql`now()` }).where(eq(tasks.id, taskId))
  await recordEvent(ctx, { type: 'task.started', projectId: task.projectId, workItemId: task.workItemId, taskId })
}

export async function submitTask(ctx: WorkCtx, me: Me, taskId: string, result: TaskResult): Promise<void> {
  const { tx } = ctx
  const { item, task } = await lockTask(tx, taskId)
  const { asRequester } = await requireCanActOn(tx, me, task)
  if (task.state !== 'open' && task.state !== 'in_progress') throw invalidState()
  const decides = task.type === 'review' || task.type === 'approval'
  if (decides) {
    if (!result.decision) throw decisionRequired()
    if (result.decision === 'changes' && !result.text.trim()) throw commentRequired()
  }
  const base = { projectId: task.projectId, workItemId: task.workItemId, taskId }
  // confidence / missing are the AI drafter's own note; a person's submission never carries them.
  const { confidence: _confidence, missing: _missing, ...submitted } = result
  result = { ...submitted, attachmentIds: [...new Set(result.attachmentIds)] }
  // A requester may only attach files they uploaded themselves, never other project files.
  await linkAttachments(tx, task, result.attachmentIds, me, asRequester)

  if (!decides || result.decision === 'approve') {
    await tx.update(tasks).set({ state: 'accepted', result, updatedAt: sql`now()` }).where(eq(tasks.id, taskId))
    await recordEvent(ctx, { type: 'task.accepted', ...base })
    await recordAcceptedKnowledge(ctx, item, task, result)
  } else {
    const comment = result.text
    await tx.update(tasks).set({ state: 'rejected', result, updatedAt: sql`now()` }).where(eq(tasks.id, taskId))
    await recordEvent(ctx, { type: 'task.rejected', ...base, reason: comment })
    if (task.role === 'REQUESTER') {
      await notifyChangesRequested(ctx, { projectId: task.projectId, workItemId: task.workItemId, taskId, comment })
    }

    const def = await definitionOf(tx, item)
    const step = def.steps.find((s) => s.key === task.stepKey)
    const templateTask = step?.tasks.find((t) => t.key === task.templateTaskKey)
    for (const depKey of templateTask?.dependsOn ?? []) {
      const depDef = step!.tasks.find((t) => t.key === depKey)!
      const [prev] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.workItemId, task.workItemId), eq(tasks.templateTaskKey, depKey)))
        .orderBy(desc(tasks.attempt))
        .limit(1)
      await createTaskAttempt(ctx, {
        workItemId: task.workItemId,
        projectId: task.projectId,
        stepKey: task.stepKey,
        task: depDef,
        attempt: (prev?.attempt ?? 0) + 1,
        feedback: comment,
        assigneeHint: prev?.assigneeId ?? null,
        executor: (prev?.executor as 'ai' | 'human' | undefined) ?? (depDef.type === 'ai' ? 'ai' : 'human'),
      })
    }
  }
  await progressWorkItem(ctx, task.workItemId)
}

/**
 * Links attachments to the task. Allowed: files of the task's project (for a requester, only ones they
 * uploaded), and project-less files the submitter uploaded in their own personal/intake conversation (a
 * requester's samples), which join the task's project. Anything else → 404 (never confirms other projects' or
 * people's ids). A file already linked to another task, or on another work item → 409 `invalid_state`,
 * so a submit never moves files off other tasks. Project-level files join the task's work item.
 */
async function linkAttachments(tx: Tx, task: TaskRow, ids: string[], me: Me, asRequester: boolean): Promise<void> {
  if (!ids.length) return
  const ownChatFile = and(
    isNull(attachments.projectId),
    eq(attachments.uploadedBy, me.id),
    inArray(
      attachments.conversationId,
      tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.ownerId, me.id)),
    ),
  )
  const rows = await tx
    .select({ id: attachments.id, taskId: attachments.taskId, workItemId: attachments.workItemId })
    .from(attachments)
    .where(
      and(
        inArray(attachments.id, ids),
        or(
          and(eq(attachments.projectId, task.projectId), asRequester ? eq(attachments.uploadedBy, me.id) : undefined),
          ownChatFile,
        ),
      ),
    )
    .orderBy(asc(attachments.id))
    .for('update')
  if (rows.length !== ids.length) throw notFound()
  const foreign = (r: (typeof rows)[number]) =>
    (r.taskId !== null && r.taskId !== task.id) || (r.workItemId !== null && r.workItemId !== task.workItemId)
  if (rows.some(foreign)) throw invalidState()
  await tx
    .update(attachments)
    .set({ projectId: task.projectId, taskId: task.id, workItemId: task.workItemId })
    .where(inArray(attachments.id, ids))
}

/**
 * Knowledge from accepted work (system writes, no permission checks: the submitter's rights were checked).
 * Call after the task row is `accepted` with `result` (submitTask, and the AI runner's submitAiResult).
 * - An `ai` / `human` task with result text → a `progress` entry; `draft` when the AI did the work.
 * - An approving `review` / `approval` → a confirmed `document` entry for each task it depends on
 *   (latest accepted attempt), and that task's draft progress entries become confirmed.
 */
export async function recordAcceptedKnowledge(ctx: WorkCtx, item: WorkItemRow, task: TaskRow, result: TaskResult): Promise<void> {
  const { tx } = ctx
  const def = await definitionOf(tx, item)
  const step = def.steps.find((s) => s.key === task.stepKey)
  const templateTask = step?.tasks.find((t) => t.key === task.templateTaskKey)
  if (!step || !templateTask) return
  const entry = (sourceTask: TaskRow, title: string, body: string) =>
    ({
      scope: 'work_item',
      projectId: sourceTask.projectId,
      workItemId: sourceTask.workItemId,
      title,
      body,
      noAi: false,
      sourceKind: 'task',
      sourceRef: sourceTask.id,
    }) as const

  if (task.type === 'ai' || task.type === 'human') {
    if (!result.text.trim()) return
    await createEntry(ctx, null, {
      ...entry(task, templateTask.title.th, result.text),
      type: 'progress',
      status: task.executor === 'ai' ? 'draft' : 'confirmed',
    })
    return
  }
  if (result.decision !== 'approve') return
  for (const depKey of templateTask.dependsOn) {
    const depDef = step.tasks.find((t) => t.key === depKey)
    const [dep] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.workItemId, task.workItemId), eq(tasks.templateTaskKey, depKey), eq(tasks.state, 'accepted')))
      .orderBy(desc(tasks.attempt))
      .limit(1)
    if (!dep || !depDef) continue
    const text = (dep.result as TaskResult | null)?.text ?? ''
    if (text.trim()) {
      await createEntry(ctx, null, { ...entry(dep, depDef.title.th, text), type: 'document', status: 'confirmed' })
    }
    const drafts = await tx
      .select({ id: knowledgeEntries.id })
      .from(knowledgeEntries)
      .where(
        and(
          eq(knowledgeEntries.sourceKind, 'task'),
          eq(knowledgeEntries.sourceRef, dep.id),
          eq(knowledgeEntries.type, 'progress'),
          eq(knowledgeEntries.status, 'draft'),
          isNull(knowledgeEntries.supersededAt),
        ),
      )
      .orderBy(asc(knowledgeEntries.id))
      // Locked, and the filter is re-checked after any wait: a draft a person edited or confirmed
      // meanwhile is no longer a current draft and is skipped instead of failing the approval.
      .for('update')
    for (const d of drafts) await confirmEntry(ctx, null, d.id)
  }
}

export async function assignTask(ctx: WorkCtx, me: Me, taskId: string, personId: string): Promise<void> {
  const { tx } = ctx
  const { item, task } = await lockTask(tx, taskId)
  if (!(await isPmOrAdmin(tx, me, task.projectId))) throw forbidden()
  if (!isActive(task.state)) throw invalidState()
  // A REQUESTER task may also go (back) to the work item's requester, who is usually not a member.
  const toRequester = task.role === 'REQUESTER' && personId === item.requesterId
  if (!toRequester && !(await memberRoles(tx, task.projectId, personId))) throw notMember()
  const takeover = task.executor === 'ai'
  await tx
    .update(tasks)
    .set({
      assigneeId: personId,
      proposedAssigneeId: null,
      state: task.state === 'proposed' ? 'open' : task.state,
      executor: 'human',
      updatedAt: sql`now()`,
    })
    .where(eq(tasks.id, taskId))
  await recordEvent(ctx, {
    type: 'task.assigned',
    projectId: task.projectId,
    workItemId: task.workItemId,
    taskId,
    payload: takeover ? { assigneeId: personId, takeover: true } : { assigneeId: personId },
  })
  await notifyManualAssignment(ctx, item, task, personId)
}

export async function confirmTask(ctx: WorkCtx, me: Me, taskId: string): Promise<void> {
  const { tx } = ctx
  const { item, task } = await lockTask(tx, taskId)
  if (!(await isPmOrAdmin(tx, me, task.projectId))) throw forbidden()
  if (task.state !== 'proposed' || !task.proposedAssigneeId) throw invalidState()
  const assigneeId = task.proposedAssigneeId
  if (!(await memberRoles(tx, task.projectId, assigneeId))) throw notMember()
  await tx
    .update(tasks)
    .set({ assigneeId, proposedAssigneeId: null, state: 'open', updatedAt: sql`now()` })
    .where(eq(tasks.id, taskId))
  await recordEvent(ctx, {
    type: 'task.assigned',
    projectId: task.projectId,
    workItemId: task.workItemId,
    taskId,
    payload: { assigneeId },
  })
  await notifyManualAssignment(ctx, item, task, assigneeId)
}

/** A PM's own decision to give a task to `personId`: they are told, unless they did it to themselves. */
async function notifyManualAssignment(ctx: WorkCtx, item: WorkItemRow, task: TaskRow, personId: string): Promise<void> {
  if (personId === ctx.actorId) return
  const def = await definitionOf(ctx.tx, item)
  const taskTitle = def.steps.flatMap((s) => s.tasks).find((t) => t.key === task.templateTaskKey)?.title.th ?? ''
  await notifyTaskAssigned(ctx, {
    taskId: task.id,
    workItemId: task.workItemId,
    role: task.role,
    personId,
    taskTitle,
  })
}

/**
 * Called when `personId` leaves the project (after the membership row is deleted, same transaction), or with
 * `roles` when they lose those roles (after the membership row is updated):
 * every active task they hold or are proposed for becomes unassigned `open`, so it lands in the PM's
 * confirmations — except REQUESTER tasks they hold as the work item's requester.
 *
 * Locks the project, then every active work item of the project (not only the ones holding this
 * person's tasks), then reads the tasks. A concurrent progress/assign holds a work item lock while it
 * picks an assignee from a membership snapshot that may still include this person; waiting for all
 * item locks means such a task is committed, and therefore visible, before we look for it. New items
 * cannot appear meanwhile because createWorkItem takes the project lock in share mode.
 */
export async function unassignMemberTasks(
  ctx: WorkCtx,
  projectId: string,
  personId: string,
  /** Role removal: only tasks with one of these roles (reason `role_removed`). Omitted: member removal. */
  roles?: string[],
): Promise<void> {
  if (roles && roles.length === 0) return
  const { tx } = ctx
  await lockProject(tx, projectId)
  await tx
    .select({ id: workItems.id })
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), eq(workItems.state, 'active')))
    .orderBy(asc(workItems.id))
    .for('no key update')
  const cleared = await tx
    .update(tasks)
    .set({ assigneeId: null, proposedAssigneeId: null, state: 'open', updatedAt: sql`now()` })
    .where(
      and(
        eq(tasks.projectId, projectId),
        inArray(tasks.state, [...ACTIVE_STATES]),
        or(eq(tasks.assigneeId, personId), eq(tasks.proposedAssigneeId, personId)),
        roles ? inArray(tasks.role, roles) : undefined,
        // The work item's requester keeps their requester tasks: those never depended on membership.
        sql`not (${tasks.role} = 'REQUESTER' and ${tasks.assigneeId} is not distinct from (select w.requester_id from work_items w where w.id = ${tasks.workItemId}))`,
      ),
    )
    .returning({ id: tasks.id, workItemId: tasks.workItemId })
  cleared.sort((a, b) => (a.workItemId + a.id).localeCompare(b.workItemId + b.id))
  for (const t of cleared) {
    await recordEvent(ctx, {
      type: 'task.unassigned',
      projectId,
      workItemId: t.workItemId,
      taskId: t.id,
      reason: roles ? 'role_removed' : 'member_removed',
      payload: roles ? { personId, roles } : { personId },
    })
  }
}

export async function cancelWorkItem(ctx: WorkCtx, me: Me, workItemId: string): Promise<void> {
  const { tx } = ctx
  const item = await lockItem(tx, workItemId)
  const ownerStillMember = item.ownerId === me.id && (await memberRoles(tx, item.projectId, me.id)) !== null
  if (!ownerStillMember && !(await isPmOrAdmin(tx, me, item.projectId))) throw forbidden()
  if (item.state !== 'active') throw invalidState()
  await withdrawItemDiscussions(ctx, workItemId, 'work_item_cancelled')

  const rejected = await tx
    .update(tasks)
    .set({ state: 'rejected', updatedAt: sql`now()` })
    .where(and(eq(tasks.workItemId, workItemId), inArray(tasks.state, [...ACTIVE_STATES])))
    .returning({ id: tasks.id })
  for (const r of rejected) {
    await recordEvent(ctx, {
      type: 'task.rejected',
      projectId: item.projectId,
      workItemId,
      taskId: r.id,
      reason: 'work_item_cancelled',
    })
  }
  await tx.update(workItems).set({ state: 'cancelled', updatedAt: sql`now()` }).where(eq(workItems.id, workItemId))
  await recordEvent(ctx, { type: 'work_item.cancelled', projectId: item.projectId, workItemId, taskId: null })
  await notifyRequestEnded(ctx, item, 'cancelled')
  // Nothing left to decide for a cancelled item (work item lock held, so proposals are locked after it).
  await supersedePending(ctx, workItemId)
}

/** The AI runner may still act on the task: open, unassigned and executed by the AI. */
const awaitingAi = (task: TaskRow) => task.state === 'open' && task.assigneeId === null && task.executor === 'ai'

/**
 * Stores an AI draft as the task's result (actor kind `ai`). No-op when the task was taken over, cancelled or
 * already finished meanwhile. Records `ai.drafted` then `task.accepted`, a draft progress entry, then advances
 * the work item so the next (human) task appears.
 */
export async function submitAiResult(
  ctx: WorkCtx,
  taskId: string,
  text: string,
  meta: { model: string; overBudget?: boolean; confidence?: 'high' | 'low'; missing?: string[] },
): Promise<boolean> {
  const { tx } = ctx
  const { item, task } = await lockTask(tx, taskId)
  if (item.state !== 'active' || !awaitingAi(task)) return false
  // The drafter's confidence note (guard G3 reads it when the step completes).
  const result: TaskResult = { text, attachmentIds: [], confidence: meta.confidence ?? 'high', missing: meta.missing ?? [] }
  const base = { projectId: task.projectId, workItemId: task.workItemId, taskId }
  await tx.update(tasks).set({ state: 'accepted', result, updatedAt: sql`now()` }).where(eq(tasks.id, taskId))
  await recordEvent(ctx, {
    type: 'ai.drafted',
    ...base,
    payload: meta.overBudget ? { model: meta.model, overBudget: true } : { model: meta.model },
  })
  await recordEvent(ctx, { type: 'task.accepted', ...base })
  await recordAcceptedKnowledge(ctx, item, task, result)
  await progressWorkItem(ctx, task.workItemId)
  return true
}

/**
 * Records that the AI could not draft the task (`ai.failed` with `reason`, actor kind `system`). The task stays
 * open and unassigned, so it remains in the PM's confirmations. No-op when it no longer awaits the AI.
 */
export async function failAiTask(ctx: WorkCtx, taskId: string, reason: string): Promise<void> {
  const { item, task } = await lockTask(ctx.tx, taskId)
  if (item.state !== 'active' || !awaitingAi(task)) return
  await recordEvent(ctx, {
    type: 'ai.failed',
    projectId: task.projectId,
    workItemId: task.workItemId,
    taskId,
    reason,
  })
}

/** PM/admin: queue another drafting attempt for an open, unassigned `draft-text` AI task. */
export async function retryAiTask(ctx: WorkCtx, me: Me, taskId: string): Promise<void> {
  const { tx } = ctx
  const { item, task } = await lockTask(tx, taskId)
  if (!(await isPmOrAdmin(tx, me, task.projectId))) throw forbidden()
  if (item.state !== 'active' || !awaitingAi(task)) throw invalidState()
  const def = await definitionOf(tx, item)
  const templateTask = def.steps.find((s) => s.key === task.stepKey)?.tasks.find((t) => t.key === task.templateTaskKey)
  if (templateTask?.capability !== 'draft-text') throw invalidState()
  const [proj] = await tx.select({ noAi: projects.noAi }).from(projects).where(eq(projects.id, task.projectId))
  if (!proj || proj.noAi) throw invalidState()
  // After a failed draft, or when no draft was ever attempted (e.g. its job was lost). A pending ai.retried
  // means a job is already queued. A duplicate job is harmless: the draft-task queue keeps one per task.
  const [last] = await tx
    .select({ type: events.type })
    .from(events)
    .where(and(eq(events.taskId, taskId), like(events.type, 'ai.%')))
    .orderBy(desc(events.seq))
    .limit(1)
  if (last && last.type !== 'ai.failed') throw invalidState()
  await recordEvent(ctx, { type: 'ai.retried', projectId: task.projectId, workItemId: task.workItemId, taskId })
  ctx.jobs.push({ name: 'draft-task', id: taskId })
}

/**
 * After a project's noAi is switched off: queues drafting for every `draft-text` task still waiting on the AI
 * (recording `ai.retried` where the last attempt failed, so the task shows as drafting again) and re-embeds the
 * project's current entries that have chunks without vectors.
 */
export async function resumeProjectAi(ctx: WorkCtx, projectId: string): Promise<void> {
  const { tx } = ctx
  const waiting = await tx
    .select({ task: tasks, item: workItems })
    .from(tasks)
    .innerJoin(workItems, eq(workItems.id, tasks.workItemId))
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.state, 'open'),
        eq(tasks.executor, 'ai'),
        isNull(tasks.assigneeId),
        eq(workItems.state, 'active'),
      ),
    )
  const defs = new Map<string, WorkflowTemplateDef>()
  for (const { task, item } of waiting) {
    let def = defs.get(item.templateId)
    if (!def) defs.set(item.templateId, (def = await definitionOf(tx, item)))
    const tt = def.steps.find((s) => s.key === task.stepKey)?.tasks.find((t) => t.key === task.templateTaskKey)
    if (tt?.capability !== 'draft-text') continue
    const [last] = await tx
      .select({ type: events.type })
      .from(events)
      .where(and(eq(events.taskId, task.id), like(events.type, 'ai.%')))
      .orderBy(desc(events.seq))
      .limit(1)
    if (last?.type === 'ai.failed') {
      await recordEvent(ctx, { type: 'ai.retried', projectId, workItemId: task.workItemId, taskId: task.id })
    }
    ctx.jobs.push({ name: 'draft-task', id: task.id })
  }
  const unembedded = await tx
    .select({ id: knowledgeEntries.id })
    .from(knowledgeEntries)
    .leftJoin(attachments, eq(attachments.id, knowledgeEntries.attachmentId))
    .where(
      and(
        eq(knowledgeEntries.projectId, projectId),
        isNull(knowledgeEntries.supersededAt),
        eq(knowledgeEntries.noAi, false),
        or(isNull(attachments.id), eq(attachments.noAi, false)),
        sql`exists (select 1 from knowledge_chunks c where c.entry_id = ${knowledgeEntries.id} and c.embedding is null)`,
      ),
    )
  for (const e of unembedded) ctx.jobs.push({ name: 'embed-entry', id: e.id })
}
