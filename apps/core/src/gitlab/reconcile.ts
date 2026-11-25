import { and, asc, eq, isNotNull } from 'drizzle-orm'
import { events, mergeRequests, projectRepos, workItemRepos } from '../db/schema.js'
import type { JobRun } from '../jobs/queue.js'
import { runWork, type WorkCtx } from '../work/context.js'
import { GitLabError, type GitLabMergeRequest } from './client.js'
import type { SyncDeps } from './sync.js'
import { upsertMergeRequest } from './webhook.js'

/** Queues `gitlab-mr-reconcile` for the work item after commit (once per transaction). */
export function queueMrReconcile(ctx: WorkCtx, workItemId: string): void {
  if (!ctx.jobs.some((j) => j.name === 'gitlab-mr-reconcile' && j.id === workItemId)) ctx.jobs.push({ name: 'gitlab-mr-reconcile', id: workItemId })
}

/**
 * Job `gitlab-mr-reconcile` `{ id: workItemId }`. GitLab does not retry failed webhook deliveries, so MR state
 * is also pulled: for each of the item's issues, GitLab's related merge requests are fetched (outside any
 * transaction) and recorded exactly as a webhook would (state-change events, `gitlab-mr-effect` after commit).
 * Until an MR has accepted the item's code, its opened MRs also get their effect re-run, which covers an MR
 * opened before the code-change attempt existed (effects are idempotent). Queued when a code-change task is created
 * and by the secretary sweep. No-op without GitLab.
 */
export async function reconcileMergeRequests(deps: SyncDeps, run: Pick<JobRun, 'id'>): Promise<void> {
  const gitlab = deps.gitlab
  if (!gitlab) return
  const links = await deps.db
    .select({ gitlabProjectId: projectRepos.gitlabProjectId, iid: workItemRepos.issueIid })
    .from(workItemRepos)
    .innerJoin(projectRepos, eq(projectRepos.id, workItemRepos.repoId))
    .where(and(eq(workItemRepos.workItemId, run.id), isNotNull(workItemRepos.issueIid)))
  const found = new Map<string, GitLabMergeRequest>()
  const failed: string[] = []
  for (const l of links) {
    try {
      for (const mr of await gitlab.relatedMergeRequests(l.gitlabProjectId, l.iid!)) {
        // Shown as links in the portal, like the webhook's (which validates them the same way).
        if (/^https?:\/\//i.test(mr.web_url)) found.set(`${mr.project_id}!${mr.iid}`, mr)
      }
    } catch (err) {
      failed.push(err instanceof GitLabError ? err.code : 'internal')
    }
  }
  await runWork(deps, { id: null, kind: 'system' }, async (ctx) => {
    for (const mr of found.values()) {
      await upsertMergeRequest(ctx, {
        gitlabProjectId: mr.project_id,
        iid: mr.iid,
        title: mr.title,
        url: mr.web_url,
        state: mr.state,
        sourceBranch: mr.source_branch,
        description: mr.description,
      })
    }
    // An MR opened before the code-change attempt existed: nothing changed, so nothing queued its effect. Only
    // until an MR first accepted the code (afterwards rework waits for a new MR or the merge, as with webhooks).
    const [acceptedByMr] = await ctx.tx
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.workItemId, run.id), eq(events.type, 'task.accepted'), eq(events.reason, 'mr_opened_in_gitlab')))
      .limit(1)
    if (acceptedByMr) return
    const open = await ctx.tx
      .select({ id: mergeRequests.id })
      .from(mergeRequests)
      .where(and(eq(mergeRequests.workItemId, run.id), eq(mergeRequests.state, 'opened')))
      .orderBy(asc(mergeRequests.createdAt), asc(mergeRequests.id))
    for (const m of open) if (!ctx.jobs.some((j) => j.name === 'gitlab-mr-effect' && j.id === m.id)) ctx.jobs.push({ name: 'gitlab-mr-effect', id: m.id })
  })
  // The queue retries; the message names only error codes (never the token or URLs).
  if (failed.length) throw new Error(`gitlab-mr-reconcile failed for ${failed.length} issue(s): ${[...new Set(failed)].join(', ')}`)
}
