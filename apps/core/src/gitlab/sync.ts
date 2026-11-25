import type { TaskResult } from '@yoda/shared'
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { discussions, knowledgeEntries, projectRepos, projects, tasks, workItemRepos, workItems } from '../db/schema.js'
import type { JobRun } from '../jobs/queue.js'
import { recordEvent, runWork, type WorkCtx, type WorkDeps } from '../work/context.js'
import { templateById } from '../workflow/seed.js'
import { GitLabError, type GitLabClient } from './client.js'
import { changedSections, mergeSection, renderIssueSection, sectionHash, workItemMarker, type IssueSectionInput } from './issue-section.js'

export type SyncDeps = WorkDeps & { config: WorkDeps['config'] & { portalUrl: string }; gitlab: GitLabClient | null }

/**
 * Queues `gitlab-issue-sync` for the work item after commit (once per transaction). `withIssues` only queues
 * when an issue already exists (content changes before the Dev step never create issues); otherwise any
 * linked repo is enough.
 */
export async function queueIssueSync(ctx: WorkCtx, workItemId: string, opts: { withIssues: boolean }): Promise<void> {
  if (ctx.jobs.some((j) => j.name === 'gitlab-issue-sync' && j.id === workItemId)) return
  const [row] = await ctx.tx
    .select({ w: workItemRepos.workItemId })
    .from(workItemRepos)
    .where(and(eq(workItemRepos.workItemId, workItemId), opts.withIssues ? isNotNull(workItemRepos.issueIid) : undefined))
    .limit(1)
  if (row) ctx.jobs.push({ name: 'gitlab-issue-sync', id: workItemId })
}

type Link = { repo: typeof projectRepos.$inferSelect; link: typeof workItemRepos.$inferSelect }
type Content = Omit<IssueSectionInput, 'siblings' | 'iid'>

/** Everything the section shows, read from committed state (confirmed knowledge, decided discussions, accepted tasks). */
async function readContent(db: Db, item: typeof workItems.$inferSelect, projectName: string, portalUrl: string): Promise<Content> {
  const def = await templateById(db, item.templateId)
  const codeSteps = (def?.steps ?? []).filter((s) => s.tasks.some((t) => t.capability === 'code-change'))
  const codeKeys = new Set(codeSteps.flatMap((s) => s.tasks.filter((t) => t.capability === 'code-change').map((t) => t.key)))
  const testKeys = new Set(codeSteps.flatMap((s) => s.tasks.filter((t) => t.role === 'QC' && t.capability === 'draft-text').map((t) => t.key)))

  // Approved outputs: confirmed documents written from accepted tasks; BA → requirements, SA → design.
  const docs = await db
    .select({ body: knowledgeEntries.body, role: tasks.role })
    .from(knowledgeEntries)
    .innerJoin(tasks, sql`${tasks.id}::text = ${knowledgeEntries.sourceRef}`)
    .where(
      and(
        eq(knowledgeEntries.workItemId, item.id),
        eq(knowledgeEntries.type, 'document'),
        eq(knowledgeEntries.status, 'confirmed'),
        eq(knowledgeEntries.sourceKind, 'task'),
        isNull(knowledgeEntries.supersededAt),
        isNull(tasks.supersededAt),
      ),
    )
    .orderBy(desc(knowledgeEntries.createdAt), desc(knowledgeEntries.id))
  const requirements = docs.find((d) => d.role === 'BA')?.body ?? (item.description.trim() ? item.description : null)
  const design = docs.find((d) => d.role === 'SA')?.body ?? null

  const ds = await db
    .select({ id: discussions.id, question: discussions.question, decision: discussions.decision, state: discussions.state })
    .from(discussions)
    .where(eq(discussions.workItemId, item.id))
    .orderBy(asc(discussions.decidedAt), asc(discussions.id))
  const discussionIds = new Set(ds.map((d) => d.id))
  const decided = ds.filter((d) => d.state === 'decided' && d.decision).map((d) => ({ question: d.question, decision: d.decision! }))
  // Decisions recorded directly as knowledge (a decided discussion's own entry is already listed above).
  const entries = await db
    .select({ title: knowledgeEntries.title, body: knowledgeEntries.body, sourceRef: knowledgeEntries.sourceRef })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.workItemId, item.id),
        eq(knowledgeEntries.type, 'decision'),
        eq(knowledgeEntries.status, 'confirmed'),
        isNull(knowledgeEntries.supersededAt),
      ),
    )
    .orderBy(asc(knowledgeEntries.createdAt), asc(knowledgeEntries.id))
  const decisions = [
    ...decided,
    ...entries.filter((e) => !e.sourceRef || !discussionIds.has(e.sourceRef)).map((e) => ({ question: e.title, decision: e.body })),
  ]

  const current = await db
    .select({ key: tasks.templateTaskKey, attempt: tasks.attempt, state: tasks.state, feedback: tasks.feedback, result: tasks.result })
    .from(tasks)
    .where(and(eq(tasks.workItemId, item.id), isNull(tasks.supersededAt)))
    .orderBy(desc(tasks.attempt), desc(tasks.createdAt))
  const tested = current.find((t) => testKeys.has(t.key) && t.state === 'accepted')
  const testCases = (tested?.result as TaskResult | null)?.text?.trim() || null
  const latestCode = current.find((t) => codeKeys.has(t.key))
  const feedback = latestCode?.feedback?.trim() || null

  return { workItem: { id: item.id, title: item.title }, projectName, portalUrl, requirements, design, decisions, testCases, feedback }
}

const errorCode = (err: unknown) => (err instanceof GitLabError ? err.code : 'internal')

// One sync per work item at a time in this process (pg-boss's `stately` queue covers other instances).
const running = new Map<string, Promise<void>>()

/** Job `gitlab-issue-sync` `{ id: workItemId }`. GitLab calls run outside any transaction. */
export async function syncIssues(deps: SyncDeps, run: JobRun): Promise<void> {
  const prev = running.get(run.id) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(() => syncOnce(deps, run))
  running.set(run.id, next)
  try {
    await next
  } finally {
    if (running.get(run.id) === next) running.delete(run.id)
  }
}

async function syncOnce(deps: SyncDeps, run: JobRun): Promise<void> {
  const gitlab = deps.gitlab
  if (!gitlab) return
  const { db } = deps
  const [item] = await db.select().from(workItems).where(eq(workItems.id, run.id))
  if (!item) return
  const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, item.projectId))
  const links: Link[] = await db
    .select({ repo: projectRepos, link: workItemRepos })
    .from(workItemRepos)
    .innerJoin(projectRepos, eq(projectRepos.id, workItemRepos.repoId))
    .where(eq(workItemRepos.workItemId, item.id))
    .orderBy(asc(projectRepos.pathWithNamespace), asc(projectRepos.id))
  if (!links.length) return
  const content = await readContent(db, item, project?.name ?? '', deps.config.portalUrl)

  const known = new Map<string, { iid: number; url: string }>()
  for (const l of links) if (l.link.issueIid !== null && l.link.issueUrl) known.set(l.repo.id, { iid: l.link.issueIid, url: l.link.issueUrl })
  const render = (self: Link) =>
    renderIssueSection({
      ...content,
      iid: known.get(self.repo.id)?.iid ?? null,
      siblings: links
        .filter((l) => l.repo.id !== self.repo.id)
        .map((l) => ({ path: l.repo.pathWithNamespace, iid: known.get(l.repo.id)?.iid ?? null, url: known.get(l.repo.id)?.url ?? null })),
    })

  const failed = new Map<string, string>()
  const created = new Set<string>()

  // 1. Create (or adopt, after a lost response) the missing issues.
  for (const l of links) {
    if (l.link.issueIid !== null) continue
    try {
      const marker = workItemMarker(item.id)
      const issue =
        (await gitlab.findIssueByMarker(l.repo.gitlabProjectId, marker)) ??
        (await gitlab.createIssue(l.repo.gitlabProjectId, { title: item.title, description: render(l) }))
      known.set(l.repo.id, { iid: issue.iid, url: issue.web_url })
      created.add(l.repo.id)
      await db
        .update(workItemRepos)
        .set({ issueIid: issue.iid, issueUrl: issue.web_url })
        .where(and(eq(workItemRepos.workItemId, item.id), eq(workItemRepos.repoId, l.repo.id), isNull(workItemRepos.issueIid)))
    } catch (err) {
      failed.set(l.repo.id, errorCode(err))
    }
  }

  // 2. Push the section (with every sibling now known) where it changed or went missing.
  const synced: { l: Link; hash: string; pushed: boolean }[] = []
  const missing: Link[] = []
  for (const l of links) {
    const own = known.get(l.repo.id)
    if (!own || failed.has(l.repo.id)) continue
    const section = render(l)
    const hash = sectionHash(section)
    try {
      const current = await gitlab.getIssue(l.repo.gitlabProjectId, own.iid)
      const body = current.description ?? ''
      const merged = mergeSection(body, section)
      const changed = hash !== l.link.sectionHash
      if (merged !== body) await gitlab.updateIssue(l.repo.gitlabProjectId, own.iid, { description: merged })
      if (changed && !created.has(l.repo.id)) {
        const heads = changedSections(body, section)
        const note = heads.length
          ? `ปรับปรุงจากพอร์ทัล / Updated from the portal: ${heads.join(', ')}`
          : 'ปรับปรุงจากพอร์ทัล / Updated from the portal'
        await gitlab.addIssueNote(l.repo.gitlabProjectId, own.iid, note)
      }
      synced.push({ l, hash, pushed: merged !== body || created.has(l.repo.id) })
    } catch (err) {
      // The issue was deleted (or moved) in GitLab: it is not recreated.
      if (err instanceof GitLabError && err.code === 'not_found') missing.push(l)
      else failed.set(l.repo.id, errorCode(err))
    }
  }

  const finalFailures = run.isFinalAttempt ? [...failed] : []
  await runWork(deps, { id: null, kind: 'system' }, async (ctx) => {
    const base = { projectId: item.projectId, workItemId: item.id, taskId: null }
    const where = (repoId: string) => and(eq(workItemRepos.workItemId, item.id), eq(workItemRepos.repoId, repoId))
    for (const { l, hash, pushed } of synced) {
      const own = known.get(l.repo.id)!
      await ctx.tx
        .update(workItemRepos)
        .set({ sectionHash: hash, syncStatus: 'synced', syncError: null, lastSyncedAt: sql`now()` })
        .where(where(l.repo.id))
      if (pushed || l.link.syncStatus !== 'synced') {
        await recordEvent(ctx, {
          type: 'gitlab.issue_synced',
          ...base,
          payload: { repoId: l.repo.id, path: l.repo.pathWithNamespace, issueIid: own.iid, created: created.has(l.repo.id) },
        })
      }
    }
    const fail = async (l: Link, code: string) => {
      await ctx.tx.update(workItemRepos).set({ syncStatus: 'failed', syncError: code }).where(where(l.repo.id))
      await recordEvent(ctx, { type: 'gitlab.issue_sync_failed', ...base, reason: code, payload: { repoId: l.repo.id, path: l.repo.pathWithNamespace, code } })
    }
    for (const l of missing) if (l.link.syncError !== 'issue_missing') await fail(l, 'issue_missing')
    for (const [repoId, code] of finalFailures) await fail(links.find((l) => l.repo.id === repoId)!, code)
  })

  if (failed.size) {
    // pg-boss retries; the message names only the error codes (never the token or URLs).
    throw new Error(`gitlab-issue-sync failed for ${failed.size} repo(s): ${[...new Set(failed.values())].join(', ')}`)
  }
}
