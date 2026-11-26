import { loginLocale } from '~/utils/loginLocale'
import { sessionEnded } from '~/utils/session'

export function useApi() {
  const { $keycloak } = useNuxtApp()
  return $fetch.create({
    baseURL: '/api',
    async onRequest({ options }) {
      try {
        await $keycloak.updateToken(30)
      } catch {
        // Sign in again only when the session really ended; a refresh that failed while offline (or with Keycloak
        // briefly down) fails just this request, and the page offers a retry.
        if (sessionEnded($keycloak)) {
          await $keycloak.login({ locale: loginLocale(document.cookie) })
          throw new Error('session_expired')
        }
        throw new Error('token_refresh_failed')
      }
      const headers = new Headers(options.headers)
      headers.set('Authorization', `Bearer ${$keycloak.token}`)
      options.headers = headers
    },
  })
}
