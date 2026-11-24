import { ContextPack, type Me, type PackEntry } from '@yoda/shared'
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { AiRefused, type AiGateway } from '../ai/gateway.js'
import type { Db } from '../db/client.js'
import { attachments, knowledgeEntries, projects, tasks, workItems } from '../db/schema.js'
import { tasksWithContext } from '../work/queries.js'
import { searchKnowledge } from './search.js'

const DEFAULT_MAX_CHARS = 60_000
const PROGRESS_LIMIT = 10
const RELATED_LIMIT = 8
const MARKER = '…[truncated]'

/**
 * Pack building is a system action, not a user's. Search takes a `Me` only to decide visibility; an admin-like
 * identity skips the per-user filter, and the project filter still scopes it to the task's project plus
 * department entries (the same set the pack reads directly). Chosen over a second search function so
 * ranking, `forAi` filtering and embedding stay in one place.
 */
const SYSTEM_ME: Me = { id: '00000000-0000-0000-0000-000000000000', username: 'system', displayName: 'system', email: null, isAdmin: true, isStaff: true }

/** SQL conditions that keep anything flagged "do not send to AI" out of a prompt. */
const sendable: SQL[] = [
  sql`not ${knowledgeEntries.noAi}`,
  sql`not exists (select 1 from attachments a where a.id = ${knowledgeEntries.attachmentId} and a.no_ai)`,
  sql`not exists (select 1 from projects p where p.id = ${knowledgeEntries.projectId} and p.no_ai)`,
]

type Row = typeof knowledgeEntries.$inferSelect

const toPackEntry = (r: Pick<Row, 'id' | 'title' | 'body' | 'status' | 'type'>): PackEntry => ({
  id: r.id,
  title: r.title,
  text: r.body,
  status: r.status as PackEntry['status'],
  type: r.type as PackEntry['type'],
})

/** Current entries of a type: work item first, then project, then department, newest first inside each. */
async function currentEntries(
  db: Db,
  w: { workItemId: string; projectId: string },
  type: Row['type'],
  o: { confirmedOnly?: boolean; department?: boolean; workItemOnly?: boolean; limit?: number },
): Promise<PackEntry[]> {
  const scopes: (SQL | undefined)[] = [eq(knowledgeEntries.workItemId, w.workItemId)]
  if (!o.workItemOnly) {
    scopes.push(and(eq(knowledgeEntries.projectId, w.projectId), isNull(knowledgeEntries.workItemId)))
    if (o.department) scopes.push(isNull(knowledgeEntries.projectId))
  }
  const conds = [
    eq(knowledgeEntries.type, type),
    isNull(knowledgeEntries.supersededAt),
    or(...scopes),
    ...(o.confirmedOnly ? [eq(knowledgeEntries.status, 'confirmed')] : []),
    ...sendable,
  ]
  const rank = sql`case when ${knowledgeEntries.workItemId} is not null then 0 when ${knowledgeEntries.projectId} is not null then 1 else 2 end`
  const q = db
    .select()
    .from(knowledgeEntries)
    .where(and(...conds))
    .orderBy(rank, desc(knowledgeEntries.createdAt), desc(knowledgeEntries.id))
  return (o.limit ? await q.limit(o.limit) : await q).map(toPackEntry)
}

/**
 * Everything an AI session needs for one task. Throws `AiRefused('no_ai')` for a noAi project. Content flagged
 * noAi (entry, its attachment, or the whole project) and noAi attachments' extracted text never appear. The
 * result renders to at most `maxChars` (when the fixed task / work item / project header fits).
 */
export async function buildContextPack(
  deps: { db: Db; ai?: Pick<AiGateway, 'embed'> | null },
  taskId: string,
  opts: { maxChars?: number } = {},
): Promise<ContextPack> {
  const { db } = deps
  const [t] = await tasksWithContext(db, eq(tasks.id, taskId), [])
  if (!t) throw new Error(`task ${taskId} not found`)
  const [project] = await db.select().from(projects).where(eq(projects.id, t.projectId))
  const [item] = await db.select().from(workItems).where(eq(workItems.id, t.workItemId))
  if (!project || !item) throw new Error(`task ${taskId} has no project or work item`)
  if (project.noAi) throw new AiRefused('no_ai')

  // Inputs: dependency results plus extracted text of their attachments, unless flagged noAi.
  const allowedFiles = t.inputs.flatMap((i) => i.attachments).filter((a) => !a.noAi && a.hasText)
  const texts = allowedFiles.length
    ? await db
        .select({ id: attachments.id, text: attachments.extractedText })
        .from(attachments)
        .where(and(inArray(attachments.id, allowedFiles.map((a) => a.id)), eq(attachments.noAi, false)))
    : []
  const textOf = new Map(texts.map((x) => [x.id, x.text ?? '']))
  const inputs = t.inputs.map((i) => {
    const parts = [i.result.text.trim()]
    for (const a of i.attachments) {
      const text = a.noAi ? '' : textOf.get(a.id)?.trim()
      if (text) parts.push(`File ${a.fileName}:\n${text}`)
    }
    return { title: i.title.en, text: parts.filter(Boolean).join('\n\n') }
  })

  const scope = { workItemId: t.workItemId, projectId: t.projectId }
  const [documents, decisions, progress, memory] = await Promise.all([
    currentEntries(db, scope, 'document', { confirmedOnly: true }),
    currentEntries(db, scope, 'decision', { confirmedOnly: true, department: true }),
    currentEntries(db, scope, 'progress', { workItemOnly: true, limit: PROGRESS_LIMIT }),
    currentEntries(db, scope, 'memory', { workItemOnly: true }),
  ])

  const included = new Set([...documents, ...decisions, ...progress, ...memory].map((e) => e.id))
  const hits = await searchKnowledge(
    db,
    SYSTEM_ME,
    { query: `${item.title} ${t.title.en}`, projectId: t.projectId, limit: RELATED_LIMIT, forAi: true },
    deps.ai,
  )
  const related = hits.filter((h) => !included.has(h.id)).map(toPackEntry)

  const pack = ContextPack.parse({
    task: { id: t.id, title: t.title, instructions: t.instructions, feedback: t.feedback, stepKey: t.stepKey, attempt: t.attempt },
    workItem: { id: item.id, title: item.title, description: item.description, priority: item.priority },
    project: { id: project.id, name: project.name, description: project.description },
    inputs,
    documents,
    decisions,
    progress,
    memory,
    related,
  })
  return fit(pack, opts.maxChars ?? DEFAULT_MAX_CHARS)
}

/** Shortens `text` by `by` characters, ending with the marker. */
function shorten(text: string, by: number): string {
  const keep = Math.max(0, text.length - by - MARKER.length)
  return text.slice(0, keep) + MARKER
}

/** Drops `related`, then `progress`, then truncates documents, then the remaining optional lists, and inputs last. */
function fit(pack: ContextPack, maxChars: number): ContextPack {
  const over = () => renderContextPack(pack).length - maxChars
  const dropLast = (list: PackEntry[]) => {
    while (list.length && over() > 0) list.pop()
  }
  if (over() <= 0) return pack
  dropLast(pack.related)
  dropLast(pack.progress)
  // Truncate document texts, largest first, by exactly what is missing.
  for (const d of [...pack.documents].sort((a, b) => b.text.length - a.text.length)) {
    const o = over()
    if (o <= 0) return pack
    if (d.text.length > MARKER.length) d.text = shorten(d.text, Math.min(o, d.text.length))
  }
  dropLast(pack.memory)
  dropLast(pack.decisions)
  dropLast(pack.documents)
  // Inputs last, from the final one backwards.
  for (const i of [...pack.inputs].reverse()) {
    const o = over()
    if (o <= 0) break
    if (i.text.length > MARKER.length) i.text = shorten(i.text, Math.min(o + MARKER.length, i.text.length))
  }
  return pack
}

const draft = (e: PackEntry) => (e.status === 'draft' ? '[UNVERIFIED DRAFT] ' : '')

function section(heading: string, entries: PackEntry[]): string[] {
  if (!entries.length) return []
  return [`## ${heading}`, '', ...entries.map((e) => `### ${draft(e)}${e.title}\n\n${e.text}`.trimEnd()), '']
}

/** Markdown for the prompt. Sections: task, work item, project, inputs, documents, decisions, progress, memory, related. */
export function renderContextPack(pack: ContextPack): string {
  const { task, workItem, project } = pack
  const lines = [
    '# Task',
    '',
    `**${task.title.en}** / ${task.title.th}`,
    `Step: ${task.stepKey}, attempt ${task.attempt}`,
    '',
    task.instructions.en,
    '',
    task.instructions.th,
    '',
  ]
  if (task.feedback) lines.push('## Changes requested', '', task.feedback, '')
  lines.push('# Work item', '', `**${workItem.title}** (priority: ${workItem.priority})`, '', workItem.description, '')
  lines.push('# Project', '', `**${project.name}**`, '', project.description, '')
  if (pack.inputs.length) {
    lines.push('## Inputs from previous steps', '')
    for (const i of pack.inputs) lines.push(`### ${i.title}`, '', i.text, '')
  }
  lines.push(
    ...section('Confirmed documents', pack.documents),
    ...section('Decisions', pack.decisions),
    ...section('Recent progress', pack.progress),
    ...section('Working memory', pack.memory),
    ...section('Related knowledge', pack.related),
  )
  return lines.join('\n').trimEnd() + '\n'
}
