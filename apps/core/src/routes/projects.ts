import type { Me } from '@yoda/shared'
import { MemberRolesPut, Project, ProjectCreate, ProjectDetail, ProjectPatch } from '@yoda/shared'
import { and, asc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { forbidden, lastPm, notStaff, notFound, requireAdmin, requireStaff } from '../auth/plugin.js'
import type { Db, Tx } from '../db/client.js'
import { people, projectMembers, projects } from '../db/schema.js'
import { canManageProject, lockProject } from '../projects/access.js'
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
    return rows.map(toProject)
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
    return detail
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

  /** Admin or project PM; otherwise 403. Admins on an unknown project get 404 from the lock. */
  async function requireManage(request: { me: Me }, id: string) {
    if (!(await canManageProject(db(), request.me, id))) throw forbidden()
  }
}
