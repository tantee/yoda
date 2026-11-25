export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  ssr: false,
  devtools: { enabled: false },
  modules: ['@nuxtjs/i18n'],
  css: ['@mdi/font/css/materialdesignicons.css', 'vuetify/styles'],
  build: { transpile: ['vuetify'] },
  devServer: { port: Number(process.env.PORTAL_PORT ?? 3000) },
  runtimeConfig: {
    // Server-only; override at runtime with NUXT_CORE_URL (used by server/routes/api proxy).
    coreUrl: process.env.CORE_URL ?? 'http://localhost:4000',
    public: {
      keycloakUrl: 'http://localhost:8080',
      keycloakRealm: 'yoda',
      keycloakClientId: 'yoda-portal',
      // The README's Runners section, linked from the Runners page (NUXT_PUBLIC_RUNNER_DOCS_URL).
      runnerDocsUrl: 'https://github.com/tantee/yoda#runners',
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
