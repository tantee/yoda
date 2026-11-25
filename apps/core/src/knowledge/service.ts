import { randomUUID } from 'node:crypto'
import type {
  KnowledgeCreate,
  KnowledgeEntry,
  KnowledgeScope,
  KnowledgeStatus,
  KnowledgeType,
  KnowledgeUpdate,
  Me,
  SourceKind,
} from '@yoda/shared'
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { forbidden, invalidState, notFound } from '../auth/plugin.js'
import { AiRefused, errorSummary, type AiGateway } from '../ai/gateway.js'
import type { AttachmentRow } from '../attachments/service.js'
import type { Db, Tx } from '../db/client.js'
import { attachments, knowledgeChunks, knowledgeEntries, people, projectMembers, projects, workItems } from '../db/schema.js'
import { queueIssueSync } from '../gitlab/sync.js'
import type { JobRun } from '../jobs/queue.js'
import { canSeeProject } from '../work/queries.js'
import { recordEvent, runWork, type WorkCtx, type WorkDeps } from '../work/context.js'
import { chunkText } from './chunk.js'

type Conn = Db | Tx
export type EntryRow = typeof knowledgeEntries.$inferSelect

export type CreateInput = KnowledgeCreate & {
  status?: KnowledgeStatus
  sourceKind?: SourceKind
  sourceRef?: string | null
  attachmentId?: string | null
}

// ---------- reads ----------

export const entryColumns = {
  id: knowledgeEntries.id,
  lineageId: knowledgeEntries.lineageId,
  version: knowledgeEntries.version,
  scope: knowledgeEntries.scope,
  projectId: knowledgeEntries.projectId,
  workItemId: knowledgeEntries.workItemId,
  type: knowledgeEntries.type,
  title: knowledgeEntries.title,
  body: knowledgeEntries.body,
  status: knowledgeEntries.status,
  sourceKind: knowledgeEntries.sourceKind,
  sourceRef: knowledgeEntries.sourceRef,
  noAi: knowledgeEntries.noAi,
  attachmentId: knowledgeEntries.attachmentId,
  createdById: knowledgeEntries.createdBy,
  createdByName: people.displayName,
  supersededAt: knowledgeEntries.supersededAt,
  createdAt: knowledgeEntries.createdAt,
}

type EntrySelect = Awaited<ReturnType<typeof selectEntries>>[number]

export function toEntry(r: EntrySelect): KnowledgeEntry {
  return {
    ...r,
    scope: r.scope as KnowledgeScope,
    type: r.type as KnowledgeType,
    status: r.status as KnowledgeStatus,
    sourceKind: r.sourceKind as SourceKind,
    supersededAt: r.supersededAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }
}

function selectEntries(db: Conn) {
  return db.select(entryColumns).from(knowledgeEntries).leftJoin(people, eq(people.id, knowledgeEntries.createdBy))
}

/** Department entries: every staff member. Project / work-item entries: project members and admins. */
async function canRead(db: Conn, me: Me, row: { projectId: string | null }): Promise<boolean> {
  if (!me.isStaff) return false
  return row.projectId === null || canSeeProject(db, me, row.projectId)
}

/** SQL condition: entries `me` may read. */
export function visibleTo(me: Me): SQL | undefined {
  if (me.isAdmin) return undefined
  return or(
    isNull(knowledgeEntries.projectId),
    inArray(
      knowledgeEntries.projectId,
      sql`(select ${projectMembers.projectId} from ${projectMembers} where ${projectMembers.personId} = ${me.id})`,
    ),
  )
}

/** Any version, or null when missing or not visible. */
export async function getEntry(db: Conn, me: Me, id: string): Promise<KnowledgeEntry | null> {
  const [r] = await selectEntries(db).where(eq(knowledgeEntries.id, id))
  if (!r || !(await canRead(db, me, r))) return null
  return toEntry(r)
}

/** All versions of the entry's lineage, oldest first; null when not visible. */
export async function listVersions(db: Conn, me: Me, id: string): Promise<KnowledgeEntry[] | null> {
  const entry = await getEntry(db, me, id)
  if (!entry) return null
  const rows = await selectEntries(db)
    .where(eq(knowledgeEntries.lineageId, entry.lineageId))
    .orderBy(asc(knowledgeEntries.version))
  return rows.map(toEntry)
}

/** Current versions, newest first. Callers check project / work item visibility for the filters. */
export async function listEntries(
  db: Conn,
  me: Me,
  f: { projectId?: string; workItemId?: string; type?: KnowledgeType; status?: KnowledgeStatus; limit?: number },
): Promise<KnowledgeEntry[]> {
  const conds: (SQL | undefined)[] = [isNull(knowledgeEntries.supersededAt), visibleTo(me)]
  if (f.projectId) conds.push(eq(knowledgeEntries.projectId, f.projectId))
  if (f.workItemId) conds.push(eq(knowledgeEntries.workItemId, f.workItemId))
  if (f.type) conds.push(eq(knowledgeEntries.type, f.type))
  if (f.status) conds.push(eq(knowledgeEntries.status, f.status))
  const rows = await selectEntries(db)
    .where(and(...conds))
    .orderBy(desc(knowledgeEntries.createdAt), desc(knowledgeEntries.id))
    .limit(f.limit ?? 200)
  return rows.map(toEntry)
}

/** Project of a work item, or null when it does not exist. */
export async function workItemProject(db: Conn, workItemId: string): Promise<string | null> {
  const [w] = await db.select({ projectId: workItems.projectId }).from(workItems).where(eq(workItems.id, workItemId))
  return w?.projectId ?? null
}

// ---------- writes ----------

/**
 * Write = project members (any role) or admin; department = admin. `me` null is the system (no checks).
 * Non-visible projects answer 404 so ids are never probed.
 */
async function assertWritable(tx: Tx, me: Me | null, projectId: string | null): Promise<void> {
  if (!me) return
  if (!me.isStaff) throw forbidden()
  if (projectId === null) {
    if (!me.isAdmin) throw forbidden()
    return
  }
  if (!(await canSeeProject(tx, me, projectId))) throw notFound()
}

async function recordKnowledgeEvent(
  ctx: WorkCtx,
  type: 'knowledge.created' | 'knowledge.updated' | 'knowledge.confirmed',
  row: EntryRow,
): Promise<void> {
  // Department entries record no events: events belong to a project.
  if (!row.projectId) return
  await recordEvent(ctx, {
    type,
    projectId: row.projectId,
    workItemId: row.workItemId,
    taskId: null,
    payload: { entryId: row.id, lineageId: row.lineageId, version: row.version, title: row.title },
  })
}

export async function createEntry(ctx: WorkCtx, me: Me | null, input: CreateInput): Promise<string> {
  const { tx } = ctx
  let projectId: string | null = null
  let workItemId: string | null = null
  if (input.scope === 'project') {
    if (!input.projectId) throw notFound()
    const [p] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId))
    if (!p) throw notFound()
    projectId = p.id
  } else if (input.scope === 'work_item') {
    if (!input.workItemId) throw notFound()
    projectId = await workItemProject(tx, input.workItemId)
    if (!projectId || (input.projectId && input.projectId !== projectId)) throw notFound()
    workItemId = input.workItemId
  }
  await assertWritable(tx, me, projectId)

  const sourceKind = input.sourceKind ?? 'person'
  const status = input.status ?? (sourceKind === 'ai' ? 'draft' : 'confirmed')
  const [row] = await tx
    .insert(knowledgeEntries)
    .values({
      lineageId: randomUUID(),
      version: 1,
      scope: input.scope,
      projectId,
      workItemId,
      type: input.type,
      title: input.title,
      body: input.body ?? '',
      status,
      sourceKind,
      sourceRef: input.sourceRef ?? null,
      noAi: input.noAi ?? false,
      attachmentId: input.attachmentId ?? null,
      createdBy: ctx.actorId,
    })
    .returning()
  await recordKnowledgeEvent(ctx, 'knowledge.created', row!)
  ctx.jobs.push({ name: 'embed-entry', id: row!.id })
  await queueIssueResync(ctx, row!)
  return row!.id
}

/** Locks the row; 404 unless it exists and is visible, 403/404 unless writable, 409 if superseded. */
async function lockCurrent(ctx: WorkCtx, me: Me | null, id: string): Promise<EntryRow> {
  const [row] = await ctx.tx.select().from(knowledgeEntries).where(eq(knowledgeEntries.id, id)).for('update')
  if (!row) throw notFound()
  if (me && !(await canRead(ctx.tx, me, row))) throw notFound()
  await assertWritable(ctx.tx, me, row.projectId)
  if (row.supersededAt) throw invalidState()
  return row
}

async function insertNextVersion(
  ctx: WorkCtx,
  old: EntryRow,
  changes: Partial<Pick<EntryRow, 'title' | 'body' | 'noAi' | 'status'>>,
  event: 'knowledge.updated' | 'knowledge.confirmed',
): Promise<string> {
  await ctx.tx.update(knowledgeEntries).set({ supersededAt: new Date() }).where(eq(knowledgeEntries.id, old.id))
  const { id: _id, createdAt: _c, supersededAt: _s, createdBy: _b, ...rest } = old
  const [row] = await ctx.tx
    .insert(knowledgeEntries)
    .values({ ...rest, ...changes, version: old.version + 1, createdBy: ctx.actorId })
    .returning()
  await recordKnowledgeEvent(ctx, event, row!)
  ctx.jobs.push({ name: 'embed-entry', id: row!.id })
  await queueIssueResync(ctx, row!)
  return row!.id
}

/** A confirmed document / decision on a work item that already has GitLab issues refreshes their section. */
async function queueIssueResync(ctx: WorkCtx, row: EntryRow): Promise<void> {
  if (!row.workItemId || row.status !== 'confirmed' || (row.type !== 'document' && row.type !== 'decision')) return
  await queueIssueSync(ctx, row.workItemId, { withIssues: true })
}

/** New version with the patch applied; a person's edit verifies the entry (status confirmed). */
export async function updateEntry(ctx: WorkCtx, me: Me | null, id: string, patch: KnowledgeUpdate): Promise<string> {
  const old = await lockCurrent(ctx, me, id)
  const changes: Partial<Pick<EntryRow, 'title' | 'body' | 'noAi' | 'status'>> = {}
  if (patch.title !== undefined) changes.title = patch.title
  if (patch.body !== undefined) changes.body = patch.body
  if (patch.noAi !== undefined) changes.noAi = patch.noAi
  if (me) changes.status = 'confirmed'
  return insertNextVersion(ctx, old, changes, 'knowledge.updated')
}

/** draft → confirmed as a new version. */
export async function confirmEntry(ctx: WorkCtx, me: Me | null, id: string): Promise<string> {
  const old = await lockCurrent(ctx, me, id)
  if (old.status !== 'draft') throw invalidState()
  return insertNextVersion(ctx, old, { status: 'confirmed' }, 'knowledge.confirmed')
}

// ---------- attachments ----------

/** Upload hook: a text-bearing attachment becomes a confirmed `document` entry. */
export async function createAttachmentEntry(deps: WorkDeps, a: AttachmentRow, text: string | null): Promise<string | null> {
  // Conversation attachments (no project) never become knowledge entries.
  const projectId = a.projectId
  if (!text?.trim() || !projectId) return null
  return runWork(deps, { id: a.uploadedBy, kind: 'person' }, (ctx) =>
    createEntry(ctx, null, {
      scope: a.workItemId ? 'work_item' : 'project',
      projectId,
      workItemId: a.workItemId ?? undefined,
      type: 'document',
      title: a.fileName,
      body: text,
      noAi: a.noAi,
      status: 'confirmed',
      sourceKind: 'upload',
      attachmentId: a.id,
    }),
  )
}

/**
 * Applies an attachment's noAi change to its current entry. Setting it copies `true` onto the entry in place
 * (a handling rule, not content, so no new version). Clearing it never clears the entry's own flag: the
 * entry may have been marked noAi itself. Either way the entry is re-chunked so embeddings follow the
 * effective flag (entry noAi OR attachment noAi), which embedEntry and forAi search check separately.
 */
export async function propagateAttachmentNoAi(ctx: WorkCtx, attachmentId: string, noAi: boolean): Promise<void> {
  const current = and(eq(knowledgeEntries.attachmentId, attachmentId), isNull(knowledgeEntries.supersededAt))
  const rows = noAi
    ? await ctx.tx.update(knowledgeEntries).set({ noAi: true }).where(current).returning({ id: knowledgeEntries.id })
    : await ctx.tx.select({ id: knowledgeEntries.id }).from(knowledgeEntries).where(current)
  for (const r of rows) ctx.jobs.push({ name: 'embed-entry', id: r.id })
}

// ---------- embedding job ----------

/**
 * Re-chunks the entry and embeds the chunks. `noAi` entries (or entries of `noAi` attachments) are chunked
 * but never embedded; refusals (noAi project, budget) store chunks without vectors; other AI failures are
 * retried, and on the final attempt chunks are stored without vectors so trigram search still works.
 */
export async function embedEntry(deps: { db: Db; ai: Pick<AiGateway, 'embed'> }, run: JobRun): Promise<void> {
  const { db, ai } = deps
  const [row] = await db
    .select({
      id: knowledgeEntries.id,
      projectId: knowledgeEntries.projectId,
      title: knowledgeEntries.title,
      body: knowledgeEntries.body,
      noAi: knowledgeEntries.noAi,
      attachmentNoAi: attachments.noAi,
      supersededAt: knowledgeEntries.supersededAt,
    })
    .from(knowledgeEntries)
    .leftJoin(attachments, eq(attachments.id, knowledgeEntries.attachmentId))
    .where(eq(knowledgeEntries.id, run.id))
  if (!row || row.supersededAt) return

  const texts = chunkText(`${row.title}\n\n${row.body}`)
  let vectors: number[][] | null = null
  if (texts.length && !row.noAi && !row.attachmentNoAi) {
    try {
      vectors = await ai.embed({ projectId: row.projectId, texts })
    } catch (err) {
      if (!(err instanceof AiRefused)) {
        if (!run.isFinalAttempt) throw err
        console.warn(`embed-entry ${row.id}: storing chunks without embeddings after final attempt: ${errorSummary(err)}`)
      }
      vectors = null
    }
  }

  await db.transaction(async (tx) => {
    // Serialize concurrent re-chunks of one entry; recheck it is still there.
    const [locked] = await tx
      .select({ noAi: knowledgeEntries.noAi, attachmentNoAi: attachments.noAi, supersededAt: knowledgeEntries.supersededAt })
      .from(knowledgeEntries)
      .leftJoin(attachments, eq(attachments.id, knowledgeEntries.attachmentId))
      .where(eq(knowledgeEntries.id, row.id))
      .for('update', { of: knowledgeEntries })
    if (!locked || locked.supersededAt) return
    // A flag may have been set while embedding ran; never keep vectors for noAi content.
    if (locked.noAi || locked.attachmentNoAi) vectors = null
    await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.entryId, row.id))
    if (!texts.length) return
    await tx.insert(knowledgeChunks).values(
      texts.map((text, idx) => ({ entryId: row.id, idx, text, embedding: vectors?.[idx] ?? null })),
    )
  })
}
