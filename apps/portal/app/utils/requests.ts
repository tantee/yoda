import type { Me, MyRequest, Proposal, RequestEvent, TaskWithContext } from '@yoda/shared'
import { localized } from './localized'

/** The requester's answer tasks that belong to one of their requests. */
export function answersFor(request: Pick<MyRequest, 'workItemId'>, answers: TaskWithContext[]): TaskWithContext[] {
  return answers.filter(a => a.workItemId === request.workItemId)
}

/** The engine creates step_advance proposals without a summary: the portal supplies the wording. */
export function proposalFallbackKey(p: Pick<Proposal, 'kind' | 'summary'>): string | null {
  return p.kind === 'step_advance' && !p.summary.trim() ? 'todo.stepAdvance' : null
}

/**
 * Whether the task page shows the trimmed requester view (no project / work item links or staff controls,
 * uploads to the viewer's own conversation): for requesters, and for staff who see the task only as its
 * requester (core's `viewerIsRequester`, e.g. a staff requester outside the project). The back link goes to
 * the viewer's home list.
 */
export function taskViewFor(
  me: Pick<Me, 'isStaff'> | null | undefined,
  task: Pick<TaskWithContext, 'viewerIsRequester'> | null | undefined,
): { requesterView: boolean; back: '/todo' | '/answers' } {
  const isStaff = !!me?.isStaff
  return { requesterView: !isStaff || !!task?.viewerIsRequester, back: isStaff ? '/todo' : '/answers' }
}

/** Steps of the shipped templates that have plain-language requester wording (proposal §8.3 glossary). */
export const REQUESTER_STEP_KEYS = ['intake', 'ba', 'sa', 'dev', 'qc', 'close'] as const

/** The i18n key of a step in requester wording ("ทีมกำลังพัฒนา"), or null for steps without one. */
export function requesterStepKey(key: string | null | undefined): string | null {
  return key && (REQUESTER_STEP_KEYS as readonly string[]).includes(key) ? `requests.step.${key}` : null
}

/** A step track in requester words: glossary names for the known steps, the step's own name otherwise. */
export function plainSteps<T extends { key: string; name: unknown }>(steps: T[], t: (key: string) => string): T[] {
  return steps.map(s => {
    const key = requesterStepKey(s.key)
    return key ? { ...s, name: t(key) } : s
  })
}

/** What a requester task asks for: accepting the delivery (approval) or answering the team's questions. */
export function requesterTaskKind(task: Pick<TaskWithContext, 'type'>): 'question' | 'delivery' {
  return task.type === 'human' ? 'question' : 'delivery'
}

/** My requests split as the page shows them: waiting for the requester, in progress, finished (order kept). */
export function groupRequests<T extends Pick<MyRequest, 'status'>>(list: T[]): { waiting: T[]; active: T[]; done: T[] } {
  return {
    waiting: list.filter(r => r.status === 'waiting_for_you'),
    active: list.filter(r => r.status === 'submitted' || r.status === 'in_progress'),
    done: list.filter(r => r.status === 'done' || r.status === 'cancelled'),
  }
}

/** Questions to me grouped by request, in the order the first question of each request arrived. */
export function answersByRequest(answers: TaskWithContext[]): { workItemId: string; title: string; answers: TaskWithContext[] }[] {
  const groups = new Map<string, { workItemId: string; title: string; answers: TaskWithContext[] }>()
  for (const a of [...answers].sort((x, y) => x.createdAt.localeCompare(y.createdAt))) {
    const g = groups.get(a.workItemId) ?? { workItemId: a.workItemId, title: a.workItemTitle, answers: [] }
    g.answers.push(a)
    groups.set(a.workItemId, g)
  }
  return [...groups.values()]
}

/**
 * The sentence of one requester timeline row: an i18n key under `requests.event` and its params. `step` gives
 * the plain step label for a key (falling back to the step's own name), `date` formats an expected date.
 */
export function requestEventText(
  e: RequestEvent,
  step: (key: string | null, name: string) => string,
  date: (d: string) => string,
  locale: string,
): { key: string; params: Record<string, string> } {
  if (e.kind === 'step' || e.kind === 'reopened') {
    return { key: `requests.event.${e.kind}`, params: { step: step(e.stepKey, e.stepName ? localized(e.stepName, locale) : '') } }
  }
  if (e.kind === 'expected_date') {
    return e.date ? { key: 'requests.event.expected_date', params: { date: date(e.date) } } : { key: 'requests.event.expected_date_cleared', params: {} }
  }
  // Someone else (staff acting for them) answered or accepted: not "you".
  if ((e.kind === 'answered' || e.kind === 'accepted') && !e.byYou) return { key: `requests.event.${e.kind}Other`, params: {} }
  return { key: `requests.event.${e.kind}`, params: {} }
}
