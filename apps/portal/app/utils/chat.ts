import type { ConversationKind, Message } from '@yoda/shared'

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** Bangkok calendar day (YYYY-MM-DD) of an ISO timestamp. */
export function bangkokDay(iso: string): string {
  return dayFormat.format(new Date(iso))
}

/** Groups messages by Bangkok calendar day, preserving order. */
export function groupMessages(messages: Message[]): { day: string; items: Message[] }[] {
  const groups: { day: string; items: Message[] }[] = []
  for (const m of messages) {
    const day = bangkokDay(m.createdAt)
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.items.push(m)
    else groups.push({ day, items: [m] })
  }
  return groups
}

/** Union by id, ascending by seq. */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map<string, Message>()
  for (const m of existing) byId.set(m.id, m)
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

export const TYPING_TIMEOUT_MS = 60_000

/**
 * The secretary only answers in personal/intake threads: "typing" while the latest person message has no
 * later ai/system message, for at most 60 s.
 */
export function isSecretaryTyping(kind: ConversationKind, messages: Message[], now: number): boolean {
  if (kind !== 'personal' && kind !== 'intake') return false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.authorKind !== 'person') return false
    return now - Date.parse(m.createdAt) < TYPING_TIMEOUT_MS
  }
  return false
}
