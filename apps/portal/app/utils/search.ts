import { SEARCH_MIN_LENGTH, type NotificationKind, type SearchResultType } from '@yoda/shared'

/** The jump box asks the server once the trimmed text is long enough. */
export function searchReady(q: string | null | undefined): boolean {
  return (q ?? '').trim().length >= SEARCH_MIN_LENGTH
}

export const SEARCH_ICONS: Record<SearchResultType, string> = {
  project: 'mdi-folder-outline',
  work_item: 'mdi-file-document-outline',
  person: 'mdi-account-outline',
  request: 'mdi-clipboard-text-outline',
}

export const NOTIFICATION_ICONS: Record<NotificationKind, string> = {
  task_assigned: 'mdi-account-arrow-left-outline',
  proposal_pending: 'mdi-check-decagram-outline',
  request_update: 'mdi-clipboard-text-outline',
  work_item_stuck: 'mdi-alert-outline',
  secretary_message: 'mdi-robot-outline',
  budget_alert: 'mdi-cash-alert',
  discussion: 'mdi-forum-outline',
}

/** True for a ⌘K / Ctrl K press (the search shortcut). */
export function isSearchHotkey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
}

/** Same-site portal paths only (never `//host` or a full URL). */
export function isLocalRoute(link: string | null | undefined): link is string {
  return !!link && link.startsWith('/') && !link.startsWith('//')
}
