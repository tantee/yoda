/**
 * UI dates (proposal §7.4): Asia/Bangkok, no seconds; Thai in the Buddhist era (`25 พ.ย. 2569 14:05`),
 * English in the Gregorian calendar (`25 Nov 2026, 14:05`). Components use `useDateFormat()`.
 */
const TZ = 'Asia/Bangkok'
type Input = string | Date | null | undefined

const tag = (locale: string) => (locale === 'en' ? 'en-GB' : 'th-TH')
const cache = new Map<string, Intl.DateTimeFormat>()
function fmt(locale: string, kind: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${kind}`
  let f = cache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(tag(locale), { ...opts, timeZone: TZ })
    cache.set(key, f)
  }
  return f
}

/** A calendar date (`YYYY-MM-DD`) is its own day; anything else is an instant. */
function toDate(v: Input): Date | null {
  if (!v) return null
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00+07:00`) : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatDateTime(v: Input, locale: string): string {
  const d = toDate(v)
  return d ? fmt(locale, 'dt', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d) : ''
}

export function formatDate(v: Input, locale: string): string {
  const d = toDate(v)
  return d ? fmt(locale, 'd', { day: 'numeric', month: 'short', year: 'numeric' }).format(d) : ''
}

/** For dense surfaces: the year is dropped within the current (Bangkok) year. */
export function formatDateShort(v: Input, locale: string, now = new Date()): string {
  const d = toDate(v)
  if (!d) return ''
  const year = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 4)
  return year(d) === year(now) ? fmt(locale, 'dm', { day: 'numeric', month: 'short' }).format(d) : formatDate(d, locale)
}

export function formatTime(v: Input, locale: string): string {
  const d = toDate(v)
  return d ? fmt(locale, 't', { hour: '2-digit', minute: '2-digit', hour12: false }).format(d) : ''
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
]

/** "3 ชม. ที่แล้ว" up to a week back; older (or future) times show the date. */
export function formatRelative(v: Input, locale: string, now = new Date()): string {
  const d = toDate(v)
  if (!d) return ''
  const secs = Math.round((now.getTime() - d.getTime()) / 1000)
  if (secs < -60 || secs >= 7 * 86400) return formatDate(d, locale)
  const rtf = new Intl.RelativeTimeFormat(locale === 'en' ? 'en' : 'th', { numeric: 'auto', style: 'short' })
  for (const [unit, size] of UNITS) {
    if (Math.abs(secs) >= size) return rtf.format(-Math.floor(secs / size), unit)
  }
  return rtf.format(0, 'second')
}
