import type { Me } from '@yoda/shared'
import { MemberRolesPut, Project, ProjectCreate, ProjectDetail } from '@yoda/shared'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { forbidden, lastPm, notFound, requireAdmin, requireStaff } from '../auth/plugin.js'
import type { Db } from '../db/client.js'
import { people, projectMembers, projects } from '../db/schema.js'
import { canManageProject } from '../projects/access.js'

type ProjectRow = typeof projects.$inferSelect

const toProject = (row: ProjectRow): Project =>
  Project.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    noAi: row.noAi,
    autonomy: row.autonomy,
    createdAt: (row.createdAt ?? new Date()).toISOString(),
  })

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

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

/** Lock the project row so concurrent membership changes serialize. */
async function lockProject(tx: Tx, id: string): Promise<void> {
  const rows = await tx.execute(sql`select 1 from projects where id = ${id} for update`)
  if (rows.length === 0) throw notFound()
}

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
    return reply.status(201).send(toProject(row!))
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
    return db().transaction(async (tx) => {
      await lockProject(tx, id)
      const [person] = await tx.select({ id: people.id }).from(people).where(eq(people.id, personId))
      if (!person) throw notFound()
      if (!roles.includes('PM') && (await isLastPm(tx, id, personId))) {
        const [current] = await tx
          .select({ roles: projectMembers.roles })
          .from(projectMembers)
          .where(and(eq(projectMembers.projectId, id), eq(projectMembers.personId, personId)))
        if (current?.roles.includes('PM')) throw lastPm()
      }
      await tx
        .insert(projectMembers)
        .values({ projectId: id, personId, roles })
        .onConflictDoUpdate({
          target: [projectMembers.projectId, projectMembers.personId],
          set: { roles },
        })
      return (await loadDetail(tx, id))!
    })
  })

  app.delete('/projects/:id/members/:personId', async (request, reply) => {
    requireStaff(request)
    const { id, personId } = MemberParams.parse(request.params)
    await requireManage(request, id)
    await db().transaction(async (tx) => {
      await lockProject(tx, id)
      const [current] = await tx
        .select({ roles: projectMembers.roles })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, id), eq(projectMembers.personId, personId)))
      if (!current) throw notFound()
      if (current.roles.includes('PM') && (await isLastPm(tx, id, personId))) throw lastPm()
      await tx
        .delete(projectMembers)
        .where(and(eq(projectMembers.projectId, id), eq(projectMembers.personId, personId)))
    })
    return reply.status(204).send()
  })

  /** Admin or project PM; otherwise 403. Admins on an unknown project get 404 from the lock. */
  async function requireManage(request: { me: Me }, id: string) {
    if (!(await canManageProject(db(), request.me, id))) throw forbidden()
  }
}
