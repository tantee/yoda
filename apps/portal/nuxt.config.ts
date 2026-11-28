import { fileURLToPath } from 'node:url'
import vuetify, { transformAssetUrls } from 'vite-plugin-vuetify'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  ssr: false,
  devtools: { enabled: false },
  app: {
    head: {
      // The Thai 400 face is on every page (proposal §3.2: preload that one file only).
      link: [
        { rel: 'preload', href: '/fonts/ibm-plex-sans-thai-thai-400-normal.woff2', as: 'font', type: 'font/woff2', crossorigin: '' },
        // The static mark (docs/design/jedi-touch.md), the same whether fun mode is on or off.
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
    },
  },
  modules: [
    '@nuxtjs/i18n',
    // Tree-shaken Vuetify: only the components and directives the templates use are bundled.
    // Styles compile from SASS with the design settings (fonts, type scale, no uppercase).
    (_options, nuxt) => {
      nuxt.hooks.hook('vite:extendConfig', (config) => {
        const styles = { configFile: fileURLToPath(new URL('./app/assets/vuetify-settings.scss', import.meta.url)) }
        // vite-plugin-vuetify is typed against a newer Vite than Nuxt's; the plugin objects are compatible.
        config.plugins?.push(vuetify({ autoImport: true, styles }) as unknown as NonNullable<typeof config.plugins>[number])
      })
    },
  ],
  // The extension approve page is never framed (clickjacking an Approve).
  routeRules: { '/extension/**': { headers: { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' } } },
  css: ['~/assets/fonts.css', '@mdi/font/css/materialdesignicons.css', 'vuetify/styles', '~/assets/main.css'],
  build: { transpile: ['vuetify'] },
  vite: { vue: { template: { transformAssetUrls } } },
  devServer: { port: Number(process.env.PORTAL_PORT ?? 3000) },
  runtimeConfig: {
    // Server-only; override at runtime with NUXT_CORE_URL (used by server/routes/api proxy).
    coreUrl: process.env.CORE_URL ?? 'http://localhost:4000',
    // Deprecated overrides, all '' by default: the portal reads sign-in, the org line and its links from core's
    // GET /api/public-config (settings, §5.6). A non-empty NUXT_PUBLIC_* value still wins (dev keeps its .env).
    public: {
      keycloakUrl: '',
      keycloakRealm: '',
      keycloakClientId: '',
      // Setup docs linked from the Runners page (NUXT_PUBLIC_RUNNER_DOCS_URL; core's default: the README's Runners).
      runnerDocsUrl: '',
      // The LINE Official Account's add-friend link, shown when linking LINE (NUXT_PUBLIC_LINE_ADD_FRIEND_URL).
      lineAddFriendUrl: '',
      // A line at the foot of the side menu, e.g. the department or hospital name (NUXT_PUBLIC_ORG_LINE).
      orgLine: '',
    },
  },
  i18n: {
    defaultLocale: 'th',
    strategy: 'no_prefix',
    locales: [
      { code: 'th', name: 'ไทย', file: 'th.json' },
      { code: 'en', name: 'English', file: 'en.json' },
    ],
    detectBrowserLanguage: false,
  },
})
