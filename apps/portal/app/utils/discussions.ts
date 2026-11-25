import type { Discussion, Priority } from '@yoda/shared'

const RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
const time = (d: Discussion) => new Date(d.createdAt).getTime()

/** A sorted copy: priority (urgent first, oldest first within a priority), newest first, or by project name. */
export function sortDiscussions(list: Discussion[], by: 'priority' | 'created' | 'project'): Discussion[] {
  const oldestFirst = (a: Discussion, b: Discussion) => time(a) - time(b)
  const copy = [...list]
  if (by === 'created') return copy.sort((a, b) => time(b) - time(a))
  if (by === 'project') {
    return copy.sort((a, b) => {
      if (!a.projectName !== !b.projectName) return a.projectName ? -1 : 1
      return (a.projectName ?? '').localeCompare(b.projectName ?? '') || oldestFirst(a, b)
    })
  }
  return copy.sort((a, b) => RANK[a.priority] - RANK[b.priority] || oldestFirst(a, b))
}

export function voteSummary(d: Discussion): { key: string; title: string; votes: number; recommended: boolean }[] {
  return (d.brief?.options ?? []).map(o => ({
    key: o.key,
    title: o.title,
    votes: d.voteCounts[o.key] ?? 0,
    recommended: d.brief?.recommendedKey === o.key,
  }))
}

const FAIL_REASONS = ['no_ai', 'budget_exceeded', 'ai_unavailable', 'ai_failed']
export function briefFailKey(reason: string | null): string {
  return `discussions.failReason.${reason && FAIL_REASONS.includes(reason) ? reason : 'ai_failed'}`
}

/** The raise_discussion proposal payload, defensively typed (it is data from the server). */
export function raisePayload(payload: Record<string, unknown>): { question: string; details: string; options: { key: string; title: string }[] } {
  const options = Array.isArray(payload.options) ? payload.options : []
  return {
    question: typeof payload.question === 'string' ? payload.question : '',
    details: typeof payload.details === 'string' ? payload.details : '',
    options: options
      .filter((o): o is { key: string; title: string } => !!o && typeof o === 'object' && typeof (o as { title?: unknown }).title === 'string')
      .map(o => ({ key: String(o.key), title: o.title })),
  }
}
