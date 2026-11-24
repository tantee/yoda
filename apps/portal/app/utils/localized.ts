import type { LocalizedText } from '@yoda/shared'

export function localized(text: LocalizedText, locale: string): string {
  return (locale === 'en' ? text.en : text.th) || text.th
}
