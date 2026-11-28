import { DEFECT_SENSITIVE_TITLE, type Me } from '@yoda/shared'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import type { Db, Tx } from '../db/client.js'
import { defectReports, projectMembers, workItems } from '../db/schema.js'

/**
 * What AI may see of a defect (plan decision 11). A sensitive defect's text lives only in `defect_reports` (its
 * work item description is the withheld marker), and every AI path shows `DEFECT_SENSITIVE_TITLE` instead of
 * its title. People and outside notifications keep the real title.
 */

type Conn = Db | Tx

/** The ids, among `workItemIds`, of sensitive defects. */
export async function sensitiveDefectIds(db: Conn, workItemIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(workItemIds)]
  if (!ids.length) return new Set()
  const rows = await db
    .select({ id: defectReports.workItemId })
    .from(defectReports)
    .where(and(inArray(defectReports.workItemId, ids), eq(defectReports.sensitive, true)))
  return new Set(rows.map((r) => r.id))
}

/** The title AI may see: the neutral one for a sensitive defect, else the item's own. */
export function aiTitle(item: { id: string; title: string }, sensitive: ReadonlySet<string>, lang: 'th' | 'en'): string {
  return sensitive.has(item.id) ? DEFECT_SENSITIVE_TITLE[lang] : item.title
}

/** `aiTitle` for one item, reading its sensitivity. */
export async function aiTitleOf(db: Conn, item: { id: string; title: string }, lang: 'th' | 'en'): Promise<string> {
  return aiTitle(item, await sensitiveDefectIds(db, [item.id]), lang)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Titles this short are replaced only by id, never by text search (they would match ordinary words). */
const MIN_TEXT_MATCH = 4

/** Plain JSON-like objects only: a Date or class instance is left as it is. */
const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)

function strings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) strings(v, out)
  else if (isPlain(value)) for (const v of Object.values(value)) strings(v, out)
}

function ids(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) for (const v of value) ids(v, out)
  else if (isPlain(value)) {
    const id = (value as Record<string, unknown>).workItemId
    if (typeof id === 'string' && UUID_RE.test(id)) out.add(id)
    for (const v of Object.values(value)) ids(v, out)
  }
}

/**
 * A secretary tool's result with every sensitive defect's title replaced by `DEFECT_SENSITIVE_TITLE.th`:
 * - `title` and `workItem` of any object whose `workItemId` is a sensitive defect;
 * - any occurrence of a sensitive defect's title (4 characters or more) in any string, e.g. a priority
 *   proposal's summary, which names the item without its id. Only defects in projects `me` may see are
 *   matched by text, so the redaction never reveals a title from elsewhere.
 * Applied once, in the tools' `guarded()` wrapper, so no tool can forget it.
 */
export async function redactToolOutput(db: Conn, me: Me, output: unknown): Promise<unknown> {
  const text: string[] = []
  strings(output, text)
  if (!text.length) return output
  const byId = new Set<string>()
  ids(output, byId)
  const haystack = text.join('\n')
  const textMatch = and(
    sql`char_length(${workItems.title}) >= ${MIN_TEXT_MATCH} and strpos(${haystack}, ${workItems.title}) > 0`,
    me.isAdmin
      ? undefined
      : sql`exists (select 1 from ${projectMembers} pm where pm.project_id = ${workItems.projectId} and pm.person_id = ${me.id})`,
  )!
  const rows = await db
    .select({ id: workItems.id, title: workItems.title })
    .from(defectReports)
    .innerJoin(workItems, eq(workItems.id, defectReports.workItemId))
    .where(
      and(
        eq(defectReports.sensitive, true),
        byId.size ? or(inArray(workItems.id, [...byId]), textMatch) : textMatch,
      ),
    )
  if (!rows.length) return output
  const sensitive = new Set(rows.map((r) => r.id))
  const neutral = DEFECT_SENSITIVE_TITLE.th
  // Longest first, so a title containing another is replaced whole.
  const titles = [...new Set(rows.map((r) => r.title).filter((t) => t.length >= MIN_TEXT_MATCH))].sort((a, b) => b.length - a.length)
  const scrub = (s: string) => titles.reduce((acc, t) => acc.split(t).join(neutral), s)

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return scrub(value)
    if (Array.isArray(value)) return value.map(walk)
    if (isPlain(value)) {
      const obj = value
      const hidden = typeof obj.workItemId === 'string' && sensitive.has(obj.workItemId)
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(obj)) {
        out[k] = hidden && (k === 'title' || k === 'workItem') && typeof v === 'string' ? neutral : walk(v)
      }
      return out
    }
    return value
  }
  return walk(output)
}
