import type {
  LocalizedText,
  PersonLoad,
  Priority,
  ProjectListItem,
  ProjectStatusSummary,
  WorkflowTemplateSummary,
  WorkItem,
  WorkItemState,
} from '@yoda/shared'
import { formatDate, formatDateShort } from './dates'
import type { StepStatus } from './steps'

export interface ProjectRow {
  project: ProjectListItem
  /** The department status summary; null for projects it leaves out (archived ones). */
  status: ProjectStatusSummary | null
}

/** Projects list rows (proposal §8.2): status joined by id, active and archived apart, list order kept. */
export function projectRows(list: ProjectListItem[], summaries: ProjectStatusSummary[]): { active: ProjectRow[]; archived: ProjectRow[] } {
  const byId = new Map(summaries.map(s => [s.projectId, s]))
  const rows = list.map(project => ({ project, status: byId.get(project.id) ?? null }))
  return { active: rows.filter(r => r.project.status === 'active'), archived: rows.filter(r => r.project.status === 'archived') }
}

export interface ItemStep {
  key: string
  name: LocalizedText
  status: StepStatus
}

/** The template (key and version) a work item runs on. */
function templateOf(templates: WorkflowTemplateSummary[], w: WorkItem): WorkflowTemplateSummary | undefined {
  return templates.find(x => x.key === w.templateKey && x.version === w.templateVersion)
}

/** A list row's step track, by the same rule as the work item detail (done items: every step done). */
export function itemSteps(templates: WorkflowTemplateSummary[], w: WorkItem): ItemStep[] {
  const tpl = templateOf(templates, w)
  if (!tpl) return []
  const current = tpl.steps.findIndex(s => s.key === w.currentStepKey)
  return tpl.steps.map((s, i) => ({
    key: s.key,
    name: s.name,
    status: w.state === 'done' || (current >= 0 && i < current) ? 'done' : i === current ? 'current' : 'pending',
  }))
}

export interface WorkItemFilter {
  q?: string
  /** Default `active`. */
  state?: WorkItemState | 'all'
  step?: string | null
  priority?: Priority | null
  ownerId?: string | null
  overdue?: boolean
}

const RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 }

export function itemOverdue(w: WorkItem, today: string): boolean {
  return w.state === 'active' && !!w.targetDate && w.targetDate < today
}

/** The project work items table (client-side: projects hold few items): filtered, most urgent then due first. */
export function filterWorkItems(items: WorkItem[], f: WorkItemFilter, today: string): WorkItem[] {
  const state = f.state ?? 'active'
  const q = (f.q ?? '').trim().toLocaleLowerCase()
  return items
    .filter(w =>
      (state === 'all' || w.state === state)
      && (!f.step || w.currentStepKey === f.step)
      && (!f.priority || w.priority === f.priority)
      && (!f.ownerId || w.ownerId === f.ownerId)
      && (!f.overdue || itemOverdue(w, today))
      && (!q || w.title.toLocaleLowerCase().includes(q)),
    )
    .sort((a, b) =>
      RANK[a.priority] - RANK[b.priority]
      || (a.targetDate ?? '9999').localeCompare(b.targetDate ?? '9999')
      || a.title.localeCompare(b.title, 'th'),
    )
}

/** Owners (by name) and the steps of the templates in use (template order, first seen), for the filter menus. */
export function workItemFilterOptions(items: WorkItem[], templates: WorkflowTemplateSummary[]): {
  owners: { id: string; name: string }[]
  steps: { key: string; name: LocalizedText }[]
} {
  const owners = new Map<string, string>()
  const steps = new Map<string, LocalizedText>()
  for (const w of items) {
    owners.set(w.ownerId, w.ownerName)
    for (const s of templateOf(templates, w)?.steps ?? []) if (!steps.has(s.key)) steps.set(s.key, s.name)
  }
  return {
    owners: [...owners].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'th')),
    steps: [...steps].map(([key, name]) => ({ key, name })),
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

/** Monday and Sunday (`YYYY-MM-DD`) of an ISO week such as `2026-W48`; null when malformed. */
export function isoWeekRange(week: string): { start: string; end: string } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(week)
  if (!m) return null
  const year = Number(m[1])
  const n = Number(m[2])
  // 4 January is always in week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const monday1 = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000)
  const start = new Date(monday1.getTime() + (n - 1) * 7 * 86_400_000)
  return { start: iso(start), end: iso(new Date(start.getTime() + 6 * 86_400_000)) }
}

/** "23–29 พ.ย. 2569" / "23–29 Nov 2026"; across months or years the shared parts are not repeated. */
export function formatWeekRange(week: string, locale: string): string {
  const r = isoWeekRange(week)
  if (!r) return week
  const [a, b] = [r.start, r.end]
  const end = formatDate(b, locale)
  if (a.slice(0, 4) !== b.slice(0, 4)) return `${formatDate(a, locale)} – ${end}`
  if (a.slice(0, 7) !== b.slice(0, 7)) return `${formatDateShort(a, locale, new Date(`${b}T12:00:00+07:00`))} – ${end}`
  return `${Number(a.slice(8))}–${end}`
}

/** Open tasks at which a member's load bar turns amber. */
export const HEAVY_LOAD = 5

/** Member load bars: open tasks against the busiest member of the project. */
export function loadBars(people: PersonLoad[]): { person: PersonLoad; percent: number; heavy: boolean }[] {
  const max = Math.max(0, ...people.map(p => p.openTasks))
  return people.map(person => ({
    person,
    percent: max ? Math.round((person.openTasks / max) * 100) : 0,
    heavy: person.openTasks >= HEAVY_LOAD,
  }))
}

/** Plain-text preview of a Markdown body: one line, markup removed, cut at `max` characters. */
export function knowledgePreview(body: string, max = 160): string {
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size))
}
