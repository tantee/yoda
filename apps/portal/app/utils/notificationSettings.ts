import { ChannelName, type MyNotificationPrefs, type NotificationKind, type NotificationPrefs } from '@yoda/shared'

export type ChannelColumn = {
  name: ChannelName
  /** Configured in env and enabled by an admin. */
  available: boolean
  linked: boolean
  /** Checkboxes in this column can be ticked. */
  usable: boolean
}

/** One column per channel. LINE and Telegram stay disabled ("not available") until they are on and linked. */
export function channelColumns(my: MyNotificationPrefs): ChannelColumn[] {
  return ChannelName.options.map((name) => {
    const available = my.channels.available.includes(name)
    const linked = my.channels.linked[name]
    return { name, available, linked, usable: available && linked }
  })
}

export function isChecked(prefs: NotificationPrefs, kind: NotificationKind, channel: ChannelName): boolean {
  return prefs.kinds[kind]?.includes(channel) ?? false
}

/** A copy of `prefs` with `channel` turned on or off for `kind` (channels kept in a stable order). */
export function toggleChannel(prefs: NotificationPrefs, kind: NotificationKind, channel: ChannelName, on: boolean): NotificationPrefs {
  const current = new Set(prefs.kinds[kind] ?? [])
  if (on) current.add(channel)
  else current.delete(channel)
  return { kinds: { ...prefs.kinds, [kind]: ChannelName.options.filter((c) => current.has(c)) } }
}

export const kindKey = (kind: NotificationKind) => `notifications.kinds.${kind}`
export const channelKey = (name: ChannelName) => `notifications.channels.${name}`

/** Milliseconds left before a link code expires (never negative). */
export const msLeft = (expiresAt: string, now: number) => Math.max(0, Date.parse(expiresAt) - now)

/** `m:ss` for a link code's countdown. */
export function countdown(expiresAt: string, now: number): string {
  const secs = Math.ceil(msLeft(expiresAt, now) / 1000)
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

/**
 * Why a column cannot be ticked, as an i18n key (null when it can): not enabled by an admin, no email on the
 * account, or a chat channel not linked yet ("เชื่อม Telegram ก่อน").
 */
export function columnNoteKey(c: Pick<ChannelColumn, 'name' | 'available' | 'linked'>): string | null {
  if (!c.available) return 'notifications.settings.notAvailable'
  if (c.linked) return null
  return c.name === 'email' ? 'notifications.settings.noEmail' : 'notifications.settings.linkFirst'
}

/** A link code lives 15 minutes (core); the share of that time left, 0-100, for the countdown ring. */
export const LINK_CODE_MS = 15 * 60 * 1000
export function codeLeftPercent(expiresAt: string, now: number): number {
  return Math.min(100, Math.round((msLeft(expiresAt, now) / LINK_CODE_MS) * 100))
}

/** One grid cell (a kind × channel checkbox); only the cell being saved is disabled. */
export const cellKey = (kind: NotificationKind, channel: ChannelName) => `${kind}:${channel}`

/**
 * Runs saves one after another, in click order, so a later save (built on the earlier click) always lands last.
 * `pending` counts the saves not finished yet; the grid takes the server's answer only from the last one.
 */
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  let pending = 0
  return {
    run<T>(job: () => Promise<T>): Promise<T> {
      pending++
      const p = tail.then(job).finally(() => { pending-- })
      tail = p.catch(() => undefined)
      return p
    },
    get pending() { return pending },
  }
}

/**
 * A reload (link poll, unlink) while saves are queued keeps the on-screen grid: those clicks are not on the server
 * yet, so the fresh prefs would briefly undo them. Everything else (channels, kinds) is taken fresh.
 */
export function withPendingPrefs(fresh: MyNotificationPrefs, current: MyNotificationPrefs | null, pending: number): MyNotificationPrefs {
  return pending > 0 && current ? { ...fresh, prefs: current.prefs } : fresh
}
