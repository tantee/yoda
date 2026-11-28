import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  test: {
    name: 'extension',
    // Only unit tests: the Playwright specs in e2e/ run with `pnpm --filter @yoda/extension e2e`.
    include: ['test/**/*.test.ts'],
    environment: 'node',
    server: { deps: { inline: ['vuetify'] } },
  },
})
