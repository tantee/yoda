import { describe, expect, it } from 'vitest'
import type { Message } from '@yoda/shared'
import { applySent, groupMessages, isSecretaryTyping, mergeLatest, mergeMessages, systemMarkerKey } from '../app/utils/chat'

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
  it('in project and work_item threads only after a message that mentions @ai / @ผู้ช่วย', () => {
    expect(isSecretaryTyping('project', [person], now)).toBe(false)
    expect(isSecretaryTyping('work_item', [person], now)).toBe(false)
    const asked = msg({ text: '@AI ช่วยสรุป', createdAt: '2026-11-24T10:00:00Z' })
    expect(isSecretaryTyping('project', [asked], now)).toBe(true)
    expect(isSecretaryTyping('work_item', [msg({ text: '@ผู้ช่วย สรุป', createdAt: '2026-11-24T10:00:00Z' })], now)).toBe(true)
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

describe('applySent', () => {
  const A = '00000000-0000-4000-8000-00000000000a'
  const B = '00000000-0000-4000-8000-00000000000b'
  it('merges a message into its own open conversation', () => {
    const m = msg({ conversationId: A, createdAt: '2026-11-24T10:00:00Z' })
    expect(applySent(A, [], m)).toEqual([m])
  })
  it('drops a message sent from a conversation that is no longer open', () => {
    const m = msg({ conversationId: A, createdAt: '2026-11-24T10:00:00Z' })
    const existing = msg({ conversationId: B, createdAt: '2026-11-24T10:00:00Z' })
    expect(applySent(B, [existing], m)).toEqual([existing])
    expect(applySent(null, [], m)).toEqual([])
  })
})

describe('mergeLatest', () => {
  const page = (n: number) => Array.from({ length: n }, () => msg({ createdAt: '2026-11-24T10:00:00Z' }))
  it('sets hasMore from a full page when the list was empty', () => {
    expect(mergeLatest([], false, page(50), 50).hasMore).toBe(true)
    expect(mergeLatest([], false, page(3), 50).hasMore).toBe(false)
  })
  it('keeps hasMore once the list is populated', () => {
    const existing = page(50)
    expect(mergeLatest(existing, true, page(2), 50).hasMore).toBe(true)
    expect(mergeLatest(existing, false, page(50), 50).hasMore).toBe(false)
  })
})

describe('systemMarkerKey', () => {
  const at = '2026-11-24T10:00:00Z'
  it('maps a known marker in a system message to its i18n key', () => {
    expect(systemMarkerKey(msg({ authorKind: 'system', text: '[[secretary.not_ready]]', createdAt: at }))).toBe(
      'chat.marker.secretaryNotReady',
    )
  })
  it('maps secretary failure markers by reason; an unknown reason falls back to the generic failure', () => {
    const key = (text: string) => systemMarkerKey(msg({ authorKind: 'system', text, createdAt: at }))
    expect(key('[[secretary.failed:budget_exceeded]]')).toBe('chat.marker.secretaryFailed.budget_exceeded')
    expect(key('[[secretary.failed:no_ai]]')).toBe('chat.marker.secretaryFailed.no_ai')
    expect(key('[[secretary.failed:ai_unavailable]]')).toBe('chat.marker.secretaryFailed.ai_unavailable')
    expect(key('[[secretary.failed:ai_failed]]')).toBe('chat.marker.secretaryFailed.ai_failed')
    expect(key('[[secretary.failed:something_new]]')).toBe('chat.marker.secretaryFailed.ai_failed')
    expect(key('[[secretary.not_ready:x]]')).toBeNull()
  })
  it('ignores unknown markers, plain text and non-system authors', () => {
    expect(systemMarkerKey(msg({ authorKind: 'system', text: '[[nope]]', createdAt: at }))).toBeNull()
    expect(systemMarkerKey(msg({ authorKind: 'system', text: 'hello', createdAt: at }))).toBeNull()
    expect(systemMarkerKey(msg({ authorKind: 'person', text: '[[secretary.not_ready]]', createdAt: at }))).toBeNull()
    expect(systemMarkerKey(msg({ authorKind: 'ai', text: '[[secretary.not_ready]]', createdAt: at }))).toBeNull()
  })
})
