import type { Me } from '@yoda/shared'
import { AppUrlsPut, MemberRolesPut, Project, ProjectCreate, ProjectDetail, ProjectListItem, ProjectPatch } from '@yoda/shared'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { forbidden, lastPm, notStaff, notFound, requireAdmin, requireStaff } from '../auth/plugin.js'
import type { Db, Tx } from '../db/client.js'
import { people, projectMembers, projects } from '../db/schema.js'
import { canManageProject, lockProject } from '../projects/access.js'
import { listAppUrls, replaceAppUrls } from '../projects/app-urls.js'
import { canSeeProject } from '../work/queries.js'
import { runWork } from '../work/context.js'
import { resumeProjectAi, unassignMemberTasks } from '../work/engine.js'

type ProjectRow = typeof projects.$inferSelect

const toProject = (row: ProjectRow): Project =>
  Project.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    noAi: row.noAi,
    autonomy: row.autonomy,
    aiBudgetUsd: row.aiBudgetUsd === null ? null : Number(row.aiBudgetUsd),
    createdAt: row.createdAt.toISOString(),
  })

async function loadDetail(db: Db | Tx, id: string): Promise<ProjectDetail | null> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id))
  if (!row) return null
  const members = await db
    .select({
      personId: projectMembers.personId,
      displayName: people.displayName,
      roles: projectMembers.roles,
    })
    .from(projectMembers)
    .innerJoin(people, eq(people.id, projectMembers.personId))
    .where(eq(projectMembers.projectId, id))
    .orderBy(asc(people.displayName), asc(people.id))
  return ProjectDetail.parse({ ...toProject(row), members })
}

/**
 * Outstanding staff tasks per person across all projects, in one grouped query: assigned and open or in
 * progress, plus proposed to them. People without any are absent.
 */
async function openTaskCounts(db: Db, personIds: string[]): Promise<Map<string, number>> {
  if (!personIds.length) return new Map()
  const ids = sql.join(personIds.map((id) => sql`${id}::uuid`), sql`, `)
  const rows = await db.execute<{ person_id: string; n: number }>(sql`
    SELECT person_id, count(*)::int AS n FROM (
      SELECT t.assignee_id AS person_id FROM tasks t
        WHERE t.role <> 'REQUESTER' AND t.superseded_at IS NULL AND t.state IN ('open', 'in_progress')
          AND t.assignee_id IN (${ids})
      UNION ALL
      SELECT t.proposed_assignee_id FROM tasks t
        WHERE t.role <> 'REQUESTER' AND t.superseded_at IS NULL AND t.state = 'proposed'
          AND t.proposed_assignee_id IN (${ids})
    ) x GROUP BY person_id
  `)
  return new Map(rows.map((r) => [r.person_id, r.n]))
}

/**
 * PM names, member counts and newest event time of `rows`, for the projects list: one query for the members, one
 * for the last activity (a max per project, answered from `events_project_created_idx`).
 */
async function listExtras(db: Db, rows: ProjectRow[]): Promise<ProjectListItem[]> {
  const ids = rows.map((r) => r.id)
  if (!ids.length) return []
  const inIds = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)
  const [members, last] = await Promise.all([
    db
      .select({ projectId: projectMembers.projectId, name: people.displayName, roles: projectMembers.roles })
      .from(projectMembers)
      .innerJoin(people, eq(people.id, projectMembers.personId))
      .where(sql`${projectMembers.projectId} in (${inIds})`)
      .orderBy(asc(people.displayName), asc(people.id)),
    db.execute<{ project_id: string; at: string | Date | null }>(sql`
      SELECT p.id AS project_id, (SELECT max(e.created_at) FROM events e WHERE e.project_id = p.id) AS at
      FROM unnest(ARRAY[${inIds}]) AS p(id)
    `),
  ])
  const byProject = new Map<string, { pms: string[]; count: number }>()
  for (const m of members) {
    const g = byProject.get(m.projectId) ?? { pms: [], count: 0 }
    g.count++
    if (m.roles.includes('PM')) g.pms.push(m.name)
    byProject.set(m.projectId, g)
  }
  const lastAt = new Map(last.map((r) => [r.project_id, r.at === null ? null : new Date(r.at).toISOString()]))
  return rows.map((row) =>
    ProjectListItem.parse({
      ...toProject(row),
      pmNames: byProject.get(row.id)?.pms ?? [],
      memberCount: byProject.get(row.id)?.count ?? 0,
      lastActivityAt: lastAt.get(row.id) ?? null,
    }),
  )
}

const ProjectParams = z.object({ id: z.string().uuid() })
const MemberParams = z.object({ id: z.string().uuid(), personId: z.string().uuid() })

/** True if `personId` is a PM and no other PM exists while other members remain. */
async function isLastPm(tx: Tx, projectId: string, personId: string): Promise<boolean> {
  const members = await tx
    .select({ personId: projectMembers.personId, roles: projectMembers.roles })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId))
  const others = members.filter((m) => m.personId !== personId)
  return others.length > 0 && !others.some((m) => m.roles.includes('PM'))
}

export function projectRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db

  app.get('/projects', async (request) => {
    requireStaff(request)
    const me = request.me
    const rows = me.isAdmin
      ? await db().select().from(projects).orderBy(asc(projects.name))
      : await db()
          .select({ p: projects })
          .from(projects)
          .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
          .where(eq(projectMembers.personId, me.id))
          .orderBy(asc(projects.name))
          .then((r) => r.map((x) => x.p))
    return listExtras(db(), rows)
  })

  app.post('/projects', async (request, reply) => {
    requireAdmin(request)
    const body = ProjectCreate.parse(request.body)
    const [row] = await db()
      .insert(projects)
      .values({ name: body.name, description: body.description, createdBy: request.me.id })
      .returning()
    if (!row) throw new Error('insert returned no row')
    return reply.status(201).send(toProject(row))
  })

  app.get('/projects/:id', async (request) => {
    requireStaff(request)
    const { id } = ProjectParams.parse(request.params)
    const detail = await loadDetail(db(), id)
    if (!detail) throw notFound()
    const me = request.me
    if (!me.isAdmin && !detail.members.some((m) => m.personId === me.id)) throw notFound()
    const load = await openTaskCounts(db(), detail.members.map((m) => m.personId))
    return { ...detail, members: detail.members.map((m) => ({ ...m, openTasks: load.get(m.personId) ?? 0 })) }
  })

  app.put('/projects/:id/members/:personId', async (request) => {
    requireStaff(request)
    const { id, personId } = MemberParams.parse(request.params)
    const { roles } = MemberRolesPut.parse(request.body)
    await requireManage(request, id)
    // runWork so task.unassigned events (roles dropped) are published after commit.
    return runWork(app.deps, { id: request.me.id, kind: 'person' }, async (ctx) => {
      const { tx } = ctx
      await lockProject(tx, id)
      // Re-check under the lock: the caller may have been demoted or removed meanwhile.
      if (!(await canManageProject(tx, request.me, id))) throw forbidden()
      const [person] = await tx
        .select({
          isAdmin: people.isAdmin,
          staffOverride: people.staffOverride,
          lastSeenStaff: people.lastSeenStaff,
        })
        .from(people)
        .where(eq(people.id, personId))
      if (!person) throw notFound()
      if (!(person.isAdmin || (person.staffOverride ?? person.lastSeenStaff))) throw notStaff()
      const [current] = await tx
        .select({ roles: projectMembers.roles })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, id), eq(projectMembers.personId, personId)))
      if (!roles.includes('PM') && current?.roles.includes('PM') && (await isLastPm(tx, id, personId))) throw lastPm()
      await tx
        .insert(projectMembers)
        .values({ projectId: id, personId, roles })
        .onConflictDoUpdate({
          target: [projectMembers.projectId, projectMembers.personId],
          set: { roles },
        })
      // Roles taken away: their active tasks in those roles go back to the PM (after the update, like removal).
      const dropped = (current?.roles ?? []).filter((r) => !(roles as string[]).includes(r))
      if (dropped.length) await unassignMemberTasks(ctx, id, personId, dropped)
      const detail = await loadDetail(tx, id)
      if (!detail) throw notFound()
      return detail
    })
  })

  app.delete('/projects/:id/members/:personId', async (request, reply) => {
    requireStaff(request)
    const { id, personId } = MemberParams.parse(request.params)
    await requireManage(request, id)
    const me = request.me
    // runWork so the task.unassigned events are published after commit.
    await runWork(app.deps, { id: me.id, kind: 'person' }, async (ctx) => {
      const { tx } = ctx
      await lockProject(tx, id)
      if (!(await canManageProject(tx, me, id))) throw forbidden()
      const [current] = await tx
        .select({ roles: projectMembers.roles })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, id), eq(projectMembers.personId, personId)))
      if (!current) throw notFound()
      if (current.roles.includes('PM') && (await isLastPm(tx, id, personId))) throw lastPm()
      await tx
        .delete(projectMembers)
        .where(and(eq(projectMembers.projectId, id), eq(projectMembers.personId, personId)))
      // After the delete: work in flight that still sees the member is waited for inside.
      await unassignMemberTasks(ctx, id, personId)
    })
    return reply.status(204).send()
  })

  app.patch('/projects/:id', async (request) => {
    requireStaff(request)
    const { id } = ProjectParams.parse(request.params)
    const patch = ProjectPatch.parse(request.body)
    // noAi and the AI budget are admin-only; autonomy stays PM/admin. Checked before any write.
    if (patch.noAi !== undefined || patch.aiBudgetUsd !== undefined) requireAdmin(request)
    await requireManage(request, id)
    // runWork so jobs queued when AI is switched back on are sent after commit.
    return runWork(app.deps, { id: request.me.id, kind: 'person' }, async (ctx) => {
      const { tx } = ctx
      await lockProject(tx, id)
      if (!(await canManageProject(tx, request.me, id))) throw forbidden()
      const [before] = await tx.select({ noAi: projects.noAi }).from(projects).where(eq(projects.id, id))
      const set: Partial<typeof projects.$inferInsert> = {}
      if (patch.autonomy !== undefined) set.autonomy = patch.autonomy
      if (patch.noAi !== undefined) set.noAi = patch.noAi
      if (patch.aiBudgetUsd !== undefined) {
        set.aiBudgetUsd = patch.aiBudgetUsd === null ? null : patch.aiBudgetUsd.toFixed(2)
      }
      if (Object.keys(set).length > 0) await tx.update(projects).set(set).where(eq(projects.id, id))
      if (before?.noAi && patch.noAi === false) await resumeProjectAi(ctx, id)
      const detail = await loadDetail(tx, id)
      if (!detail) throw notFound()
      return detail
    })
  })

  // Application URLs (Yoda Reporter URL mapping, plan A7): members read, the PM or an admin replaces the list.
  const visibleProject = async (me: Me, id: string) => {
    const [p] = await db().select({ id: projects.id }).from(projects).where(eq(projects.id, id))
    if (!p || !(await canSeeProject(db(), me, id))) throw notFound()
  }

  app.get('/projects/:id/app-urls', async (request) => {
    requireStaff(request)
    const { id } = ProjectParams.parse(request.params)
    await visibleProject(request.me, id)
    return listAppUrls(db(), id)
  })

  app.put('/projects/:id/app-urls', async (request) => {
    requireStaff(request)
    const { id } = ProjectParams.parse(request.params)
    await visibleProject(request.me, id)
    const body = AppUrlsPut.parse(request.body)
    return runWork(app.deps, { id: request.me.id, kind: 'person' }, async ({ tx }) => {
      await lockProject(tx, id)
      if (!(await canManageProject(tx, request.me, id))) throw forbidden()
      return replaceAppUrls(tx, id, body, request.me.id)
    })
  })

  /** Admin or project PM; otherwise 403. Admins on an unknown project get 404 from the lock. */
  async function requireManage(request: { me: Me }, id: string) {
    if (!(await canManageProject(db(), request.me, id))) throw forbidden()
  }
}
