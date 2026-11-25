import {
  ACTIVE_TASK_STATES,
  type DiscussionBrief,
  type DiscussionBriefEdit,
  type DiscussionCreate,
  type DiscussionDecide,
  type DiscussionOption,
  type DiscussionResponse,
  type DiscussionResponseCreate,
  type DiscussionWithdraw,
  type TaskDiscussionCreate,
  type EventType,
  type Me,
} from '@yoda/shared'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { forbidden, HttpError, invalidState, notFound } from '../auth/plugin.js'
import type { Tx } from '../db/client.js'
import { discussionResponses, discussions, projects, tasks, workItems } from '../db/schema.js'
import { queueIssueSync } from '../gitlab/sync.js'
import { createEntry } from '../knowledge/service.js'
import { notifyDiscussionEnded, notifyDiscussionRaised, notifyVotesReset } from '../notifications/service.js'
import { recordEvent, type WorkCtx } from '../work/context.js'
import { isPmOrAdmin, lockItem, progressWorkItem } from '../work/engine.js'
import { canSeeProject } from '../work/queries.js'
import { requireDiscussionVisible, toResponse, type DiscussionRow } from './queries.js'

/** A request that is well-formed but does not fit the data (unknown option, mismatched project). */
export const unprocessable = () => new HttpError(422, { error: 'invalid_state' })

export const isUndecided = (state: string) => state === 'open' || state === 'scheduled'

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
export async function recordDiscussionEvent(
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
 * A live-only discussion event (never stored, so the work item timeline is not flooded): pushed to whoever
 * may see the discussion (project members, or all staff for a department one; see stream.ts) so open views
 * refresh.
 */
function emitDiscussionLive(
  ctx: WorkCtx,
  d: Pick<DiscussionRow, 'projectId' | 'workItemId' | 'taskId'>,
  type: Extract<EventType, `discussion.${string}`>,
): void {
  ctx.emitted.push({
    type,
    projectId: d.projectId,
    workItemId: d.projectId ? d.workItemId : null,
    taskId: d.projectId ? d.taskId : null,
    conversationId: null,
    personId: null,
  })
}

/**
 * The brief's options changed (`prev` → `next`) under the discussion row lock: votes for an option that is
 * gone are deleted and each of their authors is told once. An option is gone when its key is no longer in
 * `next`; with `sameTitle` (an AI brief replacing the options, which re-keys them a, b, c, …) also when the
 * key now names an option with another title.
 */
export async function resetStaleVotes(
  ctx: WorkCtx,
  d: Pick<DiscussionRow, 'id' | 'projectId' | 'question'>,
  prev: DiscussionOption[],
  next: DiscussionOption[],
  opts: { sameTitle: boolean },
): Promise<void> {
  const kept = new Map(next.map((o) => [o.key, o.title.trim()]))
  const stale = prev
    .filter((o) => !kept.has(o.key) || (opts.sameTitle && kept.get(o.key) !== o.title.trim()))
    .map((o) => o.key)
  if (!stale.length) return
  const removed = await ctx.tx
    .delete(discussionResponses)
    .where(
      and(
        eq(discussionResponses.discussionId, d.id),
        eq(discussionResponses.kind, 'vote'),
        inArray(discussionResponses.optionKey, stale),
      ),
    )
    .returning({ authorId: discussionResponses.authorId })
  if (!removed.length) return
  await notifyVotesReset(ctx, d, removed.map((r) => r.authorId))
}

/**
 * Raises a discussion as `me` (staff). Links: `workItemId` (and optionally a `taskId` of that item) gives the
 * project; a given `projectId` must match it (422). The raiser must see the project (404 otherwise; any staff
 * for a department discussion). A linked work item is locked and must be active (409). With `requestBrief` on
 * an AI-enabled project the brief is left `pending` for the `discussion-brief` job (sent after commit); on a
 * no-AI project it fails at once with `no_ai` (the reason stays visible; people write the brief); without
 * `requestBrief` the given options become a ready, person-written brief.
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
    source: input.requestBrief ? 'ai' : 'person',
    status: wantsAi ? 'pending' : input.requestBrief ? 'failed' : 'ready',
    failReason: input.requestBrief && noAi ? 'no_ai' : null,
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
  if (brief.status === 'failed') await recordDiscussionEvent(ctx, d, 'discussion.brief_failed', { reason: 'no_ai' })
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

export async function lockDiscussion(tx: Tx, id: string): Promise<DiscussionRow> {
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
  emitDiscussionLive(ctx, d, 'discussion.responded')
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
  await resetStaleVotes(ctx, d, briefOptions(d), brief.options, { sameTitle: false })
}

/**
 * A brief pending this long has lost its job (queue outage, expired job): it may be retried. Longer than the
 * queue's worst case for one job: 3 attempts × 10 min expiry plus the retry delays (about 31 min).
 */
export const BRIEF_STUCK_MINUTES = 35

/**
 * `POST /discussions/:id/brief/retry`: the raiser, a PM or an admin asks the AI again for a failed brief (or
 * one pending for over BRIEF_STUCK_MINUTES since the discussion last changed) of an open / scheduled
 * discussion on an AI-enabled project (409 otherwise). The brief goes back to `pending`; the job is sent
 * after commit.
 */
export async function retryBrief(ctx: WorkCtx, me: Me, id: string): Promise<void> {
  const { tx } = ctx
  const ref = await visibleRef(tx, me, id)
  if (!(await canManage(tx, me, ref))) throw forbidden()
  const d = await lockDiscussion(tx, id)
  await requireDiscussionVisible(tx, me, d)
  if (!(await canManage(tx, me, d))) throw forbidden()
  const brief = d.brief as DiscussionBrief | null
  if (!isUndecided(d.state) || !brief) throw invalidState()
  if (brief.status === 'pending') {
    const [stuck] = await tx
      .select({ id: discussions.id })
      .from(discussions)
      .where(and(eq(discussions.id, id), sql`${discussions.updatedAt} < now() - make_interval(mins => ${BRIEF_STUCK_MINUTES})`))
    if (!stuck) throw invalidState()
  } else if (brief.status !== 'failed') throw invalidState()
  if (d.projectId) {
    const [project] = await tx.select({ noAi: projects.noAi }).from(projects).where(eq(projects.id, d.projectId))
    if (project?.noAi) throw invalidState()
  }
  const next: DiscussionBrief = { ...brief, source: 'ai', status: 'pending', failReason: null }
  await tx.update(discussions).set({ brief: next, updatedAt: sql`now()` }).where(eq(discussions.id, id))
  ctx.jobs.push({ name: 'discussion-brief', id })
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
 * Only an active task (proposed / open / in_progress / submitted) on the item's current step, else 409: a
 * finished task's step may already have advanced, and its discussion would hold a step it was not raised on.
 */
export async function raiseFromTask(ctx: WorkCtx, me: Me, taskId: string, input: TaskDiscussionCreate): Promise<string> {
  return raiseOnTask(ctx, me, taskId, input, { anyStaffMember: false })
}

/**
 * A runner's question (`ask_human`), raised as its owner with `raiseFromTask`'s rules except who may raise:
 * any staff member who sees the project (createDiscussion checks that), since an unattended runner's task has
 * no assignee and its owner need not be a PM. The caller has checked the owner's runner holds a live run on
 * the task; people always go through `raiseFromTask`.
 */
export async function raiseFromRunnerTask(ctx: WorkCtx, owner: Me, taskId: string, input: TaskDiscussionCreate): Promise<string> {
  return raiseOnTask(ctx, owner, taskId, input, { anyStaffMember: true })
}

async function raiseOnTask(
  ctx: WorkCtx,
  me: Me,
  taskId: string,
  input: TaskDiscussionCreate,
  o: { anyStaffMember: boolean },
): Promise<string> {
  const { tx } = ctx
  if (!me.isStaff) throw forbidden()
  const allowed = async () => {
    const [task] = await tx
      .select({
        workItemId: tasks.workItemId,
        projectId: tasks.projectId,
        assigneeId: tasks.assigneeId,
        state: tasks.state,
        stepKey: tasks.stepKey,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
    if (!task) throw notFound()
    if (o.anyStaffMember) {
      if (!(await canSeeProject(tx, me, task.projectId))) throw notFound()
    } else if (task.assigneeId !== me.id && !(await isPmOrAdmin(tx, me, task.projectId))) throw forbidden()
    return task
  }
  const ref = await allowed()
  const item = await lockItem(tx, ref.workItemId)
  const task = await allowed()
  const active = (ACTIVE_TASK_STATES as readonly string[]).includes(task.state)
  if (item.state !== 'active' || !active || task.stepKey !== item.currentStepKey) throw invalidState()
  return createDiscussion(ctx, me, { ...input, workItemId: task.workItemId, taskId })
}

/**
 * A runner's question is answered (decided or withdrawn): tasks parked on these discussions are offered to
 * runners again. Runs in the decide / withdraw transaction, which holds the work item lock, so no task locker
 * of the item (all take the item lock first) can interleave.
 */
async function unparkTasks(tx: Tx, discussionIds: string[]): Promise<void> {
  if (!discussionIds.length) return
  await tx
    .update(tasks)
    .set({ parkedDiscussionId: null, updatedAt: sql`now()` })
    .where(inArray(tasks.parkedDiscussionId, discussionIds))
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
    await unparkTasks(tx, [d.id])
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

/** Heading over AI-prepared brief content in a decision entry: it was never confirmed by a person. */
export const AI_BRIEF_HEADING = 'สรุปจาก AI (ยังไม่ได้ยืนยัน) / AI-prepared, unconfirmed'

/**
 * The confirmed decision entry: question, decision and chosen option are what people confirmed. A person's
 * brief keeps its context and recommendation; an AI brief's context, options and recommendation go under
 * AI_BRIEF_HEADING so they are not read as confirmed knowledge.
 */
export function decisionBody(d: Pick<DiscussionRow, 'question' | 'details' | 'brief'>, decision: string, option: DiscussionOption | null): string {
  const brief = d.brief as DiscussionBrief | null
  const parts = [
    `คำถาม: ${d.question}`,
    `ข้อสรุป: ${decision}`,
    option ? `ทางเลือกที่เลือก: ${option.title}` : '',
    d.details ? `รายละเอียด: ${d.details}` : '',
  ]
  if (brief?.source === 'ai') {
    const options = brief.options.map((o) =>
      [`- ${o.title}${o.key === brief.recommendedKey ? ' (แนะนำ)' : ''}`, o.pros ? `  ข้อดี: ${o.pros}` : '', o.cons ? `  ข้อเสีย: ${o.cons}` : '']
        .filter(Boolean)
        .join('\n'),
    )
    const ai = [
      brief.context ? `บริบท: ${brief.context}` : '',
      options.length ? `ทางเลือก:\n${options.join('\n')}` : '',
      brief.recommendation ? `ข้อเสนอแนะ: ${brief.recommendation}` : '',
    ].filter(Boolean)
    if (ai.length) parts.push(`## ${AI_BRIEF_HEADING}\n\n${ai.join('\n\n')}`)
  } else {
    parts.push(brief?.context ? `บริบท: ${brief.context}` : '', brief?.recommendation ? `ข้อเสนอแนะ: ${brief.recommendation}` : '')
  }
  return parts.filter(Boolean).join('\n\n')
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
  await unparkTasks(tx, [d.id])
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
  if (d.workItemId) {
    // Its decision goes into the work item's GitLab issues (deduplicated with the knowledge entry's request).
    await queueIssueSync(ctx, d.workItemId, { withIssues: true })
    await resumeAfterDiscussion(ctx, d.workItemId)
  }
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
  await unparkTasks(ctx.tx, [d.id])
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
