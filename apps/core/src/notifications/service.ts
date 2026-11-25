import type { Notification, NotificationKind, ProposalKind } from '@yoda/shared'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { notifications, people, projectMembers, workItems } from '../db/schema.js'
import type { WorkCtx } from '../work/context.js'

export type NotifyInput = {
  personId: string
  kind: NotificationKind
  title: string
  body: string
  link: string | null
  /** Notifications with the same key for the same person are created once. */
  dedupeKey: string | null
}

/**
 * Stores a notification (once per person and dedupe key) and, only when it was newly stored, queues a live
 * event addressed to that person. The event is published after the transaction commits (runWork).
 */
export async function notify(ctx: WorkCtx, input: NotifyInput): Promise<void> {
  const rows = await ctx.tx
    .insert(notifications)
    .values(input)
    .onConflictDoNothing({
      target: [notifications.personId, notifications.dedupeKey],
      where: sql`${notifications.dedupeKey} is not null`,
    })
    .returning({ id: notifications.id })
  if (!rows.length) return
  ctx.emitted.push({
    type: 'notification.created',
    projectId: null,
    workItemId: null,
    taskId: null,
    conversationId: null,
    personId: input.personId,
  })
}

async function workItemTitle(ctx: WorkCtx, workItemId: string): Promise<string> {
  const [row] = await ctx.tx.select({ title: workItems.title }).from(workItems).where(eq(workItems.id, workItemId))
  return row?.title ?? ''
}

/**
 * A task now belongs to `personId`. Staff get `task_assigned`; the requester (REQUESTER task) gets a
 * `request_update` asking for their action. One notification per task and person, however often it is assigned.
 */
export async function notifyTaskAssigned(
  ctx: WorkCtx,
  t: { taskId: string; workItemId: string; role: string; personId: string; taskTitle: string },
): Promise<void> {
  const itemTitle = await workItemTitle(ctx, t.workItemId)
  if (t.role === 'REQUESTER') {
    await notify(ctx, {
      personId: t.personId,
      kind: 'request_update',
      title: `รอการดำเนินการจากคุณ: ${t.taskTitle}`,
      body: itemTitle,
      link: `/todo/${t.taskId}`,
      dedupeKey: `request:${t.workItemId}:task:${t.taskId}`,
    })
    return
  }
  await notify(ctx, {
    personId: t.personId,
    kind: 'task_assigned',
    title: `คุณได้รับมอบหมายงาน: ${t.taskTitle}`,
    body: itemTitle,
    link: `/todo/${t.taskId}`,
    dedupeKey: `task:${t.taskId}`,
  })
}

/** The request's status changed (done / cancelled) for its requester. */
export async function notifyRequestEnded(
  ctx: WorkCtx,
  item: { id: string; title: string; requesterId: string | null },
  event: 'done' | 'cancelled',
): Promise<void> {
  if (!item.requesterId || item.requesterId === ctx.actorId) return
  await notify(ctx, {
    personId: item.requesterId,
    kind: 'request_update',
    title: event === 'done' ? 'คำขอของคุณเสร็จสมบูรณ์แล้ว' : 'คำขอของคุณถูกยกเลิก',
    body: item.title,
    link: '/requests',
    dedupeKey: `request:${item.id}:${event}`,
  })
}

export async function projectPms(ctx: WorkCtx, projectId: string): Promise<string[]> {
  const rows = await ctx.tx
    .select({ id: projectMembers.personId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), sql`'PM' = any(${projectMembers.roles})`))
  return rows.map((r) => r.id)
}

async function admins(ctx: WorkCtx): Promise<string[]> {
  const rows = await ctx.tx.select({ id: people.id }).from(people).where(eq(people.isAdmin, true))
  return rows.map((r) => r.id)
}

/** PMs of any project: they may decide project-less proposals (as PM of the project they choose). */
async function anyProjectPms(ctx: WorkCtx): Promise<string[]> {
  const rows = await ctx.tx
    .selectDistinct({ id: projectMembers.personId })
    .from(projectMembers)
    .where(sql`'PM' = any(${projectMembers.roles})`)
  return rows.map((r) => r.id)
}

/** A requester asked for changes on their delivery: the project's PMs hear about it. */
export async function notifyChangesRequested(
  ctx: WorkCtx,
  t: { projectId: string; workItemId: string; taskId: string; comment: string },
): Promise<void> {
  const itemTitle = await workItemTitle(ctx, t.workItemId)
  for (const personId of await projectPms(ctx, t.projectId)) {
    await notify(ctx, {
      personId,
      kind: 'request_update',
      title: `ผู้ขอขอให้แก้ไข: ${itemTitle}`,
      body: t.comment,
      link: `/work-items/${t.workItemId}`,
      dedupeKey: `request:${t.workItemId}:changes:${t.taskId}`,
    })
  }
}

/**
 * An `auto-assign` guard rail (G2 repeated rework, G6 daily cap) turned an automatic assignment into a
 * proposed one: the project's PMs confirm it. `reason` is the guard's plain-language (Thai) text.
 */
export async function notifyTaskProposed(
  ctx: WorkCtx,
  t: { projectId: string; workItemId: string; taskId: string; taskTitle: string; reason: string },
): Promise<void> {
  for (const personId of await projectPms(ctx, t.projectId)) {
    await notify(ctx, {
      personId,
      kind: 'proposal_pending',
      title: `รอยืนยันการมอบหมายงาน: ${t.taskTitle}`,
      body: t.reason,
      link: `/work-items/${t.workItemId}`,
      dedupeKey: `task-proposed:${t.taskId}`,
    })
  }
}

const PROPOSAL_TITLE: Record<ProposalKind, string> = {
  step_advance: 'รอยืนยันการไปขั้นตอนถัดไป',
  priority_change: 'รอยืนยันการเปลี่ยนความสำคัญ',
  create_work_item: 'รอยืนยันการสร้างงานใหม่',
  raise_discussion: 'รอยืนยันการยกประเด็นหารือ',
}

/**
 * Deciders of a new proposal: the project's PMs (admins when it has none); for project-less ones, every
 * admin and every PM of any project (each may decide it). One notification per person and proposal.
 */
export async function notifyProposalPending(
  ctx: WorkCtx,
  p: {
    id: string
    projectId: string | null
    workItemId: string | null
    kind: ProposalKind
    summary: string
    /** Plain-language reason a guard rail asked the PM (empty otherwise). */
    reason?: string
    onBehalfOf: string | null
  },
): Promise<void> {
  // Step advances and priority changes carry no summary of their own: the work item title says what it is about.
  const itemTitle = p.workItemId ? await workItemTitle(ctx, p.workItemId) : ''
  const body = [itemTitle, p.summary, p.reason ? `เหตุผล: ${p.reason}` : ''].filter(Boolean).join(' - ')
  let recipients: string[]
  if (p.projectId) {
    recipients = await projectPms(ctx, p.projectId)
    if (!recipients.length) recipients = await admins(ctx)
  } else {
    recipients = [...(await admins(ctx)), ...(await anyProjectPms(ctx))]
  }
  for (const personId of [...new Set(recipients)].sort()) {
    if (personId === p.onBehalfOf) continue
    await notify(ctx, {
      personId,
      kind: 'proposal_pending',
      title: PROPOSAL_TITLE[p.kind],
      body,
      link: '/todo',
      dedupeKey: `proposal:${p.id}`,
    })
  }
}

/** Of `ids`, the staff who may still see a discussion of `projectId` (null: a department discussion). */
async function staffWhoSee(ctx: WorkCtx, ids: string[], projectId: string | null): Promise<string[]> {
  if (!ids.length) return []
  const rows = await ctx.tx
    .select({ id: people.id })
    .from(people)
    .where(
      and(
        inArray(people.id, ids),
        sql`(${people.isAdmin} or coalesce(${people.staffOverride}, ${people.lastSeenStaff}))`,
        projectId
          ? sql`(${people.isAdmin} or exists (select 1 from ${projectMembers} where ${projectMembers.projectId} = ${projectId} and ${projectMembers.personId} = ${people.id}))`
          : undefined,
      ),
    )
  return rows.map((r) => r.id).sort()
}

type DiscussionRef = { id: string; projectId: string | null; question: string }

/**
 * A new discussion: its deciders hear about it, the project's PMs (admins when it has none); admins for a
 * department discussion. Not the raiser themself.
 */
export async function notifyDiscussionRaised(ctx: WorkCtx, d: DiscussionRef & { raisedBy: string }): Promise<void> {
  // The admin fallback applies when no PM other than the raiser is left (e.g. the sole PM raised it).
  const others = (ids: string[]) => [...new Set(ids)].filter((id) => id !== d.raisedBy)
  let ids = others(d.projectId ? await projectPms(ctx, d.projectId) : [])
  if (!ids.length) ids = others(await admins(ctx))
  for (const personId of await staffWhoSee(ctx, ids, d.projectId)) {
    await notify(ctx, {
      personId,
      kind: 'discussion',
      title: 'มีประเด็นหารือใหม่',
      body: d.question,
      link: `/discussions/${d.id}`,
      dedupeKey: `discussion:${d.id}:raised`,
    })
  }
}

/**
 * A discussion was decided or withdrawn: the raiser and everyone who responded hear about it (not whoever
 * decided / withdrew it). `text` is the decision or the withdrawal reason.
 */
export async function notifyDiscussionEnded(
  ctx: WorkCtx,
  event: 'decided' | 'withdrawn',
  d: DiscussionRef & { raisedBy: string; text: string; responders: string[] },
): Promise<void> {
  const ids = [...new Set([d.raisedBy, ...d.responders])].filter((id) => id !== ctx.actorId)
  for (const personId of await staffWhoSee(ctx, ids, d.projectId)) {
    await notify(ctx, {
      personId,
      kind: 'discussion',
      title: event === 'decided' ? `ได้ข้อสรุปแล้ว: ${d.question}` : `ประเด็นหารือถูกถอน: ${d.question}`,
      body: d.text,
      link: `/discussions/${d.id}`,
      dedupeKey: `discussion:${d.id}:${event}`,
    })
  }
}

/**
 * The brief changed and these voters' options are gone: each is told once per reset (not whoever changed
 * the brief). The dedupe key carries the reset time, so a later reset tells them again.
 */
export async function notifyVotesReset(ctx: WorkCtx, d: DiscussionRef, voters: string[]): Promise<void> {
  const ids = [...new Set(voters)].filter((id) => id !== ctx.actorId)
  if (!ids.length) return
  const [now] = await ctx.tx.execute<{ at: string }>(sql`select to_char(now() at time zone 'UTC', 'YYYYMMDDHH24MISSUS') as at`)
  for (const personId of await staffWhoSee(ctx, ids, d.projectId)) {
    await notify(ctx, {
      personId,
      kind: 'discussion',
      title: `ทางเลือกที่คุณโหวตถูกเปลี่ยน: ${d.question}`,
      body: 'ทางเลือกในบทสรุปถูกแก้ไขหรือนำออก คะแนนเสียงของคุณถูกล้าง กรุณาโหวตใหม่',
      link: `/discussions/${d.id}`,
      dedupeKey: `discussion:${d.id}:vote-reset:${now!.at}`,
    })
  }
}

type Row = typeof notifications.$inferSelect

const toNotification = (r: Row): Notification => ({
  id: r.id,
  kind: r.kind as NotificationKind,
  title: r.title,
  body: r.body,
  link: r.link,
  readAt: r.readAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
})

/** The person's newest 50 notifications (only unread ones with `unread`). */
export async function listNotifications(db: Db, personId: string, unread: boolean): Promise<Notification[]> {
  const rows = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.personId, personId), unread ? isNull(notifications.readAt) : undefined))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(50)
  return rows.map(toNotification)
}

/** Marks the person's own notifications read (other people's ids are ignored). Returns how many changed. */
export async function markRead(db: Db, personId: string, sel: { ids?: string[]; all?: boolean }): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(
      and(
        eq(notifications.personId, personId),
        isNull(notifications.readAt),
        sel.all ? undefined : inArray(notifications.id, sel.ids ?? []),
      ),
    )
    .returning({ id: notifications.id })
  return rows.length
}
