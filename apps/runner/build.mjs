// Bundles the runner CLI into dist/cli.js. Third-party deps stay external (installed with the package);
// @yoda/shared ships TypeScript source, so it is inlined.
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const external = Object.keys(pkg.dependencies).filter((d) => d !== '@yoda/shared')

await build({
  entryPoints: { cli: 'src/cli.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  external,
})
