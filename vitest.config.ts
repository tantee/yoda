import { defineConfig } from 'vitest/config'

// Root config using Vitest `projects` (replaces deprecated vitest.workspace.ts).
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    // `fileParallelism` is a root-only option (ignored inside project configs).
    // apps/core test files share one Postgres database, so files must run serially.
    fileParallelism: false,
  },
})
