import { GitLabStatus, IssueImport, RepoLink, WorkItemCreate, WorkItemReposPut } from '@yoda/shared'
import { and, eq, inArray, isNotNull, notInArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { forbidden, gitlabNotConnected, HttpError, invalidState, issueNotFound, notFound, repoNotFound, requireAdmin, requireStaff } from '../auth/plugin.js'
import { gitlabSettings, projectRepos, workItemRepos, workItems } from '../db/schema.js'
import { GitLabError } from '../gitlab/client.js'
import { latestMergedMrs } from '../gitlab/effects.js'
import { importedText } from '../gitlab/import.js'
import { devStarted, listProjectRepos, repoHasIssues, toRepo, workItemCode } from '../gitlab/repos.js'
import { queueIssueSync } from '../gitlab/sync.js'
import { handleWebhook, tokenMatches } from '../gitlab/webhook.js'
import { runWork } from '../work/context.js'
import { canSeeProject, getWorkItemDetail } from '../work/queries.js'
import { createWorkItem, isPmOrAdmin, lockItem } from '../work/engine.js'
import { canManageProject } from '../projects/access.js'
import { lockProject } from '../projects/access.js'

const IdParams = z.object({ id: z.string().uuid() })
const RepoParams = z.object({ id: z.string().uuid(), repoId: z.string().uuid() })
const STATUS_TIMEOUT_MS = 5_000
const WEBHOOK_BODY_LIMIT = 1024 * 1024
const EventUuid = z.string().trim().min(1).max(200)

export function gitlabRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db

  app.post(
    '/gitlab/webhook',
    {
      config: { public: true },
      bodyLimit: WEBHOOK_BODY_LIMIT,
      // Checked before the body is read; neither the secret nor the request headers are ever logged or echoed.
      onRequest: async (request) => {
        if (!tokenMatches(app.deps.config.gitlabWebhookSecret, request.headers['x-gitlab-token'])) throw new HttpError(401, { error: 'unauthorized' })
      },
    },
    async (request) => {
      const eventUuid = EventUuid.parse(request.headers['x-gitlab-event-uuid'])
      // GitLab does not retry failed deliveries (and disables a hook that keeps failing), so this path never
      // calls GitLab: the bot's id comes from the client's cache (filled at boot or by the admin status page).
      return handleWebhook(app.deps, eventUuid, request.body, app.deps.gitlab?.botUser?.id ?? null)
    },
  )

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
          // An empty project has no default branch yet.
          defaultBranch: found.default_branch ?? null,
          addedBy: me.id,
        })
        .onConflictDoNothing()
        .returning()
      return r ?? null
    })
    if (!row) throw new HttpError(409, { error: 'invalid_state' })
    return reply.status(201).send(toRepo(row))
  })

  /** Changed repo links can complete "every repo merged": the item's latest merged MR re-runs its effect (after commit). */
  const queueMrEffects = async (ids: string[]) => {
    for (const mrId of ids) {
      try {
        await app.deps.jobs.send('gitlab-mr-effect', { id: mrId })
      } catch (err) {
        console.error(`jobs: failed to send gitlab-mr-effect ${mrId}`, err)
      }
    }
  }

  app.delete('/projects/:id/repos/:repoId', async (request, reply) => {
    requireStaff(request)
    const { id, repoId } = RepoParams.parse(request.params)
    const me = request.me
    if (!(await canSeeProject(db(), me, id))) throw notFound()
    if (!(await canManageProject(db(), me, id))) throw forbidden()
    const effects = await db().transaction(async (tx) => {
      await lockProject(tx, id)
      const [repo] = await tx.select({ id: projectRepos.id }).from(projectRepos).where(and(eq(projectRepos.id, repoId), eq(projectRepos.projectId, id)))
      if (!repo) throw notFound()
      if (await repoHasIssues(tx, repoId)) throw invalidState()
      const linked = await tx.select({ id: workItemRepos.workItemId }).from(workItemRepos).where(eq(workItemRepos.repoId, repoId))
      await tx.delete(projectRepos).where(eq(projectRepos.id, repoId))
      return latestMergedMrs(tx, linked.map((l) => l.id))
    })
    await queueMrEffects(effects)
    return reply.status(204).send()
  })

  /**
   * A project member makes a work item from an existing issue in one of the project's repos. The issue is
   * fetched before the transaction; under the project lock the issue must not be linked to a work item yet.
   * Only that repo is linked (issue known), so the next sync appends the portal's section below the original body.
   */
  app.post('/projects/:id/import-issue', async (request, reply) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const { repoId, issueIid, templateKey } = IssueImport.parse(request.body)
    const me = request.me
    if (!(await canSeeProject(db(), me, id))) throw notFound()
    const gitlab = app.deps.gitlab
    if (!gitlab) throw gitlabNotConnected()
    const [repo] = await db().select().from(projectRepos).where(and(eq(projectRepos.id, repoId), eq(projectRepos.projectId, id)))
    if (!repo) throw repoNotFound()
    let found
    try {
      found = await gitlab.importIssue(repo.gitlabProjectId, issueIid)
    } catch (err) {
      if (err instanceof GitLabError && (err.code === 'not_found' || err.code === 'forbidden')) throw issueNotFound()
      throw new HttpError(502, { error: 'gitlab_unavailable' })
    }
    const issue = found
    const text = importedText(issue, repo.pathWithNamespace)
    const input = WorkItemCreate.parse({ ...text, templateKey: templateKey ?? 'bug-fix' })
    const workItemId = await runWork(app.deps, { id: me.id, kind: 'person' }, async (ctx) => {
      // Exclusive: two imports of the same issue serialize here, so the second sees the first's link.
      await lockProject(ctx.tx, id)
      const [still] = await ctx.tx.select({ id: projectRepos.id }).from(projectRepos).where(and(eq(projectRepos.id, repoId), eq(projectRepos.projectId, id)))
      if (!still) throw repoNotFound()
      const [linked] = await ctx.tx
        .select({ w: workItemRepos.workItemId })
        .from(workItemRepos)
        .where(and(eq(workItemRepos.repoId, repoId), eq(workItemRepos.issueIid, issue.iid)))
        .limit(1)
      if (linked) throw invalidState()
      const created = await createWorkItem(ctx, me, id, input, { repos: [{ repoId, issueIid: issue.iid, issueUrl: issue.web_url }] })
      await queueIssueSync(ctx, created, { withIssues: true })
      return created
    })
    return reply.status(201).send(await getWorkItemDetail(db(), me, workItemId))
  })

  app.get('/work-items/:id/code', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const [item] = await db().select().from(workItems).where(eq(workItems.id, id))
    if (!item || !(await canSeeProject(db(), request.me, item.projectId))) throw notFound()
    return workItemCode(db(), item, app.deps.gitlab !== null)
  })

  /**
   * PM/admin sets the work item's repos at any time: added repos get an issue (queued after commit once the Dev
   * step started); a repo can be removed only while its issue does not exist yet (409 otherwise).
   */
  app.put('/work-items/:id/repos', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const { repoIds } = WorkItemReposPut.parse(request.body)
    const me = request.me
    const wanted = [...new Set(repoIds)]
    const { code, effects, sync } = await db().transaction(async (tx) => {
      const [ref] = await tx.select({ projectId: workItems.projectId }).from(workItems).where(eq(workItems.id, id))
      if (!ref || !(await canSeeProject(tx, me, ref.projectId))) throw notFound()
      if (!(await isPmOrAdmin(tx, me, ref.projectId))) throw forbidden()
      // Lock order project → work item; the share lock keeps the project's repos from being deleted meanwhile.
      await lockProject(tx, ref.projectId, 'share')
      const item = await lockItem(tx, id)
      if (wanted.length) {
        const own = await tx.select({ id: projectRepos.id }).from(projectRepos).where(and(eq(projectRepos.projectId, item.projectId), inArray(projectRepos.id, wanted)))
        if (own.length !== wanted.length) throw repoNotFound()
      }
      const dropped = and(eq(workItemRepos.workItemId, id), wanted.length ? notInArray(workItemRepos.repoId, wanted) : undefined)
      // A repo whose issue already exists stays linked (the issue would be orphaned).
      const withIssue = await tx.select({ r: workItemRepos.repoId }).from(workItemRepos).where(and(dropped, isNotNull(workItemRepos.issueIid))).limit(1)
      if (withIssue.length) throw invalidState()
      await tx.delete(workItemRepos).where(dropped)
      const added = wanted.length
        ? await tx.insert(workItemRepos).values(wanted.map((repoId) => ({ workItemId: id, repoId }))).onConflictDoNothing().returning({ r: workItemRepos.repoId })
        : []
      // A repo added after the Dev step started gets its issue now (before Dev, the step's start creates them).
      const sync = added.length > 0 && (await devStarted(tx, item))
      return { code: await workItemCode(tx, item, app.deps.gitlab !== null), effects: await latestMergedMrs(tx, [id]), sync }
    })
    await queueMrEffects(effects)
    if (sync) {
      try {
        await app.deps.jobs.send('gitlab-issue-sync', { id })
      } catch (err) {
        console.error(`jobs: failed to send gitlab-issue-sync ${id}`, err)
      }
    }
    return code
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
