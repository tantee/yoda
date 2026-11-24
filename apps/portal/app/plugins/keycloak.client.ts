import Keycloak from 'keycloak-js'

export default defineNuxtPlugin(async () => {
  const cfg = useRuntimeConfig().public
  const keycloak = new Keycloak({
    url: cfg.keycloakUrl,
    realm: cfg.keycloakRealm,
    clientId: cfg.keycloakClientId,
  })
  // Redirects to Keycloak when not authenticated; resolves once logged in.
  await keycloak.init({ onLoad: 'login-required', pkceMethod: 'S256', checkLoginIframe: false })
  return { provide: { keycloak } }
})
