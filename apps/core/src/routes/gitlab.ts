import { GitLabStatus, RepoLink, WorkItemReposPut } from '@yoda/shared'
import { and, eq, inArray, isNotNull, notInArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { forbidden, gitlabNotConnected, HttpError, invalidState, notFound, repoNotFound, requireAdmin, requireStaff } from '../auth/plugin.js'
import { gitlabSettings, projectRepos, workItemRepos, workItems } from '../db/schema.js'
import { GitLabError } from '../gitlab/client.js'
import { devStarted, listProjectRepos, repoHasIssues, toRepo, workItemCode } from '../gitlab/repos.js'
import { canSeeProject } from '../work/queries.js'
import { isPmOrAdmin, lockItem } from '../work/engine.js'
import { canManageProject } from '../projects/access.js'
import { lockProject } from '../projects/access.js'

const IdParams = z.object({ id: z.string().uuid() })
const RepoParams = z.object({ id: z.string().uuid(), repoId: z.string().uuid() })
const STATUS_TIMEOUT_MS = 5_000

export function gitlabRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db

  app.get('/projects/:id/repos', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    if (!(await canSeeProject(db(), request.me, id))) throw notFound()
    return listProjectRepos(db(), id)
  })

  app.post('/projects/:id/repos', async (request, reply) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const { path } = RepoLink.parse(request.body)
    const me = request.me
    if (!(await canSeeProject(db(), me, id))) throw notFound()
    if (!(await canManageProject(db(), me, id))) throw forbidden()
    const gitlab = app.deps.gitlab
    if (!gitlab) throw gitlabNotConnected()
    let found
    try {
      found = await gitlab.getProject(path)
    } catch (err) {
      if (err instanceof GitLabError && (err.code === 'not_found' || err.code === 'forbidden')) throw repoNotFound()
      throw new HttpError(502, { error: 'gitlab_unavailable' })
    }
    const row = await db().transaction(async (tx) => {
      await lockProject(tx, id, 'share')
      const [r] = await tx
        .insert(projectRepos)
        .values({
          projectId: id,
          gitlabProjectId: found.id,
          pathWithNamespace: found.path_with_namespace,
          webUrl: found.web_url,
          defaultBranch: found.default_branch,
          addedBy: me.id,
        })
        .onConflictDoNothing()
        .returning()
      return r ?? null
    })
    if (!row) throw new HttpError(409, { error: 'invalid_state' })
    return reply.status(201).send(toRepo(row))
  })

  app.delete('/projects/:id/repos/:repoId', async (request, reply) => {
    requireStaff(request)
    const { id, repoId } = RepoParams.parse(request.params)
    const me = request.me
    if (!(await canSeeProject(db(), me, id))) throw notFound()
    if (!(await canManageProject(db(), me, id))) throw forbidden()
    await db().transaction(async (tx) => {
      await lockProject(tx, id)
      const [repo] = await tx.select({ id: projectRepos.id }).from(projectRepos).where(and(eq(projectRepos.id, repoId), eq(projectRepos.projectId, id)))
      if (!repo) throw notFound()
      if (await repoHasIssues(tx, repoId)) throw invalidState()
      await tx.delete(projectRepos).where(eq(projectRepos.id, repoId))
    })
    return reply.status(204).send()
  })

  app.get('/work-items/:id/code', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const [item] = await db().select().from(workItems).where(eq(workItems.id, id))
    if (!item || !(await canSeeProject(db(), request.me, item.projectId))) throw notFound()
    return workItemCode(db(), item, app.deps.gitlab !== null)
  })

  app.put('/work-items/:id/repos', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const { repoIds } = WorkItemReposPut.parse(request.body)
    const me = request.me
    const wanted = [...new Set(repoIds)]
    return db().transaction(async (tx) => {
      const [ref] = await tx.select({ projectId: workItems.projectId }).from(workItems).where(eq(workItems.id, id))
      if (!ref || !(await canSeeProject(tx, me, ref.projectId))) throw notFound()
      if (!(await isPmOrAdmin(tx, me, ref.projectId))) throw forbidden()
      // Lock order project → work item; the share lock keeps the project's repos from being deleted meanwhile.
      await lockProject(tx, ref.projectId, 'share')
      const item = await lockItem(tx, id)
      if (await devStarted(tx, item)) throw invalidState()
      if (wanted.length) {
        const own = await tx.select({ id: projectRepos.id }).from(projectRepos).where(and(eq(projectRepos.projectId, item.projectId), inArray(projectRepos.id, wanted)))
        if (own.length !== wanted.length) throw repoNotFound()
      }
      const dropped = and(eq(workItemRepos.workItemId, id), wanted.length ? notInArray(workItemRepos.repoId, wanted) : undefined)
      // A repo whose issue already exists stays linked (the issue would be orphaned).
      const withIssue = await tx.select({ r: workItemRepos.repoId }).from(workItemRepos).where(and(dropped, isNotNull(workItemRepos.issueIid))).limit(1)
      if (withIssue.length) throw invalidState()
      await tx.delete(workItemRepos).where(dropped)
      if (wanted.length) await tx.insert(workItemRepos).values(wanted.map((repoId) => ({ workItemId: id, repoId }))).onConflictDoNothing()
      return workItemCode(tx, item, app.deps.gitlab !== null)
    })
  })

  app.get('/admin/gitlab', async (request): Promise<GitLabStatus> => {
    requireAdmin(request)
    const [settings] = await db().select({ at: gitlabSettings.lastWebhookAt }).from(gitlabSettings).where(eq(gitlabSettings.id, 1))
    const lastWebhookAt = settings?.at?.toISOString() ?? null
    const gitlab = app.deps.gitlab
    if (!gitlab) return { configured: false, reachable: null, botUsername: null, lastWebhookAt }
    try {
      const user = await Promise.race([
        gitlab.currentUser(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), STATUS_TIMEOUT_MS).unref()),
      ])
      return { configured: true, reachable: true, botUsername: user.username, lastWebhookAt }
    } catch {
      return { configured: true, reachable: false, botUsername: null, lastWebhookAt }
    }
  })
}
