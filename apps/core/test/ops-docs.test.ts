import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { envSchema } from '../src/config.js'

// docs/operations.md's environment table stays in sync with what the code and the prod compose read.
const root = fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8')

const runbook = read('docs/operations.md')
const envExample = read('.env.example')

/** The names in the first column of the runbook's environment tables (`| \`NAME\` | ...`). */
const tableNames = new Set([...runbook.matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm)].map((m) => m[1]!))

const coreKeys = Object.keys(envSchema.shape)

/** Portal runtime config: `public.fooBar` is NUXT_PUBLIC_FOO_BAR, server-only `coreUrl` is NUXT_CORE_URL. */
function portalKeys() {
  const src = read('apps/portal/nuxt.config.ts')
  const block = /public:\s*\{([\s\S]*?)\n\s*\},/.exec(src)?.[1] ?? ''
  const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
  const pub = [...block.matchAll(/^\s*(\w+):/gm)].map((m) => `NUXT_PUBLIC_${snake(m[1]!)}`)
  return ['NUXT_CORE_URL', ...pub]
}

/** Every variable the prod overlay interpolates (`${NAME}`, `${NAME:-x}`, `${NAME:?x}`), skipping `$${...}`. */
function composeKeys() {
  const src = read('docker-compose.prod.yml')
  return [...src.matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!)
}

describe('docs/operations.md environment table', () => {
  it('reads a non-trivial table', () => {
    expect(coreKeys.length).toBeGreaterThan(30)
    expect(tableNames.size).toBeGreaterThan(30)
  })

  it('lists every core config key', () => {
    expect(coreKeys.filter((k) => !tableNames.has(k))).toEqual([])
  })

  it('lists every portal runtime key', () => {
    const keys = portalKeys()
    expect(keys).toContain('NUXT_PUBLIC_KEYCLOAK_URL')
    expect(keys.filter((k) => !tableNames.has(k))).toEqual([])
  })

  it('lists every variable the prod compose reads', () => {
    expect(composeKeys().filter((k) => !tableNames.has(k))).toEqual([])
  })

  it('lists nothing the code or compose does not read', () => {
    const known = new Set([...coreKeys, ...portalKeys(), ...composeKeys()])
    expect([...tableNames].filter((k) => !known.has(k))).toEqual([])
  })
})

describe('.env.example', () => {
  it('has every core config key', () => {
    const missing = coreKeys.filter((k) => !new RegExp(`^${k}=`, 'm').test(envExample))
    expect(missing).toEqual([])
  })

  it('has the release variables of the prod compose', () => {
    for (const k of ['YODA_IMAGE_PREFIX', 'YODA_VERSION']) expect(envExample).toMatch(new RegExp(`^#? ?${k}=`, 'm'))
  })
})
