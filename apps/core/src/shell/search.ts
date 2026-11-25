import { SEARCH_LIMIT, SearchResult, type Me } from '@yoda/shared'
import { and, asc, desc, eq, ilike, inArray, or, sql, type AnyColumn, type SQL } from 'drizzle-orm'
import type { Db, Tx } from '../db/client.js'
import { people, projectMembers, projects, workItems } from '../db/schema.js'

type Conn = Db | Tx

/** `%q%` with LIKE wildcards (and the escape character) taken literally. */
export function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** Prefix matches first. */
const prefixFirst = (col: AnyColumn, q: string) =>
  desc(sql`${col} ilike ${containsPattern(q).slice(1)}`)

/**
 * The jump box. Matches titles and names (case-insensitive substring), scoped like the pages they open:
 * - staff: projects they can see (admins: all), work items of those projects, and staff people;
 * - requesters: only work items they asked for, opened as their request.
 * At most SEARCH_LIMIT results: up to 3 projects and 3 people, work items fill the rest.
 */
export async function search(db: Conn, me: Me, q: string): Promise<SearchResult[]> {
  const pattern = containsPattern(q)
  if (!me.isStaff) {
    const rows = await db
      .select({ id: workItems.id, title: workItems.title, projectName: projects.name })
      .from(workItems)
      .innerJoin(projects, eq(projects.id, workItems.projectId))
      .where(and(eq(workItems.requesterId, me.id), ilike(workItems.title, pattern)))
      .orderBy(prefixFirst(workItems.title, q), desc(workItems.updatedAt), asc(workItems.id))
      .limit(SEARCH_LIMIT)
    return rows.map((r) => SearchResult.parse({ type: 'request', id: r.id, title: r.title, subtitle: r.projectName, route: `/requests/${r.id}` }))
  }

  const visibleProject = (col: typeof projects.id | typeof workItems.projectId): SQL | undefined =>
    me.isAdmin
      ? undefined
      : inArray(col, db.select({ id: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.personId, me.id)))

  const isStaff = sql`(${people.isAdmin} or coalesce(${people.staffOverride}, ${people.lastSeenStaff}))`
  const [projectRows, personRows, itemRows] = await Promise.all([
    db
      .select({ id: projects.id, name: projects.name, status: projects.status })
      .from(projects)
      .where(and(visibleProject(projects.id), ilike(projects.name, pattern)))
      .orderBy(prefixFirst(projects.name, q), asc(projects.name), asc(projects.id))
      .limit(3),
    db
      .select({ id: people.id, displayName: people.displayName, username: people.username })
      .from(people)
      .where(and(isStaff, or(ilike(people.displayName, pattern), ilike(people.username, pattern))))
      .orderBy(asc(people.displayName), asc(people.id))
      .limit(3),
    db
      .select({ id: workItems.id, title: workItems.title, projectName: projects.name })
      .from(workItems)
      .innerJoin(projects, eq(projects.id, workItems.projectId))
      .where(and(visibleProject(workItems.projectId), ilike(workItems.title, pattern)))
      .orderBy(prefixFirst(workItems.title, q), desc(workItems.updatedAt), asc(workItems.id))
      .limit(SEARCH_LIMIT),
  ])
  const itemRoom = SEARCH_LIMIT - projectRows.length - personRows.length
  return [
    ...projectRows.map((r) => ({ type: 'project' as const, id: r.id, title: r.name, subtitle: null, route: `/projects/${r.id}` })),
    ...itemRows.slice(0, itemRoom).map((r) => ({
      type: 'work_item' as const,
      id: r.id,
      title: r.title,
      subtitle: r.projectName,
      route: `/work-items/${r.id}`,
    })),
    // There is no person page yet: admins land on People, other staff on the department status.
    ...personRows.map((r) => ({
      type: 'person' as const,
      id: r.id,
      title: r.displayName,
      subtitle: r.username,
      route: me.isAdmin ? '/admin/people' : '/status',
    })),
  ].map((r) => SearchResult.parse(r))
}
