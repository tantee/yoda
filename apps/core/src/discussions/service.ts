import type {
  DiscussionBrief,
  DiscussionBriefEdit,
  DiscussionCreate,
  DiscussionDecide,
  DiscussionOption,
  DiscussionResponse,
  DiscussionResponseCreate,
  DiscussionWithdraw,
  TaskDiscussionCreate,
  EventType,
  Me,
} from '@yoda/shared'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { forbidden, HttpError, invalidState, notFound } from '../auth/plugin.js'
import type { Tx } from '../db/client.js'
import { discussionResponses, discussions, projects, tasks, workItems } from '../db/schema.js'
import { createEntry } from '../knowledge/service.js'
import { notifyDiscussionEnded, notifyDiscussionRaised } from '../notifications/service.js'
import { recordEvent, type WorkCtx } from '../work/context.js'
import { isPmOrAdmin, lockItem, progressWorkItem } from '../work/engine.js'
import { canSeeProject } from '../work/queries.js'
import { requireDiscussionVisible, toResponse, type DiscussionRow } from './queries.js'

/** A request that is well-formed but does not fit the data (unknown option, mismatched project). */
const unprocessable = () => new HttpError(422, { error: 'invalid_state' })

const isUndecided = (state: string) => state === 'open' || state === 'scheduled'

function requireUniqueKeys(options: DiscussionOption[]): void {
  if (new Set(options.map((o) => o.key)).size !== options.length) throw unprocessable()
}

function briefOptions(row: Pick<DiscussionRow, 'brief'>): DiscussionOption[] {
  return (row.brief as DiscussionBrief | null)?.options ?? []
}

/**
 * Discussion events: a project discussion records a normal event (live-pushed by the project rule); a
 * department one has no project to record it under, so it is only pushed live (to all staff, see stream.ts).
 */
async function recordDiscussionEvent(
  ctx: WorkCtx,
  d: Pick<DiscussionRow, 'id' | 'projectId' | 'workItemId' | 'taskId'>,
  type: Extract<EventType, `discussion.${string}`>,
  extra: { reason?: string; payload?: Record<string, unknown> } = {},
): Promise<void> {
  if (d.projectId) {
    await recordEvent(ctx, {
      type,
      projectId: d.projectId,
      workItemId: d.workItemId,
      taskId: d.taskId,
      reason: extra.reason ?? null,
      payload: { discussionId: d.id, ...extra.payload },
    })
    return
  }
  ctx.emitted.push({ type, projectId: null, workItemId: null, taskId: null, conversationId: null, personId: null })
}

/**
 * Raises a discussion as `me` (staff). Links: `workItemId` (and optionally a `taskId` of that item) gives the
 * project; a given `projectId` must match it (422). The raiser must see the project (404 otherwise; any staff
 * for a department discussion). A linked work item is locked and must be active (409). With `requestBrief` on
 * an AI-enabled project the brief is left `pending` for the `discussion-brief` job (sent after commit);
 * otherwise the given options become a ready, person-written brief.
 */
export async function createDiscussion(ctx: WorkCtx, me: Me, input: DiscussionCreate): Promise<string> {
  const { tx } = ctx
  if (!me.isStaff) throw forbidden()
  requireUniqueKeys(input.options)
  let projectId = input.projectId ?? null
  let stepKey: string | null = null
  if (input.workItemId) {
    // Visibility first, unlocked (a work item's project never changes): outsiders never wait on its row.
    const [ref] = await tx.select({ projectId: workItems.projectId }).from(workItems).where(eq(workItems.id, input.workItemId))
    if (!ref || !(await canSeeProject(tx, me, ref.projectId))) throw notFound()
    // Locked so the raise serialises with the item's step advance (plan 5 task 4 blocks on open discussions).
    const item = await lockItem(tx, input.workItemId)
    if (projectId && projectId !== item.projectId) throw unprocessable()
    projectId = item.projectId
    stepKey = item.currentStepKey
    if (input.taskId) {
      const [task] = await tx
        .select({ stepKey: tasks.stepKey })
        .from(tasks)
        .where(and(eq(tasks.id, input.taskId), eq(tasks.workItemId, item.id)))
      if (!task) throw notFound()
      stepKey = task.stepKey
    }
    if (item.state !== 'active') throw invalidState()
  }
  let noAi = false
  if (projectId) {
    const [project] = await tx.select({ noAi: projects.noAi }).from(projects).where(eq(projects.id, projectId))
    if (!project || !(await canSeeProject(tx, me, projectId))) throw notFound()
    noAi = project.noAi
  }
  const wantsAi = input.requestBrief && !noAi
  const brief: DiscussionBrief = {
    context: '',
    options: input.options,
    recommendation: '',
    recommendedKey: null,
    source: wantsAi ? 'ai' : 'person',
    status: wantsAi ? 'pending' : 'ready',
    failReason: null,
  }
  const [row] = await tx
    .insert(discussions)
    .values({
      projectId,
      workItemId: input.workItemId ?? null,
      taskId: input.taskId ?? null,
      stepKey,
      question: input.question,
      details: input.details,
      priority: input.priority,
      brief,
      raisedBy: me.id,
    })
    .returning()
  const d = row!
  await recordDiscussionEvent(ctx, d, 'discussion.raised')
  await notifyDiscussionRaised(ctx, { id: d.id, projectId, question: d.question, raisedBy: me.id })
  if (wantsAi) ctx.jobs.push({ name: 'discussion-brief', id: d.id })
  return d.id
}

/** Reads the row unlocked and checks visibility (404) before any lock is taken. */
async function visibleRef(tx: Tx, me: Me, id: string): Promise<DiscussionRow> {
  const [row] = await tx.select().from(discussions).where(eq(discussions.id, id))
  if (!row) throw notFound()
  await requireDiscussionVisible(tx, me, row)
  return row
}

async function lockDiscussion(tx: Tx, id: string): Promise<DiscussionRow> {
  const [row] = await tx.select().from(discussions).where(eq(discussions.id, id)).for('update')
  if (!row) throw notFound()
  return row
}

/** Deciders: PMs of the project and admins; department discussions: admins. */
async function canDecide(tx: Tx, me: Me, d: Pick<DiscussionRow, 'projectId'>): Promise<boolean> {
  return d.projectId ? isPmOrAdmin(tx, me, d.projectId) : me.isAdmin
}

/** The raiser, or a decider, may edit the brief and withdraw. */
async function canManage(tx: Tx, me: Me, d: Pick<DiscussionRow, 'projectId' | 'raisedBy'>): Promise<boolean> {
  return d.raisedBy === me.id || (await canDecide(tx, me, d))
}

/**
 * An opinion, or a vote (a person's second vote replaces the first). Open / scheduled only (409). A vote's
 * option must be in the brief (422). The discussion row is share-locked so a concurrent decision either sees
 * this response (and notifies its author) or this request sees the decision (409).
 */
export async function respond(ctx: WorkCtx, me: Me, id: string, input: DiscussionResponseCreate): Promise<DiscussionResponse> {
  const { tx } = ctx
  await visibleRef(tx, me, id)
  const [d] = await tx.select().from(discussions).where(eq(discussions.id, id)).for('share')
  if (!d) throw notFound()
  if (!isUndecided(d.state)) throw invalidState()
  const values = { discussionId: id, authorId: me.id, kind: input.kind, text: input.text }
  let row: typeof discussionResponses.$inferSelect
  if (input.kind === 'vote') {
    if (!briefOptions(d).some((o) => o.key === input.optionKey)) throw unprocessable()
    ;[row] = (await tx
      .insert(discussionResponses)
      .values({ ...values, optionKey: input.optionKey })
      .onConflictDoUpdate({
        target: [discussionResponses.discussionId, discussionResponses.authorId],
        targetWhere: sql`${discussionResponses.kind} = 'vote'`,
        set: { optionKey: input.optionKey, text: input.text, createdAt: sql`now()` },
      })
      .returning()) as [typeof discussionResponses.$inferSelect]
  } else {
    ;[row] = (await tx.insert(discussionResponses).values(values).returning()) as [typeof discussionResponses.$inferSelect]
  }
  return toResponse(row, me.displayName)
}

/** The raiser, a PM or an admin rewrites the brief: it becomes a ready, person-written brief. */
export async function editBrief(ctx: WorkCtx, me: Me, id: string, input: DiscussionBriefEdit): Promise<void> {
  const { tx } = ctx
  const ref = await visibleRef(tx, me, id)
  if (!(await canManage(tx, me, ref))) throw forbidden()
  requireUniqueKeys(input.options)
  if (input.recommendedKey !== null && !input.options.some((o) => o.key === input.recommendedKey)) throw unprocessable()
  const d = await lockDiscussion(tx, id)
  // Re-checked under the lock (membership or roles may have changed while waiting).
  await requireDiscussionVisible(tx, me, d)
  if (!(await canManage(tx, me, d))) throw forbidden()
  if (!isUndecided(d.state)) throw invalidState()
  const brief: DiscussionBrief = { ...input, source: 'person', status: 'ready', failReason: null }
  await tx.update(discussions).set({ brief, updatedAt: sql`now()` }).where(eq(discussions.id, id))
}

/**
 * After a decision or withdrawal (same transaction, work item still locked): the item's step was held by its
 * open discussions; re-running progress lets it continue once none are left (a step advance proposal in
 * `propose` projects, unless one is already pending; a guarded advance in `auto-assign` ones). No project
 * lock is taken here: the caller already holds the work item lock, and project → work item is the order.
 */
export async function resumeAfterDiscussion(ctx: WorkCtx, workItemId: string): Promise<void> {
  await progressWorkItem(ctx, workItemId)
}

/**
 * `POST /tasks/:id/raise-discussion`: the task's assignee, or a PM / admin of its project, raises a
 * discussion linked to the task's work item, the task and its step. The caller has checked the task is
 * visible (404 otherwise). Rights are re-checked under the work item lock, which createDiscussion re-takes.
 */
export async function raiseFromTask(ctx: WorkCtx, me: Me, taskId: string, input: TaskDiscussionCreate): Promise<string> {
  const { tx } = ctx
  if (!me.isStaff) throw forbidden()
  const allowed = async () => {
    const [task] = await tx
      .select({ workItemId: tasks.workItemId, projectId: tasks.projectId, assigneeId: tasks.assigneeId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
    if (!task) throw notFound()
    if (task.assigneeId !== me.id && !(await isPmOrAdmin(tx, me, task.projectId))) throw forbidden()
    return task
  }
  const ref = await allowed()
  await lockItem(tx, ref.workItemId)
  const task = await allowed()
  return createDiscussion(ctx, me, { ...input, workItemId: task.workItemId, taskId })
}

/**
 * Cancelling or reopening the work item (its lock held by the caller): every open / scheduled discussion on
 * it is withdrawn with `reason` (`discussion.withdrawn`, actor = the caller), and the raiser and responders
 * are told as on a manual withdrawal.
 */
export async function withdrawItemDiscussions(
  ctx: WorkCtx,
  workItemId: string,
  reason: 'work_item_cancelled' | 'work_item_reopened',
): Promise<void> {
  const { tx } = ctx
  const rows = await tx
    .select()
    .from(discussions)
    .where(and(eq(discussions.workItemId, workItemId), inArray(discussions.state, ['open', 'scheduled'])))
    .orderBy(asc(discussions.id))
    .for('update')
  const text = reason === 'work_item_cancelled' ? 'งานที่เกี่ยวข้องถูกยกเลิก' : 'งานที่เกี่ยวข้องถูกส่งกลับไปทำขั้นตอนก่อนหน้า'
  for (const d of rows) {
    await tx.update(discussions).set({ state: 'withdrawn', updatedAt: sql`now()` }).where(eq(discussions.id, d.id))
    await recordDiscussionEvent(ctx, d, 'discussion.withdrawn', { reason })
    await notifyDiscussionEnded(ctx, 'withdrawn', {
      id: d.id,
      projectId: d.projectId,
      question: d.question,
      raisedBy: d.raisedBy,
      text,
      responders: await responderIds(tx, d.id),
    })
  }
}

/**
 * Checks visibility (404) and permission (403) unlocked, then locks the work item (if any) and the
 * discussion, in that order, re-reads it and re-checks both: a discussion no longer open / scheduled → 409.
 */
async function lockForFinal(
  ctx: WorkCtx,
  me: Me,
  id: string,
  allowed: (tx: Tx, me: Me, d: DiscussionRow) => Promise<boolean>,
): Promise<DiscussionRow> {
  const { tx } = ctx
  const ref = await visibleRef(tx, me, id)
  if (!(await allowed(tx, me, ref))) throw forbidden()
  // work_item_id never changes, so the unlocked read tells which item to lock.
  if (ref.workItemId) await lockItem(tx, ref.workItemId)
  const d = await lockDiscussion(tx, id)
  await requireDiscussionVisible(tx, me, d)
  if (!(await allowed(tx, me, d))) throw forbidden()
  if (!isUndecided(d.state)) throw invalidState()
  return d
}

/** Knowledge titles are at most 300 characters; the full question stays in the body. */
export const KNOWLEDGE_TITLE_MAX = 300
function knowledgeTitle(question: string): string {
  const chars = [...question]
  return chars.length <= KNOWLEDGE_TITLE_MAX ? question : `${chars.slice(0, KNOWLEDGE_TITLE_MAX - 1).join('')}…`
}

function decisionBody(d: DiscussionRow, decision: string, option: DiscussionOption | null): string {
  const brief = d.brief as DiscussionBrief | null
  return [
    `คำถาม: ${d.question}`,
    `ข้อสรุป: ${decision}`,
    option ? `ทางเลือกที่เลือก: ${option.title}` : '',
    d.details ? `รายละเอียด: ${d.details}` : '',
    brief?.context ? `บริบท: ${brief.context}` : '',
    brief?.recommendation ? `ข้อเสนอแนะ: ${brief.recommendation}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Decides an open / scheduled discussion (project PM or admin; department: admin). Records the decision,
 * a confirmed `decision` knowledge entry (on the work item, else the project, else the department; written by
 * the system path with the decider as author), notifies the raiser and responders, then resumes the work item.
 */
export async function decideDiscussion(ctx: WorkCtx, me: Me, id: string, input: DiscussionDecide): Promise<void> {
  const { tx } = ctx
  const d = await lockForFinal(ctx, me, id, canDecide)
  let option: DiscussionOption | null = null
  if (input.optionKey !== undefined) {
    option = briefOptions(d).find((o) => o.key === input.optionKey) ?? null
    if (!option) throw unprocessable()
  }
  await tx
    .update(discussions)
    .set({
      state: 'decided',
      decision: input.decision,
      decidedOptionKey: option?.key ?? null,
      decidedBy: me.id,
      decidedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(discussions.id, id))
  await recordDiscussionEvent(ctx, d, 'discussion.decided', { payload: { optionKey: option?.key ?? null } })
  await createEntry(ctx, null, {
    scope: d.workItemId ? 'work_item' : d.projectId ? 'project' : 'department',
    projectId: d.projectId ?? undefined,
    workItemId: d.workItemId ?? undefined,
    type: 'decision',
    title: knowledgeTitle(d.question),
    body: decisionBody(d, input.decision, option),
    noAi: false,
    status: 'confirmed',
    sourceKind: 'person',
    sourceRef: d.id,
  })
  await notifyDiscussionEnded(ctx, 'decided', {
    id: d.id,
    projectId: d.projectId,
    question: d.question,
    raisedBy: d.raisedBy,
    text: input.decision,
    responders: await responderIds(tx, id),
  })
  if (d.workItemId) await resumeAfterDiscussion(ctx, d.workItemId)
}

async function responderIds(tx: Tx, discussionId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ id: discussionResponses.authorId })
    .from(discussionResponses)
    .where(eq(discussionResponses.discussionId, discussionId))
  return rows.map((r) => r.id)
}

/** Withdraws an open / scheduled discussion (raiser, project PM, admin); the work item resumes. */
export async function withdrawDiscussion(ctx: WorkCtx, me: Me, id: string, input: DiscussionWithdraw): Promise<void> {
  const d = await lockForFinal(ctx, me, id, canManage)
  await ctx.tx.update(discussions).set({ state: 'withdrawn', updatedAt: sql`now()` }).where(eq(discussions.id, id))
  await recordDiscussionEvent(ctx, d, 'discussion.withdrawn', { reason: input.reason })
  await notifyDiscussionEnded(ctx, 'withdrawn', {
    id: d.id,
    projectId: d.projectId,
    question: d.question,
    raisedBy: d.raisedBy,
    text: input.reason,
    responders: await responderIds(ctx.tx, id),
  })
  if (d.workItemId) await resumeAfterDiscussion(ctx, d.workItemId)
}
