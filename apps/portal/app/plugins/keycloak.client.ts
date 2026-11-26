import type { PublicConfig } from '@yoda/shared'
import Keycloak from 'keycloak-js'
import { loginLocale } from '~/utils/loginLocale'
import { hashWithoutOAuth } from '~/utils/oauthFragment'
import { bootPlan, loadPublicConfig } from '~/utils/publicConfig'

// Boot (installer proposal §4.1, §5.6; spike §2): core's /public-config first, then keycloak-js. keycloak-js
// is constructed only once the config is in (init() cannot run twice) and never on /setup or /recovery, so those
// work while sign-in is unset, wrong or down. Without a Keycloak instance (/setup, /recovery, setup required, or
// the boot error screen) nothing that reads $keycloak mounts: the route middleware and app.vue see to it.
export default defineNuxtPlugin(async () => {
  const { config, bootError } = usePublicConfig()
  try {
    config.value = await loadPublicConfig(() => $fetch<PublicConfig>('/api/public-config', { cache: 'no-store' }))
  } catch {
    config.value = null
  }
  const plan = bootPlan(window.location.pathname, config.value, useRuntimeConfig().public)
  if (plan.kind !== 'keycloak') {
    if (plan.kind === 'error') bootError.value = plan.error
    return { provide: { keycloak: null as unknown as Keycloak } }
  }
  const keycloak = new Keycloak(plan.options)
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
