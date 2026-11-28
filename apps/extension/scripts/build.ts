// Builds the extension: `release` into dist/ (with --zip, release/yoda-reporter-<version>.zip), or `e2e` into
// dist-e2e/ (the e2e-only host permission and ?tab= target). The manifest `key` comes from keys/yoda-reporter.pub,
// or YODA_EXTENSION_PUBLIC_KEY_FILE (tests); never a private key.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync, type Zippable } from 'fflate'
import { build } from 'vite'
import { buildManifest, type BuildTarget } from '../src/manifest'

const root = fileURLToPath(new URL('..', import.meta.url))
const target = (process.argv[2] ?? 'release') as BuildTarget
if (target !== 'release' && target !== 'e2e') throw new Error(`unknown target ${target}`)
const zip = process.argv.includes('--zip')
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version
const outDir = join(root, target === 'e2e' ? 'dist-e2e' : 'dist')

function publicKey(): string | null {
  const file = process.env.YODA_EXTENSION_PUBLIC_KEY_FILE ?? join(root, '../../keys/yoda-reporter.pub')
  return existsSync(file) ? readFileSync(file, 'utf8').trim() || null : null
}

await build({ root, configFile: join(root, 'vite.config.ts'), mode: target, logLevel: 'warn' })
for (const name of ['isolated', 'main']) {
  await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    define: { 'import.meta.env.VITE_TARGET': JSON.stringify(target) },
    build: {
      outDir: join(outDir, 'injected'),
      emptyOutDir: false,
      target: 'chrome116',
      minify: true,
      lib: { entry: join(root, `src/injected/${name}.ts`), formats: ['iife'], name: `yodaReporter_${name}`, fileName: () => `${name}.js` },
    },
  })
}
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(buildManifest({ yodaVersion: version, publicKey: publicKey(), target }), null, 2)}\n`)

if (zip) {
  if (target !== 'release') throw new Error('only the release build is zipped')
  // Reproducible: sorted entries, every mtime SOURCE_DATE_EPOCH (or 1980-01-01, the zip epoch).
  const epoch = process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000) : new Date('1980-01-01T00:00:00Z')
  const files: Zippable = {}
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
  for (const f of walk(outDir).sort()) files[relative(outDir, f).split('\\').join('/')] = [readFileSync(f), { mtime: epoch, level: 9 }]
  const release = join(root, 'release')
  rmSync(release, { recursive: true, force: true })
  mkdirSync(release, { recursive: true })
  writeFileSync(join(release, `yoda-reporter-${version}.zip`), zipSync(files))
  console.log(`release/yoda-reporter-${version}.zip`)
}
console.log(`built ${target} into ${relative(root, outDir)}`)
