export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  ssr: false,
  devtools: { enabled: false },
  modules: ['@nuxtjs/i18n'],
  css: ['@mdi/font/css/materialdesignicons.css', 'vuetify/styles'],
  build: { transpile: ['vuetify'] },
  devServer: { port: Number(process.env.PORTAL_PORT ?? 3000) },
  routeRules: {
    '/api/**': { proxy: (process.env.CORE_URL ?? 'http://localhost:4000') + '/**' },
  },
  runtimeConfig: {
    public: {
      keycloakUrl: 'http://localhost:8080',
      keycloakRealm: 'yoda',
      keycloakClientId: 'yoda-portal',
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
