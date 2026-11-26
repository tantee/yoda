import type { EventEntry, EventType, WorkItemEventsPage } from '@yoda/shared'
import { bangkokDay } from '~/utils/chat'
import { bangkokToday } from '~/utils/status'

type Entry = EventEntry & { seq?: number }

/** Newest first: by seq when the events carry one (work item pages), else by time (project timelines). */
function newestFirst(a: Entry, b: Entry): number {
  if (a.seq !== undefined && b.seq !== undefined) return b.seq - a.seq
  return b.createdAt.localeCompare(a.createdAt)
}

/** The timeline grouped by Bangkok calendar day (proposal §6.9), newest day and newest event first. */
export function timelineDays<E extends Entry>(events: E[]): { day: string; items: E[] }[] {
  const groups: { day: string; items: E[] }[] = []
  for (const e of [...events].sort(newestFirst)) {
    const day = bangkokDay(e.createdAt)
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.items.push(e)
    else groups.push({ day, items: [e] })
  }
  return groups
}

/** "today" / "yesterday" for a `YYYY-MM-DD` Bangkok day, else null (the heading is just the date). */
export function relativeDay(day: string, now = new Date()): 'today' | 'yesterday' | null {
  if (day === bangkokToday(now)) return 'today'
  if (day === bangkokToday(new Date(now.getTime() - 86_400_000))) return 'yesterday'
  return null
}

/** Step changes, merge requests and decisions: the events worth a filled dot. */
const KEY_EVENTS = new Set<EventType>([
  'work_item.created', 'work_item.step_advanced', 'work_item.done', 'work_item.cancelled', 'work_item.reopened',
  'work_item.priority_changed', 'work_item.target_date_changed',
  'gitlab.mr_opened', 'gitlab.mr_merged', 'gitlab.mr_closed',
  'proposal.accepted', 'discussion.raised', 'discussion.decided',
])
export const isKeyEvent = (e: Pick<EventEntry, 'type'>) => KEY_EVENTS.has(e.type)

/** Timeline dot: key events filled primary, AI events hollow indigo, everything else hollow gray. */
export function eventDot(e: Pick<EventEntry, 'type' | 'actorKind'>): 'key' | 'ai' | 'plain' {
  if (isKeyEvent(e)) return 'key'
  return e.actorKind === 'ai' ? 'ai' : 'plain'
}

/**
 * A refreshed newest page joins what is loaded: it replaces everything in its own range, older pages already
 * loaded stay below it. When the page does not reach the loaded events (more new events than a page), the
 * timeline starts over from the newest page so it never shows a gap.
 */
export function mergeTimeline(loaded: WorkItemEventsPage, latest: WorkItemEventsPage): WorkItemEventsPage {
  if (!loaded.events.length || latest.nextBefore === null || !latest.events.length) return latest
  const oldest = latest.events[latest.events.length - 1]!.seq
  if (!loaded.events.some(e => e.seq >= oldest)) return latest
  const older = loaded.events.filter(e => e.seq < oldest)
  return {
    events: [...latest.events, ...older],
    nextBefore: older.length ? loaded.nextBefore : latest.nextBefore,
  }
}
