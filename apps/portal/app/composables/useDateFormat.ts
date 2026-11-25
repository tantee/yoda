import { formatDate, formatDateShort, formatDateTime, formatRelative, formatTime } from '~/utils/dates'

type Input = string | Date | null | undefined

/** Dates in the current UI language: Buddhist era in Thai, Gregorian in English, Bangkok time, no seconds. */
export function useDateFormat() {
  const { locale } = useI18n()
  return {
    dateTime: (v: Input) => formatDateTime(v, locale.value),
    date: (v: Input) => formatDate(v, locale.value),
    dateShort: (v: Input) => formatDateShort(v, locale.value),
    time: (v: Input) => formatTime(v, locale.value),
    relative: (v: Input, now?: Date) => formatRelative(v, locale.value, now),
  }
}
