import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SETTING_KEYS, byEnvName, settingDef } from '@yoda/shared'
import { describe, expect, it } from 'vitest'
import { envSchema, loadConfig } from '../src/config.js'
import { prodComposeCoreEnv, prodComposeCoreRaw } from './prod-compose-env.js'

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

  it('passes every UI-editable core setting as ${NAME:-}, so an unset variable never locks it', () => {
    const raw = prodComposeCoreRaw()
    expect(Object.keys(raw).length).toBeGreaterThan(40)
    // Always set (a default, required, or fixed value): only bootstrap-only settings or non-settings may be.
    const always = Object.entries(raw).filter(([name, value]) => value !== `\${${name}:-}`).map(([name]) => name)
    const editable = always.filter((name) => {
      const d = byEnvName(name)
      return d && !d.bootstrapOnly
    })
    expect(editable).toEqual([])
    // With an empty .env, nothing that maps to an editable setting reaches core non-empty.
    const env = prodComposeCoreEnv()
    expect(Object.entries(env).filter(([k, v]) => v !== '' && byEnvName(k) && !byEnvName(k)!.bootstrapOnly)).toEqual([])
  })

  it('trusts two proxy hops when deploy.sh pinned the built-in proxy, unless .env sets them', () => {
    expect(prodComposeCoreEnv().YODA_TRUSTED_PROXY_HOPS).toBe('')
    expect(prodComposeCoreEnv({ YODA_PROXY_ENABLED: 'true' }).YODA_TRUSTED_PROXY_HOPS).toBe('2')
    expect(prodComposeCoreEnv({ YODA_PROXY_ENABLED: 'true', YODA_TRUSTED_PROXY_HOPS: '3' }).YODA_TRUSTED_PROXY_HOPS).toBe('3')
    const env = { ...prodComposeCoreEnv({ YODA_PROXY_ENABLED: 'true', YODA_PROXY_DOMAIN: 'portal.example.org', YODA_PROXY_CERT_MODE: 'internal' }), DATABASE_URL: 'postgres://yoda:x@postgres:5432/yoda', S3_ACCESS_KEY: 'a', S3_SECRET_KEY: 'b' }
    expect(loadConfig(env)).toMatchObject({ trustedProxyHops: 2, proxy: { domain: 'portal.example.org', certMode: 'internal', httpsPort: 443 } })
  })

  it('core starts on the prod compose env with an empty .env (empty values take the defaults)', () => {
    const env = { ...prodComposeCoreEnv(), DATABASE_URL: 'postgres://yoda:x@postgres:5432/yoda', S3_ACCESS_KEY: 'a', S3_SECRET_KEY: 'b' }
    const c = loadConfig(env)
    expect(c).toMatchObject({ oidcClientId: 'yoda-portal', staffGroup: '/it-dev', aiModelDraft: 'anthropic:claude-opus-5-5', aiWorkers: 2, dailyTaskCap: 8, runnerLeaseSeconds: 600, mcpEnabled: true, smtpPort: 587, smtpSecure: false, migrateOnStart: false })
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
    expect(runbook).toContain('curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.2.0/install.sh')
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

describe('release docs (GitHub Releases + GHCR, D1)', () => {
  const readme = read('README.md')
  const guide = read('docs/guides/install.md')
  const releasing = read('docs/releasing.md')
  const installSh = read('ops/install/install.sh')
  const embedded = /^RELEASE_PUBKEY_EMBEDDED='([^']+)'$/m.exec(installSh)?.[1]

  it('installs from the GitHub Release assets, pinned and verified, in the README and the install guide', () => {
    for (const [name, text] of [['README', readme], ['install guide', guide]] as const) {
      for (const f of ['install.sh', 'SHA256SUMS', 'SHA256SUMS.minisig']) {
        expect(text, `${name} ${f}`).toContain(`curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.0.0/${f}\n`)
      }
      expect(text, name).toContain('sh install.sh --version 1.0.0 --dir /srv/yoda')
      expect(text, name).toMatch(/latest release/)
      expect(text, name).toContain('--image-prefix')
      expect(text, name).not.toMatch(/curl[^\n`]*\|\s*(ba)?sh\b/)
    }
    // The mirror is the only place for the placeholder file server.
    expect(readme).not.toContain('files.example.org')
  })

  it('shows the same release public key as install.sh embeds and keys/yoda-release.pub holds', () => {
    expect(embedded).toBeTruthy()
    expect(read('keys/yoda-release.pub').split('\n')[1]).toBe(embedded)
    for (const [name, text] of [['README', readme], ['install guide', guide], ['runbook', runbook], ['releasing', releasing]] as const) {
      const keys = [...text.matchAll(/minisign -Vm SHA256SUMS -P ([A-Za-z0-9+/=]+)/g)].map((m) => m[1])
      expect(keys.length, name).toBeGreaterThan(0)
      expect(new Set(keys), name).toEqual(new Set([embedded]))
    }
  })

  it('verifies before running anything: every snippet keeps the minisign status, checks the trusted comment and the checksum, then chains on', () => {
    for (const [name, text] of [['README', readme], ['install guide', guide], ['runbook', runbook], ['releasing', releasing]] as const) {
      const lines = text.split('\n')
      const at = lines.flatMap((l, i) => (/minisign -Vm SHA256SUMS -P /.test(l) ? [i] : []))
      expect(at.length, name).toBeGreaterThan(0)
      for (const i of at) {
        // out=$(minisign ...) && keeps minisign's exit status (a pipe into grep would drop it).
        expect(lines[i], name).toMatch(/^\s*out=\$\(minisign -Vm SHA256SUMS -P [A-Za-z0-9+/=]+\) &&$/)
        const m = /^\s*printf '%s\\n' "\$out" \| grep -Fx 'Trusted comment: yoda release (\d+\.\d+\.\d+)' &&$/.exec(lines[i + 1]!)
        expect(m, `${name}: ${lines[i + 1]}`).toBeTruthy()
        // The rest of the block: the checksum, then every command chained with && (the last one ends it).
        const rest: string[] = []
        for (let j = i + 2; j < lines.length && !/^\s*```/.test(lines[j]!); j++) rest.push(lines[j]!.replace(/\s+#.*$/, ''))
        expect(rest[0]!.trim(), name).toMatch(/^sha256sum --check --ignore-missing SHA256SUMS( &&)?$/)
        for (const r of rest.slice(0, -1)) expect(r, `${name}: ${r}`).toMatch(/ &&$/)
        expect(rest.at(-1)!, name).not.toMatch(/&&$/)
        // The same version in the grep as in the command it guards.
        for (const r of rest) for (const v of r.matchAll(/(?:--version |YODA_VERSION=|yoda-)(\d+\.\d+\.\d+)/g)) expect(v[1], `${name}: ${r}`).toBe(m![1])
      }
      expect(text, name).not.toMatch(/minisign -Vm SHA256SUMS -P \S+ \|/)
    }
    // The rollback unpacks the target release's bundle (its compose files and digest pins) before deploying it.
    const rollback = runbook.slice(runbook.indexOf('**Rollback.**'))
    expect(rollback.slice(0, 1200)).toMatch(/tar -xzf yoda-1\.0\.0\.tar\.gz --no-same-owner &&\n[\s\S]*YODA_VERSION=1\.0\.0 sh ops\/deploy\/deploy\.sh/)
  })

  it('documents the digest pins: mirrors keep them, the opt-out, and never deleting untagged versions', () => {
    for (const text of [runbook, releasing]) expect(text).toContain('YODA_IGNORE_BUNDLE_DIGESTS=1')
    expect(releasing).toContain('**Never delete untagged versions of the ghcr.io packages**')
    expect(releasing).not.toMatch(/delete them in the package settings/)
  })

  it('documents the owner steps for the signing key, secrets, packages and the tag', () => {
    for (const s of [
      'minisign -G -p yoda.pub -s yoda.key',
      'RELEASE_PUBKEY_EMBEDDED',
      // The secrets live in the `release` environment, which only v* tags may use.
      'gh secret set --env release MINISIGN_SECRET_KEY < yoda.key',
      'gh secret set --env release MINISIGN_PASSWORD',
      'gh secret delete MINISIGN_SECRET_KEY',
      'gh secret delete MINISIGN_PASSWORD',
      'type **Tag**, pattern `v*`',
      '**Restrict creations**',
      'Re-run failed jobs',
      '## Pinned build inputs',
      'docker buildx imagetools inspect',
      '## <version> — unreleased',
      'Change visibility → Public',
      'git tag -s v1.0.0',
      'git push origin v1.0.0',
      '## Verifying releases',
      'C73EF0AF404BAE84',
      'keys/yoda-release.pub',
      "--base-url 'https://files.example.org/yoda/releases/{version}/'",
    ]) expect(releasing, s).toContain(s)
    for (const text of [readme, guide]) expect(text).toContain('C73EF0AF404BAE84')
    // 1.0.0 is dated for its release; the release workflow refuses an undated heading.
    expect(read('CHANGELOG.md')).toMatch(/^## 1\.0\.0 — 2026-11-27$/m)
    expect(read('CHANGELOG.md')).not.toMatch(/^## 1\.0\.0 — unreleased$/m)
    expect(read('CHANGELOG.md')).not.toMatch(/^## Unreleased$/m)
    expect(read('docs/design/installer-proposal.md')).toMatch(/^\| D1 \|.*Decided 2026-11-27 \(owner\): \(b\) GitHub Releases \+ GHCR/m)
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
