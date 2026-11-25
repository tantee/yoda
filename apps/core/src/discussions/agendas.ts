import type { Agenda, AgendaCreate, AgendaItemsPut, DiscussionState, Me, Priority } from '@yoda/shared'
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { forbidden, notFound } from '../auth/plugin.js'
import type { Db, Tx } from '../db/client.js'
import { agendas, discussions, projectMembers, projects } from '../db/schema.js'
import type { WorkCtx } from '../work/context.js'
import { requireDiscussionVisible, visibleTo } from './queries.js'
import { isUndecided, unprocessable, recordDiscussionEvent } from './service.js'

type Conn = Db | Tx
type AgendaRow = typeof agendas.$inferSelect

/** Editors: admins and PMs of any project. Everyone else on staff only views. */
export async function canEditAgendas(db: Conn, me: Me): Promise<boolean> {
  if (me.isAdmin) return true
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(projectMembers)
    .where(and(eq(projectMembers.personId, me.id), sql`'PM' = any(${projectMembers.roles})`))
    .limit(1)
  return !!row
}

async function loadAgendas(db: Conn, me: Me, rows: AgendaRow[]): Promise<Agenda[]> {
  if (!rows.length) return []
  const items = await db
    .select({
      agendaId: discussions.agendaId,
      discussionId: discussions.id,
      position: discussions.agendaPosition,
      question: discussions.question,
      projectName: projects.name,
      state: discussions.state,
      priority: discussions.priority,
    })
    .from(discussions)
    .leftJoin(projects, eq(projects.id, discussions.projectId))
    .where(and(inArray(discussions.agendaId, rows.map((r) => r.id)), visibleTo(me)))
    .orderBy(asc(discussions.agendaPosition), asc(discussions.id))
  return rows.map((a) => ({
    id: a.id,
    title: a.title,
    meetingAt: a.meetingAt.toISOString(),
    createdById: a.createdBy,
    items: items
      .filter((i) => i.agendaId === a.id)
      .map((i, n) => ({
        discussionId: i.discussionId,
        position: i.position ?? n,
        question: i.question,
        projectName: i.projectName,
        state: i.state as DiscussionState,
        priority: i.priority as Priority,
      })),
    createdAt: a.createdAt.toISOString(),
  }))
}

/** Agendas with the discussions `me` can see; `upcoming` = meeting not yet past, soonest first (else newest first). */
export async function listAgendas(db: Conn, me: Me, upcoming: boolean): Promise<Agenda[]> {
  const rows = upcoming
    ? await db.select().from(agendas).where(gte(agendas.meetingAt, sql`now()`)).orderBy(asc(agendas.meetingAt), asc(agendas.id))
    : await db.select().from(agendas).orderBy(desc(agendas.meetingAt), asc(agendas.id))
  return loadAgendas(db, me, rows)
}

export async function getAgenda(db: Conn, me: Me, id: string): Promise<Agenda> {
  const [row] = await db.select().from(agendas).where(eq(agendas.id, id))
  if (!row) throw notFound()
  return (await loadAgendas(db, me, [row]))[0]!
}

export async function createAgenda(tx: Tx, me: Me, input: AgendaCreate): Promise<string> {
  if (!(await canEditAgendas(tx, me))) throw forbidden()
  const [row] = await tx
    .insert(agendas)
    .values({ title: input.title, meetingAt: new Date(input.meetingAt), createdBy: me.id })
    .returning({ id: agendas.id })
  return row!.id
}

async function lockAgenda(tx: Tx, id: string): Promise<AgendaRow> {
  const [row] = await tx.select().from(agendas).where(eq(agendas.id, id)).for('update')
  if (!row) throw notFound()
  return row
}

/**
 * Lock order: agenda row, then discussion rows ordered by id. Never a work item lock (decide/withdraw take
 * work item -> discussion), so the two paths only ever meet on discussion rows and cannot form a cycle.
 */
async function lockDiscussions(tx: Tx, ids: string[]) {
  if (!ids.length) return []
  return tx.select().from(discussions).where(inArray(discussions.id, ids)).orderBy(asc(discussions.id)).for('update')
}

/**
 * Sets the agenda's ordered list. Listed discussions must be visible to the editor (404) and open/scheduled
 * (422; checked under lock, so a discussion decided meanwhile changes nothing); they get this agenda, their
 * index and `scheduled` (moving from another agenda if need be). Undecided ones previously on the agenda but
 * not listed go back to `open`. Items the editor cannot see, and decided/withdrawn ones, are left in place
 * and sort after the listed ones.
 */
export async function putAgendaItems(ctx: WorkCtx, me: Me, id: string, input: AgendaItemsPut): Promise<void> {
  const { tx } = ctx
  if (!(await canEditAgendas(tx, me))) throw forbidden()
  if (new Set(input.discussionIds).size !== input.discussionIds.length) throw unprocessable()
  await lockAgenda(tx, id)
  const current = await tx.select({ id: discussions.id }).from(discussions).where(eq(discussions.agendaId, id))
  const ids = [...new Set([...current.map((c) => c.id), ...input.discussionIds])]
  const rows = await lockDiscussions(tx, ids)
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const did of input.discussionIds) {
    const d = byId.get(did)
    if (!d) throw notFound()
    await requireDiscussionVisible(tx, me, d)
    if (!isUndecided(d.state)) throw unprocessable()
  }
  const listed = new Set(input.discussionIds)
  const kept: typeof rows = []
  for (const d of rows) {
    if (listed.has(d.id) || d.agendaId !== id) continue
    const visible = await requireDiscussionVisible(tx, me, d).then(() => true, () => false)
    if (!visible || !isUndecided(d.state)) kept.push(d)
    else await tx.update(discussions).set({ state: 'open', agendaId: null, agendaPosition: null, updatedAt: sql`now()` }).where(eq(discussions.id, d.id))
  }
  for (const [index, did] of input.discussionIds.entries()) {
    const d = byId.get(did)!
    await tx.update(discussions).set({ state: 'scheduled', agendaId: id, agendaPosition: index, updatedAt: sql`now()` }).where(eq(discussions.id, did))
    if (d.agendaId !== id) await recordDiscussionEvent(ctx, d, 'discussion.scheduled', { payload: { agendaId: id } })
  }
  kept.sort((a, b) => (a.agendaPosition ?? 0) - (b.agendaPosition ?? 0))
  for (const [n, d] of kept.entries()) {
    await tx.update(discussions).set({ agendaPosition: input.discussionIds.length + n }).where(eq(discussions.id, d.id))
  }
}

/**
 * Deletes the agenda. Undecided discussions on it return to `open`; decided/withdrawn ones keep their state
 * (their agenda link is cleared, as the agenda is gone).
 */
export async function deleteAgenda(tx: Tx, me: Me, id: string): Promise<void> {
  if (!(await canEditAgendas(tx, me))) throw forbidden()
  await lockAgenda(tx, id)
  const current = await tx.select({ id: discussions.id }).from(discussions).where(eq(discussions.agendaId, id))
  const rows = await lockDiscussions(tx, current.map((c) => c.id))
  for (const d of rows) {
    if (d.agendaId !== id) continue
    await tx
      .update(discussions)
      .set({ agendaId: null, agendaPosition: null, updatedAt: sql`now()`, ...(isUndecided(d.state) ? { state: 'open' } : {}) })
      .where(eq(discussions.id, d.id))
  }
  await tx.delete(agendas).where(eq(agendas.id, id))
}
