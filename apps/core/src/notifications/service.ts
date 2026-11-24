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
      link: `/work-items/${t.workItemId}`,
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
    link: `/work-items/${item.id}`,
    dedupeKey: `request:${item.id}:${event}`,
  })
}

async function projectPms(ctx: WorkCtx, projectId: string): Promise<string[]> {
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

const PROPOSAL_TITLE: Record<ProposalKind, string> = {
  step_advance: 'รอยืนยันการไปขั้นตอนถัดไป',
  priority_change: 'รอยืนยันการเปลี่ยนความสำคัญ',
  create_work_item: 'รอยืนยันการสร้างงานใหม่',
}

/** Deciders of a new proposal: the project's PMs (admins when it has none, and for project-less ones). */
export async function notifyProposalPending(
  ctx: WorkCtx,
  p: { id: string; projectId: string | null; kind: ProposalKind; summary: string; onBehalfOf: string | null },
): Promise<void> {
  let recipients = p.projectId ? await projectPms(ctx, p.projectId) : []
  if (!recipients.length) recipients = await admins(ctx)
  for (const personId of recipients) {
    if (personId === p.onBehalfOf) continue
    await notify(ctx, {
      personId,
      kind: 'proposal_pending',
      title: PROPOSAL_TITLE[p.kind],
      body: p.summary,
      link: '/todo',
      dedupeKey: `proposal:${p.id}`,
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
