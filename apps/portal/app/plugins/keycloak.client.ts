import Keycloak from 'keycloak-js'
import { loginLocale } from '~/utils/loginLocale'

export default defineNuxtPlugin(async () => {
  const cfg = useRuntimeConfig().public
  const keycloak = new Keycloak({
    url: cfg.keycloakUrl,
    realm: cfg.keycloakRealm,
    clientId: cfg.keycloakClientId,
  })
  // Redirects to Keycloak when not authenticated; resolves once logged in.
  // The sign-in page opens in the portal's language (Keycloak's `ui_locales`).
  await keycloak.init({ onLoad: 'login-required', pkceMethod: 'S256', checkLoginIframe: false, locale: loginLocale(document.cookie) })
  return { provide: { keycloak } }
})
