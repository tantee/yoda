import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFECT_LIMITS, MAX_UPLOAD_BYTES } from '@yoda/shared'
import { parse } from 'yaml'
import { interpolate } from './prod-compose-env.js'

// Structure of the release pipeline (.gitlab-ci.yml), the deploy script it runs and the prod compose images.
const root = fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8')

type Job = {
  stage?: string
  extends?: string | string[]
  image?: string | { name: string }
  services?: (string | { name: string })[]
  variables?: Record<string, string>
  rules?: { if?: string; when?: string }[]
  before_script?: string[]
  script?: string[]
  resource_group?: string
  interruptible?: boolean
  environment?: string | { name: string }
}

const ciText = read('.gitlab-ci.yml')
const ci = parse(ciText) as Record<string, Job> & { stages: string[] }
const lines = (job: Job) => [...(job.before_script ?? []), ...(job.script ?? [])].join('\n')
const images = ['core', 'portal', 'runner', 'backup']

describe('.gitlab-ci.yml', () => {
  it('has the expected jobs and stages', () => {
    const jobs = Object.keys(ci).filter((k) => !k.startsWith('.') && !['stages', 'default', 'variables'].includes(k))
    expect(jobs.sort()).toEqual(['build-backup', 'build-core', 'build-portal', 'build-runner', 'deploy', 'release-bundle', 'secrets', 'test'])
    expect(ci.stages).toEqual(['secrets', 'test', 'build', 'release', 'deploy'])
  })

  it('installs bash, flock, curl, minisign and shellcheck for the ops script tests', () => {
    const test = ci.test!
    expect(String(test.image)).toMatch(/alpine/)
    expect(test.before_script?.[0]).toMatch(/^apk add --no-cache (.* )?bash( |$)/)
    for (const pkg of ['util-linux', 'curl', 'minisign', 'shellcheck']) expect(test.before_script?.[0]).toMatch(new RegExp(` ${pkg}( |$)`))
  })

  it('builds and pushes every image to $CI_REGISTRY_IMAGE/<name>', () => {
    const build = ci['.build']!
    expect(build.stage).toBe('build')
    expect(build.rules).toEqual([{ if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' }, { if: '$CI_COMMIT_TAG' }])
    // A pinned docker-in-docker pair (same version for the client and the daemon).
    const image = String(build.image)
    expect(image).toMatch(/^docker:\d+\.\d+\.\d+$/)
    expect(build.services).toEqual([`${image}-dind`])
    // Logs in with the job's registry credentials from stdin, never on the command line.
    expect(lines(build)).toContain('echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"')
    const script = lines(build)
    expect(script).toContain('"$CI_REGISTRY_IMAGE/$IMAGE_NAME"')
    expect(script).toContain('$CI_COMMIT_SHORT_SHA')
    // The version without a `v`: a mirrored GitHub tag v1.2.0 is image 1.2.0.
    expect(script).toContain('"$IMAGE:${CI_COMMIT_TAG#v}"')
    expect(script).toMatch(/\$CI_COMMIT_BRANCH" = "\$CI_DEFAULT_BRANCH"[^\n]*:latest/)
    expect(script).toContain('docker push --all-tags')
    for (const name of images) {
      const job = ci[`build-${name}`]!
      expect(job.extends).toBe('.build')
      expect(job.variables?.IMAGE_NAME).toBe(name)
      expect(job.script ?? []).toEqual([])
    }
    expect(ci['build-backup']!.variables).toMatchObject({ DOCKERFILE: 'ops/backup/Dockerfile', CONTEXT: 'ops/backup' })
  })

  it('deploys only by hand, only on tags, one deploy at a time, after the images (not the bundle)', () => {
    const deploy = ci.deploy!
    expect(deploy.stage).toBe('deploy')
    expect(deploy.rules).toEqual([{ if: '$CI_COMMIT_TAG', when: 'manual' }])
    expect(deploy.resource_group).toBe('production')
    expect(deploy.interruptible).toBe(false)
    expect((deploy as Job & { needs?: string[] }).needs?.sort()).toEqual(images.map((n) => `build-${n}`).sort())
  })

  describe('release-bundle (installer proposal §3.4, D1: the internal mirror)', () => {
    const job = ci['release-bundle'] as Job & { artifacts?: { paths?: string[] } }
    const script = lines(job)

    it('runs on tags only, building the bundle with ops/install/bundle.sh for the tag and the registry path', () => {
      expect(job.stage).toBe('release')
      expect(job.rules).toEqual([{ if: '$CI_COMMIT_TAG' }])
      expect(script).toMatch(/case "\$CI_COMMIT_TAG" in/)
      expect(script).toContain('export YODA_RELEASE="${CI_COMMIT_TAG#v}"')
      expect(script).toContain('sh ops/install/bundle.sh "$YODA_RELEASE" "$CI_REGISTRY_IMAGE" dist')
      // Reproducible: the commit's time, with GNU tar and git from apk.
      expect(script).toContain('export SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)"')
      expect(script).toMatch(/apk add --no-cache [^\n]*\btar\b[^\n]*\bgit\b/)
      expect(job.artifacts?.paths).toEqual(['dist/releases/'])
    })

    it('signs SHA256SUMS with the protected file key, naming the release, and checks it against install.sh\'s key', () => {
      expect(script).toContain('test -s "$YODA_RELEASE_SIGNING_KEY"')
      expect(script).toContain('minisign -S -s "$YODA_RELEASE_SIGNING_KEY" -m "dist/releases/$YODA_RELEASE/SHA256SUMS" -t "yoda release $YODA_RELEASE"')
      // The optional key password goes on stdin, never on the command line.
      expect(script).toContain(`printf '%s\\n' "$YODA_RELEASE_SIGNING_PASSWORD" | minisign -S`)
      expect(script).toContain('RELEASE_PUBKEY_EMBEDDED')
      expect(script).toMatch(/minisign -V -P "\$pub"/)
      // The trusted comment install.sh expects.
      expect(read('ops/install/install.sh')).toContain('Trusted comment: yoda release $version')
    })

    it('uploads with the token on stdin only, and skips the upload while no URL is set', () => {
      expect(script).toContain('if [ -z "${YODA_RELEASE_UPLOAD_URL:-}" ]')
      expect(script).toMatch(/printf 'header = "Authorization: Bearer %s"\\n' "\$YODA_RELEASE_UPLOAD_TOKEN" \|\s*curl [^\n]*-K -/)
      expect(script).not.toMatch(/curl [^\n|]*\$YODA_RELEASE_UPLOAD_TOKEN/)
      // An empty token, or one with quotes, spaces or newlines (it goes into a curl config line), is refused.
      expect(script).toContain(`if [ -z "$YODA_RELEASE_UPLOAD_TOKEN" ] || printf '%s' "$YODA_RELEASE_UPLOAD_TOKEN" | tr -d 'A-Za-z0-9._~+/=-' | grep -q .; then`)
      const guard = script.indexOf('if [ -z "$YODA_RELEASE_UPLOAD_TOKEN" ]')
      expect(guard).toBeLessThan(script.indexOf('--upload-file'))
    })
  })

  it('checks the host key and keeps the SSH key private', () => {
    const script = lines(ci.deploy!)
    expect(script).toContain('chmod 600 "$DEPLOY_SSH_KEY"')
    expect(script).toContain('$DEPLOY_KNOWN_HOSTS')
    expect(script).toContain('StrictHostKeyChecking=yes')
    expect(script).not.toMatch(/StrictHostKeyChecking=(no|accept-new)/)
    expect(script).not.toMatch(/ssh-keyscan/)
    for (const v of ['$DEPLOY_HOST', '$DEPLOY_USER', '$DEPLOY_PATH', "YODA_VERSION='${CI_COMMIT_TAG#v}'"]) expect(script).toContain(v)
    expect(script).toContain('ops/deploy/deploy.sh')
  })

  it('copies the compose files, the deploy script and the runbook files, not the dev init.sql or .env', () => {
    const copy = (ci.deploy!.script ?? []).find((l) => /\btar -cf\b/.test(l)) ?? ''
    for (const f of ['docker-compose.yml', 'docker-compose.prod.yml', 'ops/deploy/deploy.sh', 'ops/proxy/Caddyfile', 'docs/operations.md', '.env.example', 'CHANGELOG.md']) expect(copy).toContain(f)
    expect(copy).not.toContain('init.sql')
    expect(copy.split(/\s+/)).not.toContain('.env')
  })

  it('fails the deploy when any part of the copy pipeline fails', () => {
    const script = ci.deploy!.script ?? []
    const pipefail = script.indexOf('set -o pipefail')
    const pipe = script.findIndex((l) => /\btar -cf\b[\s\S]*\|\s*ssh\b/.test(l))
    expect(pipefail).toBeGreaterThan(-1)
    expect(pipe).toBeGreaterThan(pipefail)
  })

  it('holds no literal secrets or hosts', () => {
    // Deploy settings come from CI/CD variables, never from the file.
    for (const [name, job] of Object.entries(ci)) {
      if (typeof job !== 'object' || Array.isArray(job)) continue
      for (const key of Object.keys(job.variables ?? {})) {
        expect(`${name}:${key}`).not.toMatch(/:(DEPLOY_|CI_REGISTRY)/)
      }
    }
    // The only password is the CI-only throwaway test database's.
    const passwords = [...ciText.matchAll(/(PASSWORD|TOKEN|SECRET|KEY)\s*:\s*(\S+)/gi)].map((m) => `${m[1]}: ${m[2]}`)
    expect(passwords).toEqual(['PASSWORD: yoda-ci'])
    // No URLs or addresses other than the CI services.
    const urls = [...ciText.matchAll(/[a-z][a-z0-9+.-]*:\/\/([^/\s@]+@)?([^/\s:'"]+)/gi)].map((m) => m[2])
    expect([...new Set(urls)]).toEqual(['postgres'])
    expect(ciText).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/)
    expect(ciText).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/)
  })
})

describe('ops/deploy/deploy.sh', () => {
  const sh = read('ops/deploy/deploy.sh')
  // The commands only, not the header comment that describes them.
  const code = sh
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')
  const order = (s: string) => {
    const i = code.indexOf(s)
    expect(i, s).toBeGreaterThan(-1)
    return i
  }

  it('pulls, fills the bootstrap volume, migrates once, starts, then waits for /ready', () => {
    const pull = order(' pull')
    const init = order(' run --rm init')
    const migrate = order(' run --rm migrate')
    expect(pull).toBeLessThan(init)
    expect(init).toBeLessThan(migrate)
    const up = order(' up -d --no-build')
    const ready = order('/api/ready')
    expect(pull).toBeLessThan(migrate)
    expect(migrate).toBeLessThan(up)
    expect(up).toBeLessThan(ready)
    expect(sh).toMatch(/^set -eu$/m)
  })

  it('pins the release in release.env once its images are on the host, and runs compose with it', () => {
    expect(code).toMatch(/^\s*docker compose --env-file \.env --env-file "\$release" -f docker-compose\.yml -f docker-compose\.prod\.yml "\$@"$/m)
    expect(code).toContain(`printf 'YODA_VERSION=%s\\n' "$YODA_VERSION" > "$release"`)
    const next = order('release=release.env.next')
    const pull = order(' pull')
    const check = order('docker image inspect')
    const pin = order('mv "$release" release.env')
    const migrate = order(' run --rm migrate')
    expect(next).toBeLessThan(pull)
    expect(check).toBeLessThan(pin)
    expect(pin).toBeLessThan(migrate)
    // Never builds on the host.
    expect(code).not.toMatch(/(?<!no-)\bbuild\b/)
  })

  it('refuses an unsafe version string', () => {
    expect(sh).toContain('YODA_VERSION')
    expect(sh).toMatch(/case "\$YODA_VERSION" in/)
  })

  it('creates an empty .env (0600) when there is none instead of failing (§13.3)', () => {
    expect(code).toContain('(umask 077 && : > .env)')
    expect(code).not.toMatch(/no \.env in/)
    expect(order('(umask 077')).toBeLessThan(order(' pull'))
  })

  it('prints the setup hint after ready, when /public-config says setup is required', () => {
    const ready = order('/api/ready')
    const pc = order('/public-config')
    expect(ready).toBeLessThan(pc)
    expect(code).toContain('yoda-admin setup-token')
  })

  it('defaults to the public GHCR images without an image prefix (never Docker Hub), before changing anything', () => {
    expect(code).toContain("DEFAULT_IMAGE_PREFIX='ghcr.io/tantee/yoda'")
    const refuse = order('YODA_IMAGE_PREFIX is not set')
    expect(refuse).toBeLessThan(order('(umask 077'))
    expect(refuse).toBeLessThan(order('release=release.env.next'))
    expect(read('ops/install/install.sh')).toMatch(/printf 'YODA_IMAGE_PREFIX=%s\\n' "\$prefix" > "\$dir\/release\.env"/)
  })

  it('never touches a volume (the bootstrap volume holds the master key)', () => {
    expect(code).not.toMatch(/\bvolume\b|\bdown\b|\s-v\b|--volumes/)
  })

  it('turns the built-in proxy on from the profiles in effect, pins it, validates it before release.env and init, and reloads it after the start', () => {
    const detect = order(`printf '%s\\n' "$services" | grep -qx proxy`)
    // A compose error stops the deploy with compose's message: it is never read as "no proxy service".
    expect(order('services=$(dc config --services 2>&1) || {')).toBeLessThan(detect)
    expect(code).not.toContain('config --services 2>/dev/null')
    const enabled = order(`printf 'YODA_PROXY_ENABLED=%s\\n' "$enabled" >> "$release"`)
    const pull = order(' pull')
    const validate = order('run --rm --no-deps -T proxy caddy validate --config /etc/caddy/yoda/Caddyfile --adapter caddyfile')
    const pin = order('mv "$release" release.env')
    const init = order(' run --rm init')
    const up = order(' up -d --no-build')
    const root = order('cp proxy:/data/caddy/pki/authorities/local/root.crt proxy/root.crt.next')
    const reload = order('exec -T proxy caddy reload --config /etc/caddy/yoda/Caddyfile --adapter caddyfile --force')
    expect(detect).toBeLessThan(enabled)
    expect(enabled).toBeLessThan(pull)
    expect(pull).toBeLessThan(validate)
    // Validated with the new release's files before release.env names it (a refused proxy leaves the old one).
    expect(validate).toBeLessThan(pin)
    expect(pin).toBeLessThan(init)
    // Compose keeps a container whose own settings did not change: the Caddyfile, sites and certificates reload.
    expect(up).toBeLessThan(reload)
    expect(reload).toBeLessThan(root)
    // Only the public root certificate leaves the proxy: never a key.
    expect(code).not.toMatch(/\.key\b/)
  })
})

type Service = {
  image?: string
  build?: unknown
  command?: string[]
  user?: string
  ports?: string[]
  volumes?: string[]
  group_add?: string[]
  depends_on?: Record<string, { condition: string }>
  environment?: Record<string, string | null>
  cap_drop?: string[]
  cap_add?: string[]
  security_opt?: string[]
  read_only?: boolean
  tmpfs?: string[]
}
// `!reset` / `!override` are compose merge tags; the yaml parser keeps the value and only warns about them.
const prod = parse(read('docker-compose.prod.yml'), { logLevel: 'error' }) as { services: Record<string, Service> }

describe('docker-compose.prod.yml images', () => {
  const want: Record<string, string> = { init: 'core', migrate: 'core', core: 'core', portal: 'portal', backup: 'backup', runner: 'runner' }

  it.each(Object.entries(want))('%s uses the published %s image at a required version and still builds locally', (service, name) => {
    const s = prod.services[service]!
    // No default prefix: a missing one must stop compose, never pull `yoda/...` from Docker Hub.
    // With the image's digest pinned (deploy.sh, from the signed bundle.env): <prefix>/<name>:<version>@<digest>.
    const D = `YODA_${name.toUpperCase()}_DIGEST`
    expect(s.image).toBe(
      `\${YODA_IMAGE_PREFIX:?YODA_IMAGE_PREFIX is required (the registry path; see release.env)}/${name}:\${YODA_VERSION:?YODA_VERSION is required (see release.env)}\${${D}:+@\${${D}}}`,
    )
    expect(s.build).toBeTruthy()
  })
})

describe('docker-compose.prod.yml built-in HTTPS proxy (docs/operations.md, section 4b)', () => {
  const p = prod.services.proxy as Service & { profiles?: string[]; healthcheck?: { test: string[] } }

  it('is off unless the proxy profile is on, and runs Caddy pinned by version and digest', () => {
    expect(p.profiles).toEqual(['proxy'])
    expect(p.image).toMatch(/^caddy:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/)
    expect(p.build).toBeUndefined()
  })

  it('publishes 80 and 443 (the same ports inside), and forwards to the portal over the compose network', () => {
    expect(p.ports).toEqual([
      '${YODA_PROXY_BIND:-0.0.0.0}:${YODA_PROXY_HTTP_PORT:-80}:${YODA_PROXY_HTTP_PORT:-80}',
      '${YODA_PROXY_BIND:-0.0.0.0}:${YODA_PROXY_HTTPS_PORT:-443}:${YODA_PROXY_HTTPS_PORT:-443}',
    ])
    expect(p.depends_on).toEqual(['portal'])
    expect(read('ops/proxy/Caddyfile')).toMatch(/^\treverse_proxy portal:3000$/m)
    // The portal and core stay on loopback: the proxy needs neither port.
    expect(prod.services.portal!.ports).toEqual(['${PORTAL_BIND:-127.0.0.1}:${PORTAL_PORT:-3000}:3000'])
  })

  it('mounts the bundle Caddyfile and the certificate directory read-only, and keeps its data in its own volume', () => {
    expect(p.volumes).toEqual([
      './ops/proxy:/etc/caddy/yoda:ro',
      './proxy/certs:/etc/caddy/certs:ro',
      './proxy/sites:/etc/caddy/sites:ro',
      'proxy-data:/data',
      'proxy-config:/config',
    ])
    // The internal CA's private key lives in proxy-data: no other service mounts it (core reads the presented certificate).
    for (const [name, svc] of Object.entries(prod.services)) {
      if (name === 'proxy') continue
      expect((svc.volumes ?? []).some((v) => v.startsWith('proxy-data') || v.startsWith('proxy-config')), name).toBe(false)
    }
    expect(read('docker-compose.prod.yml')).toMatch(/^ {2}proxy-data:$/m)
    expect(p.environment).toMatchObject({ YODA_PROXY_DOMAIN: '${YODA_PROXY_DOMAIN:-}', YODA_PROXY_CERT_MODE: '${YODA_PROXY_CERT_MODE:-internal}' })
  })

  it('makes core and the portal trust two hops when deploy.sh pins YODA_PROXY_ENABLED, unless .env sets it', () => {
    for (const name of ['core', 'portal']) {
      expect(prod.services[name]!.environment?.YODA_TRUSTED_PROXY_HOPS, name).toBe('${YODA_TRUSTED_PROXY_HOPS:-${YODA_PROXY_ENABLED:+2}}')
    }
    expect(prod.services.core!.environment).toMatchObject({ YODA_PROXY_ENABLED: '${YODA_PROXY_ENABLED:-}', YODA_PROXY_DOMAIN: '${YODA_PROXY_DOMAIN:-}' })
  })

  it('runs hardened: no capabilities but binding low ports and reading the 0600 key, no privilege gain, read-only root', () => {
    expect(p.cap_drop).toEqual(['ALL'])
    // DAC_OVERRIDE (Docker's default set, the container's own mounts) reads the 0600 key; never DAC_READ_SEARCH,
    // which re-enables open_by_handle_at (the "shocker" escape) under Docker's default seccomp profile.
    expect(p.cap_add).toEqual(['NET_BIND_SERVICE', 'DAC_OVERRIDE'])
    expect(read('docker-compose.prod.yml')).not.toMatch(/^\s*cap_add:.*DAC_READ_SEARCH/m)
    expect(p.security_opt).toEqual(['no-new-privileges:true'])
    expect(p.read_only).toBe(true)
    expect(p.tmpfs).toEqual(['/tmp'])
    expect(p.environment).toMatchObject({ YODA_PROXY_ACME_CA: '${YODA_PROXY_ACME_CA:-https://acme-v02.api.letsencrypt.org/directory}' })
  })

  it('runs the Caddyfile from the mounted ops/proxy directory (a new bundle\'s file is seen; a file mount keeps the old inode)', () => {
    expect(p.command).toEqual(['caddy', 'run', '--config', '/etc/caddy/yoda/Caddyfile', '--adapter', 'caddyfile'])
    expect(p.volumes).toContain('./ops/proxy:/etc/caddy/yoda:ro')
    expect((p.volumes ?? []).some((v) => v.includes('Caddyfile'))).toBe(false)
    // deploy.sh validates and reloads that same path.
    const deployCode = read('ops/deploy/deploy.sh')
    expect(deployCode).toContain('caddy validate --config /etc/caddy/yoda/Caddyfile --adapter caddyfile')
    expect(deployCode).toContain('caddy reload --config /etc/caddy/yoda/Caddyfile --adapter caddyfile --force')
    expect(deployCode).not.toMatch(/\/etc\/caddy\/Caddyfile/)
  })

  it('gives Caddy no {$NAME:default} for a variable compose passes empty (Caddy keeps the default for unset ones only)', () => {
    const env = p.environment ?? {}
    const caddyfile = read('ops/proxy/Caddyfile').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    const withDefault = [...caddyfile.matchAll(/\{\$([A-Z_][A-Z0-9_]*):([^}]*)\}/g)].map((m) => [m[1]!, m[2]!] as const)
    expect(withDefault.length).toBeGreaterThan(0)
    for (const [name, fallback] of withDefault) {
      if (!(name in env)) continue
      // With an empty .env compose passes its own default: it must be the Caddyfile's, never empty.
      expect(interpolate(String(env[name]), {}), name).toBe(fallback)
      expect(interpolate(String(env[name]), { [name]: '' }), name).toBe(fallback)
    }
    // Every variable the Caddyfile reads bare that compose passes and acme needs is non-empty by default.
    expect(interpolate(String(env.YODA_PROXY_ACME_CA), {})).toBe('https://acme-v02.api.letsencrypt.org/directory')
    expect(caddyfile).toMatch(/^\t\t\tdir \{\$YODA_PROXY_ACME_CA\}$/m)
  })

  it('has a healthcheck on Caddy\'s admin endpoint inside the container', () => {
    expect(p.healthcheck?.test).toEqual(['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:2019/config/'])
  })
})

describe('ops/proxy/Caddyfile', () => {
  const caddy = read('ops/proxy/Caddyfile')

  it('has one TLS snippet per certificate mode, chosen by YODA_PROXY_CERT_MODE', () => {
    expect(caddy).toMatch(/^\(tls-internal\) \{\n\ttls internal\n\}$/m)
    expect(caddy).toMatch(/^\(tls-files\) \{\n\ttls \/etc\/caddy\/certs\/cert\.pem \/etc\/caddy\/certs\/key\.pem\n\}$/m)
    // Let's Encrypt only (a named issuer: no fallback to another CA), production unless YODA_PROXY_ACME_CA says.
    expect(caddy).toMatch(/^\(tls-acme\) \{\n\ttls \{\n\t\tissuer acme \{\n\t\t\tdir \{\$YODA_PROXY_ACME_CA\}\n\t\t\temail \{\$YODA_PROXY_ACME_EMAIL\}\n\t\t\}\n\t\}\n\}$/m)
    // No port in the address: an empty YODA_PROXY_DOMAIN must fail validation, not become a catch-all site.
    expect(caddy).toMatch(/^\{\$YODA_PROXY_DOMAIN\} \{\n\timport tls-\{\$YODA_PROXY_CERT_MODE\}$/m)
  })

  it('redirects http to https keeping a port other than 443 (Caddy\'s own redirect drops it: same port inside)', () => {
    expect(caddy).toMatch(/^http:\/\/\{\$YODA_PROXY_DOMAIN\}:\{\$YODA_PROXY_HTTP_PORT:80\} \{\n\tredir https:\/\/\{host\}:\{\$YODA_PROXY_HTTPS_PORT:443\}\{uri\} 308\n\}$/m)
  })

  it('names the admin endpoint (container-local), caps request bodies above the largest upload and times out slow clients only', () => {
    expect(caddy).toMatch(/^\tadmin localhost:2019$/m)
    const max = /^\trequest_body @other \{\n\t\tmax_size (\d+)MiB\n\t\}$/m.exec(caddy)
    expect(max, 'request_body @other max_size').not.toBeNull()
    const bytes = Number(max![1]) * 1024 * 1024
    expect(bytes).toBeGreaterThan(MAX_UPLOAD_BYTES)
    expect(bytes).toBeLessThanOrEqual(2 * MAX_UPLOAD_BYTES)
    expect(caddy).toMatch(/^\t\ttimeouts \{\n\t\t\t(?:#.*\n\t\t\t)*read_header 30s\n\t\t\tidle 5m\n\t\t\}$/m)
    // Never a body or write timeout: on HTTP/1.1 Go's read timeout covers the whole request and would cancel the
    // portal's long server-sent-events GETs.
    expect(caddy).not.toMatch(/^\s*(read_body|write)\s/m)
  })

  it('the 32MiB request_body block applies to @other, which excludes /api/extension/defects, and the defects path has its own 56MiB block; no unmatched request_body block remains', () => {
    expect(caddy).toMatch(/^\t@defects path \/api\/extension\/defects$/m)
    expect(caddy).toMatch(/^\t@other not path \/api\/extension\/defects$/m)
    const defects = /^\trequest_body @defects \{\n\t\tmax_size (\d+)MiB\n\t\}$/m.exec(caddy)
    expect(defects, 'request_body @defects').not.toBeNull()
    const bytes = Number(defects![1]) * 1024 * 1024
    // Above the largest report the extension may send (50 MiB plus multipart framing), well below 64 MiB.
    expect(bytes).toBeGreaterThan(DEFECT_LIMITS.maxReportBytes + 1024 * 1024)
    expect(bytes).toBeLessThan(64 * 1024 * 1024)
    expect([...caddy.matchAll(/^\s*request_body\b(.*)$/gm)].map((m) => m[1]!.trim())).toEqual(['@defects {', '@other {'])
  })

  it('names the internal CA after the domain, so staff recognise it in their trust store', () => {
    expect(caddy).toMatch(/^\tpki \{\n\t\tca local \{\n\t\t\tname "Yoda \{\$YODA_PROXY_DOMAIN\} internal CA"\n\t\t\troot_cn "Yoda \{\$YODA_PROXY_DOMAIN\} internal CA root"\n/m)
  })

  it('keeps readiness inside the host and leaves the forwarded headers to Caddy (it replaces a client\'s X-Forwarded-For)', () => {
    expect(caddy).toMatch(/@ready path \/api\/ready \/api\/ready\/\*\n\trespond @ready 404/)
    expect(caddy).not.toMatch(/trusted_proxies/)
    expect(caddy).not.toMatch(/header_up/)
  })
})

describe('Dockerfiles pin their base images by digest', () => {
  it.each(['apps/core/Dockerfile', 'apps/portal/Dockerfile', 'apps/runner/Dockerfile', 'ops/backup/Dockerfile'])('%s', (file) => {
    const froms = read(file).split('\n').filter((l) => l.startsWith('FROM '))
    expect(froms.length).toBeGreaterThan(0)
    // <image>:<exact tag>@sha256:<digest>: the tag for reading, the digest for what is built.
    for (const f of froms) expect(f).toMatch(/^FROM (--platform=\$BUILDPLATFORM )?[a-z0-9./-]+:[0-9][\w.-]*@sha256:[0-9a-f]{64}( AS \w+)?$/)
    // Only a build stage runs on the builder's platform; the image that ships is always the target platform's.
    expect(froms.at(-1)).not.toContain('--platform')
  })

  it('builds the portal (plain JavaScript output) on the native platform, not under QEMU', () => {
    expect(read('apps/portal/Dockerfile')).toMatch(/^FROM --platform=\$BUILDPLATFORM node:\S+ AS build$/m)
    expect(read('apps/portal/nuxt.config.ts')).toMatch(/ssr: false/)
  })
})

describe('docker-compose.prod.yml exposure', () => {
  const text = read('docker-compose.prod.yml')

  it('publishes core and the portal on loopback by default', () => {
    expect(prod.services.core!.ports).toEqual(['${CORE_BIND:-127.0.0.1}:${CORE_PORT:-4000}:4000'])
    expect(prod.services.portal!.ports).toEqual(['${PORTAL_BIND:-127.0.0.1}:${PORTAL_PORT:-3000}:3000'])
  })

  it('publishes nothing from postgres and rustfs, and turns the RustFS console off', () => {
    expect(text).toMatch(/^ {2}postgres:\n(?: {4}#.*\n)*(?: {4}.*\n)*? {4}ports: !reset \[\]$/m)
    expect(text).toMatch(/^ {2}rustfs:\n(?: {4}#.*\n)*(?: {4}.*\n)*? {4}ports: !reset \[\]$/m)
    expect(prod.services.postgres!.ports).toEqual([])
    expect(prod.services.rustfs!.ports).toEqual([])
    expect(prod.services.rustfs!.environment?.RUSTFS_CONSOLE_ENABLE).toBe('false')
  })

  it('mounts only the database and bootstrap volumes into postgres (no dev init.sql)', () => {
    expect(text).toMatch(/^ {4}volumes: !override$/m)
    expect(prod.services.postgres!.volumes).toEqual(['pgdata:/var/lib/postgresql/data', 'yoda-bootstrap:/var/lib/yoda:ro'])
  })

  it('requires nothing but the image prefix and YODA_VERSION (installer proposal §13.3)', () => {
    const text = read('docker-compose.prod.yml')
    const required = [...text.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)].map((m) => m[1])
    expect(new Set(required)).toEqual(new Set(['YODA_IMAGE_PREFIX', 'YODA_VERSION']))
    expect(text).not.toMatch(/YODA_IMAGE_PREFIX:-/)
    expect(prod.services.core!.environment?.PORTAL_URL).toBe('${PORTAL_URL:-}')
    expect(prod.services.core!.environment?.OIDC_ISSUER).toBe('${OIDC_ISSUER:-}')
  })
})

describe('docker-compose.prod.yml bootstrap volume (installer proposal §3.2, spike R3)', () => {
  const s = prod.services
  const mount = 'yoda-bootstrap:/var/lib/yoda'
  const afterInit = (name: string) => expect(s[name]!.depends_on?.init, name).toEqual({ condition: 'service_completed_successfully' })

  it('runs init once, as root, from the core image, writing the volume and probing the database read-only', () => {
    const init = s.init!
    expect(init.command).toEqual(['node', 'dist/init.js'])
    expect(init.user).toBe('0:0')
    expect(init.volumes).toEqual([mount, 'pgdata:/probe/pgdata:ro'])
    expect((init as { restart?: string }).restart).toBe('no')
    // Every value is optional: env overrides generation, never required.
    for (const k of ['POSTGRES_PASSWORD', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'YODA_MASTER_KEY']) expect(init.environment?.[k], k).toBe(`\${${k}:-}`)
    expect((parse(read('docker-compose.prod.yml'), { logLevel: 'error' }) as { volumes: Record<string, unknown> }).volumes).toHaveProperty('yoda-bootstrap')
  })

  it('starts everything that reads the volume after init', () => {
    for (const name of ['postgres', 'rustfs', 'migrate', 'core', 'backup']) afterInit(name)
  })

  it('mounts it read-only everywhere but core (the setup token), with the shared group except for postgres', () => {
    for (const name of ['postgres', 'rustfs', 'migrate', 'backup']) expect(s[name]!.volumes, name).toContain(`${mount}:ro`)
    expect(s.core!.volumes).toContain(mount)
    for (const name of ['rustfs', 'migrate', 'core', 'backup']) expect(s[name]!.group_add, name).toEqual(['10500'])
    expect(s.postgres!.group_add).toBeUndefined()
    expect(s.portal!.volumes ?? []).not.toContain(mount)
    expect(s.portal!.volumes ?? []).not.toContain(`${mount}:ro`)
  })

  it('gives postgres and RustFS the files, removing the plain variables (the images refuse both forms)', () => {
    // The parser keeps a scalar `!reset null` as null or 'null' (it only warns about the compose tag); the text
    // checks below pin the tag itself.
    const reset = (v: unknown) => v === null || v === 'null'
    expect(s.postgres!.environment).toMatchObject({ POSTGRES_PASSWORD_FILE: '/var/lib/yoda/postgres-password' })
    expect(reset(s.postgres!.environment?.POSTGRES_PASSWORD)).toBe(true)
    expect(reset(s.rustfs!.environment?.RUSTFS_ACCESS_KEY) && reset(s.rustfs!.environment?.RUSTFS_SECRET_KEY)).toBe(true)
    expect(read('docker-compose.prod.yml')).toMatch(/^ {6}POSTGRES_PASSWORD: !reset null$/m)
    expect(s.rustfs!.environment).toMatchObject({
      RUSTFS_ACCESS_KEY_FILE: '/var/lib/yoda/s3-access-key',
      RUSTFS_SECRET_KEY_FILE: '/var/lib/yoda/s3-secret-key',
    })
    expect(read('docker-compose.prod.yml')).toMatch(/^ {6}RUSTFS_ACCESS_KEY: !reset null\n {6}RUSTFS_SECRET_KEY: !reset null$/m)
  })

  it('lets core, migrate and backup derive DATABASE_URL and the S3 keys from bootstrap.env, env first', () => {
    for (const name of ['core', 'migrate', 'backup']) {
      const env = s[name]!.environment!
      expect(env.DATABASE_URL, name).toBe('${DATABASE_URL:-}')
      expect(env.YODA_BOOTSTRAP_FILE, name).toBe('/var/lib/yoda/bootstrap.env')
    }
    for (const name of ['core', 'backup']) for (const k of ['S3_ACCESS_KEY', 'S3_SECRET_KEY']) expect(s[name]!.environment?.[k], `${name} ${k}`).toBe(`\${${k}:-}`)
    expect(s.core!.environment?.YODA_MASTER_KEY_FILE).toBe('/var/lib/yoda/core/master-key')
    // The master key never reaches core's env from compose; init copies an env key into the core-only file.
    expect(s.core!.environment).not.toHaveProperty('YODA_MASTER_KEY')
    expect(s.backup!.environment).not.toHaveProperty('YODA_MASTER_KEY_FILE')
  })

  it('no longer requires the Keycloak variables in the portal (it reads /public-config)', () => {
    for (const k of ['NUXT_PUBLIC_KEYCLOAK_URL', 'NUXT_PUBLIC_KEYCLOAK_REALM', 'NUXT_PUBLIC_KEYCLOAK_CLIENT_ID']) {
      expect(s.portal!.environment?.[k], k).toBe(`\${${k}:-}`)
      // Core sees them too, to log a mismatch with OIDC_ISSUER (§6.4).
      expect(s.core!.environment?.[k], k).toBe(`\${${k}:-}`)
    }
  })
})

describe('docker-compose.yml (dev) keeps its throwaway credentials', () => {
  const dev = parse(read('docker-compose.yml')) as { services: Record<string, Service> }

  it('has no init service and no bootstrap volume (dev core runs on the host with .env)', () => {
    expect(dev.services.init).toBeUndefined()
    expect(dev.services.postgres!.environment?.POSTGRES_PASSWORD).toBe('yoda')
    expect(dev.services.rustfs!.environment?.RUSTFS_ACCESS_KEY).toBe('${S3_ACCESS_KEY:-yoda}')
  })
})

describe('apps/core/Dockerfile', () => {
  it('carries the extension zip in /app/extension, built and checked in its own stage', () => {
    const docker = read('apps/core/Dockerfile')
    const stage = docker.slice(docker.indexOf(' AS extension'), docker.indexOf(' AS build'))
    expect(stage).toContain('pnpm install --frozen-lockfile --ignore-scripts --filter @yoda/extension...')
    expect(stage).toContain('pnpm --filter @yoda/extension build:zip && pnpm --filter @yoda/extension check:dist')
    expect(docker).toContain('COPY --from=extension /repo/apps/extension/release/ /app/extension/')
    // Where the core looks for it (apps/core/src/extension/files.ts).
    expect(read('apps/core/src/extension/files.ts')).toContain("'/app/extension'")
    // The image builds its own zip: a stale local one never enters the context.
    expect(read('.dockerignore')).toMatch(/^apps\/extension\/release$/m)
  })
})

describe('.github/workflows/ci.yml', () => {
  const gh = parse(read('.github/workflows/ci.yml')) as { jobs: Record<string, { steps: { run?: string }[] }> }

  it('installs minisign and shellcheck in the test job, before the tests', () => {
    const steps = gh.jobs.test!.steps.map((s) => s.run ?? '')
    const install = steps.findIndex((r) => /apt-get install -y [^\n]*\bminisign\b/.test(r))
    expect(install).toBeGreaterThan(-1)
    expect(steps[install]).toMatch(/\bshellcheck\b/)
    expect(steps[install]).toMatch(/^sudo apt-get update && /)
    expect(install).toBeLessThan(steps.indexOf('pnpm test'))
  })

  it('builds every image and pushes none', () => {
    const runs = gh.jobs.build!.steps.map((s) => s.run ?? '').join('\n')
    for (const name of images) expect(runs).toMatch(new RegExp(`docker build( .*)? -t yoda/${name}( |$)`, 'm'))
    expect(runs).not.toMatch(/docker (push|login)/)
  })

  it('has the extension job running the e2e in Playwright Chromium, keeping the report only on failure', () => {
    const job = gh.jobs.extension as unknown as { steps: { run?: string; if?: string; uses?: string; with?: { path?: string } }[] }
    const runs = job.steps.map((s) => s.run ?? '')
    const install = runs.findIndex((r) => r.includes('playwright install --with-deps chromium'))
    const e2e = runs.findIndex((r) => r.includes('build:e2e') && r.includes('@yoda/extension e2e'))
    expect(install).toBeGreaterThan(-1)
    expect(e2e).toBeGreaterThan(install)
    const upload = job.steps.find((s) => s.uses?.startsWith('actions/upload-artifact'))
    expect(upload?.if).toBe('failure()')
    expect(upload?.with?.path).toContain('apps/extension/test-results/')
    expect((gh.jobs.build as unknown as { needs: string[] }).needs).toContain('extension')
  })

  it('builds and checks the extension zip, and scans the release output with gitleaks', () => {
    const runs = (gh.jobs.extension as unknown as { steps: { run?: string }[] }).steps.map((s) => s.run ?? '')
    const zip = runs.findIndex((r) => /@yoda\/extension build:zip && pnpm --filter @yoda\/extension check:dist/.test(r))
    const scan = runs.findIndex((r) => r.includes('zricethezav/gitleaks:v8.30.1 detect --no-git'))
    expect(zip).toBeGreaterThan(-1)
    expect(scan).toBeGreaterThan(zip)
    expect(runs[scan]).toContain('--source /repo/apps/extension/dist')
    expect(runs[scan]).toContain('--config /repo/.gitleaks.toml')
  })
})

type Step = { id?: string; name?: string; uses?: string; if?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> }
type WfJob = {
  if?: string
  needs?: string | string[]
  permissions?: Record<string, string>
  env?: Record<string, string>
  outputs?: Record<string, string>
  'runs-on'?: string
  strategy?: {
    matrix?: {
      include?: { name: string; file: string; context: string }[]
      image?: { name: string; file: string; context: string }[]
      arch?: { name: string; platform: string; runner: string }[]
      name?: string[]
    }
  }
  services?: Record<string, { image: string; ports?: string[] }>
  steps: Step[]
}

describe('.github/workflows/release.yml (GitHub Releases + GHCR)', () => {
  const text = read('.github/workflows/release.yml')
  const wf = parse(text) as {
    on: Record<string, any>
    permissions: Record<string, string>
    env: Record<string, string>
    jobs: Record<string, WfJob & { environment?: string; 'timeout-minutes'?: number }>
  }
  const jobs = wf.jobs
  const step = (job: string, pred: (s: Step) => boolean) => {
    const s = jobs[job]!.steps.find(pred)
    expect(s, job).toBeTruthy()
    return s!
  }
  const REAL = "needs.meta.outputs.real == 'true'"
  const DRY = "needs.meta.outputs.real != 'true'"
  const meta = () => step('meta', (s) => s.id === 'meta').run!

  it('releases only on a pushed v* tag; pull requests and manual runs (no inputs) are always dry runs', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect(wf.on.push).toEqual({ tags: ['v*'] })
    const paths: string[] = wf.on.pull_request.paths
    for (const p of ['.github/workflows/release.yml', 'ops/install/**', 'apps/*/Dockerfile', 'apps/extension/**', 'keys/**', 'ops/backup/**', 'docker-compose.prod.yml', 'CHANGELOG.md']) expect(paths).toContain(p)
    // No dry_run switch: a manual run can never publish.
    expect(wf.on.workflow_dispatch ?? null).toBeNull()
    expect(text).not.toMatch(/inputs\./)
    expect(meta()).toContain('if [ "$EVENT" = push ]; then')
    expect(meta()).toContain('refs/tags/v*) ;;')
    expect(meta()).toContain('version=${REF#refs/tags/v}')
    expect(meta()).toContain('version="0.0.0-dryrun.$RUN_NUMBER"')
  })

  it('checks a release before building: tag on main, notes dated, package versions equal to the tag', () => {
    const checkout = step('meta', (s) => !!s.uses?.startsWith('actions/checkout@'))
    expect(checkout.with).toMatchObject({ 'fetch-depth': 0, 'persist-credentials': false })
    const run = meta()
    expect(run).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main ||')
    expect(run).toContain('sh ops/install/release-notes.sh "$version" > /dev/null ||')
    expect(run).toMatch(/\*\[Uu\]nreleased\*\) echo "::error::CHANGELOG\.md still says/)
    expect(run).toContain('for f in package.json apps/core/package.json apps/extension/package.json; do')
    expect(run).toMatch(/\[ "\$pkg" = "\$version" \] \|\|\n\s*\{ echo "::error::\$f says version \$pkg, the tag says \$version[^\n]*exit 1; \}/)
    expect(run).not.toContain('::warning::')
  })

  it('the release meta step accepts only x.y.z and x.y.z-rc.N, and checks the extension version', () => {
    const run = meta()
    const re = /grep -Eqx '([^']+)' \|\|/.exec(run)?.[1]
    expect(re).toBeTruthy()
    const accepts = (v: string) => spawnSync('sh', ['-c', `printf '%s\\n' "$1" | grep -Eqx '${re}'`, 'sh', v]).status === 0
    for (const v of ['1.2.0', '0.0.1', '10.20.30', '1.2.0-rc.1', '1.2.0-rc.999', '65535.0.0']) expect(accepts(v), v).toBe(true)
    for (const v of ['1.2', '1.2.0.1', '01.2.0', '1.2.0-rc.0', '1.2.0-rc.1000', '1.2.0-beta.1', '1.2.0-rc1', 'v1.2.0', '1.2.0-dryrun.4'])
      expect(accepts(v), v).toBe(false)
    // The part ceiling is a loop over the numeric parts.
    expect(run).toContain('[ "$part" -le 65535 ] ||')
    expect(run.indexOf('grep -Eqx')).toBeLessThan(run.indexOf('git merge-base'))
    expect(run).toContain('apps/extension/package.json')
  })

  it('orders the jobs: images by digest, then the bundle pinning them is signed and verified, then tags, then the release', () => {
    expect(Object.keys(jobs).sort()).toEqual(['bundle', 'images', 'images-dry', 'manifest', 'manifest-dry', 'meta', 'one-line-install', 'release', 'tag'])
    expect(jobs['images-dry']!.needs).toBe('meta')
    expect(jobs['images-dry']!.if).toBe(DRY)
    expect(jobs.images!.needs).toBe('meta')
    expect(jobs.images!.if).toBe(REAL)
    expect(jobs['manifest-dry']!.needs).toEqual(['meta', 'images-dry'])
    expect(jobs['manifest-dry']!.if).toBe(DRY)
    expect(jobs.manifest!.needs).toEqual(['meta', 'images'])
    expect(jobs.manifest!.if).toBe(REAL)
    expect(jobs.bundle!.needs).toEqual(['meta', 'manifest-dry', 'manifest'])
    expect(jobs.bundle!.if).toBe('${{ !cancelled() && !failure() }}')
    // Dry runs only, after the bundle: the one-line install of the dry run's bundle on a fresh Ubuntu.
    expect(jobs['one-line-install']!.needs).toEqual(['meta', 'bundle'])
    expect(jobs['one-line-install']!.if).toBe("${{ !cancelled() && !failure() && needs.meta.outputs.real != 'true' && needs.bundle.result == 'success' }}")
    expect(jobs.tag!.needs).toEqual(['meta', 'bundle'])
    expect(jobs.tag!.if).toBe("${{ !cancelled() && !failure() && needs.meta.outputs.real == 'true' && needs.bundle.result == 'success' }}")
    expect(jobs.release!.needs).toEqual(['meta', 'bundle', 'tag'])
    expect(jobs.release!.if).toBe(
      "${{ !cancelled() && !failure() && needs.meta.outputs.real == 'true' && needs.bundle.result == 'success' && needs.tag.result == 'success' }}",
    )
  })

  // GitHub's job conditions, for the subset this workflow uses: a job runs when its `if` holds; an `if` without a
  // status check function (success(), failure(), cancelled(), always()) gets an implicit success(), which is false
  // as soon as any job upstream of it did not succeed, skipped included, not only its direct needs (v1.1.0's first
  // run: tag and release were skipped behind manifest-dry, which a release skips, though meta and bundle succeeded).
  // failure()/cancelled() look at all upstream jobs too.
  const needsOf = (j: string) => [jobs[j]!.needs ?? []].flat()
  const upstream = (j: string): string[] => [...new Set(needsOf(j).flatMap((n) => [n, ...upstream(n)]))]
  const STATUS = /\b(success|failure|cancelled|always)\(\)/
  const simulate = (real: boolean, fail: string[] = [], ifs: Record<string, string> = {}) => {
    const result: Record<string, 'success' | 'failure' | 'skipped'> = {}
    const order = Object.keys(jobs)
    while (Object.keys(result).length < order.length) {
      for (const j of order) {
        if (result[j] || !needsOf(j).every((n) => result[n])) continue
        const raw = (ifs[j] ?? jobs[j]!.if ?? '').replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim()
        const terms = raw ? raw.split('&&').map((t) => t.trim()) : []
        if (!STATUS.test(raw)) terms.unshift('success()')
        const ups = upstream(j)
        const ok = terms.every((t) => {
          switch (t) {
            // The whole upstream chain, as GitHub evaluates it (v1.1.0: tag skipped although meta and bundle succeeded).
            case 'success()': return ups.every((n) => result[n] === 'success')
            case '!failure()': return !ups.some((n) => result[n] === 'failure')
            case '!cancelled()': return true
            case "needs.meta.outputs.real == 'true'": return real
            case "needs.meta.outputs.real != 'true'": return !real
          }
          const m = /^needs\.([\w-]+)\.result == 'success'$/.exec(t)
          if (m) {
            expect(needsOf(j), `${j}: ${t}`).toContain(m[1])
            return result[m[1]!] === 'success'
          }
          throw new Error(`${j}: the simulation does not know the condition term "${t}"`)
        })
        result[j] = ok ? (fail.includes(j) ? 'failure' : 'success') : 'skipped'
      }
    }
    return Object.keys(result).filter((j) => result[j] !== 'skipped').sort()
  }

  it('runs every job of a release and of a dry run, by GitHub\'s rules (simulated: neither path publishes in CI)', () => {
    expect(simulate(true)).toEqual(['bundle', 'images', 'manifest', 'meta', 'release', 'tag'])
    expect(simulate(false)).toEqual(['bundle', 'images-dry', 'manifest-dry', 'meta', 'one-line-install'])
    // A failure anywhere stops what follows: nothing is tagged or released past a failed job.
    expect(simulate(true, ['manifest'])).toEqual(['images', 'manifest', 'meta'])
    expect(simulate(true, ['bundle'])).toEqual(['bundle', 'images', 'manifest', 'meta'])
    expect(simulate(true, ['tag'])).toEqual(['bundle', 'images', 'manifest', 'meta', 'tag'])
    expect(simulate(false, ['images-dry'])).toEqual(['images-dry', 'meta'])
    expect(simulate(false, ['bundle'])).toEqual(['bundle', 'images-dry', 'manifest-dry', 'meta'])
    // one-line-install never runs on a release, also when everything before it succeeded or it lost its dry-run term.
    expect(simulate(true)).not.toContain('one-line-install')
    expect(simulate(true, [], { 'one-line-install': "${{ !cancelled() && !failure() && needs.bundle.result == 'success' }}" })).toContain('one-line-install')
    // The conditions v1.1.0's first run had: tag and release skipped behind the skipped manifest-dry.
    const before = { tag: REAL, release: REAL }
    expect(simulate(true, [], before)).toEqual(['bundle', 'images', 'manifest', 'meta'])
  })

  it('gives a status check function to every job that waits, on its own path, for a job that path skips', () => {
    for (const real of [true, false]) {
      const runs = simulate(real)
      for (const j of runs) {
        if (upstream(j).every((u) => runs.includes(u))) continue
        // A skip it does not expect would skip it too: its condition checks status itself (and never runs past a failure).
        expect(jobs[j]!.if ?? '', `${j} (${real ? 'release' : 'dry run'})`).toMatch(STATUS)
        expect(jobs[j]!.if ?? '', j).toContain('!failure()')
      }
    }
  })

  it('grants minimal permissions: packages:write only to the real image and tag jobs, never to a dry run', () => {
    expect(wf.permissions).toEqual({})
    expect(jobs.meta!.permissions).toEqual({ contents: 'read' })
    expect(jobs['images-dry']!.permissions).toEqual({ contents: 'read' })
    expect(jobs['manifest-dry']!.permissions).toEqual({ contents: 'read' })
    expect(jobs.bundle!.permissions).toEqual({ contents: 'read' })
    expect(jobs['one-line-install']!.permissions).toEqual({ contents: 'read' })
    expect(jobs.images!.permissions).toEqual({ contents: 'read', packages: 'write' })
    expect(jobs.manifest!.permissions).toEqual({ contents: 'read', packages: 'write' })
    expect(jobs.tag!.permissions).toEqual({ contents: 'read', packages: 'write' })
    expect(jobs.release!.permissions).toEqual({ contents: 'write' })
  })

  it('runs the signing and publishing jobs in the `release` environment (v* tags only); a dry run in none', () => {
    for (const j of ['images', 'manifest', 'tag', 'release']) expect(jobs[j]!.environment, j).toBe('release')
    expect(jobs.bundle!.environment).toBe("${{ needs.meta.outputs.real == 'true' && 'release' || '' }}")
    for (const j of ['meta', 'images-dry', 'manifest-dry', 'one-line-install']) expect(jobs[j]!.environment, j).toBeUndefined()
  })

  it('pins every action by full commit SHA, and the BuildKit and registry images by digest', () => {
    const uses = Object.values(jobs).flatMap((j) => j.steps.map((s) => s.uses).filter(Boolean)) as string[]
    expect(uses.length).toBeGreaterThan(6)
    for (const u of uses) expect(u).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/)
    for (const line of text.split('\n').filter((l) => /uses: /.test(l))) expect(line).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/)
    for (const j of ['images-dry', 'images', 'manifest-dry', 'manifest']) {
      const buildx = step(j, (s) => !!s.uses?.startsWith('docker/setup-buildx-action@'))
      expect(String(buildx.with!['driver-opts'])).toMatch(/^image=moby\/buildkit:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/)
    }
    expect(jobs['manifest-dry']!.services!.registry!.image).toMatch(/^registry:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/)
  })

  it('keeps secrets out of the file and out of run scripts (they reach scripts as env only)', () => {
    const refs = [...text.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]!)
    expect([...new Set(refs)].sort()).toEqual(['GITHUB_TOKEN', 'MINISIGN_PASSWORD', 'MINISIGN_SECRET_KEY'])
    for (const job of Object.values(jobs)) for (const s of job.steps) expect(s.run ?? '', s.name).not.toMatch(/\$\{\{/)
    expect(text).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|untrusted comment|RW[A-Za-z0-9+/]{50,}/)
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/)
  })

  it('builds each of the four images natively per architecture (no QEMU): a release pushed by digest, without cache; a dry run never pushed', () => {
    // v1.0.0: arm64 builds under QEMU hung (the portal's Nuxt build, then core's pnpm install); never emulate again.
    expect(text).not.toMatch(/setup-qemu-action|binfmt/)
    expect(text).not.toMatch(/outputs\.platforms/)
    for (const j of ['images-dry', 'images']) {
      // A stuck build fails well before GitHub's 6-hour job limit.
      expect(jobs[j]!['timeout-minutes'], j).toBe(45)
      expect(jobs[j]!['runs-on'], j).toBe('${{ matrix.arch.runner }}')
      const matrix = jobs[j]!.strategy!.matrix!
      expect(matrix.image!.map((m) => m.name), j).toEqual(images)
      expect(matrix.image!.find((m) => m.name === 'backup')).toMatchObject({ file: 'ops/backup/Dockerfile', context: 'ops/backup' })
      expect(matrix.arch, j).toEqual([
        { name: 'amd64', platform: 'linux/amd64', runner: 'ubuntu-24.04' },
        { name: 'arm64', platform: 'linux/arm64', runner: 'ubuntu-24.04-arm' },
      ])
      const build = step(j, (s) => !!s.uses?.startsWith('docker/build-push-action@'))
      expect(build.with!.platforms, j).toBe('${{ matrix.arch.platform }}')
      expect(build.with!.push, j).toBeUndefined()
      expect(build.with!.tags, j).toBeUndefined()
      expect(String(build.with!.labels)).toContain('org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}')
      expect(String(build.with!.labels)).toContain('org.opencontainers.image.title=yoda-${{ matrix.image.name }}')
      const keep = step(j, (s) => s.name === 'keep the ${{ matrix.arch.name }} digest')
      expect(keep.env).toEqual({ NAME: '${{ matrix.image.name }}', ARCH: '${{ matrix.arch.name }}', DIGEST: '${{ steps.build.outputs.digest }}' })
      expect(keep.run).toContain("grep -Eqx 'sha256:[0-9a-f]{64}'")
      // Per-architecture digests never match the bundle's digest-* pattern.
      const up = jobs[j]!.steps.filter((s) => s.uses?.startsWith('actions/upload-artifact@')).map((s) => String(s.with!.name))
      expect(up[0]).toBe('arch-digest-${{ matrix.image.name }}-${{ matrix.arch.name }}')
      for (const n of up) expect(n).not.toMatch(/^digest-/)
    }
    expect(step('images', (s) => !!s.uses?.startsWith('docker/build-push-action@')).with!.outputs).toBe(
      'type=image,name=${{ needs.meta.outputs.prefix }}/${{ matrix.image.name }},push-by-digest=true,name-canonical=true,push=true',
    )
    // The dry run exports an OCI archive per architecture for manifest-dry; it pushes nowhere.
    const dryBuild = step('images-dry', (s) => !!s.uses?.startsWith('docker/build-push-action@'))
    expect(dryBuild.with!.outputs).toBe('type=oci,dest=${{ runner.temp }}/image.tar,name=${{ needs.meta.outputs.prefix }}/${{ matrix.image.name }}')
    // A release never reads the cache pull requests write.
    const real = step('images', (s) => !!s.uses?.startsWith('docker/build-push-action@'))
    expect(real.with!['no-cache']).toBe(true)
    expect(real.with!['cache-from']).toBeUndefined()
    expect(real.with!['cache-to']).toBeUndefined()
    expect(dryBuild.with!['cache-from']).toBe('type=gha,scope=${{ matrix.image.name }}-${{ matrix.arch.name }}')
    // The dry jobs have no registry login.
    for (const j of ['images-dry', 'manifest-dry']) expect(jobs[j]!.steps.some((s) => s.uses?.startsWith('docker/login-action@')), j).toBe(false)
    for (const j of ['images', 'manifest']) {
      const login = step(j, (s) => !!s.uses?.startsWith('docker/login-action@'))
      expect(login.with).toMatchObject({ registry: 'ghcr.io', password: '${{ secrets.GITHUB_TOKEN }}' })
    }
    expect(wf.env).toEqual({ DOCKER_BUILD_RECORD_UPLOAD: 'false' })
    // The image prefix and tags match what install.sh and release.env use: ghcr.io/<owner>/yoda, version without v.
    expect(meta()).toContain(`echo "prefix=ghcr.io/$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')"`)
    expect(meta()).toContain('echo "tag=v$version"')
    expect(read('ops/install/install.sh')).toContain("DEFAULT_IMAGE_PREFIX='ghcr.io/tantee/yoda'")
  })

  it('merges the two architectures of each image by digest only (untagged), the same script in a release and a dry run', () => {
    for (const j of ['manifest', 'manifest-dry']) {
      expect(jobs[j]!.strategy!.matrix!.name, j).toEqual(images)
      expect(jobs[j]!['runs-on'], j).toBe('ubuntu-24.04')
      expect(jobs[j]!['timeout-minutes'], j).toBe(20)
      const dl = jobs[j]!.steps.filter((s) => s.uses?.startsWith('actions/download-artifact@')).map((s) => s.with!.pattern)
      expect(dl, j).toContain('arch-digest-${{ matrix.name }}-*')
      const merge = step(j, (s) => s.id === 'merge')
      expect(merge.env, j).toEqual({ NAME: '${{ matrix.name }}', REPO: '${{ env.MERGE_PREFIX }}/${{ matrix.name }}' })
      expect(merge.run).toContain('digest=$(sh .github/scripts/merge-image.sh "$REPO" "$amd64" "$arm64")')
      const keep = step(j, (s) => s.name === 'keep the digest')
      expect(keep.env).toEqual({ NAME: '${{ matrix.name }}', DIGEST: '${{ steps.merge.outputs.digest }}' })
      expect(step(j, (s) => !!s.uses?.startsWith('actions/upload-artifact@')).with!.name).toBe('digest-${{ matrix.name }}')
    }
    expect(jobs.manifest!.env).toEqual({ MERGE_PREFIX: '${{ needs.meta.outputs.prefix }}' })
    // The dry run merges in a registry on its own runner, after checking the archives kept their build digests.
    expect(jobs['manifest-dry']!.env).toEqual({ MERGE_PREFIX: 'localhost:5000/yoda' })
    expect(jobs['manifest-dry']!.services!.registry!.ports).toEqual(['5000:5000'])
    const copy = step('manifest-dry', (s) => /local registry/.test(s.name ?? ''))
    expect(copy.run).toContain('skopeo copy --all --preserve-digests')
    expect(copy.run).toMatch(/\[ "\$got" = "\$want" \] \|\|/)
    expect(wf.on.pull_request.paths).toContain('.github/scripts/**')

    const sh = read('.github/scripts/merge-image.sh')
    expect(sh).toMatch(/^set -eu$/m)
    expect(sh).toContain('docker buildx imagetools create --dry-run "$repo@$amd64" "$repo@$arm64"')
    // Pushed to its own digest, never a tag; then read back and checked.
    expect(sh).toContain('docker buildx imagetools create --tag "$repo@$digest" "$repo@$amd64" "$repo@$arm64"')
    expect(sh).not.toMatch(/--tag "\$repo:/)
    expect(sh).toContain('docker buildx imagetools inspect --raw "$repo@$digest"')
    expect(sh).toContain('[ "$platforms" = "linux/amd64,linux/arm64" ]')
  })

  it('writes the pushed digests into the bundle before signing it', () => {
    const order = jobs.bundle!.steps.map((s) => s.name ?? s.id ?? s.uses)
    const download = step('bundle', (s) => !!s.uses?.startsWith('actions/download-artifact@'))
    expect(download.with).toMatchObject({ pattern: 'digest-*', 'merge-multiple': true })
    expect(step('bundle', (s) => s.name === 'build the bundle').run).toContain('sh ops/install/bundle.sh "$VERSION" "$IMAGE_PREFIX" dist "$RUNNER_TEMP/digests.txt"')
    expect(order.indexOf('collect the image digests')).toBeLessThan(order.indexOf('build the bundle'))
    expect(order.indexOf('build the bundle')).toBeLessThan(order.indexOf('sign SHA256SUMS with the release key'))
  })

  it('signs a real release with the MINISIGN_* secrets, failing clearly without either', () => {
    const sign = step('bundle', (s) => s.name === 'sign SHA256SUMS with the release key')
    expect(sign.if).toBe(REAL)
    expect(sign.env).toEqual({ MINISIGN_SECRET_KEY: '${{ secrets.MINISIGN_SECRET_KEY }}', MINISIGN_PASSWORD: '${{ secrets.MINISIGN_PASSWORD }}' })
    const run = sign.run!
    const guard = run.indexOf('if [ -z "${MINISIGN_SECRET_KEY:-}" ]; then')
    expect(guard).toBeGreaterThan(-1)
    expect(run.slice(guard)).toMatch(/::error::The secret MINISIGN_SECRET_KEY is not set[^\n]*gh secret set --env release MINISIGN_SECRET_KEY < yoda\.key[^\n]*\n\s*exit 1/)
    const pw = run.indexOf('if [ -z "${MINISIGN_PASSWORD:-}" ]; then')
    expect(pw).toBeGreaterThan(guard)
    expect(run.slice(pw)).toMatch(/::error::The secret MINISIGN_PASSWORD is not set or empty[^\n]*\n\s*exit 1/)
    expect(run).toContain(`printf '%s\\n' "$MINISIGN_PASSWORD" | minisign -S -s "$key" -m "$DIST/SHA256SUMS" -t "yoda release $VERSION"`)
    expect(run).toContain('(umask 077 &&')
    expect(run).toContain(`trap 'rm -f "$key"' EXIT`)
    // The build step reads no secret.
    expect(step('bundle', (s) => s.name === 'build the bundle').env).toBeUndefined()
  })

  it('checks the key embedded in install.sh against the signature on a real release', () => {
    const check = step('bundle', (s) => s.name === 'check the release key against install.sh')
    expect(check.if).toBe(REAL)
    expect(check.run).toContain(`pub=$(sed -n "s/^RELEASE_PUBKEY_EMBEDDED='\\(.*\\)'$/\\1/p" ops/install/install.sh)`)
    expect(check.run).toMatch(/\*REPLACE-WITH\*\)\n\s*echo "::error::ops\/install\/install\.sh still embeds the placeholder/)
    expect(check.run).toContain('minisign -V -q -P "$pub" -m "$DIST/SHA256SUMS" ||')
  })

  it('signs a dry run with a throwaway key made in the job, never stored, and verifies it with install.sh', () => {
    const eph = step('bundle', (s) => s.id === 'ephemeral')
    expect(eph.if).toBe(DRY)
    expect(eph.env).toBeUndefined()
    expect(eph.run).toContain('minisign -G -p "$eph/yoda.pub" -s "$eph/yoda.key"')
    expect(eph.run).toContain('rm -f "$eph/yoda.key"')
    expect(eph.run).not.toContain('REPLACE-WITH')
    const verify = step('bundle', (s) => s.name === 'verify end to end with install.sh')
    expect(verify.if).toBeUndefined()
    expect(verify.env).toEqual({ YODA_RELEASE_PUBKEY: '${{ steps.ephemeral.outputs.pubkey }}' })
    expect(verify.run).toContain('sh ops/install/check-release.sh "$VERSION" "$DIST" "$IMAGE_PREFIX" "$RUNNER_TEMP/digests.txt"')
    // Only a real release keeps the bundle for publishing; a dry run keeps its own for a day, for one-line-install.
    const upload = step('bundle', (s) => s.name === 'keep the signed bundle for the release job')
    expect(upload.if).toBe(REAL)
    expect(upload.with!.name).toBe('release-bundle')
    const dry = step('bundle', (s) => s.name === 'keep the dry-run bundle for one-line-install')
    expect(dry.if).toBe(DRY)
    expect(dry.with).toMatchObject({ name: 'dry-run-bundle', 'retention-days': 1, 'if-no-files-found': 'error' })
    expect(jobs.bundle!.outputs).toEqual({ pubkey: '${{ steps.ephemeral.outputs.pubkey }}' })
    const order = jobs.bundle!.steps.map((s) => s.name ?? s.id)
    expect(order.indexOf('check the release key against install.sh')).toBeLessThan(order.indexOf('verify end to end with install.sh'))
    expect(order.indexOf('verify end to end with install.sh')).toBeLessThan(order.indexOf('keep the signed bundle for the release job'))
  })

  it('runs the README one-liner with --yes on a fresh, pinned ubuntu:24.04 on dry runs only, with a timeout', () => {
    const job = jobs['one-line-install']!
    expect(job['timeout-minutes']).toBe(20)
    expect(job['runs-on']).toBe('ubuntu-24.04')
    expect(job.env).toEqual({
      VERSION: '${{ needs.meta.outputs.version }}',
      IMAGE_PREFIX: '${{ needs.meta.outputs.prefix }}',
      YODA_RELEASE_PUBKEY: '${{ needs.bundle.outputs.pubkey }}',
      UBUNTU_IMAGE: expect.stringMatching(/^ubuntu:24\.04@sha256:[0-9a-f]{64}$/),
    })
    const get = step('one-line-install', (s) => !!s.uses?.startsWith('actions/download-artifact@'))
    expect(get.with).toEqual({ name: 'dry-run-bundle', path: '${{ runner.temp }}/release' })
    const run = step('one-line-install', (s) => s.name === 'the one-line install on a fresh Ubuntu').run!
    expect(run).toBe('sh .github/scripts/one-line-install-e2e.sh "$VERSION" "$RUNNER_TEMP/release" "$IMAGE_PREFIX"')
    const sh = read('.github/scripts/one-line-install-e2e.sh')
    // The README's one-liner exactly (piped, --yes), from the release layout GitHub serves, as a user with sudo.
    expect(read('README.md')).toContain('curl -fsSL https://github.com/tantee/yoda/releases/latest/download/install.sh | sh\n')
    expect(sh).toContain(`oneliner="curl -fsSL $origin/releases/latest/download/install.sh | sh -s -- --yes --base-url '$origin/releases/{version}/'"`)
    expect(sh).toContain('docker exec -u deploy ')
    expect(sh).toContain('docker run -d --privileged --network host')
    expect(sh).toContain('"$image" sleep infinity')
    expect(sh).toContain('--no-install-recommends curl ca-certificates sudo')
    expect(sh).toContain("dockerd > /tmp/dockerd.log 2>&1")
    // What it proves: the report, the installs from apt and Docker's repository, compose 2.24+, then the release
    // verified and unpacked into /srv/yoda (sudo mkdir + chown), stopping at the pull of images never pushed.
    for (const line of [
      '  - minisign: not found (checks the release signature)',
      '  - Docker Engine: not found, needs 24 or later',
      '  - Docker Compose plugin: not found, needs v2.24 or later',
      'https://download.docker.com/linux/ubuntu noble stable',
      'Docker Compose $compose is older than 2.24',
      'install: signature and checksum verified',
      'install: Create /srv/yoda with sudo and give it to deploy? yes (--yes)',
      'deploy: pulling the images of $version failed',
      '/srv/yoda is not owned by deploy',
    ]) expect(sh, line).toContain(line)
    // Never a real release: no secret, no environment, no write permission.
    expect(JSON.stringify(job)).not.toMatch(/secrets\./)
  })

  it('tags exactly the digests of the signed bundle, after checking its signature again', () => {
    const readBack = step('tag', (s) => s.name === 'read the digests from the signed bundle').run!
    expect(readBack).toContain('minisign -V -P "$pub" -m assets/SHA256SUMS')
    expect(readBack).toContain('grep -qFx "Trusted comment: yoda release $VERSION"')
    expect(readBack).toContain('sha256sum --check SHA256SUMS')
    expect(readBack).toContain('tar -xzOf "assets/yoda-$VERSION.tar.gz" bundle.env')
    const tag = step('tag', (s) => s.name === 'tag the images').run!
    expect(tag).toContain('docker buildx imagetools create -t "$PREFIX/$name:$VERSION" -t "$PREFIX/$name:$SHA_TAG" "$PREFIX/$name@$digest"')
    expect(tag).toContain('[ "$got" = "$digest" ] ||')
    expect(text).not.toMatch(/:latest\b/)
  })

  it('creates the GitHub Release with the CHANGELOG notes, the four assets, prerelease for x.y.z-<suffix>', () => {
    const create = step('release', (s) => s.name === 'create the GitHub Release')
    expect(create.env).toEqual({ GH_TOKEN: '${{ github.token }}' })
    const run = create.run!
    expect(run).toContain('sh ops/install/release-notes.sh "$VERSION" > "$RUNNER_TEMP/notes.md"')
    expect(run).toContain('gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --verify-tag')
    expect(run).toContain('[ "$PRERELEASE" != true ] || pre=--prerelease')
    expect(meta()).toMatch(/\*-\*\) prerelease=true ;;/)
    expect(run).not.toMatch(/\bgit (tag|push)\b/)
  })
})
