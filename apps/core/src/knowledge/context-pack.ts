import { ContextPack, type Me, type PackEntry } from '@yoda/shared'
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { AiRefused, type AiGateway } from '../ai/gateway.js'
import type { Db } from '../db/client.js'
import { attachments, knowledgeEntries, projects, tasks, workItems } from '../db/schema.js'
import { tasksWithContext } from '../work/queries.js'
import { searchKnowledge } from './search.js'
import { notGitLabDraft } from './service.js'

export const PACK_MAX_CHARS = 60_000
const PROGRESS_LIMIT = 10
const RELATED_LIMIT = 8
const ENTRY_LIMIT = 50
const MARKER = '…[truncated]'

/**
 * Pack building is a system action, not a user's. Search takes a `Me` only to decide visibility; an admin-like
 * identity skips the per-user filter, and the project filter still scopes it to the task's project plus
 * department entries (the same set the pack reads directly). Chosen over a second search function so
 * ranking, `forAi` filtering and embedding stay in one place.
 */
export const SYSTEM_ME: Me = { id: '00000000-0000-0000-0000-000000000000', username: 'system', displayName: 'system', email: null, isAdmin: true, isStaff: true }

/** SQL conditions that keep anything flagged "do not send to AI" out of a prompt. */
const sendable: SQL[] = [
  notGitLabDraft(),
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
export async function currentEntries(
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
  /** `me`: whose visibility the related-knowledge search uses (a runner's owner); the system by default. */
  opts: { maxChars?: number; me?: Me } = {},
): Promise<{ pack: ContextPack; overBudget: boolean }> {
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
      if (text) parts.push(`File ${oneLine(a.fileName)}:\n${text}`)
    }
    return { title: oneLine(i.title.en), text: parts.filter(Boolean).join('\n\n') }
  })

  const scope = { workItemId: t.workItemId, projectId: t.projectId }
  const [documents, decisions, progress, memory] = await Promise.all([
    currentEntries(db, scope, 'document', { confirmedOnly: true, limit: ENTRY_LIMIT }),
    currentEntries(db, scope, 'decision', { confirmedOnly: true, department: true, limit: ENTRY_LIMIT }),
    currentEntries(db, scope, 'progress', { workItemOnly: true, limit: PROGRESS_LIMIT }),
    currentEntries(db, scope, 'memory', { workItemOnly: true }),
  ])

  const included = new Set([...documents, ...decisions, ...progress, ...memory].map((e) => e.id))
  const hits = await searchKnowledge(
    db,
    opts.me ?? SYSTEM_ME,
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
  return fit(pack, opts.maxChars ?? PACK_MAX_CHARS)
}

/** Shortens `text` by exactly `by` characters, the last ones being the marker. */
function shorten(text: string, by: number): string {
  return text.slice(0, Math.max(0, text.length - by - MARKER.length)) + MARKER
}

/** Collapses newlines so a value is safe inside a heading or bold span. */
const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim()

/**
 * Stored text inside a `~~~text` fence, so it can never pose as a heading of the pack. Every `~` followed by
 * another gets a backslash, so no run of tildes in the text can close the fence.
 */
export const fence = (text: string) => `~~~text\n${text.replace(/~(?=~)/g, '~\\')}\n~~~`

const blockOf = (e: PackEntry) => `### ${draft(e)}${oneLine(e.title)}\n\n${fence(e.text.trimEnd())}`
/** Characters one entry adds to the rendered document (block plus its line break). */
const entryCost = (e: PackEntry) => blockOf(e).length + 1
/** Extra characters a section heading adds when its list is non-empty. */
const headingCost = (h: string) => `## ${h}`.length + 3

/**
 * Drops `related`, then `progress`, then truncates documents, then the remaining optional lists, and inputs last.
 * The overage is tracked arithmetically (each removal subtracts its rendered length) so cost is near-linear;
 * a real render confirms after each pass. `overBudget` is true when nothing more can go and it still exceeds.
 */
function fit(pack: ContextPack, maxChars: number): { pack: ContextPack; overBudget: boolean } {
  const real = () => renderContextPack(pack).length - maxChars
  for (let pass = 0; pass < 4; pass++) {
    let o = real()
    if (o <= 0) return { pack, overBudget: false }
    const dropLast = (list: PackEntry[], heading: string) => {
      while (list.length && o > 0) {
        o -= entryCost(list.pop()!)
        if (!list.length) o -= headingCost(heading)
      }
    }
    dropLast(pack.related, 'Related knowledge')
    dropLast(pack.progress, 'Recent progress')
    // Truncate document texts, largest first, by exactly what is missing.
    for (const d of [...pack.documents].sort((x, y) => y.text.length - x.text.length)) {
      if (o <= 0) break
      const cut = Math.min(o, d.text.length)
      if (d.text.length > MARKER.length && cut > 0) {
        d.text = shorten(d.text, cut)
        o -= cut
      }
    }
    dropLast(pack.memory, 'Working memory')
    dropLast(pack.decisions, 'Decisions')
    dropLast(pack.documents, 'Confirmed documents')
    // Inputs last, from the final one backwards, cutting exactly the overage.
    for (const i of [...pack.inputs].reverse()) {
      if (o <= 0) break
      const cut = Math.min(o, i.text.length)
      if (i.text.length > MARKER.length && cut > 0) {
        i.text = shorten(i.text, cut)
        o -= cut
      }
    }
  }
  return { pack, overBudget: real() > 0 }
}

const draft = (e: PackEntry) => (e.status === 'draft' ? '[UNVERIFIED DRAFT] ' : '')

function section(heading: string, entries: PackEntry[]): string[] {
  if (!entries.length) return []
  return [`## ${heading}`, '', ...entries.map(blockOf), '']
}

/** Repositories and the branch a runner works on (see runners/work.ts). */
export type RunCode = {
  repos: { repoId: string; path: string; webUrl: string; defaultBranch: string | null; issueIid: number | null; issueUrl: string | null }[]
  branch: string
}

/** The `# Code` section of a runner's pack: where to work and which issue the merge request closes. */
export function renderCode(code: RunCode): string {
  const lines = ['# Code', '', `Branch: \`${code.branch}\` (core opens the merge request; never push the default branch)`, '']
  for (const r of code.repos) {
    lines.push(`- ${oneLine(r.path)} (${r.webUrl}), default branch ${r.defaultBranch ?? 'none'}`)
    if (r.issueUrl) lines.push(`  Issue #${r.issueIid}: ${r.issueUrl}`)
  }
  if (!code.repos.length) lines.push('No repository is linked to this work item.')
  return lines.join('\n') + '\n'
}

/**
 * Markdown for the prompt. Sections: task, work item, project, inputs, documents, decisions, progress, memory,
 * related. Stored text (descriptions, feedback, inputs, knowledge) is fenced; `code` appends a `# Code` section.
 */
export function renderContextPack(pack: ContextPack, code?: RunCode): string {
  const { task, workItem, project } = pack
  const lines = [
    '# Task',
    '',
    `**${oneLine(task.title.en)}** / ${oneLine(task.title.th)}`,
    `Step: ${task.stepKey}, attempt ${task.attempt}`,
    '',
    task.instructions.en,
    '',
    task.instructions.th,
    '',
  ]
  if (task.feedback) lines.push('## Changes requested', '', fence(task.feedback), '')
  lines.push('# Work item', '', `**${oneLine(workItem.title)}** (priority: ${workItem.priority})`, '', workItem.description ? fence(workItem.description) : '', '')
  lines.push('# Project', '', `**${oneLine(project.name)}**`, '', project.description, '')
  if (pack.inputs.length) {
    lines.push('## Inputs from previous steps', '')
    for (const i of pack.inputs) lines.push(`### ${oneLine(i.title)}`, '', fence(i.text.trimEnd()), '')
  }
  lines.push(
    ...section('Confirmed documents', pack.documents),
    ...section('Decisions', pack.decisions),
    ...section('Recent progress', pack.progress),
    ...section('Working memory', pack.memory),
    ...section('Related knowledge', pack.related),
  )
  const md = lines.join('\n').trimEnd() + '\n'
  return code ? `${md}\n${renderCode(code)}` : md
}
