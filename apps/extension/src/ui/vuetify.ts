import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans-thai/400.css'
import '@fontsource/ibm-plex-sans-thai/500.css'
import '@fontsource/ibm-plex-sans-thai/600.css'
import '@mdi/font/css/materialdesignicons.css'
import 'vuetify/styles'
import './base.css'
import { vuetifyDefaults, vuetifyTheme } from '@yoda/shared/ui/vuetify-theme'
import { createVuetify } from 'vuetify'
import { en, th } from 'vuetify/locale'
import type { Locale } from '../i18n'

/** The portal's theme and defaults, so testers see one product (proposal §2). Components are imported where used. */
export function makeVuetify(locale: Locale) {
  return createVuetify({
    icons: { defaultSet: 'mdi' },
    theme: vuetifyTheme,
    defaults: vuetifyDefaults,
    locale: { locale, fallback: 'en', messages: { en, th } },
  })
}
