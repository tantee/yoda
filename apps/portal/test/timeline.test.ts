import { describe, expect, it } from 'vitest'
import type { SeqEventEntry } from '@yoda/shared'
import { eventDot, isKeyEvent, mergeTimeline, relativeDay, timelineDays } from '../app/utils/timeline'

let n = 0
function ev(seq: number, createdAt: string, over: Partial<SeqEventEntry> = {}): SeqEventEntry {
  n++
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    seq,
    type: 'task.created',
    actorKind: 'person',
    actorId: null,
    actorName: null,
    taskId: null,
    reason: null,
    payload: { n },
    createdAt,
    ...over,
  }
}

describe('timelineDays', () => {
  it('groups by Bangkok calendar day, newest day and newest event first', () => {
    // 16:59Z = 23:59 Bangkok on the 24th; 17:01Z = 00:01 on the 25th
    const a = ev(1, '2026-11-24T16:59:00Z')
    const b = ev(2, '2026-11-24T17:01:00Z')
    const c = ev(3, '2026-11-25T03:00:00Z')
    const days = timelineDays([a, b, c])
    expect(days.map(d => d.day)).toEqual(['2026-11-25', '2026-11-24'])
    expect(days[0]!.items.map(x => x.seq)).toEqual([3, 2])
    expect(days[1]!.items.map(x => x.seq)).toEqual([1])
  })
  it('orders events without seq (project timelines) by time', () => {
    const { seq: _a, ...x } = ev(1, '2026-11-25T01:00:00Z')
    const { seq: _b, ...y } = ev(2, '2026-11-25T02:00:00Z')
    expect(timelineDays([x, y])[0]!.items.map(e => e.createdAt)).toEqual(['2026-11-25T02:00:00Z', '2026-11-25T01:00:00Z'])
  })
  it('returns [] for no events', () => {
    expect(timelineDays([])).toEqual([])
  })
})

describe('relativeDay', () => {
  const now = new Date('2026-11-25T10:00:00+07:00')
  it('names today and yesterday in Bangkok, else null', () => {
    expect(relativeDay('2026-11-25', now)).toBe('today')
    expect(relativeDay('2026-11-24', now)).toBe('yesterday')
    expect(relativeDay('2026-11-23', now)).toBeNull()
  })
  it('uses the Bangkok date just after midnight', () => {
    expect(relativeDay('2026-11-26', new Date('2026-11-25T17:30:00Z'))).toBe('today')
  })
})

describe('eventDot / isKeyEvent', () => {
  it('step changes, MRs and decisions are key; AI actors get the AI dot; the rest are plain', () => {
    expect(isKeyEvent(ev(1, '2026-11-25T00:00:00Z', { type: 'work_item.step_advanced' }))).toBe(true)
    expect(isKeyEvent(ev(1, '2026-11-25T00:00:00Z', { type: 'gitlab.mr_opened' }))).toBe(true)
    expect(isKeyEvent(ev(1, '2026-11-25T00:00:00Z', { type: 'discussion.decided' }))).toBe(true)
    expect(isKeyEvent(ev(1, '2026-11-25T00:00:00Z', { type: 'task.created' }))).toBe(false)
    expect(eventDot(ev(1, '2026-11-25T00:00:00Z', { type: 'work_item.reopened' }))).toBe('key')
    expect(eventDot(ev(1, '2026-11-25T00:00:00Z', { type: 'ai.drafted', actorKind: 'ai' }))).toBe('ai')
    expect(eventDot(ev(1, '2026-11-25T00:00:00Z', { type: 'knowledge.created' }))).toBe('plain')
  })
})

describe('mergeTimeline', () => {
  const t = '2026-11-25T00:00:00Z'
  it('takes the newest page as is when nothing is loaded yet', () => {
    const page = { events: [ev(5, t), ev(4, t)], nextBefore: 4 }
    expect(mergeTimeline({ events: [], nextBefore: null }, page)).toEqual(page)
  })
  it('keeps older pages already loaded below a refreshed newest page', () => {
    const loaded = { events: [ev(6, t), ev(5, t), ev(3, t), ev(2, t)], nextBefore: 2 }
    const latest = { events: [ev(8, t), ev(6, t), ev(5, t)], nextBefore: 5 }
    const merged = mergeTimeline(loaded, latest)
    expect(merged.events.map(e => e.seq)).toEqual([8, 6, 5, 3, 2])
    expect(merged.nextBefore).toBe(2)
  })
  it('drops loaded events the newest page no longer has in its range (fresh copies win)', () => {
    const old = ev(5, t, { reason: 'old' })
    const fresh = { ...old, reason: 'new' }
    const merged = mergeTimeline({ events: [old], nextBefore: null }, { events: [ev(7, t), fresh], nextBefore: null })
    expect(merged.events.map(e => [e.seq, e.reason])).toEqual([[7, null], [5, 'new']])
    expect(merged.nextBefore).toBeNull()
  })
  it('starts over from the newest page when it does not reach the loaded events (a gap)', () => {
    const loaded = { events: [ev(3, t), ev(2, t)], nextBefore: 2 }
    const latest = { events: [ev(9, t), ev(8, t)], nextBefore: 8 }
    expect(mergeTimeline(loaded, latest)).toEqual(latest)
  })
})
