/**
 * The language for the Keycloak sign-in page (`ui_locales`): the portal's saved choice (`yoda_locale` cookie),
 * else Thai, so the browser's language never decides it (same rule as plugins/locale.client.ts).
 */
export function loginLocale(cookie: string): 'th' | 'en' {
  return /(?:^|;\s*)yoda_locale=en(?:;|$)/.test(cookie) ? 'en' : 'th'
}
