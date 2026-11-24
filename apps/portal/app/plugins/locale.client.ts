// Thai is the default; a user's explicit choice is remembered in a cookie (browser language is ignored).
export default defineNuxtPlugin(async (nuxtApp) => {
  const i18n = nuxtApp.$i18n as { locale: Ref<string>; setLocale: (l: 'th' | 'en') => Promise<void> }
  const saved = useCookie<string | null>('yoda_locale', { maxAge: 60 * 60 * 24 * 365 })
  if (saved.value === 'en' || saved.value === 'th') await i18n.setLocale(saved.value)
  watch(i18n.locale, (l) => { saved.value = l })
})
