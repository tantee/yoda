import { describe, expect, it } from 'vitest'
import { meetingIso, moveItem, splitAgendas } from '../app/utils/agendas'

describe('moveItem', () => {
  it('moves an item up or down, leaving the input as is', () => {
    const list = ['a', 'b', 'c', 'd']
    expect(moveItem(list, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(list, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveItem(list, 1, 2)).toEqual(['a', 'c', 'b', 'd'])
    expect(list).toEqual(['a', 'b', 'c', 'd'])
  })
  it('ignores moves out of range or in place', () => {
    expect(moveItem(['a', 'b'], 0, 2)).toEqual(['a', 'b'])
    expect(moveItem(['a', 'b'], -1, 0)).toEqual(['a', 'b'])
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b'])
  })
})

describe('meetingIso', () => {
  it('reads the day and time in Bangkok time', () => {
    expect(meetingIso('2026-12-02', '09:30')).toBe('2026-12-02T02:30:00.000Z')
    expect(meetingIso('2026-12-02', '06:00')).toBe('2026-12-01T23:00:00.000Z')
  })
  it('is null until both parts are valid', () => {
    expect(meetingIso(null, '09:30')).toBeNull()
    expect(meetingIso('2026-12-02', '')).toBeNull()
    expect(meetingIso('2026-12-02', '25:00')).toBeNull()
    expect(meetingIso('2/12/2026', '09:30')).toBeNull()
  })
})

describe('splitAgendas', () => {
  it('lists upcoming soonest first and past latest first', () => {
    const now = Date.parse('2026-11-26T00:00:00Z')
    const a = (id: string, meetingAt: string) => ({ id, meetingAt })
    const r = splitAgendas([a('p1', '2026-11-01T00:00:00Z'), a('u2', '2026-12-10T00:00:00Z'), a('u1', '2026-11-27T00:00:00Z'), a('p2', '2026-11-20T00:00:00Z')], now)
    expect(r.upcoming.map(x => x.id)).toEqual(['u1', 'u2'])
    expect(r.past.map(x => x.id)).toEqual(['p2', 'p1'])
  })
})
