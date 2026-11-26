import Keycloak from 'keycloak-js'
import { loginLocale } from '~/utils/loginLocale'
import { hashWithoutOAuth } from '~/utils/oauthFragment'

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
  // The callback (`#state=…&code=…`) must not stay in the address bar, history or a copied link. keycloak-js strips
  // it, but Nuxt's first navigation (app:created) replays the URL captured before init, so strip it after every
  // navigation that carries it.
  const router = useRouter()
  router.afterEach((to) => {
    const hash = hashWithoutOAuth(to.hash)
    if (hash !== null) void router.replace({ ...to, hash })
  })
  return { provide: { keycloak } }
})
