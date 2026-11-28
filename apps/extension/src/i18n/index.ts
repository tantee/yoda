import { createI18n } from 'vue-i18n'
import en from './en.json'
import th from './th.json'

export type Locale = 'th' | 'en'
const KEY = 'locale'

/** The saved ไทย/EN choice (storage.local, shared by every extension page); Thai by default. */
export async function savedLocale(): Promise<Locale> {
  try {
    const v = (await chrome.storage.local.get(KEY))[KEY]
    return v === 'en' ? 'en' : 'th'
  } catch {
    return 'th'
  }
}

export async function saveLocale(l: Locale): Promise<void> {
  await chrome.storage.local.set({ [KEY]: l })
}

export function makeI18n(locale: Locale) {
  return createI18n({ legacy: false, locale, fallbackLocale: 'en', messages: { th, en } })
}
