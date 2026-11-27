import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Nuxt registers components/<dir>/<Name>.vue as <DirName> (the directory is a prefix, a repeated segment dropped).
// A bare <Name> for such a file resolves to nothing at runtime: Vue renders an unknown element and the page loses it
// silently (found on /recovery: no TOTP QR code or secret, no new codes). Every PascalCase tag must be imported in
// the file or be a name Nuxt registers.
const app = fileURLToPath(new URL('../app/', import.meta.url))
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.vue') ? [p] : []
  })
const pascal = (s: string) => s.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')

function nuxtName(file: string): string {
  const parts = relative(join(app, 'components'), file).replace(/\.vue$/, '').split('/').map(pascal)
  let name = ''
  for (const p of parts) name = p.startsWith(name) && name ? p : name + p
  return name
}

const registered = new Set([
  ...walk(join(app, 'components')).map(nuxtName),
  'NuxtLayout', 'NuxtPage', 'NuxtLink', 'NuxtLoadingIndicator', 'ClientOnly', 'Teleport', 'Transition', 'TransitionGroup', 'KeepAlive', 'Suspense', 'Component',
])

describe('component names', () => {
  it('every PascalCase tag in a template is imported or registered by Nuxt', () => {
    const problems: string[] = []
    for (const file of [...walk(join(app, 'pages')), ...walk(join(app, 'components')), ...walk(join(app, 'layouts')), join(app, 'app.vue')]) {
      const src = readFileSync(file, 'utf8')
      const template = src.slice(src.indexOf('<template'))
      const imported = new Set([...src.matchAll(/import\s+([A-Z]\w*)\s+from\s+['"][^'"]+\.vue['"]/g)].map((m) => m[1]))
      for (const [, tag] of template.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)) {
        if (!imported.has(tag!) && !registered.has(tag!)) problems.push(`${relative(app, file)}: <${tag}>`)
      }
    }
    expect([...new Set(problems)]).toEqual([])
  })
})
