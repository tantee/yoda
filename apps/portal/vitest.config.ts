import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Components are rendered to strings (no DOM); Nuxt auto-imports come from an explicit `#imports` shim.
  plugins: [vue()],
  resolve: {
    alias: {
      '#imports': fileURLToPath(new URL('./test/support/imports.ts', import.meta.url)),
      '~': fileURLToPath(new URL('./app', import.meta.url)),
    },
  },
  test: {
    name: 'portal',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    server: { deps: { inline: ['vuetify'] } },
  },
})
