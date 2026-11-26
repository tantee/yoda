import type { Discussion, DiscussionResponse, Priority } from '@yoda/shared'

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

export interface OptionShare {
  key: string
  title: string
  pros: string
  cons: string
  votes: number
  /** Share of all votes, 0-100 (rounded); 0 when nobody voted. */
  percent: number
  recommended: boolean
  mine: boolean
  decided: boolean
}

/** The brief's options with their vote bars: count, share of the votes, and the recommended / my / decided marks. */
export function voteShares(d: Discussion): { options: OptionShare[]; total: number } {
  const options = d.brief?.options ?? []
  const total = options.reduce((sum, o) => sum + (d.voteCounts[o.key] ?? 0), 0)
  return {
    total,
    options: options.map((o) => {
      const votes = d.voteCounts[o.key] ?? 0
      return {
        key: o.key,
        title: o.title,
        pros: o.pros,
        cons: o.cons,
        votes,
        percent: total ? Math.round((votes / total) * 100) : 0,
        recommended: d.brief?.recommendedKey === o.key,
        mine: d.myVote === o.key,
        decided: d.decidedOptionKey === o.key,
      }
    }),
  }
}

/** Who currently votes for each option: each person's latest vote counts (responses come oldest first). */
export function votersByOption(responses: readonly DiscussionResponse[]): Record<string, string[]> {
  const latest = new Map<string, { name: string; key: string }>()
  for (const r of responses) {
    if (r.kind !== 'vote' || !r.optionKey) continue
    latest.delete(r.authorId)
    latest.set(r.authorId, { name: r.authorName, key: r.optionKey })
  }
  const out: Record<string, string[]> = {}
  for (const { name, key } of latest.values()) (out[key] ??= []).push(name)
  return out
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
