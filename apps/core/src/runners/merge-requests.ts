import type { OpenMrInput } from '@yoda/shared'
import { and, desc, eq, sql } from 'drizzle-orm'
import { gitlabNotConnected, gitlabUnavailable, invalidBranch, invalidState, repoNotFound } from '../auth/plugin.js'
import type { Tx } from '../db/client.js'
import { agentRuns, events, mergeRequests, projectRepos, tasks, workItemRepos } from '../db/schema.js'
import { GitLabError, type GitLabClient } from '../gitlab/client.js'
import { stripCommentMarkers } from '../gitlab/issue-section.js'
import { upsertMergeRequest, workItemShortId } from '../gitlab/webhook.js'
import { recordEvent, runWork } from '../work/context.js'
import { asOwner, lockRunTask, nowOf, type RunnerCtx, type RunnerDeps } from './claims.js'
import { lockLiveRun, workable } from './work.js'

export type MrDeps = RunnerDeps & { gitlab: GitLabClient | null }

/**
 * A closing keyword (any form of close / fix / resolve / implement, any case), an optional `:` and `issue(s)`,
 * then an issue reference: `#3`, `group/proj#9` or a URL. GitLab scans MR titles and descriptions with a pattern
 * like this one (instances can widen it), so this errs on the side of rewriting: the runner's text must not close
 * (or link the MR to) anything but its own item. Only the keyword is rewritten, so a list after it (`#5 and #6`)
 * is left without one.
 */
const CLOSING =
  /\b(?:clos(?:e|es|ed|ing)|fix(?:es|ed|ing)?|resolv(?:e|es|ed|ing)|implement(?:s|ed|ing)?)\b\s*:?\s*(?:issues?\b\s*:?\s*)?(?=(?:[\w.-]+(?:\/[\w.-]+)+)?#\d|https?:\/\/)/giu

/** The runner's text, safe for an MR title or description: no HTML comment markers, closing keywords turned into `Refs`. */
export function runnerMrText(text: string): string {
  return stripCommentMarkers(text).replace(CLOSING, 'Refs ').trim()
}

/** A runner branch for the work item: `yoda/<its first 8 hex>-<a-z0-9- slug, 1–60 chars>`. */
export const runnerBranchPattern = (workItemId: string) => new RegExp(`^yoda/${workItemShortId(workItemId)}-[a-z0-9-]{1,60}$`)

/**
 * A retried call after the run already ended `succeeded` (the MR effect accepted its task): the MR this run
 * opened from that branch, without calling GitLab again. Null otherwise.
 */
async function alreadyOpened(tx: Tx, rc: RunnerCtx, input: OpenMrInput): Promise<{ mrIid: number; url: string } | null> {
  const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, input.runId))
  if (!run || run.runnerId !== rc.runner.id || run.state !== 'succeeded' || run.branch !== input.sourceBranch) return null
  const [mr] = await tx
    .select({ mrIid: mergeRequests.mrIid, url: mergeRequests.url })
    .from(mergeRequests)
    .innerJoin(tasks, eq(tasks.workItemId, mergeRequests.workItemId))
    .where(and(eq(tasks.id, run.taskId), eq(mergeRequests.repoId, input.repoId), eq(mergeRequests.sourceBranch, input.sourceBranch)))
    .orderBy(desc(mergeRequests.createdAt))
    .limit(1)
  return mr ?? null
}

/**
 * Opens the run's MR in GitLab, from the branch the runner pushed to the repo's default branch, with
 * `Closes #<issue>` added when the work item has an issue in that repo. Reads in one transaction, calls GitLab
 * outside any, then records the MR in a short one: the `merge_requests` row is upserted the way the MR webhook
 * does it (linked to the run's work item), `gitlab.mr_requested` is recorded once per run and MR, and the branch
 * is stored on the run. `gitlab-mr-effect` is queued after commit even when the row did not change (it is
 * idempotent, and the webhook that would queue it may be lost). The same call again returns the same MR (via
 * GitLab's 409 while the run is live; from the stored row once the MR effect has ended the run).
 */
export async function openMergeRequest(deps: MrDeps, rc: RunnerCtx, input: OpenMrInput): Promise<{ mrIid: number; url: string }> {
  const now = nowOf(deps)
  const read = await runWork(deps, asOwner(rc), async (ctx) => {
    let live: Awaited<ReturnType<typeof lockLiveRun>>
    try {
      live = await lockLiveRun(ctx.tx, rc, input.runId, now)
    } catch (err) {
      // Read after the locks, so an MR effect that ended the run meanwhile is seen.
      const replay = await alreadyOpened(ctx.tx, rc, input)
      if (replay) return replay
      throw err
    }
    const { run, task, item } = live
    if (!workable(rc, item, task)) throw invalidState('task_unavailable')
    if (!deps.gitlab) throw gitlabNotConnected()
    const [link] = await ctx.tx
      .select({ repo: projectRepos, issueIid: workItemRepos.issueIid })
      .from(workItemRepos)
      .innerJoin(projectRepos, eq(projectRepos.id, workItemRepos.repoId))
      .where(and(eq(workItemRepos.workItemId, item.id), eq(workItemRepos.repoId, input.repoId)))
    if (!link) throw repoNotFound()
    return { runId: run.id, taskId: task.id, workItemId: item.id, repo: link.repo, issueIid: link.issueIid }
  })
  if ('mrIid' in read) return read
  const gitlab = deps.gitlab!
  const { repo } = read
  if (!runnerBranchPattern(read.workItemId).test(input.sourceBranch)) throw invalidBranch()

  const title = runnerMrText(input.title) || input.sourceBranch
  let created: { iid: number; webUrl: string; state: string }
  try {
    const target = repo.defaultBranch ?? (await gitlab.getProject(repo.gitlabProjectId)).default_branch
    if (!target) throw invalidBranch('no_default_branch')
    if (input.sourceBranch === target) throw invalidBranch()
    const text = runnerMrText(input.description)
    const closes = read.issueIid === null ? '' : `Closes #${read.issueIid}`
    created = await gitlab.createMergeRequest(repo.gitlabProjectId, {
      sourceBranch: input.sourceBranch,
      targetBranch: target,
      title,
      description: [text, closes].filter(Boolean).join('\n\n'),
      removeSourceBranch: true,
    })
  } catch (err) {
    if (!(err instanceof GitLabError)) throw err
    // e.g. the branch was never pushed; GitLab's message is not passed on.
    if (err.code === 'bad_request') throw invalidBranch('gitlab_rejected')
    throw gitlabUnavailable()
  }

  return runWork(deps, asOwner(rc), async (ctx) => {
    const { tx } = ctx
    const task = await lockRunTask(tx, read.taskId)
    await upsertMergeRequest(ctx, {
      gitlabProjectId: repo.gitlabProjectId,
      iid: created.iid,
      title,
      url: created.webUrl,
      state: created.state,
      sourceBranch: input.sourceBranch,
      description: '',
      linkTo: { repoId: repo.id, workItemId: read.workItemId },
    })
    const [mr] = await tx
      .select()
      .from(mergeRequests)
      .where(and(eq(mergeRequests.repoId, repo.id), eq(mergeRequests.mrIid, created.iid)))
    // The repo was unlinked from the project meanwhile: GitLab has the MR, the portal has nowhere to keep it.
    if (!mr) throw repoNotFound()
    // The run's branch is a record; it is kept even when the run ended while GitLab answered.
    await tx.update(agentRuns).set({ branch: input.sourceBranch }).where(eq(agentRuns.id, read.runId))
    const [seen] = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.type, 'gitlab.mr_requested'),
          eq(events.taskId, task.id),
          sql`${events.payload}->>'runId' = ${read.runId}`,
          sql`${events.payload}->>'mergeRequestId' = ${mr.id}`,
        ),
      )
      .limit(1)
    if (!seen) {
      await recordEvent(ctx, {
        type: 'gitlab.mr_requested',
        projectId: task.projectId,
        workItemId: task.workItemId,
        taskId: task.id,
        payload: {
          runId: read.runId,
          runnerId: rc.runner.id,
          mergeRequestId: mr.id,
          repoId: repo.id,
          path: repo.pathWithNamespace,
          mrIid: mr.mrIid,
          url: mr.url,
          branch: input.sourceBranch,
        },
      })
    }
    if (!ctx.jobs.some((j) => j.name === 'gitlab-mr-effect' && j.id === mr.id)) ctx.jobs.push({ name: 'gitlab-mr-effect', id: mr.id })
    return { mrIid: mr.mrIid, url: mr.url }
  })
}
