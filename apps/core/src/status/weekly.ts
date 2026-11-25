import { and, asc, desc, eq, gte, isNull, ne, sql, type SQL } from 'drizzle-orm'
import type { AppDeps } from '../app.js'
import { AiFailed, AiRefused, errorSummary } from '../ai/gateway.js'
import { WEEKLY_SUMMARY_SYSTEM } from '../ai/prompts.js'
import type { Db, Tx } from '../db/client.js'
import { discussions, events, knowledgeEntries, people, projects, tasks, workItems } from '../db/schema.js'
import type { JobRun } from '../jobs/queue.js'
import { fence } from '../knowledge/context-pack.js'
import { createEntry, notGitLabDraft, redraftEntry } from '../knowledge/service.js'
import { recordEvent, runWork } from '../work/context.js'
import { bangkokDate } from './health.js'

export type WeeklyDeps = Pick<AppDeps, 'db' | 'ai' | 'bus' | 'jobs' | 'config'> & { now?: () => Date }

export const WEEKLY_MAX_CHARS = 40_000
export const WEEKLY_MAX_OUTPUT_TOKENS = 2000
const WINDOW_MS = 7 * 86_400_000
const EVENT_LIMIT = 300
const ROW_LIMIT = 30
const CLIP = 1500
const MARKER = '…[truncated]'
const REQUESTER = '[ผู้ขอ / requester]'

const WEEK = /^\d{4}-W\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}${MARKER}` : s)
const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim()

/** ISO-8601 week (`YYYY-Www`) of the calendar date at `date` in `tz`. */
export function isoWeek(date: Date, tz = 'Asia/Bangkok'): string {
  const [y, m, d] = date.toLocaleDateString('en-CA', { timeZone: tz }).split('-').map(Number)
  const day = new Date(Date.UTC(y!, m! - 1, d!))
  // The Thursday of the same Monday-based week decides the year.
  const weekday = day.getUTCDay() || 7
  day.setUTCDate(day.getUTCDate() + 4 - weekday)
  const year = day.getUTCFullYear()
  const week = Math.ceil(((day.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** The week a summary written at `now` reports on: the one the past 7 days started in (Monday 08:00 → last week). */
export const summaryWeek = (now: Date): string => isoWeek(new Date(now.getTime() - WINDOW_MS))

/** `sourceRef` of a project-week's summary entry (read back by the status queries). */
export const weeklyRef = (projectId: string, week: string) => `weekly:${projectId}:${week}`

/** Knowledge rows that may go to the AI: no "do not send", no unreviewed GitLab notes, no earlier summaries. */
const sendable: SQL[] = [
  notGitLabDraft(),
  sql`not ${knowledgeEntries.noAi}`,
  sql`not exists (select 1 from attachments a where a.id = ${knowledgeEntries.attachmentId} and a.no_ai)`,
  sql`coalesce(${knowledgeEntries.sourceRef}, '') not like 'weekly:%'`,
]

/** Events about the summary itself (its own events, its entry's knowledge events) are not activity. */
const notSummaryEvent = sql`${events.type} not like 'status.%' and not (${events.type} like 'knowledge.%' and exists (
  select 1 from knowledge_entries k where k.id::text = ${events.payload}->>'entryId' and k.source_ref like 'weekly:%'
))`

/** A section of material: a heading and its fenced blocks (left out when it has none). */
type Section = { heading: string; blocks: { label: string; text: string }[] }

const renderBlock = (label: string, text: string) => `### ${label}\n\n${fence(text)}`

/** Renders sections in order, stopping at `max` characters; the block that crosses the limit is clipped. */
function render(sections: Section[], max: number): string {
  const out: string[] = []
  let used = 0
  const add = (s: string) => {
    used += s.length + (out.length ? 2 : 0)
    out.push(s)
  }
  for (const section of sections) {
    if (!section.blocks.length) continue
    const heading = `## ${section.heading}`
    if (used + heading.length + 2 > max) break
    add(heading)
    for (const b of section.blocks) {
      const room = max - used - 2
      let block = renderBlock(b.label, b.text)
      let text = b.text
      while (block.length > room && text.length > 0) {
        text = text.slice(0, Math.max(0, text.length - (block.length - room) - MARKER.length))
        block = renderBlock(b.label, text ? `${text}${MARKER}` : '')
      }
      if (!text || block.length > room) return out.join('\n\n')
      add(block)
    }
  }
  return out.join('\n\n')
}

/** Display names of the project's requesters, longest first, to redact from stored text. */
async function requesterNames(db: Db | Tx, projectId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: people.displayName })
    .from(workItems)
    .innerJoin(people, eq(people.id, workItems.requesterId))
    .where(eq(workItems.projectId, projectId))
  return rows
    .map((r) => r.name.trim())
    .filter((n) => n.length >= 2)
    .sort((a, b) => b.length - a.length)
}

const redactor = (names: string[]) => {
  if (!names.length) return (s: string) => s
  const re = new RegExp(names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  return (s: string) => s.replace(re, REQUESTER)
}

/**
 * The project's last week (since `since`) as fenced material for the AI: events (type and work item title),
 * accepted staff task results, decided discussions, confirmed knowledge and progress notes (drafts marked
 * [UNVERIFIED DRAFT]). No person is named: actors are left out and requesters' names are redacted from stored
 * text; requester tasks' results are left out. "Do not send to AI" content never appears. At most
 * `WEEKLY_MAX_CHARS`; empty when nothing happened.
 */
export async function weeklyMaterial(db: Db, projectId: string, since: Date): Promise<string> {
  const current = [eq(knowledgeEntries.projectId, projectId), isNull(knowledgeEntries.supersededAt), gte(knowledgeEntries.createdAt, since), ...sendable]
  const [eventRows, results, decided, confirmed, progress, names] = await Promise.all([
    db
      .select({ type: events.type, createdAt: events.createdAt, title: workItems.title })
      .from(events)
      .leftJoin(workItems, eq(workItems.id, events.workItemId))
      .where(and(eq(events.projectId, projectId), gte(events.createdAt, since), notSummaryEvent))
      .orderBy(desc(events.seq))
      .limit(EVENT_LIMIT),
    db
      .select({ title: workItems.title, key: tasks.templateTaskKey, result: tasks.result })
      .from(tasks)
      .innerJoin(workItems, eq(workItems.id, tasks.workItemId))
      .where(and(eq(tasks.projectId, projectId), eq(tasks.state, 'accepted'), ne(tasks.role, 'REQUESTER'), gte(tasks.updatedAt, since)))
      .orderBy(asc(tasks.updatedAt), asc(tasks.id))
      .limit(ROW_LIMIT),
    db
      .select({ question: discussions.question, decision: discussions.decision, title: workItems.title })
      .from(discussions)
      .leftJoin(workItems, eq(workItems.id, discussions.workItemId))
      .where(and(eq(discussions.projectId, projectId), eq(discussions.state, 'decided'), gte(discussions.decidedAt, since)))
      .orderBy(asc(discussions.decidedAt), asc(discussions.id))
      .limit(ROW_LIMIT),
    db
      .select({ type: knowledgeEntries.type, title: knowledgeEntries.title, body: knowledgeEntries.body })
      .from(knowledgeEntries)
      .where(and(...current, eq(knowledgeEntries.status, 'confirmed'), ne(knowledgeEntries.type, 'progress')))
      .orderBy(asc(knowledgeEntries.createdAt), asc(knowledgeEntries.id))
      .limit(ROW_LIMIT),
    db
      .select({ title: knowledgeEntries.title, body: knowledgeEntries.body, status: knowledgeEntries.status })
      .from(knowledgeEntries)
      .where(and(...current, eq(knowledgeEntries.type, 'progress')))
      .orderBy(asc(knowledgeEntries.createdAt), asc(knowledgeEntries.id))
      .limit(ROW_LIMIT),
    requesterNames(db, projectId),
  ])
  const redact = redactor(names)
  const label = (s: string) => oneLine(redact(s))
  const text = (s: string) => redact(clip(s.trimEnd(), CLIP))

  const sections: Section[] = [
    {
      heading: 'Decided discussions',
      blocks: decided.map((d) => ({
        label: label(d.title ? `${d.question} (${d.title})` : d.question),
        text: text(d.decision ?? ''),
      })),
    },
    {
      heading: 'Accepted task results',
      blocks: results
        .filter((r) => r.result?.text?.trim())
        .map((r) => ({ label: label(`${r.title} / ${r.key}`), text: text(r.result!.text) })),
    },
    {
      heading: 'Confirmed knowledge',
      blocks: confirmed.map((k) => ({ label: label(`${k.type}: ${k.title}`), text: text(k.body) })),
    },
    {
      heading: 'Progress notes',
      blocks: progress.map((p) => ({
        label: `${p.status === 'draft' ? '[UNVERIFIED DRAFT] ' : ''}${label(p.title)}`,
        text: text(p.body),
      })),
    },
    {
      heading: 'Events (date, type, work item), newest first',
      blocks: eventRows.length
        ? [{ label: 'Events', text: eventRows.map((e) => `${bangkokDate(e.createdAt)} ${e.type}${e.title ? ` — ${redact(oneLine(e.title))}` : ''}`).join('\n') }]
        : [],
    },
  ]
  return render(sections, WEEKLY_MAX_CHARS)
}

/** Permanent AI failures (nothing to retry); other errors are for the queue to retry. */
const permanent = (err: unknown) => err instanceof AiRefused || (err instanceof AiFailed && err.reason !== 'provider_error')

const SYSTEM = { id: null, kind: 'system' } as const

/**
 * Writes (or, with `force`, rewrites) the project's summary of `week` as a draft `document` entry, keyed by
 * `sourceRef` `weekly:<projectId>:<week>`. No-AI projects and quiet weeks get nothing; without `force` an
 * existing entry is kept and nothing is billed. The AI call runs outside any transaction; the write takes a
 * per-project-week advisory lock and re-checks, so a rerun or a racing regenerate never duplicates the entry
 * (a regenerate supersedes it with a new version).
 */
export async function runWeeklySummary(
  deps: WeeklyDeps,
  input: { projectId: string; week: string; force: boolean },
  run?: Pick<JobRun, 'id' | 'isFinalAttempt' | 'signal'>,
): Promise<void> {
  const { db } = deps
  const { projectId, week, force } = input
  const [project] = await db.select({ name: projects.name, noAi: projects.noAi }).from(projects).where(eq(projects.id, projectId))
  if (!project || project.noAi) return

  const ref = weeklyRef(projectId, week)
  const existing = async (conn: Db | Tx) =>
    (
      await conn
        .select({ id: knowledgeEntries.id })
        .from(knowledgeEntries)
        .where(and(eq(knowledgeEntries.projectId, projectId), eq(knowledgeEntries.sourceRef, ref), isNull(knowledgeEntries.supersededAt)))
        .limit(1)
    )[0] ?? null
  if (!force && (await existing(db))) return

  const now = deps.now?.() ?? new Date()
  const material = await weeklyMaterial(db, projectId, new Date(now.getTime() - WINDOW_MS))
  if (!material) return

  let body: string
  try {
    const out = await deps.ai.generateText({
      job: 'fast',
      projectId,
      system: WEEKLY_SUMMARY_SYSTEM,
      prompt: `Project: ${oneLine(project.name)}\nWeek: ${week}\n\n${material}`,
      maxOutputTokens: WEEKLY_MAX_OUTPUT_TOKENS,
      signal: run?.signal,
    })
    body = out.text.trim()
  } catch (err) {
    if (err instanceof AiRefused && err.reason === 'budget_exceeded') {
      await runWork(deps, SYSTEM, (ctx) =>
        recordEvent(ctx, { type: 'status.weekly_summary_skipped', projectId, workItemId: null, taskId: null, reason: 'budget_exceeded', payload: { week } }),
      )
      return
    }
    if (permanent(err) || !run || run.isFinalAttempt) {
      console.warn(`weekly-summary ${projectId}:${week}: no summary: ${errorSummary(err)}`)
      return
    }
    throw err
  }
  if (!body) return

  await runWork(deps, SYSTEM, async (ctx) => {
    await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ref}))`)
    const cur = await existing(ctx.tx)
    if (cur && !force) return
    const title = `สรุปประจำสัปดาห์ ${week} / Weekly summary ${week}`
    const entryId = cur
      ? await redraftEntry(ctx, cur.id, { title, body })
      : await createEntry(ctx, null, {
          scope: 'project',
          projectId,
          type: 'document',
          title,
          body,
          noAi: false,
          status: 'draft',
          sourceKind: 'ai',
          sourceRef: ref,
        })
    const [row] = await ctx.tx.select({ version: knowledgeEntries.version }).from(knowledgeEntries).where(eq(knowledgeEntries.id, entryId))
    await recordEvent(ctx, {
      type: 'status.weekly_summary',
      projectId,
      workItemId: null,
      taskId: null,
      payload: { week, entryId, version: row!.version },
    })
  })
}

/** Job id of a project-week's summary (also its singleton key); a regenerate adds `:force`. */
export const weeklyJobId = (projectId: string, week: string, force = false) => `${projectId}:${week}${force ? ':force' : ''}`

/** `weekly-summary-project` job: id `<projectId>:<week>[:force]`. */
export async function weeklySummaryJob(deps: WeeklyDeps, run: JobRun): Promise<void> {
  const [projectId, week, flag] = run.id.split(':')
  if (!projectId || !UUID.test(projectId) || !week || !WEEK.test(week)) {
    console.warn(`weekly-summary-project: bad job id ${run.id}`)
    return
  }
  await runWeeklySummary(deps, { projectId, week, force: flag === 'force' }, run)
}

/** `weekly-summary` schedule (Monday 08:00 Asia/Bangkok): one job per active project for last week. */
export async function fanOutWeeklySummaries(deps: WeeklyDeps): Promise<void> {
  const week = summaryWeek(deps.now?.() ?? new Date())
  const rows = await deps.db.select({ id: projects.id }).from(projects).where(eq(projects.status, 'active')).orderBy(asc(projects.id))
  for (const p of rows) await deps.jobs.send('weekly-summary-project', { id: weeklyJobId(p.id, week) })
}

/** A PM's regenerate: the current summary week, replaced even if it exists. */
export async function queueWeeklyRegenerate(deps: WeeklyDeps, projectId: string): Promise<void> {
  await deps.jobs.send('weekly-summary-project', { id: weeklyJobId(projectId, summaryWeek(deps.now?.() ?? new Date()), true) })
}
