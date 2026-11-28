import { createVuetify } from 'vuetify'
import { en, th } from 'vuetify/locale'
import { vuetifyDefaults, vuetifyTheme } from '@yoda/shared/ui/vuetify-theme'

// The tokens and defaults live in @yoda/shared, shared with the Yoda Reporter extension.
export { vuetifyDefaults, vuetifyTheme }

export default defineNuxtPlugin((nuxtApp) => {
  const i18n = nuxtApp.$i18n as { locale: Ref<string> }
  // Components and directives are imported where used (vite-plugin-vuetify autoImport in nuxt.config.ts).
  const vuetify = createVuetify({
    icons: { defaultSet: 'mdi' },
    theme: vuetifyTheme,
    defaults: vuetifyDefaults,
    locale: { locale: i18n.locale.value === 'en' ? 'en' : 'th', fallback: 'en', messages: { en, th } },
  })
  nuxtApp.vueApp.use(vuetify)
  watch(
    i18n.locale,
    (l) => {
      vuetify.locale.current.value = l === 'en' ? 'en' : 'th'
    },
    { immediate: true },
  )
})
