import { Priority, type LocalizedText, type Proposal, type TaskWithContext, type Todo, type TodoWorkItem, type WorkItem } from '@yoda/shared'
import { waitingFor } from './runners'

export type TodoTab = 'all' | 'decisions' | 'confirmations' | 'mine'
export const TODO_TABS: TodoTab[] = ['all', 'decisions', 'confirmations', 'mine']

/** A card in "waiting for your decision": an item whose finished step waits to be advanced, or a proposal. */
export type Decision = { type: 'advance'; item: WorkItem } | { type: 'proposal'; proposal: Proposal }

export type TodoView = { decisions: Decision[]; confirmations: TaskWithContext[]; mine: TaskWithContext[] }

const inProject = (projectId: string | null) => (rowProject: string | null) => !projectId || rowProject === projectId

function sections(todo: Todo, projectId: string | null): TodoView {
  const keep = inProject(projectId)
  return {
    decisions: [
      ...todo.awaitingAdvance.filter(w => keep(w.projectId)).map(item => ({ type: 'advance' as const, item })),
      ...todo.proposals.filter(p => keep(p.projectId)).map(proposal => ({ type: 'proposal' as const, proposal })),
    ],
    confirmations: todo.confirmations.filter(t => keep(t.projectId)),
    mine: todo.tasks.filter(t => keep(t.projectId)),
  }
}

/** The rows a tab shows, limited to one project when chosen (project-less proposals only show without one). */
export function filterTodo(todo: Todo, f: { tab: TodoTab; projectId: string | null }): TodoView {
  const all = sections(todo, f.projectId)
  return {
    decisions: f.tab === 'all' || f.tab === 'decisions' ? all.decisions : [],
    confirmations: f.tab === 'all' || f.tab === 'confirmations' ? all.confirmations : [],
    mine: f.tab === 'all' || f.tab === 'mine' ? all.mine : [],
  }
}

/** Tab counts for the chosen project (or all). */
export function todoCounts(todo: Todo, projectId: string | null): Record<TodoTab, number> {
  const s = sections(todo, projectId)
  const decisions = s.decisions.length
  const confirmations = s.confirmations.length
  const mine = s.mine.length
  return { all: decisions + confirmations + mine, decisions, confirmations, mine }
}

const RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 }

/** Priority first, then the longest-waiting; a new array. */
export function byPriority(rows: TaskWithContext[]): TaskWithContext[] {
  return rows
    .map((t, i) => ({ t, i }))
    .sort(
      (a, b) =>
        RANK[a.t.workItemPriority] - RANK[b.t.workItemPriority] ||
        (a.t.createdAt ?? '').localeCompare(b.t.createdAt ?? '') ||
        a.i - b.i,
    )
    .map(x => x.t)
}

export type Waiting = 'drafting' | 'failed' | 'runner' | 'ai' | 'proposed' | 'assignee'

/** What a confirmation row waits for ("สิ่งที่รออยู่"). */
export function waitingOf(t: TaskWithContext): Waiting {
  if (t.aiStatus === 'drafting') return 'drafting'
  if (t.aiStatus === 'failed') return 'failed'
  if (t.proposedAssigneeId) return 'proposed'
  const w = waitingFor(t)
  if (w) return w
  return t.executor === 'ai' && !t.assigneeId ? 'ai' : 'assignee'
}

/** A step_advance proposal's change, named from the item's steps (payload `fromStep` / `toStep`). */
export function stepChange(p: Proposal, item: TodoWorkItem | undefined): { from: LocalizedText; to: LocalizedText } | null {
  const { fromStep, toStep } = p.payload as { fromStep?: unknown; toStep?: unknown }
  if (!item || typeof fromStep !== 'string' || typeof toStep !== 'string') return null
  const from = item.steps.find(s => s.key === fromStep)
  const to = item.steps.find(s => s.key === toStep)
  return from && to ? { from: from.name, to: to.name } : null
}

/** A priority_change proposal: the item's current priority (when known) and the proposed one. */
export function priorityChange(p: Proposal, item: TodoWorkItem | undefined): { from: Priority | null; to: Priority } | null {
  const to = Priority.safeParse(p.payload.priority)
  if (!to.success) return null
  return { from: item?.priority ?? null, to: to.data }
}

/** The projects the page's rows belong to, for the project filter, sorted by name. */
export function todoProjects(todo: Todo): { id: string; name: string }[] {
  const names = new Map<string, string>()
  for (const t of [...todo.tasks, ...todo.confirmations]) {
    if (!t.viewerIsRequester) names.set(t.projectId, t.projectName)
  }
  for (const [id, name] of Object.entries(todo.projectNames)) names.set(id, name)
  return [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'th'))
}

/** The first `limit` rows until the person asks to show them all. */
export function visibleRows<T>(rows: T[], expanded: boolean, limit: number): T[] {
  return expanded ? rows : rows.slice(0, limit)
}

type CrumbTask = Pick<TaskWithContext, 'projectId' | 'projectName' | 'workItemId' | 'workItemTitle'> & { title: string }

/**
 * The task page's breadcrumbs (proposal §8.2, §8.3): staff see โครงการ › project › work item › task; requesters
 * go back to their request; staff who see the task only as its requester go back to their to-do.
 */
export function taskCrumbs(
  task: CrumbTask,
  view: { requesterView: boolean; isStaff: boolean },
  t: (key: string) => string,
): { label: string; to?: string }[] {
  if (!view.requesterView) {
    return [
      { label: t('nav.projects'), to: '/projects' },
      { label: task.projectName, to: `/projects/${task.projectId}` },
      { label: task.workItemTitle, to: `/work-items/${task.workItemId}` },
      { label: task.title },
    ]
  }
  if (view.isStaff) return [{ label: t('nav.todo'), to: '/todo' }, { label: task.title }]
  return [
    { label: t('nav.requests'), to: '/requests' },
    { label: task.workItemTitle, to: `/requests/${task.workItemId}` },
    { label: task.title },
  ]
}
