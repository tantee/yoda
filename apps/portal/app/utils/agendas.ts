/** A copy of `list` with the item at `from` moved to `to` (drag and drop, or the row menu's up / down). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

/** A meeting time from the picker's day (`YYYY-MM-DD`) and time (`HH:mm`), in Bangkok time, as ISO; null if incomplete. */
export function meetingIso(day: string | null, time: string | null): string | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null
  const d = new Date(`${day}T${time}:00+07:00`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Upcoming meetings soonest first, past ones latest first. */
export function splitAgendas<T extends { meetingAt: string }>(list: readonly T[], now: number): { upcoming: T[]; past: T[] } {
  const at = (a: T) => new Date(a.meetingAt).getTime()
  return {
    upcoming: list.filter(a => at(a) >= now).sort((a, b) => at(a) - at(b)),
    past: list.filter(a => at(a) < now).sort((a, b) => at(b) - at(a)),
  }
}
