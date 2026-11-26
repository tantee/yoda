import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PROD_COMPOSE_CORE_ENV, SETTING_KEYS, settingDef } from '@yoda/shared'
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

  it('passes every portal runtime key to the prod portal service', () => {
    const src = read('docker-compose.prod.yml')
    const service = /^  portal:\n([\s\S]*?)(?=^  \S|(?![\s\S]))/m.exec(src)?.[1] ?? ''
    const env = new Set([...service.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!))
    expect(env).toContain('NUXT_CORE_URL')
    expect(portalKeys().filter((k) => !env.has(k))).toEqual([])
  })

  it('lists nothing the code or compose does not read', () => {
    const known = new Set([...coreKeys, ...portalKeys(), ...composeKeys()])
    expect([...tableNames].filter((k) => !known.has(k))).toEqual([])
  })
})

describe('settings registry (installer proposal §5.1, §9)', () => {
  const defs = SETTING_KEYS.map(settingDef)
  const envOf = (pred: (d: (typeof defs)[number]) => boolean) =>
    defs.filter((d) => d.envName && pred(d)).map((d) => d.envName!).sort()
  /** §9 rows the runbook does not list: one lives on the Keycloak server, one is compose's own variable. */
  const NOT_IN_RUNBOOK = ['YODA_LOGIN_FUN_MODE', 'COMPOSE_PROFILES']
  /** The server runner's variables stay outside the registry (§9.4). */
  const runnerOnly = (k: string) => k.startsWith('YODA_RUNNER_') || k.startsWith('YODA_GIT_')

  it('has a core row for exactly the envSchema keys', () => {
    expect(envOf((d) => d.scope === 'core')).toEqual([...coreKeys].sort())
  })

  it('has a portal row for exactly the portal runtime keys', () => {
    const rows = envOf((d) => d.scope === 'portal')
    expect(portalKeys().filter((k) => !rows.includes(k))).toEqual([])
    expect(rows.filter((k) => !portalKeys().includes(k))).toEqual([])
  })

  it('lists every registry env var in the runbook table', () => {
    expect(envOf(() => true).filter((k) => !tableNames.has(k) && !NOT_IN_RUNBOOK.includes(k))).toEqual([])
  })

  it('knows which core variables the prod compose always sets (a default, required, or fixed)', () => {
    const src = read('docker-compose.prod.yml')
    const service = /^  core:\n([\s\S]*?)(?=^  \S)/m.exec(src)?.[1] ?? ''
    const env = /^    environment:\n((?:^      .*\n)+)/m.exec(service)?.[1] ?? ''
    const always = [...env.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*(.*)$/gm)]
      .filter(([, name, value]) => value !== `\${${name}:-}`)
      .map(([, name]) => name!)
    expect(always.length).toBeGreaterThan(10)
    expect([...PROD_COMPOSE_CORE_ENV].sort()).toEqual(always.sort())
  })

  it('has a row for every runbook variable but the server runner ones', () => {
    const rows = new Set(envOf(() => true))
    expect([...tableNames].filter((k) => !rows.has(k) && !runnerOnly(k))).toEqual([])
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

describe('docs/operations.md installer (installer proposal §3.4, §13.2)', () => {
  it('downloads install.sh pinned, checks it, then runs it (never curl | sh)', () => {
    expect(runbook).toContain('curl -fsSLO https://files.example.org/yoda/releases/1.2.0/install.sh')
    expect(runbook).toContain('sh install.sh --version 1.2.0 --dir /srv/yoda')
    expect(runbook).toMatch(/minisign -Vm SHA256SUMS/)
    expect(runbook).not.toMatch(/curl[^\n`]*\|\s*(ba)?sh\b/)
  })

  it('covers the setup token, the recovery kit, the master key and the troubleshooting entries', () => {
    for (const s of [
      'dc exec core yoda-admin setup-token',
      'Store the recovery kit',
      '## 4a. Bootstrap volume and master key',
      '**Setup token lost or expired.**',
      '**Locked out of Keycloak**',
      '**Wrong or missing master key**',
      '"Set by environment" and cannot be edited',
      'YODA_TRUSTED_PROXY_HOPS=2',
      'YODA_RELEASE_SIGNING_KEY',
      'YODA_RELEASE_UPLOAD_URL',
    ]) expect(runbook, s).toContain(s)
  })
})

describe('core image', () => {
  it('leaves the dev-only scripts (demo seed) out of the build context, while typecheck covers them', () => {
    expect(read('.dockerignore').split('\n')).toContain('apps/core/scripts')
    expect(JSON.parse(read('apps/core/tsconfig.json')).include).toContain('scripts')
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
