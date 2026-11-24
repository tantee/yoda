import { mentionsSecretary, type ConversationKind, type Message } from '@yoda/shared'

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
 * The secretary answers every person message in personal/intake threads, and in project/work_item threads
 * those that mention it (`@ai` / `@ผู้ช่วย`): "typing" while the latest message is such a person message with
 * no later ai/system message, for at most 60 s.
 */
export function isSecretaryTyping(kind: ConversationKind, messages: Message[], now: number): boolean {
  const m = messages.at(-1)
  if (!m || m.authorKind !== 'person') return false
  if (kind !== 'personal' && kind !== 'intake' && !mentionsSecretary(m.text)) return false
  return now - Date.parse(m.createdAt) < TYPING_TIMEOUT_MS
}

/** A just-sent message joins the list only if its conversation is still the open one. */
export function applySent(openId: string | null, list: Message[], sent: Message): Message[] {
  return sent.conversationId === openId ? mergeMessages(list, [sent]) : list
}

/**
 * Merges the newest page into the list. When the list was still empty (the initial load was superseded or
 * not back yet) this page is the first one, so it also decides whether older messages exist.
 */
export function mergeLatest(
  list: Message[],
  hasMore: boolean,
  page: Message[],
  limit: number,
): { messages: Message[]; hasMore: boolean } {
  return { messages: mergeMessages(list, page), hasMore: list.length === 0 ? page.length === limit : hasMore }
}

/** Stable markers the core stores as system message text, mapped to i18n keys. */
const SYSTEM_MARKERS: Record<string, string> = {
  'secretary.not_ready': 'chat.marker.secretaryNotReady',
}
/** `[[secretary.failed:<reason>]]`: why the secretary could not answer. */
const SECRETARY_FAILED = new Set(['budget_exceeded', 'no_ai', 'ai_unavailable', 'ai_failed'])

/** The i18n key for a known `[[marker]]` / `[[marker:arg]]` system message, else null (show the text as is). */
export function systemMarkerKey(m: Pick<Message, 'authorKind' | 'text'>): string | null {
  if (m.authorKind !== 'system') return null
  const match = /^\[\[([a-z0-9_.]+)(?::([a-z0-9_]+))?\]\]$/.exec(m.text.trim())
  if (!match) return null
  const [, name, arg] = match
  if (name === 'secretary.failed' && arg !== undefined) {
    return `chat.marker.secretaryFailed.${SECRETARY_FAILED.has(arg) ? arg : 'ai_failed'}`
  }
  return arg === undefined ? (SYSTEM_MARKERS[name!] ?? null) : null
}
