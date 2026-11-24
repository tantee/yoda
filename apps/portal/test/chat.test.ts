import { describe, expect, it } from 'vitest'
import type { Message } from '@yoda/shared'
import { groupMessages, isSecretaryTyping, mergeMessages } from '../app/utils/chat'

let n = 0
function msg(over: Partial<Message> & { createdAt: string }): Message {
  n++
  return {
    id: crypto.randomUUID(),
    conversationId: '00000000-0000-4000-8000-000000000001',
    seq: n,
    authorKind: 'person',
    authorId: null,
    authorName: null,
    text: 'x',
    attachments: [],
    actions: [],
    ...over,
  }
}

describe('groupMessages', () => {
  it('splits messages across midnight Bangkok into two days, keeping order', () => {
    // 16:59Z = 23:59 in Bangkok (UTC+7); 17:01Z = 00:01 next day
    const a = msg({ createdAt: '2026-11-24T16:59:00Z' })
    const b = msg({ createdAt: '2026-11-24T17:01:00Z' })
    const c = msg({ createdAt: '2026-11-24T18:00:00Z' })
    const groups = groupMessages([a, b, c])
    expect(groups.map(g => g.day)).toEqual(['2026-11-24', '2026-11-25'])
    expect(groups[0]!.items).toEqual([a])
    expect(groups[1]!.items).toEqual([b, c])
  })
  it('returns [] for no messages', () => {
    expect(groupMessages([])).toEqual([])
  })
})

describe('mergeMessages', () => {
  it('dedupes by id and sorts by seq', () => {
    const a = msg({ createdAt: '2026-11-24T10:00:00Z' })
    const b = msg({ createdAt: '2026-11-24T10:01:00Z' })
    expect(mergeMessages([b], [a, b]).map(m => m.id)).toEqual([a.id, b.id])
  })
})

describe('isSecretaryTyping', () => {
  const now = Date.parse('2026-11-24T10:00:30Z')
  const person = msg({ createdAt: '2026-11-24T10:00:00Z' })
  it('is on for a fresh person message in a personal thread', () => {
    expect(isSecretaryTyping('personal', [person], now)).toBe(true)
    expect(isSecretaryTyping('intake', [person], now)).toBe(true)
  })
  it('is off in project and work_item threads', () => {
    expect(isSecretaryTyping('project', [person], now)).toBe(false)
    expect(isSecretaryTyping('work_item', [person], now)).toBe(false)
  })
  it('stops when a later system or ai message arrives', () => {
    const sys = msg({ authorKind: 'system', createdAt: '2026-11-24T10:00:05Z' })
    const ai = msg({ authorKind: 'ai', createdAt: '2026-11-24T10:00:05Z' })
    expect(isSecretaryTyping('personal', [person, sys], now)).toBe(false)
    expect(isSecretaryTyping('personal', [person, ai], now)).toBe(false)
  })
  it('stops after 60 seconds', () => {
    expect(isSecretaryTyping('personal', [person], now + 31_000)).toBe(false)
  })
  it('is off when there are no person messages', () => {
    expect(isSecretaryTyping('personal', [], now)).toBe(false)
  })
})
