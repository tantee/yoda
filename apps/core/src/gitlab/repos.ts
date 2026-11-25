import type { Repo, WorkItemCode } from '@yoda/shared'
import { and, asc, eq, isNotNull } from 'drizzle-orm'
import type { Db, Tx } from '../db/client.js'
import { mergeRequests, projectRepos, tasks, workItemRepos, workItems } from '../db/schema.js'
import { templateById } from '../workflow/seed.js'

type Conn = Db | Tx

export function toRepo(r: typeof projectRepos.$inferSelect): Repo {
  return {
    id: r.id,
    projectId: r.projectId,
    gitlabProjectId: r.gitlabProjectId,
    pathWithNamespace: r.pathWithNamespace,
    webUrl: r.webUrl,
    defaultBranch: r.defaultBranch,
    createdAt: r.createdAt.toISOString(),
  }
}

export async function listProjectRepos(db: Conn, projectId: string): Promise<Repo[]> {
  const rows = await db.select().from(projectRepos).where(eq(projectRepos.projectId, projectId)).orderBy(asc(projectRepos.pathWithNamespace), asc(projectRepos.id))
  return rows.map(toRepo)
}

/** True once any work item has a GitLab issue in the repo. */
export async function repoHasIssues(db: Conn, repoId: string): Promise<boolean> {
  const rows = await db
    .select({ w: workItemRepos.workItemId })
    .from(workItemRepos)
    .where(and(eq(workItemRepos.repoId, repoId), isNotNull(workItemRepos.issueIid)))
    .limit(1)
  return rows.length > 0
}

/** The Dev step has started once the work item has any task whose template task has the `code-change` capability. */
export async function devStarted(db: Conn, item: { id: string; templateId: string }): Promise<boolean> {
  const def = await templateById(db, item.templateId)
  if (!def) return false
  const codeKeys = new Set(def.steps.flatMap((s) => s.tasks.filter((t) => t.capability === 'code-change').map((t) => `${s.key}/${t.key}`)))
  if (!codeKeys.size) return false
  const rows = await db.select({ stepKey: tasks.stepKey, key: tasks.templateTaskKey }).from(tasks).where(eq(tasks.workItemId, item.id))
  return rows.some((t) => codeKeys.has(`${t.stepKey}/${t.key}`))
}

export async function workItemCode(db: Conn, item: typeof workItems.$inferSelect, connected: boolean): Promise<WorkItemCode> {
  const links = await db
    .select({ repo: projectRepos, link: workItemRepos })
    .from(workItemRepos)
    .innerJoin(projectRepos, eq(projectRepos.id, workItemRepos.repoId))
    .where(eq(workItemRepos.workItemId, item.id))
    .orderBy(asc(projectRepos.pathWithNamespace), asc(projectRepos.id))
  const mrs = await db.select().from(mergeRequests).where(eq(mergeRequests.workItemId, item.id)).orderBy(asc(mergeRequests.createdAt), asc(mergeRequests.id))
  return {
    repos: links.map((l) => toRepo(l.repo)),
    issues: links.map(({ repo, link }) => ({
      repoId: repo.id,
      pathWithNamespace: repo.pathWithNamespace,
      issueIid: link.issueIid,
      issueUrl: link.issueUrl,
      status: link.syncStatus as 'pending' | 'synced' | 'failed',
      lastSyncedAt: link.lastSyncedAt?.toISOString() ?? null,
      error: link.syncError,
    })),
    mergeRequests: mrs.map((m) => ({
      id: m.id,
      repoId: m.repoId,
      mrIid: m.mrIid,
      title: m.title,
      url: m.url,
      state: m.state as 'opened' | 'merged' | 'closed',
      sourceBranch: m.sourceBranch,
      pipeline: m.pipeline as 'none' | 'pending' | 'running' | 'success' | 'failed' | 'canceled',
      updatedAt: m.updatedAt.toISOString(),
    })),
    connected,
  }
}
