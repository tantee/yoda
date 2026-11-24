import { defineConfig } from 'vitest/config'

// Root config using Vitest `projects` (replaces deprecated vitest.workspace.ts).
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
})
