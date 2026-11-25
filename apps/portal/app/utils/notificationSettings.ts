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
