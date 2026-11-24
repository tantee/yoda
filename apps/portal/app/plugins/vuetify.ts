import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { en, th } from 'vuetify/locale'

export default defineNuxtPlugin((nuxtApp) => {
  const i18n = nuxtApp.$i18n as { locale: Ref<string> }
  const vuetify = createVuetify({
    components,
    directives,
    icons: { defaultSet: 'mdi' },
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
