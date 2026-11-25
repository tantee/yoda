import type { MergeRequestState, PipelineStatus } from '@yoda/shared'
import { timingSafeEqual } from 'node:crypto'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Tx } from '../db/client.js'
import { events, gitlabDeliveries, gitlabSettings, knowledgeEntries, mergeRequests, projectRepos, tasks, workItemRepos, workItems } from '../db/schema.js'
import { createEntry } from '../knowledge/service.js'
import { stripCommentMarkers } from './issue-section.js'
import { notify } from '../notifications/service.js'
import { recordEvent, runWork, type WorkCtx, type WorkDeps } from '../work/context.js'
import { templateById } from '../workflow/seed.js'

export type WebhookResult = { ok: true; duplicate?: true; ignored?: true }

const OK: WebhookResult = { ok: true }
const IGNORED: WebhookResult = { ok: true, ignored: true }
const DUPLICATE: WebhookResult = { ok: true, duplicate: true }

const NOTE_EXCERPT = 500
const NOTE_BODY = 4_000
const MAX_SCAN = 100_000

/** Constant-time compare of `X-Gitlab-Token` with the configured secret; no secret configured → never matches. */
export function tokenMatches(secret: string | undefined, given: unknown): boolean {
  if (!secret || typeof given !== 'string') return false
  const a = Buffer.from(secret, 'utf8')
  const b = Buffer.from(given, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Work items are referenced from branch names by the first 8 hex digits of their id: `yoda/<shortId>-…`. */
export const workItemShortId = (id: string) => id.slice(0, 8).toLowerCase()

const KEYWORD = /\b(?:clos(?:e|es|ed|ing)|fix(?:es|ed|ing)?|resolv(?:e|es|ed|ing))\b:?\s*/giu
const REF = /([\w.-]+(?:\/[\w.-]+)+)?#(\d+)\b/uy
const SEP = /(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*)/iuy

/**
 * Issue iids an MR description closes in its own project: `Closes #12`, `fixes #3, #4 and #5`,
 * `resolves group/proj#9` (only when `group/proj` is this project). Mentions without a keyword don't count.
 */
export function closingRefs(description: string, projectPath: string): number[] {
  const text = description.slice(0, MAX_SCAN)
  const path = projectPath.toLowerCase()
  const out: number[] = []
  for (const m of text.matchAll(KEYWORD)) {
    let pos = m.index + m[0].length
    for (;;) {
      REF.lastIndex = pos
      const r = REF.exec(text)
      if (!r) break
      const iid = Number(r[2])
      if ((!r[1] || r[1].toLowerCase() === path) && Number.isSafeInteger(iid) && !out.includes(iid)) out.push(iid)
      pos = REF.lastIndex
      SEP.lastIndex = pos
      if (!SEP.exec(text)) break
      pos = SEP.lastIndex
    }
  }
  return out
}

/** Untrusted text from GitLab: HTML comment markers (which could fake the portal's issue markers) are removed. */
export function sanitizeNote(text: string): string {
  return stripCommentMarkers(text).trim()
}

function clip(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

const Project = z.object({ id: z.number().int() })
const httpUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u))

const MrHook = z.object({
  object_kind: z.literal('merge_request'),
  project: Project,
  object_attributes: z.object({
    iid: z.number().int().positive(),
    title: z.string(),
    url: httpUrl,
    state: z.string(),
    source_branch: z.string(),
    description: z.string().nullish(),
  }),
})

const PipelineHook = z.object({
  object_kind: z.literal('pipeline'),
  project: Project,
  object_attributes: z.object({ id: z.number().int(), status: z.string(), ref: z.string().nullish() }),
  merge_request: z.object({ iid: z.number().int() }).nullish(),
})

const NoteHook = z.object({
  object_kind: z.literal('note'),
  project: Project,
  user: z.object({ id: z.number().int(), username: z.string() }),
  object_attributes: z.object({ id: z.number().int(), note: z.string(), noteable_type: z.string(), system: z.boolean().nullish() }),
  issue: z.object({ iid: z.number().int() }).nullish(),
})

/** Whether handling this payload needs the bot's GitLab user id (resolved by the caller, outside any transaction). */
export function needsBotUser(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { object_kind?: unknown }).object_kind === 'note'
}

const MR_STATES: Record<string, MergeRequestState> = { opened: 'opened', locked: 'opened', reopened: 'opened', merged: 'merged', closed: 'closed' }
const PIPELINE_STATES: Record<string, PipelineStatus> = {
  created: 'pending',
  waiting_for_resource: 'pending',
  preparing: 'pending',
  pending: 'pending',
  scheduled: 'pending',
  manual: 'pending',
  running: 'running',
  success: 'success',
  failed: 'failed',
  canceled: 'canceled',
  skipped: 'canceled',
}

const lockKey = (ctx: WorkCtx, key: string) => ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`)

/**
 * Handles one verified delivery. The event UUID is stored in the same transaction as its effects, so a
 * delivery that fails is not marked seen and GitLab's retry is processed. `botUserId`: notes by it are ignored.
 */
export async function handleWebhook(deps: WorkDeps, eventUuid: string, body: unknown, botUserId: number | null): Promise<WebhookResult> {
  return runWork(deps, { id: null, kind: 'system' }, async (ctx) => {
    const fresh = await ctx.tx.insert(gitlabDeliveries).values({ eventUuid }).onConflictDoNothing().returning({ u: gitlabDeliveries.eventUuid })
    if (!fresh.length) return DUPLICATE
    const kind = typeof body === 'object' && body !== null ? (body as { object_kind?: unknown }).object_kind : undefined
    let result = IGNORED
    if (kind === 'merge_request') {
      const p = MrHook.safeParse(body)
      if (p.success) result = await onMergeRequest(ctx, p.data)
    } else if (kind === 'pipeline') {
      const p = PipelineHook.safeParse(body)
      if (p.success) result = await onPipeline(ctx, p.data)
    } else if (kind === 'note') {
      const p = NoteHook.safeParse(body)
      if (p.success) result = await onNote(ctx, p.data, botUserId)
    }
    await ctx.tx.update(gitlabSettings).set({ lastWebhookAt: sql`now()` }).where(eq(gitlabSettings.id, 1))
    return result
  })
}

type RepoRow = typeof projectRepos.$inferSelect

const reposOf = (tx: Tx, gitlabProjectId: number) => tx.select().from(projectRepos).where(eq(projectRepos.gitlabProjectId, gitlabProjectId))

/** The work item an MR belongs to: a closing reference to one of its issues, else the `yoda/<shortId>-` branch. */
async function matchWorkItem(tx: Tx, repo: RepoRow, description: string, branch: string): Promise<string | null> {
  const iids = closingRefs(description, repo.pathWithNamespace)
  if (iids.length) {
    const rows = await tx
      .select({ workItemId: workItemRepos.workItemId, iid: workItemRepos.issueIid })
      .from(workItemRepos)
      .where(and(eq(workItemRepos.repoId, repo.id), inArray(workItemRepos.issueIid, iids)))
    for (const iid of iids) {
      const hit = rows.find((r) => r.iid === iid)
      if (hit) return hit.workItemId
    }
  }
  const short = branch.match(/^yoda\/([0-9a-f]{8})-/i)?.[1]?.toLowerCase()
  if (short) {
    const rows = await tx
      .select({ workItemId: workItemRepos.workItemId })
      .from(workItemRepos)
      .where(and(eq(workItemRepos.repoId, repo.id), sql`${workItemRepos.workItemId}::text like ${`${short}%`}`))
      .limit(2)
    // An ambiguous prefix links nothing.
    if (rows.length === 1) return rows[0]!.workItemId
  }
  return null
}

const MR_EVENT = { opened: 'gitlab.mr_opened', merged: 'gitlab.mr_merged', closed: 'gitlab.mr_closed' } as const

async function onMergeRequest(ctx: WorkCtx, hook: z.infer<typeof MrHook>): Promise<WebhookResult> {
  const a = hook.object_attributes
  const state = MR_STATES[a.state]
  if (!state) return IGNORED
  const repos = await reposOf(ctx.tx, hook.project.id)
  if (!repos.length) return IGNORED
  const title = clip(a.title, 500)
  const sourceBranch = clip(a.source_branch, 255)
  for (const repo of repos) {
    const match = await matchWorkItem(ctx.tx, repo, a.description ?? '', a.source_branch)
    const [inserted] = await ctx.tx
      .insert(mergeRequests)
      .values({ repoId: repo.id, mrIid: a.iid, workItemId: match, title, url: a.url, state, sourceBranch })
      .onConflictDoNothing()
      .returning()
    let row = inserted
    let prev: { state: string; workItemId: string | null } | null = null
    if (!row) {
      const [old] = await ctx.tx
        .select()
        .from(mergeRequests)
        .where(and(eq(mergeRequests.repoId, repo.id), eq(mergeRequests.mrIid, a.iid)))
        .for('update')
      prev = old!
      ;[row] = await ctx.tx
        .update(mergeRequests)
        .set({
          title,
          url: a.url,
          // Merged is final: a late delivery of an earlier state never un-merges.
          state: old!.state === 'merged' ? 'merged' : state,
          sourceBranch,
          // Once linked, an MR stays linked (a later description edit may drop the reference).
          workItemId: match ?? old!.workItemId,
          updatedAt: sql`now()`,
        })
        .where(eq(mergeRequests.id, old!.id))
        .returning()
    }
    const mr = row!
    if (!mr.workItemId) continue
    const stateChanged = !prev || prev.state !== mr.state
    const newlyLinked = !prev || prev.workItemId !== mr.workItemId
    if (!stateChanged && !newlyLinked) continue
    await recordEvent(ctx, {
      type: MR_EVENT[mr.state as MergeRequestState],
      projectId: repo.projectId,
      workItemId: mr.workItemId,
      taskId: null,
      payload: { mergeRequestId: mr.id, repoId: repo.id, path: repo.pathWithNamespace, mrIid: mr.mrIid, url: mr.url, state: mr.state },
    })
    ctx.jobs.push({ name: 'gitlab-mr-effect', id: mr.id })
  }
  return OK
}

/** The work item's current code-change (`implement`) task, latest attempt first. */
export async function implementTask(tx: Tx, workItemId: string): Promise<{ id: string; assigneeId: string | null; itemTitle: string } | null> {
  const [item] = await tx.select({ templateId: workItems.templateId, title: workItems.title }).from(workItems).where(eq(workItems.id, workItemId))
  if (!item) return null
  const def = await templateById(tx, item.templateId)
  const keys = (def?.steps ?? []).flatMap((s) => s.tasks.filter((t) => t.capability === 'code-change').map((t) => t.key))
  if (!keys.length) return null
  const [t] = await tx
    .select({ id: tasks.id, assigneeId: tasks.assigneeId })
    .from(tasks)
    .where(and(eq(tasks.workItemId, workItemId), isNull(tasks.supersededAt), inArray(tasks.templateTaskKey, keys)))
    .orderBy(desc(tasks.attempt), desc(tasks.createdAt))
    .limit(1)
  return t ? { ...t, itemTitle: item.title } : null
}

async function onPipeline(ctx: WorkCtx, hook: z.infer<typeof PipelineHook>): Promise<WebhookResult> {
  const status = PIPELINE_STATES[hook.object_attributes.status]
  if (!status) return IGNORED
  const repos = await reposOf(ctx.tx, hook.project.id)
  if (!repos.length) return IGNORED
  const pipelineId = hook.object_attributes.id
  const ref = hook.object_attributes.ref ?? null
  let matched = false
  for (const repo of repos) {
    const which = hook.merge_request
      ? eq(mergeRequests.mrIid, hook.merge_request.iid)
      : ref
        ? and(eq(mergeRequests.sourceBranch, ref), eq(mergeRequests.state, 'opened'))
        : undefined
    if (!which) continue
    const mrs = await ctx.tx
      .update(mergeRequests)
      .set({ pipeline: status, updatedAt: sql`now()` })
      .where(and(eq(mergeRequests.repoId, repo.id), which))
      .returning()
    for (const mr of mrs) {
      matched = true
      if (status !== 'failed' || !mr.workItemId) continue
      await lockKey(ctx, `gitlab-pipeline:${mr.id}:${pipelineId}`)
      const [seen] = await ctx.tx
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.type, 'gitlab.pipeline'),
            eq(events.workItemId, mr.workItemId),
            sql`${events.payload}->>'mergeRequestId' = ${mr.id}`,
            sql`${events.payload}->>'pipelineId' = ${String(pipelineId)}`,
          ),
        )
        .limit(1)
      if (!seen) {
        await recordEvent(ctx, {
          type: 'gitlab.pipeline',
          projectId: repo.projectId,
          workItemId: mr.workItemId,
          taskId: null,
          payload: { mergeRequestId: mr.id, repoId: repo.id, path: repo.pathWithNamespace, mrIid: mr.mrIid, pipelineId, status },
        })
      }
      const task = await implementTask(ctx.tx, mr.workItemId)
      if (task?.assigneeId) {
        await notify(ctx, {
          personId: task.assigneeId,
          kind: 'work_item_stuck',
          title: clip(`ไปป์ไลน์ไม่ผ่าน: ${mr.title}`, 300),
          body: task.itemTitle,
          link: `/todo/${task.id}`,
          dedupeKey: `pipeline:${mr.id}:${pipelineId}`,
        })
      }
    }
  }
  return matched ? OK : IGNORED
}

async function onNote(ctx: WorkCtx, hook: z.infer<typeof NoteHook>, botUserId: number | null): Promise<WebhookResult> {
  const a = hook.object_attributes
  if (a.noteable_type !== 'Issue' || !hook.issue || a.system) return IGNORED
  if (botUserId !== null && hook.user.id === botUserId) return IGNORED
  const text = sanitizeNote(a.note)
  if (!text) return IGNORED
  const links = await ctx.tx
    .select({ workItemId: workItemRepos.workItemId, repo: projectRepos })
    .from(workItemRepos)
    .innerJoin(projectRepos, eq(projectRepos.id, workItemRepos.repoId))
    .where(and(eq(projectRepos.gitlabProjectId, hook.project.id), eq(workItemRepos.issueIid, hook.issue.iid)))
  if (!links.length) return IGNORED
  const author = clip(hook.user.username.replace(/[^\w.-]/g, ''), 100)
  const sourceRef = `gitlab-note:${hook.project.id}:${a.id}`
  for (const { workItemId, repo } of links) {
    // One entry per note, however often GitLab delivers it.
    await lockKey(ctx, `${sourceRef}:${workItemId}`)
    const [seen] = await ctx.tx
      .select({ id: knowledgeEntries.id })
      .from(knowledgeEntries)
      .where(and(eq(knowledgeEntries.workItemId, workItemId), eq(knowledgeEntries.sourceKind, 'gitlab'), eq(knowledgeEntries.sourceRef, sourceRef)))
      .limit(1)
    if (seen) continue
    await recordEvent(ctx, {
      type: 'gitlab.note',
      projectId: repo.projectId,
      workItemId,
      taskId: null,
      payload: { repoId: repo.id, path: repo.pathWithNamespace, issueIid: hook.issue.iid, noteId: a.id, author, excerpt: clip(text, NOTE_EXCERPT) },
    })
    // A draft for staff to review; nothing (secretary, AI) acts on it automatically.
    await createEntry(ctx, null, {
      scope: 'work_item',
      workItemId,
      type: 'progress',
      title: clip(`GitLab ${repo.pathWithNamespace}#${hook.issue.iid}: @${author}`, 300),
      body: clip(text, NOTE_BODY),
      noAi: false,
      status: 'draft',
      sourceKind: 'gitlab',
      sourceRef,
    })
  }
  return OK
}
