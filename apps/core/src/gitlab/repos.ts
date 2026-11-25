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

/** The secretary's view of a work item's code: repo paths, issue refs and MR states (no URLs). Null if none. */
export async function codeSummary(db: Conn, workItemId: string) {
  const links = await db
    .select({ path: projectRepos.pathWithNamespace, iid: workItemRepos.issueIid, status: workItemRepos.syncStatus })
    .from(workItemRepos)
    .innerJoin(projectRepos, eq(projectRepos.id, workItemRepos.repoId))
    .where(eq(workItemRepos.workItemId, workItemId))
    .orderBy(asc(projectRepos.pathWithNamespace), asc(projectRepos.id))
  const mrs = await db
    .select({ path: projectRepos.pathWithNamespace, iid: mergeRequests.mrIid, title: mergeRequests.title, state: mergeRequests.state, pipeline: mergeRequests.pipeline })
    .from(mergeRequests)
    .innerJoin(projectRepos, eq(projectRepos.id, mergeRequests.repoId))
    .where(eq(mergeRequests.workItemId, workItemId))
    .orderBy(asc(mergeRequests.createdAt), asc(mergeRequests.id))
  if (!links.length && !mrs.length) return null
  return {
    repos: links.map((l) => l.path),
    issues: links.map((l) => ({ issue: l.iid === null ? `${l.path} (not created yet)` : `${l.path}#${l.iid}`, status: l.status })),
    mergeRequests: mrs.map((m) => ({ mergeRequest: `${m.path}!${m.iid}`, title: m.title.slice(0, 200), state: m.state, pipeline: m.pipeline })),
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * `text` without links into the GitLab hosts of the project's repos (e.g. an imported issue's URL), for content
 * a requester may read.
 */
export async function withoutGitLabLinks(db: Conn, projectId: string, text: string): Promise<string> {
  if (!text) return text
  const rows = await db.select({ url: projectRepos.webUrl }).from(projectRepos).where(eq(projectRepos.projectId, projectId))
  const origins = new Set<string>()
  for (const r of rows) {
    try {
      origins.add(new URL(r.url).origin)
    } catch {
      // Stored URLs come from GitLab; an unparsable one has nothing to match.
    }
  }
  let out = text
  for (const o of origins) out = out.replace(new RegExp(`${escapeRe(o)}[^\\s)\\]>"'<]*`, 'gi'), '')
  return out === text ? text : out.replace(/^[ \t]*\n+/, '').trim()
}
