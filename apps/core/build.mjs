// Bundles core into dist/. Third-party deps stay external (installed in the image);
// @yoda/shared ships TypeScript source, so it is inlined.
import { cpSync, readFileSync } from 'node:fs'
import { build } from 'esbuild'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const external = Object.keys(pkg.dependencies).filter((d) => d !== '@yoda/shared')

// src/env-preload.ts must run before every external (the AI SDK reads the environment when it is imported). esbuild
// places external imports where their module lands in the bundle (lazily loaded modules come first), so each entry
// gets `import "./env-preload.js"` as its first line (a banner) and the preload is a file of its own; the source
// import of it (for tsx in development) resolves to the same external file.
const preloadExternal = {
  name: 'env-preload-external',
  setup(b) {
    b.onResolve({ filter: /^\.\/env-preload\.js$/ }, () => ({ path: './env-preload.js', external: true }))
  },
}
const common = { outdir: 'dist', bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: true, external }

await build({ ...common, entryPoints: { 'env-preload': 'src/env-preload.ts' } })
await build({
  ...common,
  entryPoints: { server: 'src/server.ts', migrate: 'src/db/migrate.ts', init: 'src/init.ts', 'yoda-admin': 'src/yoda-admin.ts' },
  banner: { js: 'import "./env-preload.js";' },
  plugins: [preloadExternal],
})

// Workflow templates are read from disk at startup (see src/workflow/seed.ts).
cpSync('src/workflow/templates', 'dist/workflow/templates', { recursive: true })
