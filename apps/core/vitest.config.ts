import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'core',
    include: ['test/**/*.test.ts'],
    // Tests share one Postgres database, so files must run serially.
    fileParallelism: false,
  },
})
