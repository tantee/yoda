// Thai is the default (or the organisation's default language); a user's explicit choice is remembered in a cookie (browser language is ignored).
export default defineNuxtPlugin(async (nuxtApp) => {
  const i18n = nuxtApp.$i18n as { locale: Ref<string>; setLocale: (l: 'th' | 'en') => Promise<void> }
  const saved = useCookie<string | null>('yoda_locale', { maxAge: 60 * 60 * 24 * 365 })
  if (saved.value === 'en' || saved.value === 'th') await i18n.setLocale(saved.value)
  // No choice yet: the organisation's default language (System settings → General, from /public-config).
  else if (usePublicConfig().config.value?.org.defaultLocale === 'en') await i18n.setLocale('en')
  watch(i18n.locale, (l) => { saved.value = l })
})
