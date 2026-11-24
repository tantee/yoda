export function useApi() {
  const { $keycloak } = useNuxtApp()
  return $fetch.create({
    baseURL: '/api',
    async onRequest({ options }) {
      await $keycloak.updateToken(30)
      const headers = new Headers(options.headers)
      headers.set('Authorization', `Bearer ${$keycloak.token}`)
      options.headers = headers
    },
  })
}
