import type { Discussion, DiscussionBrief, DiscussionResponse, DiscussionResponseKind, DiscussionState, Me, Priority } from '@yoda/shared'
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { notFound } from '../auth/plugin.js'
import type { Db, Tx } from '../db/client.js'
import { discussionResponses, discussions, people, projectMembers, projects, workItems } from '../db/schema.js'
import { canSeeProject } from '../work/queries.js'

type Conn = Db | Tx
export type DiscussionRow = typeof discussions.$inferSelect

export type DiscussionListQuery = {
  state?: DiscussionState
  projectId?: string
  sort?: 'priority' | 'created' | 'project'
}

const raiser = alias(people, 'raiser')
const decider = alias(people, 'decider')

const priorityRank = sql`case ${discussions.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`

/**
 * Discussions are staff-only (routes refuse requesters first). A project discussion is visible to whoever can
 * see the project (admins, members); a department discussion (no project) to all staff. 404 otherwise.
 */
export async function requireDiscussionVisible(db: Conn, me: Me, row: Pick<DiscussionRow, 'projectId'>): Promise<void> {
  if (!me.isStaff) throw notFound()
  if (row.projectId && !(await canSeeProject(db, me, row.projectId))) throw notFound()
}

/** The discussion row, 404 unless it exists and `me` may see it. */
export async function visibleDiscussionRow(db: Conn, me: Me, id: string): Promise<DiscussionRow> {
  const [row] = await db.select().from(discussions).where(eq(discussions.id, id))
  if (!row) throw notFound()
  await requireDiscussionVisible(db, me, row)
  return row
}

/** Rows `me` may see: department discussions and those of projects `me` belongs to (admins: all). */
function visibleTo(me: Me): SQL | undefined {
  if (me.isAdmin) return undefined
  return or(
    isNull(discussions.projectId),
    sql`exists (select 1 from ${projectMembers} where ${projectMembers.projectId} = ${discussions.projectId} and ${projectMembers.personId} = ${me.id})`,
  )
}

async function select(db: Conn, me: Me, where: SQL | undefined, order: SQL[]): Promise<Discussion[]> {
  const rows = await db
    .select({
      d: discussions,
      projectName: projects.name,
      workItemTitle: workItems.title,
      raisedByName: raiser.displayName,
      decidedByName: decider.displayName,
    })
    .from(discussions)
    .leftJoin(projects, eq(projects.id, discussions.projectId))
    .leftJoin(workItems, eq(workItems.id, discussions.workItemId))
    .innerJoin(raiser, eq(raiser.id, discussions.raisedBy))
    .leftJoin(decider, eq(decider.id, discussions.decidedBy))
    .where(where)
    .orderBy(...order)
  if (!rows.length) return []
  const ids = rows.map((r) => r.d.id)
  const counts = await db
    .select({
      discussionId: discussionResponses.discussionId,
      kind: discussionResponses.kind,
      optionKey: discussionResponses.optionKey,
      n: sql<number>`count(*)::int`,
      mine: sql<boolean>`bool_or(${discussionResponses.authorId} = ${me.id})`,
    })
    .from(discussionResponses)
    .where(inArray(discussionResponses.discussionId, ids))
    .groupBy(discussionResponses.discussionId, discussionResponses.kind, discussionResponses.optionKey)
  const stats = new Map<string, { votes: Record<string, number>; myVote: string | null; total: number }>()
  for (const c of counts) {
    const s = stats.get(c.discussionId) ?? { votes: {}, myVote: null, total: 0 }
    s.total += c.n
    if (c.kind === 'vote' && c.optionKey) {
      s.votes[c.optionKey] = c.n
      if (c.mine) s.myVote = c.optionKey
    }
    stats.set(c.discussionId, s)
  }
  return rows.map(({ d, ...names }) => {
    const s = stats.get(d.id)
    return {
      id: d.id,
      projectId: d.projectId,
      projectName: names.projectName,
      workItemId: d.workItemId,
      workItemTitle: names.workItemTitle,
      taskId: d.taskId,
      stepKey: d.stepKey,
      question: d.question,
      details: d.details,
      priority: d.priority as Priority,
      state: d.state as DiscussionState,
      brief: (d.brief as DiscussionBrief | null) ?? null,
      raisedById: d.raisedBy,
      raisedByName: names.raisedByName,
      decision: d.decision,
      decidedOptionKey: d.decidedOptionKey,
      decidedById: d.decidedBy,
      decidedByName: names.decidedByName,
      decidedAt: d.decidedAt?.toISOString() ?? null,
      agendaId: d.agendaId,
      voteCounts: s?.votes ?? {},
      myVote: s?.myVote ?? null,
      responseCount: s?.total ?? 0,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    }
  })
}

/** 404 unless visible. */
export async function getDiscussion(db: Conn, me: Me, id: string): Promise<Discussion> {
  await visibleDiscussionRow(db, me, id)
  const [d] = await select(db, me, eq(discussions.id, id), [])
  if (!d) throw notFound()
  return d
}

/**
 * Visible discussions; by default the open and scheduled ones. A `projectId` the caller cannot see → 404.
 * Sorts: `priority` (default: priority, then oldest first), `created` (newest first), `project` (project
 * name with department discussions first, then priority and age).
 */
export async function listDiscussions(db: Conn, me: Me, q: DiscussionListQuery): Promise<Discussion[]> {
  if (q.projectId && !(await canSeeProject(db, me, q.projectId))) throw notFound()
  const where = and(
    q.state ? eq(discussions.state, q.state) : inArray(discussions.state, ['open', 'scheduled']),
    q.projectId ? eq(discussions.projectId, q.projectId) : undefined,
    visibleTo(me),
  )
  const byAge = [asc(discussions.createdAt), asc(discussions.id)]
  const order =
    q.sort === 'created'
      ? [desc(discussions.createdAt), desc(discussions.id)]
      : q.sort === 'project'
        ? [sql`${projects.name} asc nulls first`, asc(discussions.projectId), priorityRank, ...byAge]
        : [priorityRank, ...byAge]
  return select(db, me, where, order)
}

/** Oldest first; 404 unless the discussion is visible. */
export async function listResponses(db: Conn, me: Me, id: string): Promise<DiscussionResponse[]> {
  await visibleDiscussionRow(db, me, id)
  const rows = await db
    .select({ r: discussionResponses, authorName: people.displayName })
    .from(discussionResponses)
    .innerJoin(people, eq(people.id, discussionResponses.authorId))
    .where(eq(discussionResponses.discussionId, id))
    .orderBy(asc(discussionResponses.createdAt), asc(discussionResponses.id))
  return rows.map(({ r, authorName }) => toResponse(r, authorName))
}

export function toResponse(r: typeof discussionResponses.$inferSelect, authorName: string): DiscussionResponse {
  return {
    id: r.id,
    discussionId: r.discussionId,
    authorId: r.authorId,
    authorName,
    kind: r.kind as DiscussionResponseKind,
    optionKey: r.optionKey,
    text: r.text,
    createdAt: r.createdAt.toISOString(),
  }
}
