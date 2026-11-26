// Bundles core into dist/. Third-party deps stay external (installed in the image);
// @yoda/shared ships TypeScript source, so it is inlined.
import { cpSync, readFileSync } from 'node:fs'
import { build } from 'esbuild'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const external = Object.keys(pkg.dependencies).filter((d) => d !== '@yoda/shared')

await build({
  entryPoints: { server: 'src/server.ts', migrate: 'src/db/migrate.ts', init: 'src/init.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
})

// Workflow templates are read from disk at startup (see src/workflow/seed.ts).
cpSync('src/workflow/templates', 'dist/workflow/templates', { recursive: true })
