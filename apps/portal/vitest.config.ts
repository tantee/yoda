import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'portal',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
