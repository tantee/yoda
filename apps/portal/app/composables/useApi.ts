export function useApi() {
  const { $keycloak } = useNuxtApp()
  return $fetch.create({
    baseURL: '/api',
    async onRequest({ options }) {
      try {
        await $keycloak.updateToken(30)
      } catch {
        // Session/refresh token expired: go back through login and never send the request.
        await $keycloak.login()
        throw new Error('session_expired')
      }
      const headers = new Headers(options.headers)
      headers.set('Authorization', `Bearer ${$keycloak.token}`)
      options.headers = headers
    },
  })
}
