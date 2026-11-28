import { createApp, type Component } from 'vue'
import { makeI18n, savedLocale } from '../i18n'
import { makeVuetify } from './vuetify'

/** Mounts an extension page with the shared theme and the saved language. */
export async function mountPage(root: Component): Promise<void> {
  const locale = await savedLocale()
  document.documentElement.lang = locale
  createApp(root).use(makeI18n(locale)).use(makeVuetify(locale)).mount('#app')
}
