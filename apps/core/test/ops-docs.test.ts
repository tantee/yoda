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

describe('docs/operations.md commands', () => {
  const DC = 'docker compose --env-file .env --env-file release.env -f docker-compose.yml -f docker-compose.prod.yml'

  it('defines dc with the host .env and the pinned release.env', () => {
    expect(runbook).toContain(`alias dc='${DC}'`)
  })

  it('runs every host compose command through dc (only the local try-out names the files)', () => {
    const raw = [...runbook.matchAll(/^.*docker compose -f docker-compose\.yml.*$/gm)].map((m) => m[0])
    expect(raw.length).toBe(1)
    expect(raw[0]).toContain('YODA_VERSION=latest docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d')
    expect(runbook).not.toMatch(/docker compose \.\.\./)
  })

  it('never builds on the host: every `dc up` has --no-build', () => {
    const ups = [...runbook.matchAll(/\bdc (?:--profile \w+ )?up -d\b[^`]*/g)].map((m) => m[0])
    expect(ups.length).toBeGreaterThan(5)
    expect(ups.filter((u) => !u.includes('--no-build'))).toEqual([])
    expect(runbook).toContain('dc run --rm backup --now')
    expect(runbook).toContain('dc run --rm -e RESTORE_CONFIRM=yes --entrypoint restore.sh backup')
  })

  it('does not copy the dev init.sql to the host', () => {
    expect(runbook).not.toContain('init.sql')
  })
})

describe('docs consistency', () => {
  it('shows 8-character link codes everywhere', () => {
    for (const [name, text] of [['runbook', runbook], ['.env.example', envExample], ['README', read('README.md')]] as const) {
      const codes = [...text.matchAll(/LINK-(X+)\b/g)].map((m) => m[1]!.length)
      expect(codes.filter((n) => n !== 8), name).toEqual([])
    }
    expect(runbook).toContain('LINK-XXXXXXXX')
  })

  it('.env.example points the webhooks at the same URLs as the runbook', () => {
    for (const path of ['/api/webhooks/line', '/api/webhooks/telegram']) {
      const url = `https://portal.example.org${path}`
      expect(runbook).toContain(url)
      expect(envExample).toContain(url)
    }
    expect(envExample).not.toMatch(/<core>\/webhooks/)
  })

  it('.env.example says secrets live in the host .env, as the runbook does', () => {
    expect(envExample).not.toMatch(/secrets come from the deploy environment/i)
    expect(envExample).toMatch(/Secrets live only in that \.env and in CI\/CD variables, never in the repository/)
    expect(runbook).toMatch(/Secrets live only in the deploy host's `\.env`/)
  })
})
