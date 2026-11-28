import { execFile, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// ops/install/install.sh and ops/deploy/deploy.sh against a local fixture bundle, a minisign key generated here
// (never committed) and a stub `docker` that records its calls. CI installs curl, minisign and shellcheck
// (.gitlab-ci.yml and .github/workflows/ci.yml test jobs): with CI set these tests run and fail without them; a
// developer machine without them skips.
const root = fileURLToPath(new URL('../../../', import.meta.url))
const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0
const posix = process.platform !== 'win32'
const ci = !!process.env.CI
const canInstall = posix && has('minisign') && (has('curl') || has('wget'))
const gnuTar = spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU tar') ?? false

describe.runIf(ci)('CI has the installer test tools', () => {
  it.each([['minisign'], ['shellcheck'], ['tar']])('%s', (cmd) => {
    expect(has(cmd), `${cmd} is missing: install it in the CI test job`).toBe(true)
  })
  it('curl or wget', () => expect(has('curl') || has('wget')).toBe(true))
})

const DOCKER_STUB = `#!/bin/sh
echo "$*" >> "$FAKE/docker-calls"
# FAKE_DENIED: this user may not use the daemon, unless it runs with the docker group (FAKE_IN_GROUP, set by the sg stub).
if [ -n "\${FAKE_DENIED:-}" ] && [ -z "\${FAKE_IN_GROUP:-}" ] && [ "$*" != 'compose version --short' ] && [ "$1" != --version ]; then
  echo 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock' >&2
  exit 1
fi
case "$1" in
  --version) echo "Docker version \${FAKE_ENGINE:-27.5.1}, build 0000000" ;;
  version) [ -z "\${FAKE_NO_DAEMON:-}" ] || exit 1; echo "\${FAKE_ENGINE:-27.5.1}" ;;
  login) ;;
  image) [ -z "\${FAKE_NO_IMAGE:-}" ] || exit 1 ;;
  compose)
    shift
    case " $* " in
      *" caddy validate "*) [ -z "\${FAKE_VALIDATE_FAIL:-}" ] || { echo 'Error: adapting config using caddyfile' >&2; exit 1; } ;;
      *" config --services "*) [ -z "\${FAKE_CONFIG_FAIL:-}" ] || { echo 'yaml: line 3: mapping values are not allowed in this context' >&2; exit 15; }; for svc in \${FAKE_SERVICES:-}; do echo "$svc"; done ;;
      *" exec -T proxy caddy reload "*) [ -z "\${FAKE_RELOAD_FAIL:-}" ] || { echo 'Error: loading new config' >&2; exit 1; } ;;
      *" exec -T proxy "*) echo "\${FAKE_PROXY_INFO:-internal portal.example.org 443}" ;;
      *" cp proxy:"*) [ -z "\${FAKE_NO_ROOT:-}" ] || exit 1; for a; do last=$a; done; echo 'PUBLIC ROOT' > "$last" ;;
      *" version --short "*) echo "\${FAKE_COMPOSE:-2.29.1}" ;;
      *" config --images "*) echo "registry.example.org/group/yoda/core:1.2.0" ;;
      *" exec -T core "*) echo "\${FAKE_SETUP:-required}" ;;
      *" exec -T portal "*) exit "\${FAKE_READY:-0}" ;;
    esac
    ;;
esac
exit 0
`

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, out: `${stdout}${stderr}` })
    })
  })
}

/** A temp dir with the stub docker on PATH, and the env to run scripts with. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'yoda-install-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'docker'), DOCKER_STUB)
  chmodSync(join(bin, 'docker'), 0o755)
  // No terminal to ask on (YODA_TTY empty) and no known distribution, unless a test says otherwise: a developer's
  // terminal is never read, and nothing is ever installed on the machine running the tests.
  const env: Record<string, string> = { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: dir, FAKE: dir, YODA_TTY: '', YODA_OS_RELEASE: join(dir, 'no-os-release') }
  const calls = () => (existsSync(join(dir, 'docker-calls')) ? readFileSync(join(dir, 'docker-calls'), 'utf8') : '')
  return { dir, env, calls }
}

/** A stub command in the sandbox's bin (first on PATH). */
function stub(dir: string, name: string, body: string) {
  writeFileSync(join(dir, 'bin', name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(dir, 'bin', name), 0o755)
}
/** sudo that records what it was asked to run, and runs only mkdir and chown (unlocking a read-only parent first,
 * as root could write there): never apt-get or anything else on the machine running the tests. */
function writeSudo(dir: string, unlock = '') {
  stub(dir, 'sudo', `echo "$*" >> "$FAKE/sudo-calls"
case "$1" in
  mkdir | chown) ${unlock ? `chmod 755 '${unlock}'; ` : ''}exec "$@" ;;
  # the package-manager stubs (never the machine's own: they are not on a test's PATH then)
  env | apt-get | dnf) [ -x "$FAKE/bin/apt-get" ] || exit 0; exec "$@" ;;
  install) case "$*" in *docker.list) cp "$4" "$FAKE/docker.list" ;; esac ;;
esac
exit 0`)
}

const mode = (path: string) => (statSync(path).mode & 0o777).toString(8)

/** What deploy.sh pins when no bundle.env of the release names digests: the tags (empty, so compose does not warn). */
const NO_PINS = 'YODA_CORE_DIGEST=\nYODA_PORTAL_DIGEST=\nYODA_RUNNER_DIGEST=\nYODA_BACKUP_DIGEST=\n'
const digest = (c: string) => `sha256:${c.repeat(64)}`
const DIGESTS = { core: digest('a'), portal: digest('b'), runner: digest('c'), backup: digest('d') }
const digestsFile = (dir: string, d: Record<string, string> = DIGESTS) => {
  const f = join(dir, 'digests.txt')
  writeFileSync(f, Object.entries(d).map(([n, v]) => `${n} ${v}\n`).join(''))
  return f
}
/** What deploy.sh pins with the built-in proxy off: YODA_PROXY_ENABLED empty (compose then trusts no extra hop). */
const OFF = 'YODA_PROXY_ENABLED=\n'
const PINS = Object.entries(DIGESTS).map(([n, v]) => `YODA_${n.toUpperCase()}_DIGEST=${v}\n`).join('')

describe.skipIf(!posix)('ops/deploy/deploy.sh (stub docker)', () => {
  const deploy = join(root, 'ops/deploy/deploy.sh')
  const PREFIX = { YODA_IMAGE_PREFIX: 'registry.example.org/group/yoda' }

  it('creates an empty .env (0600) when there is none, then init before migrate, and prints the setup hint', async () => {
    const s = sandbox()
    const work = join(s.dir, 'srv')
    mkdirSync(work)
    const r = await run('sh', [deploy], { cwd: work, env: { ...s.env, ...PREFIX, YODA_VERSION: '1.2.0' } })
    expect(r.code, r.out).toBe(0)
    expect(readFileSync(join(work, '.env'), 'utf8')).toBe('')
    expect(mode(join(work, '.env'))).toBe('600')
    expect(readFileSync(join(work, 'release.env'), 'utf8')).toBe(`YODA_VERSION=1.2.0\nYODA_IMAGE_PREFIX=registry.example.org/group/yoda\n${NO_PINS}${OFF}`)
    const calls = s.calls()
    const at = (s: string) => calls.indexOf(s)
    expect(at('pull --quiet')).toBeGreaterThan(-1)
    expect(at('run --rm init')).toBeGreaterThan(at('pull --quiet'))
    expect(at('run --rm migrate')).toBeGreaterThan(at('run --rm init'))
    expect(at('up -d --no-build')).toBeGreaterThan(at('run --rm migrate'))
    expect(r.out).toContain('created an empty .env')
    expect(r.out).toContain('http://127.0.0.1:3000/setup')
    expect(r.out).toContain('exec core yoda-admin setup-token')
    // Never a volume: the bootstrap volume holds the master key.
    expect(calls).not.toMatch(/\bvolume\b|\bdown\b|\s-v(\s|$)/)
    rmSync(s.dir, { recursive: true, force: true })
  })

  it('keeps an existing .env and the pinned image prefix, and prints no hint once setup is done', async () => {
    const s = sandbox()
    writeFileSync(join(s.dir, '.env'), 'PORTAL_PORT=3100\nOIDC_ISSUER=https://sso.example.org/realms/yoda\n', { mode: 0o640 })
    writeFileSync(join(s.dir, 'release.env'), 'YODA_VERSION=1.1.0\nYODA_IMAGE_PREFIX=registry.example.org/group/yoda\n')
    const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, YODA_VERSION: '1.2.0', FAKE_SETUP: 'done' } })
    expect(r.code, r.out).toBe(0)
    expect(readFileSync(join(s.dir, '.env'), 'utf8')).toBe('PORTAL_PORT=3100\nOIDC_ISSUER=https://sso.example.org/realms/yoda\n')
    expect(mode(join(s.dir, '.env'))).toBe('640')
    expect(readFileSync(join(s.dir, 'release.env'), 'utf8')).toBe(`YODA_VERSION=1.2.0\nYODA_IMAGE_PREFIX=registry.example.org/group/yoda\n${NO_PINS}${OFF}`)
    expect(r.out).not.toContain('created an empty .env')
    expect(r.out).not.toContain('/setup')
    expect(r.out).toContain('deploy: 1.2.0 ready')
    rmSync(s.dir, { recursive: true, force: true })
  })

  it('uses and pins the public GHCR images without an image prefix anywhere (never Docker Hub)', async () => {
    const s = sandbox()
    const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, YODA_VERSION: '1.2.0', FAKE_SETUP: 'done' } })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('YODA_IMAGE_PREFIX is not set: using the public release images, ghcr.io/tantee/yoda')
    expect(readFileSync(join(s.dir, 'release.env'), 'utf8')).toBe(`YODA_VERSION=1.2.0\nYODA_IMAGE_PREFIX=ghcr.io/tantee/yoda\n${NO_PINS}${OFF}`)
    rmSync(s.dir, { recursive: true, force: true })
  })

  const bundleEnv = (dir: string, version: string, prefix: string, pins = PINS) =>
    writeFileSync(join(dir, 'bundle.env'), `YODA_IMAGE_PREFIX=${prefix}\nYODA_VERSION=${version}\n${pins}`)

  it('pins the image digests of the bundle.env of the same release and prefix', async () => {
    const s = sandbox()
    bundleEnv(s.dir, '1.2.0', 'registry.example.org/group/yoda')
    const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...PREFIX, YODA_VERSION: '1.2.0', FAKE_SETUP: 'done' } })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('images pinned by digest (bundle.env of 1.2.0)')
    expect(readFileSync(join(s.dir, 'release.env'), 'utf8')).toBe(`YODA_VERSION=1.2.0\nYODA_IMAGE_PREFIX=registry.example.org/group/yoda\n${PINS}${OFF}`)
    rmSync(s.dir, { recursive: true, force: true })
  })

  it('pins the digests of the same release under another prefix too (a mirror that copied the images)', async () => {
    const s = sandbox()
    bundleEnv(s.dir, '1.2.0', 'ghcr.io/tantee/yoda')
    const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...PREFIX, YODA_VERSION: '1.2.0', FAKE_SETUP: 'done' } })
    expect(r.code, r.out).toBe(0)
    expect(readFileSync(join(s.dir, 'release.env'), 'utf8')).toBe(`YODA_VERSION=1.2.0\nYODA_IMAGE_PREFIX=registry.example.org/group/yoda\n${PINS}${OFF}`)
    rmSync(s.dir, { recursive: true, force: true })
  })

  it('runs the tags for another release, or with YODA_IGNORE_BUNDLE_DIGESTS=1 (with a warning)', async () => {
    for (const [version, env] of [
      ['1.1.0', {}],
      ['1.2.0', { YODA_IGNORE_BUNDLE_DIGESTS: '1' }],
    ] as const) {
      const s = sandbox()
      bundleEnv(s.dir, version, 'registry.example.org/group/yoda')
      const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...PREFIX, ...env, YODA_VERSION: '1.2.0', FAKE_SETUP: 'done' } })
      expect(r.code, r.out).toBe(0)
      if (version === '1.2.0') expect(r.out).toContain('warning: YODA_IGNORE_BUNDLE_DIGESTS=1: running the 1.2.0 tags')
      expect(readFileSync(join(s.dir, 'release.env'), 'utf8')).toBe(`YODA_VERSION=1.2.0\nYODA_IMAGE_PREFIX=registry.example.org/group/yoda\n${NO_PINS}${OFF}`)
      rmSync(s.dir, { recursive: true, force: true })
    }
  })

  it('refuses a bundle.env of the release with a malformed digest, before touching anything', async () => {
    const s = sandbox()
    bundleEnv(s.dir, '1.2.0', 'registry.example.org/group/yoda', PINS.replace(DIGESTS.portal, 'sha256:nothex'))
    const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...PREFIX, YODA_VERSION: '1.2.0' } })
    expect(r.code).toBe(2)
    expect(r.out).toContain('bundle.env has no valid YODA_PORTAL_DIGEST')
    expect(s.calls()).toBe('')
    rmSync(s.dir, { recursive: true, force: true })
  })

  it('exits 3 when the images cannot be pulled, before pinning the release', async () => {
    const s = sandbox()
    const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...PREFIX, YODA_VERSION: '1.2.0', FAKE_NO_IMAGE: '1' } })
    expect(r.code).toBe(3)
    expect(r.out).toContain('docker login ghcr.io')
    expect(existsSync(join(s.dir, 'release.env'))).toBe(false)
    expect(s.calls()).not.toContain('run --rm init')
    rmSync(s.dir, { recursive: true, force: true })
  })

  it('accepts the prefix of an older install kept in .env, without pinning it in release.env', async () => {
    const s = sandbox()
    writeFileSync(join(s.dir, '.env'), 'YODA_IMAGE_PREFIX=registry.example.org/old/yoda\n')
    const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, YODA_VERSION: '1.2.0', FAKE_SETUP: 'done' } })
    expect(r.code, r.out).toBe(0)
    expect(readFileSync(join(s.dir, 'release.env'), 'utf8')).toBe(`YODA_VERSION=1.2.0\n${NO_PINS}${OFF}`)
    rmSync(s.dir, { recursive: true, force: true })
  })

  it.each([['"registry.example.org/old/yoda"'], ["'registry.example.org/old/yoda'"], ['registry.example.org/old/yoda  # pinned']])(
    'accepts a quoted or commented prefix in .env (%s), as compose reads it',
    async (value) => {
      const s = sandbox()
      writeFileSync(join(s.dir, '.env'), `YODA_IMAGE_PREFIX=${value}\n`)
      const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, YODA_VERSION: '1.2.0', FAKE_SETUP: 'done' } })
      expect(r.code, r.out).toBe(0)
      rmSync(s.dir, { recursive: true, force: true })
    },
  )

  it('takes an empty or quoted-empty prefix in .env as none: the GHCR images, pinned over it in release.env', async () => {
    const s = sandbox()
    writeFileSync(join(s.dir, '.env'), 'YODA_IMAGE_PREFIX=""\n')
    const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, YODA_VERSION: '1.2.0', FAKE_SETUP: 'done' } })
    expect(r.code, r.out).toBe(0)
    expect(readFileSync(join(s.dir, 'release.env'), 'utf8')).toContain('YODA_IMAGE_PREFIX=ghcr.io/tantee/yoda\n')
    rmSync(s.dir, { recursive: true, force: true })
  })

  it('uses PORTAL_PORT from .env in the hint and pins a given image prefix', async () => {
    const s = sandbox()
    writeFileSync(join(s.dir, '.env'), 'PORTAL_PORT=3100\n')
    const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, YODA_VERSION: '1.2.0', YODA_IMAGE_PREFIX: 'registry.example.org/x/yoda' } })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('http://127.0.0.1:3100/setup')
    expect(readFileSync(join(s.dir, 'release.env'), 'utf8')).toContain('YODA_IMAGE_PREFIX=registry.example.org/x/yoda\n')
    rmSync(s.dir, { recursive: true, force: true })
  })

  describe('with the built-in HTTPS proxy (profile `proxy`)', () => {
    const ON = { FAKE_SERVICES: 'init migrate core portal proxy', YODA_PROXY_DOMAIN: 'portal.example.org' }
    const OFF_SERVICES = { FAKE_SERVICES: 'init migrate core portal' }
    const OLD = 'YODA_VERSION=1.1.0\nYODA_IMAGE_PREFIX=registry.example.org/group/yoda\n'
    /** deploy.sh stopped before pulling (or before pinning): release.env is the old one, no .next is left. */
    const unchanged = (dir: string, calls: string) => {
      expect(readFileSync(join(dir, 'release.env'), 'utf8')).toBe(OLD)
      expect(existsSync(join(dir, 'release.env.next'))).toBe(false)
      expect(calls).not.toContain('run --rm init')
      expect(calls).not.toContain('up -d')
    }

    it('pins YODA_PROXY_ENABLED, validates the Caddyfile before anything is replaced, and copies the public root', async () => {
      const s = sandbox()
      writeFileSync(join(s.dir, '.env'), 'COMPOSE_PROFILES=proxy\nYODA_PROXY_DOMAIN=portal.example.org\n')
      const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...PREFIX, ...ON, YODA_VERSION: '1.2.0' } })
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(join(s.dir, 'release.env'), 'utf8')).toBe(`YODA_VERSION=1.2.0\nYODA_IMAGE_PREFIX=registry.example.org/group/yoda\n${NO_PINS}YODA_PROXY_ENABLED=true\n`)
      const calls = s.calls()
      const at = (x: string) => calls.indexOf(x)
      expect(at('run --rm --no-deps -T proxy caddy validate --config /etc/caddy/yoda/Caddyfile --adapter caddyfile')).toBeGreaterThan(at('pull --quiet'))
      expect(at('run --rm init')).toBeGreaterThan(at('caddy validate'))
      const reload = at('exec -T proxy caddy reload --config /etc/caddy/yoda/Caddyfile --adapter caddyfile --force')
      expect(reload).toBeGreaterThan(at('up -d --no-build'))
      expect(at('cp proxy:/data/caddy/pki/authorities/local/root.crt proxy/root.crt.next')).toBeGreaterThan(reload)
      expect(r.out).toContain('built-in HTTPS proxy configuration reloaded')
      expect(readFileSync(join(s.dir, 'proxy/root.crt'), 'utf8')).toBe('PUBLIC ROOT\n')
      expect(mode(join(s.dir, 'proxy/root.crt'))).toBe('644')
      expect(existsSync(join(s.dir, 'proxy/root.crt.next'))).toBe(false)
      for (const d of ['proxy/certs', 'proxy/sites']) expect(statSync(join(s.dir, d)).isDirectory(), d).toBe(true)
      expect(r.out).toContain('built-in HTTPS proxy settings checked')
      expect(r.out).toContain('built-in HTTPS proxy on: https://portal.example.org (certificates: internal)')
      expect(r.out).toContain('through the built-in proxy: https://portal.example.org/setup')
      expect(r.out).toContain('/proxy/root.crt: install it on the staff PCs')
      // .env is never changed, also with the proxy.
      expect(readFileSync(join(s.dir, '.env'), 'utf8')).toBe('COMPOSE_PROFILES=proxy\nYODA_PROXY_DOMAIN=portal.example.org\n')
      rmSync(s.dir, { recursive: true, force: true })
    })

    it('names a port other than 443 in the address, and copies no root for the files and acme modes', async () => {
      const s = sandbox()
      const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...PREFIX, ...ON, YODA_VERSION: '1.2.0', FAKE_PROXY_INFO: 'files portal.example.org 8443' } })
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('built-in HTTPS proxy on: https://portal.example.org:8443 (certificates: files)')
      expect(r.out).toContain('https://portal.example.org:8443/setup')
      expect(s.calls()).not.toContain('cp proxy:')
      expect(existsSync(join(s.dir, 'proxy/root.crt'))).toBe(false)
      rmSync(s.dir, { recursive: true, force: true })
    })

    it('stops before release.env or anything running is replaced when caddy validate refuses the settings (exit 2)', async () => {
      const s = sandbox()
      writeFileSync(join(s.dir, 'release.env'), OLD)
      const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...PREFIX, ...ON, YODA_VERSION: '1.2.0', FAKE_VALIDATE_FAIL: '1' } })
      expect(r.code).toBe(2)
      expect(r.out).toContain("the built-in HTTPS proxy's settings are invalid")
      expect(r.out).toContain('Error: adapting config using caddyfile')
      expect(r.out).toContain('release.env and the running containers are unchanged')
      // Validated after the pull, with the new release's files and images (release.env.next), never pinned.
      expect(s.calls().indexOf('caddy validate')).toBeGreaterThan(s.calls().indexOf('pull --quiet'))
      unchanged(s.dir, s.calls())
      rmSync(s.dir, { recursive: true, force: true })
    })

    it('fails (exit 1) when the proxy does not take the reloaded configuration', async () => {
      const s = sandbox()
      const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...PREFIX, ...ON, YODA_VERSION: '1.2.0', FAKE_RELOAD_FAIL: '1' } })
      expect(r.code).toBe(1)
      expect(r.out).toContain('Error: loading new config')
      expect(r.out).toContain('the built-in HTTPS proxy did not reload its configuration')
      // It may be stopped or restart-looping, not only on a stale configuration.
      expect(r.out).toContain('dc ps proxy, dc logs --tail 50 proxy')
      expect(s.calls().match(/caddy reload/g)?.length).toBe(6)
      rmSync(s.dir, { recursive: true, force: true })
    }, 60_000)

    it.each([
      ['.env', 'COMPOSE_PROFILES=proxy\n', {}],
      ['.env', 'COMPOSE_PROFILES="runner, proxy"\n', {}],
      ['env', '', { COMPOSE_PROFILES: 'proxy' }],
    ])('refuses the proxy profile with compose files that have no proxy service (%s %j %j), before pulling', async (_where, dotenv, env) => {
      const s = sandbox()
      writeFileSync(join(s.dir, '.env'), dotenv)
      writeFileSync(join(s.dir, 'release.env'), OLD)
      const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...OFF_SERVICES, ...env, YODA_VERSION: '1.0.0' } })
      expect(r.code).toBe(2)
      expect(r.out).toContain('the compose files of 1.0.0 have no proxy service: it came with release 1.1.0')
      expect(s.calls()).not.toContain('pull')
      unchanged(s.dir, s.calls())
      rmSync(s.dir, { recursive: true, force: true })
    })

    it.each([
      ['.env off', 'YODA_PROXY_ENABLED=false\n', {}, OFF_SERVICES, /YODA_PROXY_ENABLED=false in the \.env, but the built-in HTTPS proxy is off/],
      ['env off', '', { YODA_PROXY_ENABLED: 'true' }, OFF_SERVICES, /YODA_PROXY_ENABLED=true in the environment, but the built-in HTTPS proxy is off/],
      ['env on', '', { YODA_PROXY_ENABLED: '' }, ON, /YODA_PROXY_ENABLED= in the environment, but the built-in HTTPS proxy is on/],
      ['.env on', 'YODA_PROXY_ENABLED=yes\n', {}, ON, /YODA_PROXY_ENABLED=yes in the \.env, but the built-in HTTPS proxy is on/],
    ])('refuses a YODA_PROXY_ENABLED it does not pin itself (%s), before pulling', async (_name, dotenv, env, services, message) => {
      const s = sandbox()
      writeFileSync(join(s.dir, '.env'), dotenv)
      writeFileSync(join(s.dir, 'release.env'), OLD)
      const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...services, ...env, YODA_VERSION: '1.2.0' } })
      expect(r.code).toBe(2)
      expect(r.out).toMatch(message)
      expect(s.calls()).not.toContain('pull')
      unchanged(s.dir, s.calls())
      rmSync(s.dir, { recursive: true, force: true })
    })

    it('accepts YODA_PROXY_ENABLED=true in .env with the proxy on (the same value), and warns about hops other than 2', async () => {
      const s = sandbox()
      writeFileSync(join(s.dir, '.env'), 'YODA_PROXY_ENABLED=true\nYODA_TRUSTED_PROXY_HOPS=1\n')
      const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...PREFIX, ...ON, YODA_VERSION: '1.2.0', FAKE_SETUP: 'done' } })
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('warning: YODA_TRUSTED_PROXY_HOPS=1 while the built-in HTTPS proxy is on (it needs 2')
      const two = sandbox()
      writeFileSync(join(two.dir, '.env'), 'YODA_TRUSTED_PROXY_HOPS=2\n')
      const r2 = await run('sh', [deploy], { cwd: two.dir, env: { ...two.env, ...PREFIX, ...ON, YODA_VERSION: '1.2.0', FAKE_SETUP: 'done' } })
      expect(r2.code, r2.out).toBe(0)
      expect(r2.out).not.toContain('YODA_TRUSTED_PROXY_HOPS=')
      rmSync(s.dir, { recursive: true, force: true })
      rmSync(two.dir, { recursive: true, force: true })
    })

    it.each([
      ['no domain', { YODA_PROXY_DOMAIN: '' }, /YODA_PROXY_DOMAIN is not set/],
      ['a wildcard', { YODA_PROXY_DOMAIN: '*.example.org' }, /YODA_PROXY_DOMAIN must be one host name .*: \*\.example\.org/],
      ['a URL', { YODA_PROXY_DOMAIN: 'https://portal.example.org' }, /YODA_PROXY_DOMAIN must be one host name/],
      ['an unknown mode', { YODA_PROXY_CERT_MODE: 'self' }, /YODA_PROXY_CERT_MODE must be internal, files or acme: self/],
      ['a bad port', { YODA_PROXY_HTTPS_PORT: '84x3' }, /YODA_PROXY_HTTPS_PORT is not a port number: 84x3/],
      ['acme on another port', { YODA_PROXY_CERT_MODE: 'acme', YODA_PROXY_ACME_EMAIL: 'it@example.org', YODA_PROXY_HTTPS_PORT: '8443' }, /acme needs the proxy on ports 80 and 443/],
      ['acme without an email', { YODA_PROXY_CERT_MODE: 'acme' }, /acme needs YODA_PROXY_ACME_EMAIL/],
      ['an ACME email with a brace', { YODA_PROXY_CERT_MODE: 'acme', YODA_PROXY_ACME_EMAIL: 'it@example.org}' }, /YODA_PROXY_ACME_EMAIL is not an email address/],
      ['an ACME email with a space', { YODA_PROXY_CERT_MODE: 'acme', YODA_PROXY_ACME_EMAIL: 'it @example.org' }, /YODA_PROXY_ACME_EMAIL is not an email address/],
      ['an http ACME directory', { YODA_PROXY_CERT_MODE: 'acme', YODA_PROXY_ACME_EMAIL: 'it@example.org', YODA_PROXY_ACME_CA: 'http://acme.example.org/directory' }, /YODA_PROXY_ACME_CA must be an https:\/\/ ACME directory URL/],
      ['an ACME directory with a placeholder', { YODA_PROXY_CERT_MODE: 'acme', YODA_PROXY_ACME_EMAIL: 'it@example.org', YODA_PROXY_ACME_CA: 'https://acme.example.org/{x}' }, /YODA_PROXY_ACME_CA must be an https:\/\/ ACME directory URL/],
    ])('refuses settings the proxy cannot run with (%s), before pulling', async (_name, env, message) => {
      const s = sandbox()
      writeFileSync(join(s.dir, 'release.env'), OLD)
      const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...ON, ...env, YODA_VERSION: '1.2.0' } })
      expect(r.code).toBe(2)
      expect(r.out).toMatch(message)
      expect(s.calls()).not.toContain('pull')
      unchanged(s.dir, s.calls())
      rmSync(s.dir, { recursive: true, force: true })
    })

    it('stops with compose\'s own error when it cannot read the compose files (never "no proxy service")', async () => {
      const s = sandbox()
      writeFileSync(join(s.dir, 'release.env'), OLD)
      const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...ON, YODA_VERSION: '1.2.0', FAKE_CONFIG_FAIL: '1' } })
      expect(r.code).toBe(2)
      expect(r.out).toContain('yaml: line 3: mapping values are not allowed in this context')
      expect(r.out).toContain('docker compose cannot read the compose files and .env')
      expect(s.calls()).not.toContain('pull')
      unchanged(s.dir, s.calls())
      rmSync(s.dir, { recursive: true, force: true })
    })

    it('takes the settings from .env too, and acme on 80 and 443 with Let\'s Encrypt staging', async () => {
      const s = sandbox()
      writeFileSync(join(s.dir, '.env'), 'YODA_PROXY_CERT_MODE=acme\nYODA_PROXY_ACME_EMAIL=it@example.org\nYODA_PROXY_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory\nYODA_PROXY_HTTP_PORT=80\nYODA_PROXY_HTTPS_PORT=443\n')
      const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...PREFIX, ...ON, YODA_VERSION: '1.2.0', FAKE_SETUP: 'done' } })
      expect(r.code, r.out).toBe(0)
      rmSync(s.dir, { recursive: true, force: true })
    })

    it.runIf(has('openssl'))('warns about an organisation certificate that expires soon, has expired or does not name the domain (files mode)', async () => {
      const s = sandbox()
      mkdirSync(join(s.dir, 'proxy/certs'), { recursive: true })
      const make = (days: string, san: string) => {
        const g = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', days, '-subj', '/CN=portal.example.org', '-addext', `subjectAltName=${san}`, '-keyout', join(s.dir, 'proxy/certs/key.pem'), '-out', join(s.dir, 'proxy/certs/cert.pem')], { encoding: 'utf8' })
        expect(g.status, g.stderr).toBe(0)
      }
      const env = { ...s.env, ...PREFIX, ...ON, YODA_PROXY_CERT_MODE: 'files', YODA_VERSION: '1.2.0', FAKE_SETUP: 'done', FAKE_PROXY_INFO: 'files portal.example.org 443' }
      make('10', 'DNS:portal.example.org')
      let r = await run('sh', [deploy], { cwd: s.dir, env })
      expect(r.code, r.out).toBe(0)
      expect(r.out).toMatch(/warning: proxy\/certs\/cert\.pem expires within 30 days \(.+\)/)
      expect(r.out).not.toContain('does not name')
      make('400', 'DNS:other.example.org')
      r = await run('sh', [deploy], { cwd: s.dir, env })
      expect(r.code, r.out).toBe(0)
      expect(r.out).not.toContain('expires within 30 days')
      expect(r.out).toContain('warning: proxy/certs/cert.pem does not name portal.example.org in its subject alternative names')
      make('400', 'DNS:*.example.org')
      r = await run('sh', [deploy], { cwd: s.dir, env })
      expect(r.out).not.toContain('does not name')
      rmSync(s.dir, { recursive: true, force: true })
    }, 60_000)

    it.each([
      ['.env', 'PORTAL_BIND=0.0.0.0\n', {}],
      ['.env', 'CORE_BIND="10.0.0.5"\n', {}],
      ['env', '', { PORTAL_BIND: '10.0.0.5' }],
    ])('refuses a portal or core published beyond the host (%s %j %j), before pulling', async (_where, dotenv, env) => {
      const s = sandbox()
      writeFileSync(join(s.dir, '.env'), dotenv)
      writeFileSync(join(s.dir, 'release.env'), 'YODA_VERSION=1.1.0\nYODA_IMAGE_PREFIX=registry.example.org/group/yoda\n')
      const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...ON, ...env, YODA_VERSION: '1.2.0' } })
      expect(r.code).toBe(2)
      expect(r.out).toMatch(/(PORTAL|CORE)_BIND=.* publishes it beyond this host while the built-in HTTPS proxy is on/)
      expect(s.calls()).not.toContain('pull')
      expect(readFileSync(join(s.dir, 'release.env'), 'utf8')).toBe('YODA_VERSION=1.1.0\nYODA_IMAGE_PREFIX=registry.example.org/group/yoda\n')
      expect(existsSync(join(s.dir, 'release.env.next'))).toBe(false)
      rmSync(s.dir, { recursive: true, force: true })
    })

    it('accepts loopback binds, and warns when the internal root is not there yet', async () => {
      const s = sandbox()
      writeFileSync(join(s.dir, '.env'), 'PORTAL_BIND=127.0.0.1\nCORE_BIND=localhost\n')
      const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...PREFIX, ...ON, YODA_VERSION: '1.2.0', FAKE_NO_ROOT: '1', FAKE_SETUP: 'done' } })
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain("warning: the proxy's internal CA root is not there yet")
      rmSync(s.dir, { recursive: true, force: true })
    }, 60_000)

    it('leaves everything as before with the profile off: pinned empty, no validate, no proxy directory', async () => {
      const s = sandbox()
      // An empty line in .env (as .env.example has it) is not a value: accepted.
      writeFileSync(join(s.dir, '.env'), 'YODA_PROXY_ENABLED=\nCOMPOSE_PROFILES=runner\n')
      const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...PREFIX, YODA_VERSION: '1.2.0', ...OFF_SERVICES } })
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(join(s.dir, 'release.env'), 'utf8')).toBe(`YODA_VERSION=1.2.0\nYODA_IMAGE_PREFIX=registry.example.org/group/yoda\n${NO_PINS}${OFF}`)
      expect(s.calls()).not.toContain('proxy')
      expect(existsSync(join(s.dir, 'proxy'))).toBe(false)
      rmSync(s.dir, { recursive: true, force: true })
    })
  })

  it.each([['latest;rm'], ['-x'], ['']])('refuses the version %j', async (v) => {
    const s = sandbox()
    const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...PREFIX, YODA_VERSION: v } })
    expect(r.code).not.toBe(0)
    expect(s.calls()).toBe('')
    rmSync(s.dir, { recursive: true, force: true })
  })
})

describe.skipIf(!ci && !canInstall)('ops/install/install.sh (fixture bundle, test key)', () => {
  const version = '1.2.0'
  let work: string
  let server: Server
  let base: string
  let pub: string
  let otherPub: string
  /** Files served by path under /releases/<version>/; tests swap entries to tamper. */
  let served: Record<string, Buffer>
  let good: Record<string, Buffer>
  /** The fixture server's origin, and every path asked for (latest lookups and downloads). */
  let origin: string
  let requests: string[] = []

  const sign = (keyDir: string, file: string, comment: string) => {
    const r = spawnSync('minisign', ['-S', '-s', join(keyDir, 'k.sec'), '-m', file, '-t', comment], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
  }
  const keygen = (keyDir: string) => {
    mkdirSync(keyDir, { recursive: true })
    const r = spawnSync('minisign', ['-G', '-W', '-p', join(keyDir, 'k.pub'), '-s', join(keyDir, 'k.sec')], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    return readFileSync(join(keyDir, 'k.pub'), 'utf8').split('\n')[1]!.trim()
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'yoda-bundle-'))
    const b = spawnSync('sh', ['ops/install/bundle.sh', version, 'registry.example.org/group/yoda', join(work, 'dist')], { cwd: root, encoding: 'utf8' })
    expect(b.status, b.stderr).toBe(0)
    const rel = join(work, 'dist/releases', version)
    pub = keygen(join(work, 'key'))
    otherPub = keygen(join(work, 'other'))
    sign(join(work, 'key'), join(rel, 'SHA256SUMS'), `yoda release ${version}`)
    good = Object.fromEntries(['SHA256SUMS', 'SHA256SUMS.minisig', `yoda-${version}.tar.gz`, 'install.sh'].map((f) => [f, readFileSync(join(rel, f))]))
    served = { ...good }
    server = createServer((req, res) => {
      requests.push(req.url ?? '')
      // GitHub's releases/latest redirect, and its API (pretty-printed, as GitHub sends it).
      if (req.url === '/latest') return void res.writeHead(302, { Location: `/yoda/releases/tag/v${version}` }).end()
      if (req.url === '/api/latest') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(`{\n  "url": "x",\n  "tag_name": "v${version}",\n  "name": "Yoda ${version}"\n}\n`)
      const prefix = `/yoda/releases/${version}/`
      const name = req.url?.startsWith(prefix) ? req.url.slice(prefix.length) : ''
      const body = served[name]
      if (!body) return void res.writeHead(404).end()
      res.writeHead(200).end(body)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    // The internal-mirror layout: "{version}" in --base-url becomes the version.
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    base = `${origin}/yoda/releases/{version}/`
  })

  afterAll(async () => {
    await new Promise((r) => server?.close(r))
    rmSync(work, { recursive: true, force: true })
  })

  /** install.sh on its own (no SHA256SUMS next to it): it downloads everything from the fixture server. */
  const install = async (args: string[] = [], env: Record<string, string> = {}, key: string | null = pub) => {
    const s = sandbox()
    const target = join(s.dir, 'srv', 'yoda')
    const script = join(s.dir, 'install.sh')
    writeFileSync(script, good['install.sh']!)
    const r = await run('sh', [script, '--dir', target, '--base-url', base, ...args], {
      env: { ...s.env, ...(key ? { YODA_RELEASE_PUBKEY: key } : {}), ...env },
    })
    served = { ...good }
    return { ...r, ...s, target }
  }

  it('verifies, unpacks into a new directory with an empty .env (0600) and deploys the pinned release', async () => {
    const r = await install(['--version', version])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('signature and checksum verified')
    for (const f of ['docker-compose.yml', 'docker-compose.prod.yml', 'ops/deploy/deploy.sh', '.env.example', 'bundle.env']) {
      expect(existsSync(join(r.target, f)), f).toBe(true)
    }
    expect(readFileSync(join(r.target, '.env'), 'utf8')).toBe('')
    expect(mode(join(r.target, '.env'))).toBe('600')
    expect(readFileSync(join(r.target, 'release.env'), 'utf8')).toBe(`YODA_VERSION=${version}\nYODA_IMAGE_PREFIX=registry.example.org/group/yoda\n${NO_PINS}${OFF}`)
    const calls = r.calls()
    expect(calls).toContain('run --rm init')
    expect(calls).toContain('up -d --no-build')
    // Not a terminal: no interactive login, a hint instead.
    expect(calls).not.toMatch(/^login/m)
    expect(r.out).toContain('docker login registry.example.org')
    expect(r.out).toContain('/setup')
    expect(r.out).toContain('yoda-admin setup-token')
    rmSync(r.dir, { recursive: true, force: true })
  })

  const refuses = async (r: Awaited<ReturnType<typeof install>>, message: RegExp | string) => {
    expect(r.code, r.out).not.toBe(0)
    expect(r.out).toMatch(message)
    // Nothing unpacked, nothing deployed.
    expect(existsSync(join(r.target, 'docker-compose.yml'))).toBe(false)
    expect(r.calls()).not.toContain('compose --env-file')
    rmSync(r.dir, { recursive: true, force: true })
  }

  describe('--with-proxy (the built-in HTTPS proxy)', () => {
    // A throwaway self-signed pair, made here and never committed.
    const certs = (dir: string, { days = '90', san = 'DNS:portal.example.org', name = '' } = {}) => {
      const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', days, '-subj', '/CN=portal.example.org', '-addext', `subjectAltName=${san}`, '-keyout', join(dir, `k${name}.pem`), '-out', join(dir, `c${name}.pem`)], { encoding: 'utf8' })
      expect(r.status, r.stderr).toBe(0)
      return { cert: join(dir, `c${name}.pem`), key: join(dir, `k${name}.pem`) }
    }
    const PROXY = { FAKE_SERVICES: 'init migrate core portal proxy' }

    it('writes the profile, the name and the mode (internal by default) into the new .env, and deploys', async () => {
      const r = await install(['--version', version, '--with-proxy', '--domain', 'portal.example.org'], PROXY)
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(join(r.target, 'release.env'), 'utf8')).toContain('YODA_PROXY_ENABLED=true\n')
      expect(readFileSync(join(r.target, '.env'), 'utf8')).toBe(
        '# The built-in HTTPS proxy (install.sh --with-proxy; docs/operations.md, section 4b).\nCOMPOSE_PROFILES=proxy\nYODA_PROXY_DOMAIN=portal.example.org\nYODA_PROXY_CERT_MODE=internal\n',
      )
      expect(mode(join(r.target, '.env'))).toBe('600')
      expect(existsSync(join(r.target, 'ops/proxy/Caddyfile'))).toBe(true)
      expect(statSync(join(r.target, 'proxy/certs')).isDirectory()).toBe(true)
      expect(r.out).toContain('built-in HTTPS proxy: https://portal.example.org (certificates: internal), written to')
      expect(r.out).toContain('/proxy/root.crt (the internal CA')
      expect(r.calls()).toContain('up -d --no-build')
      rmSync(r.dir, { recursive: true, force: true })
    })

    it.runIf(has('openssl'))('copies the organisation certificate and key for --cert-mode files (key 0600), with other ports', async () => {
      const s = mkdtempSync(join(tmpdir(), 'yoda-certs-'))
      const c = certs(s)
      const r = await install(['--version', version, '--with-proxy', '--domain=portal.example.org', '--cert-mode', 'files', '--cert', c.cert, '--key', c.key, '--http-port', '8080', '--https-port', '8443'], PROXY)
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(join(r.target, 'proxy/certs/cert.pem'))).toEqual(readFileSync(c.cert))
      expect(readFileSync(join(r.target, 'proxy/certs/key.pem'))).toEqual(readFileSync(c.key))
      expect(mode(join(r.target, 'proxy/certs/key.pem'))).toBe('600')
      expect(mode(join(r.target, 'proxy/certs/cert.pem'))).toBe('644')
      const env = readFileSync(join(r.target, '.env'), 'utf8')
      expect(env).toContain('YODA_PROXY_CERT_MODE=files\nYODA_PROXY_HTTP_PORT=8080\nYODA_PROXY_HTTPS_PORT=8443\n')
      expect(env).not.toContain('PRIVATE KEY')
      expect(r.out).toContain('https://portal.example.org:8443 (certificates: files)')
      expect(r.out).not.toContain('expires within 30 days')
      rmSync(r.dir, { recursive: true, force: true })
      rmSync(s, { recursive: true, force: true })
    })

    it.runIf(has('openssl'))('checks the organisation certificate before writing anything: the name, the key, the time left', async () => {
      const s = mkdtempSync(join(tmpdir(), 'yoda-certs-'))
      const other = certs(s, { san: 'DNS:other.example.org', name: '-other' })
      const good = certs(s)
      const files = (c: string, k: string) => ['--version', version, '--with-proxy', '--domain', 'portal.example.org', '--cert-mode', 'files', '--cert', c, '--key', k]
      // Only the subject alternative names count, as in browsers (the CN is portal.example.org in both).
      await refuses(await install(files(other.cert, other.key), PROXY), /does not name portal\.example\.org in its subject alternative names/)
      await refuses(await install(files(good.cert, other.key), PROXY), /is not the private key of/)
      const wild = certs(s, { san: 'DNS:*.example.org', name: '-wild' })
      const w = await install(files(wild.cert, wild.key), PROXY)
      expect(w.code, w.out).toBe(0)
      rmSync(w.dir, { recursive: true, force: true })
      const soon = certs(s, { days: '10', name: '-soon' })
      const r = await install(files(soon.cert, soon.key), PROXY)
      expect(r.code, r.out).toBe(0)
      expect(r.out).toMatch(/warning: .*c-soon\.pem expires within 30 days/)
      rmSync(r.dir, { recursive: true, force: true })
      rmSync(s, { recursive: true, force: true })
    })

    it('writes the ACME email for --cert-mode acme and warns that the host must be reachable', async () => {
      const r = await install(['--version', version, '--with-proxy', '--domain', 'portal.example.org', '--cert-mode', 'acme', '--acme-email', 'it@example.org'], PROXY)
      expect(r.code, r.out).toBe(0)
      const env = readFileSync(join(r.target, '.env'), 'utf8')
      expect(env).toContain('YODA_PROXY_CERT_MODE=acme\nYODA_PROXY_ACME_EMAIL=it@example.org\n')
      expect(env).not.toContain('YODA_PROXY_ACME_CA')
      expect(r.out).toContain('reachable from the internet on ports 80 and 443')
      rmSync(r.dir, { recursive: true, force: true })
    })

    it('writes Let\'s Encrypt\'s staging directory for --acme-staging', async () => {
      const r = await install(['--version', version, '--with-proxy', '--domain', 'portal.example.org', '--cert-mode', 'acme', '--acme-email', 'it@example.org', '--acme-staging', '--https-port', '443'], PROXY)
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(join(r.target, '.env'), 'utf8')).toContain('YODA_PROXY_ACME_EMAIL=it@example.org\n# Let\'s Encrypt staging (a trial: browsers do not trust it); remove for a real certificate.\nYODA_PROXY_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory\n')
      rmSync(r.dir, { recursive: true, force: true })
    })

    it.each([
      [['--with-proxy'], /--with-proxy needs --domain/],
      [['--with-proxy', '--domain', 'https://portal.example.org'], /--domain must be a host name/],
      [['--with-proxy', '--domain', 'portal.example.org/x'], /--domain must be a host name/],
      [['--with-proxy', '--domain', 'portal.example.org', '--cert-mode', 'self'], /--cert-mode must be internal, files or acme/],
      [['--with-proxy', '--domain', 'portal.example.org', '--cert-mode', 'files'], /needs --cert .* and --key/],
      [['--with-proxy', '--domain', 'portal.example.org', '--cert-mode', 'files', '--cert', '/nonexistent/c.pem', '--key', '/nonexistent/k.pem'], /cannot read the certificate/],
      [['--with-proxy', '--domain', 'portal.example.org', '--cert', '/etc/hosts'], /--cert and --key are for --cert-mode files only/],
      [['--with-proxy', '--domain', 'portal.example.org', '--cert-mode', 'acme'], /--cert-mode acme needs --acme-email/],
      [['--with-proxy', '--domain', 'portal.example.org', '--cert-mode', 'acme', '--acme-email', 'it@example.org;x'], /not an email address/],
      [['--with-proxy', '--domain', 'portal.example.org', '--acme-email', 'it@example.org'], /--acme-email is for --cert-mode acme only/],
      [['--with-proxy', '--domain', 'portal.example.org', '--https-port', '70000'], /not a port number/],
      [['--domain', 'portal.example.org'], /go with --with-proxy/],
      [['--cert-mode', 'internal'], /go with --with-proxy/],
      [['--acme-staging'], /go with --with-proxy/],
      [['--with-proxy', '--domain', 'portal.example.org', '--acme-staging'], /--acme-staging is for --cert-mode acme only/],
      [['--with-proxy', '--domain', 'portal.example.org', '--cert-mode', 'acme', '--acme-email', 'it@example.org', '--https-port', '8443'], /--cert-mode acme needs ports 80 and 443/],
      [['--with-proxy', '--domain', 'portal.example.org', '--cert-mode', 'acme', '--acme-email', 'it@example.org', '--http-port', '8080'], /--cert-mode acme needs ports 80 and 443/],
    ])('refuses %j before downloading anything', async (args, message) => {
      await refuses(await install(['--version', version, ...args]), message)
    })

    it.each([['1.0.0'], ['1.0.3'], ['0.9.0']])('refuses --with-proxy for release %s, which has no proxy, before downloading anything', async (v) => {
      await refuses(await install(['--version', v, '--with-proxy', '--domain', 'portal.example.org']), /the built-in HTTPS proxy \(--with-proxy\) needs release 1\.1\.0 or later; this is /)
    })

    it('refuses a non-PEM key for --cert-mode files', async () => {
      const s = mkdtempSync(join(tmpdir(), 'yoda-certs-'))
      writeFileSync(join(s, 'c.pem'), '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n')
      writeFileSync(join(s, 'k.pem'), 'not a key\n')
      await refuses(await install(['--version', version, '--with-proxy', '--domain', 'portal.example.org', '--cert-mode', 'files', '--cert', join(s, 'c.pem'), '--key', join(s, 'k.pem')]), /is not a PEM private key/)
      rmSync(s, { recursive: true, force: true })
    })
  })

  it('takes a --base-url without "{version}" as the release directory itself', async () => {
    const dir = base.replace('{version}/', `${version}`)
    const r = await install(['--version', version, '--base-url', dir])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`downloading Yoda ${version} from ${dir}/`)
    rmSync(r.dir, { recursive: true, force: true })
  })

  it('needs no registry login for the public GHCR images', async () => {
    const r = await install(['--version', version, '--image-prefix', 'ghcr.io/tantee/yoda'])
    expect(r.code, r.out).toBe(0)
    expect(readFileSync(join(r.target, 'release.env'), 'utf8')).toBe(`YODA_VERSION=${version}\nYODA_IMAGE_PREFIX=ghcr.io/tantee/yoda\n${NO_PINS}${OFF}`)
    expect(r.calls()).not.toMatch(/^login/m)
    expect(r.out).not.toContain('docker login')
    rmSync(r.dir, { recursive: true, force: true })
  })

  it('offers no ghcr.io login off a terminal when the pull fails, and names it in the failure', async () => {
    const r = await install(['--version', version, '--image-prefix', 'ghcr.io/tantee/yoda'], { FAKE_NO_IMAGE: '1' })
    expect(r.code).not.toBe(0)
    expect(r.calls()).not.toMatch(/^login/m)
    expect(r.out).toContain('docker login ghcr.io')
    rmSync(r.dir, { recursive: true, force: true })
  })

  it('warns when YODA_RELEASE_PUBKEY replaces the embedded release key', async () => {
    const r = await install(['--version', version])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('warning: YODA_RELEASE_PUBKEY replaces the release key built into this script (key id C73EF0AF404BAE84)')
    rmSync(r.dir, { recursive: true, force: true })
  })

  it('refuses a changed bundle (checksum mismatch)', async () => {
    const tampered = Buffer.from(good[`yoda-${version}.tar.gz`]!)
    tampered[tampered.length - 10] ^= 0xff
    served[`yoda-${version}.tar.gz`] = tampered
    await refuses(await install(['--version', version]), /checksum MISMATCH/)
  })

  it('refuses a SHA256SUMS changed after signing', async () => {
    served.SHA256SUMS = Buffer.from(good.SHA256SUMS!.toString().replace(/^[0-9a-f]/, (c) => (c === '0' ? '1' : '0')))
    await refuses(await install(['--version', version]), /signature check FAILED/)
  })

  it('refuses a signature from another key', async () => {
    await refuses(await install(['--version', version], {}, otherPub), /signature check FAILED/)
  })

  it('refuses a missing signature', async () => {
    delete served['SHA256SUMS.minisig']
    await refuses(await install(['--version', version]), /download failed/)
  })

  it('refuses SHA256SUMS signed for another release', async () => {
    const rel = join(work, 'replay')
    mkdirSync(rel, { recursive: true })
    writeFileSync(join(rel, 'SHA256SUMS'), good.SHA256SUMS!)
    sign(join(work, 'key'), join(rel, 'SHA256SUMS'), 'yoda release 1.1.0')
    served['SHA256SUMS.minisig'] = readFileSync(join(rel, 'SHA256SUMS.minisig'))
    await refuses(await install(['--version', version]), /not signed for release 1\.2\.0/)
  })

  it('refuses to run with a placeholder public key (a fork or mirror that has not set its own)', async () => {
    await refuses(await install(['--version', version], {}, 'RWQ-REPLACE-WITH-THE-YODA-RELEASE-PUBLIC-KEY'), /no release public key yet/)
  })

  it('checks with the embedded release key when none is given, refusing a signature from the test key', async () => {
    await refuses(await install(['--version', version], {}, null), /signature check FAILED/)
  })

  it.each([[['--version', '1.2']], [['--version', 'v1.2.0']], [['--version', 'latest;rm']]])('refuses a version that is not x.y.z %j', async (args) => {
    await refuses(await install(args), /not a pinned release version/)
  })

  it('needs --version with an internal mirror (--base-url has no "latest"), before downloading anything', async () => {
    for (const args of [[], ['--version', 'latest']]) {
      served = {}
      await refuses(await install(args), /an internal mirror \(--base-url\) has no "latest": pass --version/)
    }
  })

  it.each([
    [{ FAKE_COMPOSE: '2.20.3' }, /- Docker Compose: found 2\.20\.3, needs v2\.24 or later/],
    [{ FAKE_COMPOSE: 'v1.29.2' }, /- Docker Compose: found v1\.29\.2, needs v2\.24 or later/],
    [{ FAKE_ENGINE: '23.0.1' }, /- Docker Engine: found 23\.0\.1, needs 24 or later/],
    [{ FAKE_NO_DAEMON: '1' }, /cannot talk to the Docker daemon/],
  ])('refuses a host without the prerequisites (%j), naming what it found and what it needs', async (env, message) => {
    await refuses(await install(['--version', version], env), message)
  })

  it('accepts Compose v2.24 exactly', async () => {
    const r = await install(['--version', version], { FAKE_COMPOSE: 'v2.24.0' })
    expect(r.code, r.out).toBe(0)
    rmSync(r.dir, { recursive: true, force: true })
  })

  it('pins the image prefix in release.env before deploying, and names it when the deploy fails', async () => {
    const r = await install(['--version', version], { FAKE_NO_IMAGE: '1' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`images: registry.example.org/group/yoda/<core|portal|runner|backup>:${version}`)
    expect(r.out).toContain(`deploy of ${version} failed (images registry.example.org/group/yoda/<name>:${version}`)
    // deploy.sh stopped before pinning its release: what is there is install.sh's pin.
    expect(readFileSync(join(r.target, 'release.env'), 'utf8')).toBe('YODA_IMAGE_PREFIX=registry.example.org/group/yoda\n')
    expect(r.calls()).not.toContain('run --rm init')
    rmSync(r.dir, { recursive: true, force: true })
  })

  it('an --image-prefix wins over the bundle', async () => {
    const r = await install(['--version', version, '--image-prefix', 'registry.example.org/mirror/yoda'])
    expect(r.code, r.out).toBe(0)
    expect(readFileSync(join(r.target, 'release.env'), 'utf8')).toBe(`YODA_VERSION=${version}\nYODA_IMAGE_PREFIX=registry.example.org/mirror/yoda\n${NO_PINS}${OFF}`)
    rmSync(r.dir, { recursive: true, force: true })
  })

  it('unpacks with this user\'s modes (no setuid or world-writable bits from the archive)', async () => {
    const r = await install(['--version', version])
    expect(r.code, r.out).toBe(0)
    expect(statSync(join(r.target, 'ops/deploy/deploy.sh')).mode & 0o7022).toBe(0)
    expect(statSync(join(r.target, 'docker-compose.prod.yml')).mode & 0o7022).toBe(0)
    rmSync(r.dir, { recursive: true, force: true })
  })

  it.skipIf(!has('python3'))('check-release.sh verifies the signed bundle end to end, as the release workflow runs it', async () => {
    const r = await run('sh', ['ops/install/check-release.sh', version, join(work, 'dist/releases', version), 'registry.example.org/group/yoda'], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: work, YODA_RELEASE_PUBKEY: pub },
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`check-release: ${version} verified end to end`)
    // The one-line install too: piped, the latest release from the local releases/latest redirect.
    expect(r.out).toContain(`check-release: the piped install (latest: ${version}) verified, unpacked and deployed`)
  }, 30_000)

  it.skipIf(!has('python3'))('check-release.sh checks a bundle that pins image digests, and refuses other digests', async () => {
    const dist = join(work, 'pinned')
    const digests = digestsFile(work)
    const b = spawnSync('sh', ['ops/install/bundle.sh', version, 'registry.example.org/group/yoda', dist, digests], { cwd: root, encoding: 'utf8' })
    expect(b.status, b.stderr).toBe(0)
    const rel = join(dist, 'releases', version)
    sign(join(work, 'key'), join(rel, 'SHA256SUMS'), `yoda release ${version}`)
    const check = (file?: string) =>
      run('sh', ['ops/install/check-release.sh', version, rel, 'registry.example.org/group/yoda', ...(file ? [file] : [])], {
        cwd: root,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: work, YODA_RELEASE_PUBKEY: pub },
      })
    const ok = await check(digests)
    expect(ok.code, ok.out).toBe(0)
    expect(ok.out).toContain('images: registry.example.org/group/yoda/<core|portal|runner|backup>:1.2.0, pinned by the digests in the signed bundle.env')
    expect(ok.out).toContain('images pinned by digest (bundle.env of 1.2.0)')
    // With a real docker compose: the prod files resolve to <prefix>/<name>:<version>@<digest> with that release.env.
    if (spawnSync('docker', ['compose', 'version'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: work } }).status === 0) expect(ok.out).toContain('check-release: compose runs the pinned images')
    const otherDir = mkdtempSync(join(tmpdir(), 'yoda-digests-'))
    const other = await check(digestsFile(otherDir, { ...DIGESTS, runner: digest('e') }))
    expect(other.code).not.toBe(0)
    expect(other.out).toContain(`bundle.env does not pin runner at ${digest('e')}`)
    const none = await check()
    expect(none.code).not.toBe(0)
    expect(none.out).toContain('bundle.env pins digests that were not given to check')
    rmSync(otherDir, { recursive: true, force: true })
  }, 60_000)

  it.skipIf(!has('python3'))('check-release.sh fails a release signed by another key than the one it checks with', async () => {
    const r = await run('sh', ['ops/install/check-release.sh', version, join(work, 'dist/releases', version), 'registry.example.org/group/yoda'], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: work, YODA_RELEASE_PUBKEY: otherPub },
    })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('signature check FAILED')
  }, 30_000)

  /** curl ... | sh -s -- ...: install.sh read from a pipe, in the release directory next to a signed SHA256SUMS it
   * cannot see (piped, $0 is the shell): it downloads SHA256SUMS and the signature for the version. */
  const piped = async (args: string[] = [], env: Record<string, string> = {}, key: string | null = pub, s = sandbox()) => {
    const target = join(s.dir, 'srv', 'yoda')
    requests = []
    const r = await run('sh', ['-c', 'cat "$0" | sh -s -- "$@"', join(work, 'dist/releases', version, 'install.sh'), '--dir', target, '--base-url', base, ...args], {
      env: { ...s.env, ...(key ? { YODA_RELEASE_PUBKEY: key } : {}), ...env },
    })
    served = { ...good }
    return { ...r, ...s, target }
  }

  describe('piped (curl -fsSL .../install.sh | sh -s -- ...)', () => {
    it('downloads SHA256SUMS and its signature for the version, verifies, unpacks and deploys', async () => {
      const r = await piped(['--version', version])
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain(`downloading Yoda ${version} from ${base.replace('{version}', version)}`)
      expect(r.out).not.toContain('next to install.sh')
      expect(r.out).toContain('signature and checksum verified')
      expect(requests).toEqual([`/yoda/releases/${version}/SHA256SUMS`, `/yoda/releases/${version}/SHA256SUMS.minisig`, `/yoda/releases/${version}/yoda-${version}.tar.gz`])
      expect(readFileSync(join(r.target, 'release.env'), 'utf8')).toBe(`YODA_VERSION=${version}\nYODA_IMAGE_PREFIX=registry.example.org/group/yoda\n${NO_PINS}${OFF}`)
      expect(r.calls()).toContain('up -d --no-build')
      rmSync(r.dir, { recursive: true, force: true })
    })

    it('resolves the latest release from the releases/latest redirect (no --version)', async () => {
      const r = await piped([], { YODA_LATEST_URL: `${origin}/latest`, YODA_RELEASES_API: `${origin}/api/never` })
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain(`latest release: ${version}`)
      expect(requests[0]).toBe('/latest')
      expect(requests).not.toContain('/api/never')
      expect(existsSync(join(r.target, 'docker-compose.yml'))).toBe(true)
      rmSync(r.dir, { recursive: true, force: true })
    })

    it('falls back to the GitHub API\'s tag_name when the redirect does not name a release', async () => {
      const r = await piped(['--version', 'latest'], { YODA_LATEST_URL: `${origin}/gone`, YODA_RELEASES_API: `${origin}/api/latest` })
      expect(r.code, r.out).toBe(0)
      expect(requests.slice(0, 2)).toEqual(['/gone', '/api/latest'])
      expect(r.out).toContain(`latest release: ${version}`)
      rmSync(r.dir, { recursive: true, force: true })
    })

    it('stops when no latest release can be found, before downloading anything', async () => {
      const r = await piped([], { YODA_LATEST_URL: `${origin}/gone`, YODA_RELEASES_API: `${origin}/api/gone` })
      await refuses(r, /cannot find the latest release \(http:\/\/127\.0\.0\.1:\d+\/gone, http:\/\/127\.0\.0\.1:\d+\/api\/gone\): pass --version/)
      expect(requests).toEqual(['/gone', '/api/gone'])
    })

    it('refuses a bad signature, a wrong trusted-comment version and a bad bundle checksum, unpacking nothing', async () => {
      // A signature from another key.
      await refuses(await piped(['--version', version], {}, otherPub), /signature check FAILED for SHA256SUMS/)
      // Signed with the release key, but for another release (a replayed older SHA256SUMS).
      const rel = join(work, 'replay-piped')
      mkdirSync(rel, { recursive: true })
      writeFileSync(join(rel, 'SHA256SUMS'), good.SHA256SUMS!)
      sign(join(work, 'key'), join(rel, 'SHA256SUMS'), 'yoda release 1.2.1')
      served['SHA256SUMS.minisig'] = readFileSync(join(rel, 'SHA256SUMS.minisig'))
      await refuses(await piped(['--version', version]), /SHA256SUMS was not signed for release 1\.2\.0 \(it names 1\.2\.1\)/)
      // The trusted comment must be exactly the release: a longer version is not this one either.
      sign(join(work, 'key'), join(rel, 'SHA256SUMS'), 'yoda release 1.2.0-rc.1')
      served['SHA256SUMS.minisig'] = readFileSync(join(rel, 'SHA256SUMS.minisig'))
      await refuses(await piped(['--version', version]), /was not signed for release 1\.2\.0/)
      // A changed bundle.
      const tampered = Buffer.from(good[`yoda-${version}.tar.gz`]!)
      tampered[tampered.length - 10] ^= 0xff
      served[`yoda-${version}.tar.gz`] = tampered
      await refuses(await piped(['--version', version]), /checksum MISMATCH for yoda-1\.2\.0\.tar\.gz/)
      // A missing signature.
      delete served['SHA256SUMS.minisig']
      await refuses(await piped(['--version', version]), /download failed: .*SHA256SUMS\.minisig/)
    })

    it('reads its questions from the terminal (YODA_TTY, /dev/tty), never from the piped script', async () => {
      if (process.getuid?.() === 0) return
      const s = sandbox()
      const locked = join(s.dir, 'locked')
      mkdirSync(locked)
      chmodSync(locked, 0o555)
      writeSudo(s.dir, locked)
      writeFileSync(join(s.dir, 'tty'), 'y\n')
      const r = await piped(['--version', version, '--dir', join(locked, 'yoda')], { YODA_TTY: join(s.dir, 'tty') }, pub, s)
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain(`Create ${join(locked, 'yoda')} with sudo and give it to`)
      expect(existsSync(join(locked, 'yoda/docker-compose.yml'))).toBe(true)
      chmodSync(locked, 0o755)
      rmSync(s.dir, { recursive: true, force: true })
    })
  })

  describe('next to a signed SHA256SUMS (sh install.sh in the directory of the downloaded assets)', () => {
    it('uses those files, takes the release they are signed for, and downloads nothing', async () => {
      const s = sandbox()
      served = {}
      requests = []
      const r = await run('sh', [join(work, 'dist/releases', version, 'install.sh'), '--dir', join(s.dir, 'srv/yoda'), '--base-url', base], { env: { ...s.env, YODA_RELEASE_PUBKEY: pub } })
      served = { ...good }
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('using the SHA256SUMS and SHA256SUMS.minisig next to install.sh')
      expect(r.out).toContain(`using yoda-${version}.tar.gz next to install.sh`)
      expect(requests).toEqual([])
      expect(readFileSync(join(s.dir, 'srv/yoda/release.env'), 'utf8')).toContain(`YODA_VERSION=${version}\n`)
      rmSync(s.dir, { recursive: true, force: true })
    })

    it('refuses an install.sh that is not the one the signed SHA256SUMS lists, or another --version', async () => {
      const s = sandbox()
      const rel = join(s.dir, 'assets')
      mkdirSync(rel)
      for (const f of ['SHA256SUMS', 'SHA256SUMS.minisig', `yoda-${version}.tar.gz`]) writeFileSync(join(rel, f), good[f]!)
      writeFileSync(join(rel, 'install.sh'), `${good['install.sh']!.toString()}# changed\n`)
      const env = { ...s.env, YODA_RELEASE_PUBKEY: pub }
      const changed = await run('sh', [join(rel, 'install.sh'), '--dir', join(s.dir, 'srv/yoda')], { env })
      expect(changed.code).not.toBe(0)
      expect(changed.out).toMatch(/checksum MISMATCH: .*install\.sh is not the install\.sh the signed SHA256SUMS next to it lists/)
      writeFileSync(join(rel, 'install.sh'), good['install.sh']!)
      const other = await run('sh', [join(rel, 'install.sh'), '--version', '1.2.1', '--dir', join(s.dir, 'srv/yoda')], { env })
      expect(other.code).not.toBe(0)
      expect(other.out).toContain('SHA256SUMS was not signed for release 1.2.1 (it names 1.2.0)')
      expect(existsSync(join(s.dir, 'srv'))).toBe(false)
      rmSync(s.dir, { recursive: true, force: true })
    })
  })

  describe('--dir that cannot be created (e.g. /srv/yoda: permission denied)', () => {
    const locked = (s: ReturnType<typeof sandbox>) => {
      const d = join(s.dir, 'locked')
      mkdirSync(d)
      chmodSync(d, 0o555)
      writeSudo(s.dir, d)
      writeFileSync(join(s.dir, 'install.sh'), good['install.sh']!)
      return d
    }
    const skip = process.getuid?.() === 0

    it.skipIf(skip)('creates it with sudo and gives it to this user, with --yes or a yes on the terminal', async () => {
      for (const how of ['--yes', 'tty']) {
        const s = sandbox()
        const d = locked(s)
        writeFileSync(join(s.dir, 'tty'), 'yes\n')
        const r = await run('sh', [join(s.dir, 'install.sh'), '--version', version, '--dir', join(d, 'yoda'), '--base-url', base, ...(how === '--yes' ? ['--yes'] : [])], {
          env: { ...s.env, YODA_RELEASE_PUBKEY: pub, ...(how === 'tty' ? { YODA_TTY: join(s.dir, 'tty') } : {}) },
        })
        expect(r.code, r.out).toBe(0)
        expect(r.out).toContain(`cannot create ${join(d, 'yoda')} as `)
        const sudo = readFileSync(join(s.dir, 'sudo-calls'), 'utf8')
        expect(sudo).toMatch(new RegExp(`^mkdir -p ${join(d, 'yoda')}\nchown [^:\\s]+:[^\\s]+ ${join(d, 'yoda')}\n$`))
        expect(existsSync(join(d, 'yoda/docker-compose.yml'))).toBe(true)
        chmodSync(d, 0o755)
        rmSync(s.dir, { recursive: true, force: true })
      }
    })

    it.skipIf(skip)('stops when told no, and without a terminal or --yes never assumes yes (names the flag)', async () => {
      for (const [tty, message] of [['n\n', /cannot create .*: create it yourself \(sudo mkdir -p/], [null, /There is no terminal to ask on .* run it again with --yes, or create it yourself/]] as const) {
        const s = sandbox()
        const d = locked(s)
        if (tty) writeFileSync(join(s.dir, 'tty'), tty)
        const r = await run('sh', [join(s.dir, 'install.sh'), '--version', version, '--dir', join(d, 'yoda'), '--base-url', base], {
          env: { ...s.env, YODA_RELEASE_PUBKEY: pub, ...(tty ? { YODA_TTY: join(s.dir, 'tty') } : {}) },
        })
        expect(r.code).not.toBe(0)
        expect(r.out).toMatch(message)
        expect(existsSync(join(s.dir, 'sudo-calls'))).toBe(false)
        expect(existsSync(join(d, 'yoda'))).toBe(false)
        chmodSync(d, 0o755)
        rmSync(s.dir, { recursive: true, force: true })
      }
    })
  })

  it('warns below 10 GB free with the free space and the path it checked', async () => {
    const s = sandbox()
    writeFileSync(join(s.dir, 'bin', 'df'), '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/disk1 99999999 1 5347737 1% /"\n')
    chmodSync(join(s.dir, 'bin', 'df'), 0o755)
    writeFileSync(join(s.dir, 'install.sh'), good['install.sh']!)
    const r = await run('sh', [join(s.dir, 'install.sh'), '--version', version, '--dir', join(s.dir, 'srv/yoda'), '--base-url', base], { env: { ...s.env, YODA_RELEASE_PUBKEY: pub } })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`warning: only 5.1 GB free at ${s.dir} (checked for ${join(s.dir, 'srv/yoda')}); Yoda needs about 10 GB`)
    rmSync(s.dir, { recursive: true, force: true })
  })

  describe('the docker group (the user may not use the daemon yet)', () => {
    /** id: this user is `tester`, uid 1000; FAKE_GROUPS_DB is what /etc/group says, the process has no docker group. */
    const groups = (s: ReturnType<typeof sandbox>, db: string) => {
      stub(s.dir, 'id', `case "$*" in
  -u) echo 1000 ;;
  -un) echo tester ;;
  -nG) echo tester ;;
  '-nG tester') echo "${db}" ;;
  *) exec /usr/bin/id "$@" ;;
esac`)
      stub(s.dir, 'sg', `echo "sg $*" >> "$FAKE/sg-calls"
[ "$1" = docker ] && [ "$2" = -c ] || exit 2
FAKE_IN_GROUP=1 exec /bin/sh -c "$3"`)
      writeSudo(s.dir)
    }
    const go = (s: ReturnType<typeof sandbox>, args: string[] = []) => {
      writeFileSync(join(s.dir, 'install.sh'), good['install.sh']!)
      return run('sh', [join(s.dir, 'install.sh'), '--version', version, '--dir', join(s.dir, 'srv/yoda'), '--base-url', base, ...args], { env: { ...s.env, YODA_RELEASE_PUBKEY: pub, FAKE_DENIED: '1' } })
    }

    it('in the group but not in this login: runs docker through sg docker for this run, deploy.sh included', async () => {
      const s = sandbox()
      groups(s, 'tester docker')
      const r = await go(s)
      expect(r.code, r.out).toBe(0)
      expect(existsSync(join(s.dir, 'sudo-calls'))).toBe(false)
      // Every argument arrives intact through sg -c (the format template, compose's flags).
      expect(readFileSync(join(s.dir, 'sg-calls'), 'utf8')).toContain("sg docker -c exec '")
      expect(s.calls()).toContain('version --format {{.Server.Version}}')
      expect(s.calls()).toContain('run --rm migrate')
      expect(r.out).toContain('tester is in the docker group now: log out and back in')
      rmSync(s.dir, { recursive: true, force: true })
    })

    it('not in the group: adds the user with --yes (sudo usermod -aG docker), then the same', async () => {
      const s = sandbox()
      groups(s, 'tester')
      const r = await go(s, ['--yes'])
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(join(s.dir, 'sudo-calls'), 'utf8')).toBe('usermod -aG docker tester\n')
      expect(r.out).toContain('Add tester to the docker group (sudo usermod -aG docker tester)? yes (--yes)')
      expect(s.calls()).toContain('run --rm migrate')
      rmSync(s.dir, { recursive: true, force: true })
    })

    it('not in the group, no terminal and no --yes: stops naming --yes, sudo usermod and running with sudo', async () => {
      const s = sandbox()
      groups(s, 'tester')
      const r = await go(s)
      await refuses({ ...r, ...s, target: join(s.dir, 'srv/yoda') }, /run it again with --yes, or add it yourself \(sudo usermod -aG docker tester, then log out and back in\), or run install\.sh with sudo/)
    })
  })

  describe('dependencies (a stubbed system: PATH without the tools, YODA_OS_RELEASE, stub sudo and package managers)', () => {
    /** Every command of the machine's PATH but those a fresh host may lack, or that must never run here. */
    let toolbox: string
    const HIDDEN = ['curl', 'wget', 'minisign', 'docker', 'sudo', 'apt-get', 'apt-cache', 'add-apt-repository', 'dpkg', 'dnf', 'yum', 'rpm', 'id', 'sg', 'usermod', 'systemctl', 'service']
    const which = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).stdout.trim()
    const realCurl = which('curl')
    const realMinisign = which('minisign')
    beforeAll(() => {
      toolbox = join(work, 'toolbox')
      mkdirSync(toolbox)
      for (const d of (process.env.PATH ?? '/usr/bin:/bin').split(':')) {
        if (!d || !existsSync(d)) continue
        for (const name of readdirSync(d)) {
          if (HIDDEN.includes(name) || existsSync(join(toolbox, name))) continue
          try {
            symlinkSync(join(d, name), join(toolbox, name))
          } catch {
            // a name twice on PATH, or unreadable: the first wins
          }
        }
      }
    })

    const UBUNTU = 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nID=ubuntu\nID_LIKE=debian\nUBUNTU_CODENAME=noble\n'
    const DEBIAN = 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nVERSION_CODENAME=bookworm\nID=debian\n'
    const ROCKY = 'NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.4"\n'

    /** A host that has only `have` of curl, minisign and docker, as user `tester` (uid 1000). */
    const host = (opts: { os?: string; have?: string[]; sudo?: boolean; env?: Record<string, string>; hide?: string[] } = {}) => {
      const s = sandbox()
      let tools = toolbox
      if (opts.hide) {
        tools = join(s.dir, 'toolbox')
        mkdirSync(tools)
        for (const name of readdirSync(toolbox)) if (!opts.hide.includes(name)) symlinkSync(join(toolbox, name), join(tools, name))
      }
      rmSync(join(s.dir, 'bin', 'docker'))
      writeFileSync(join(s.dir, 'docker-stub'), DOCKER_STUB)
      // curl: the real one, except Docker's repository key (never fetched from the internet in a test).
      writeFileSync(join(s.dir, 'curl-stub'), `#!/bin/sh
case "$*" in
  *download.docker.com*) echo "curl $*" >> "$FAKE/sys-calls"; prev=''; for a; do [ "$prev" != -o ] || echo 'DOCKER KEY' > "$a"; prev=$a; done; exit 0 ;;
esac
exec '${realCurl}' "$@"
`)
      const add = (tool: string) => {
        if (tool === 'curl') writeFileSync(join(s.dir, 'bin', 'curl'), readFileSync(join(s.dir, 'curl-stub')))
        if (tool === 'docker') writeFileSync(join(s.dir, 'bin', 'docker'), DOCKER_STUB)
        if (tool === 'minisign') symlinkSync(realMinisign, join(s.dir, 'bin', 'minisign'))
        if (tool !== 'minisign') chmodSync(join(s.dir, 'bin', tool), 0o755)
      }
      for (const t of opts.have ?? ['curl']) add(t)
      stub(s.dir, 'id', `case "$*" in
  -u) echo 1000 ;;
  -un) echo tester ;;
  -nG | '-nG tester') echo 'tester docker' ;;
  *) exec /usr/bin/id "$@" ;;
esac`)
      // A package manager that "installs" what it is asked for: the tools appear on PATH.
      const pm = `echo "$(basename "$0") $*" >> "$FAKE/sys-calls"
case "$1" in
  info | show) exit "\${FAKE_NO_MINISIGN_PKG:-0}" ;;
  install) ;;
  *) exit 0 ;;
esac
for p; do
  case "$p" in
    minisign) ln -sf '${realMinisign}' "$FAKE/bin/minisign" ;;
    curl) cp "$FAKE/curl-stub" "$FAKE/bin/curl"; chmod 755 "$FAKE/bin/curl" ;;
    docker-ce-cli) cp "$FAKE/docker-stub" "$FAKE/bin/docker"; chmod 755 "$FAKE/bin/docker" ;;
  esac
done`
      stub(s.dir, 'apt-get', pm)
      stub(s.dir, 'dnf', pm)
      stub(s.dir, 'apt-cache', 'exit "${FAKE_NO_MINISIGN_PKG:-0}"')
      stub(s.dir, 'dpkg', `case "$1" in
  --print-architecture) echo amd64 ;;
  -s) exit "\${FAKE_DOCKER_CE:-1}" ;;
esac`)
      if (opts.sudo !== false) writeSudo(s.dir)
      if (opts.os) writeFileSync(join(s.dir, 'os-release'), opts.os)
      const env = { ...s.env, PATH: `${join(s.dir, 'bin')}:${tools}`, YODA_OS_RELEASE: join(s.dir, opts.os ? 'os-release' : 'none'), YODA_RELEASE_PUBKEY: pub, ...opts.env }
      writeFileSync(join(s.dir, 'install.sh'), good['install.sh']!)
      const target = join(s.dir, 'srv/yoda')
      const go = async (args: string[] = [], first: string[] = ['--version', version]) => {
        requests = []
        const r = await run('sh', [join(s.dir, 'install.sh'), ...first, '--dir', target, '--base-url', base, ...args], { env })
        return { ...r, ...s, target }
      }
      const log = (name: string) => (existsSync(join(s.dir, name)) ? readFileSync(join(s.dir, name), 'utf8') : '')
      return { s, go, log }
    }
    const done = (h: ReturnType<typeof host>) => rmSync(h.s.dir, { recursive: true, force: true })

    it('checks first and names exactly what is missing; an unknown system gets the manual steps and exit 1', async () => {
      const h = host({ have: ['curl'] })
      const r = await h.go(['--yes'])
      expect(r.code).toBe(1)
      expect(r.out).toContain('missing or too old:\n  - minisign: not found (checks the release signature)\n  - Docker Engine: not found, needs 24 or later\n  - Docker Compose plugin: not found, needs v2.24 or later')
      expect(r.out).not.toContain('curl: not found')
      expect(r.out).toContain('install.sh can install them on Debian, Ubuntu and the RHEL family only; this system is unknown')
      expect(r.out).toContain('  - minisign: your package manager, or https://jedisct1.github.io/minisign/')
      expect(r.out).toContain('  - Docker Engine 24 or later with the Compose plugin v2.24 or later: https://docs.docker.com/engine/install/')
      // Before anything else: nothing asked of the network, sudo or a package manager.
      expect(requests).toEqual([])
      expect(h.log('sudo-calls') + h.log('sys-calls')).toBe('')
      done(h)
    })

    it('reports curl, tar and sha256sum missing too, and openssl only for --cert-mode files', async () => {
      const h = host({ have: ['minisign', 'docker'], os: 'ID=alpine\n', hide: ['tar', 'sha256sum', 'shasum', 'openssl'] })
      const r = await h.go()
      expect(r.code).toBe(1)
      expect(r.out).toContain('missing or too old:\n  - curl: not found (downloads the release)\n  - tar: not found (unpacks the release)\n  - sha256sum or shasum: not found (checks the release checksum)\n')
      expect(r.out).toContain('this system is alpine')
      expect(r.out).not.toContain('openssl')
      const dir = mkdtempSync(join(tmpdir(), 'yoda-certs-'))
      writeFileSync(join(dir, 'c.pem'), '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n')
      writeFileSync(join(dir, 'k.pem'), '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n')
      const f = await h.go(['--with-proxy', '--domain', 'portal.example.org', '--cert-mode', 'files', '--cert', join(dir, 'c.pem'), '--key', join(dir, 'k.pem')])
      expect(f.out).toContain('  - openssl: not found (checks the --cert-mode files certificate)')
      rmSync(dir, { recursive: true, force: true })
      done(h)
    })

    it('Ubuntu without a terminal or --yes: shows the plan and stops naming --yes, never assuming yes', async () => {
      const h = host({ os: UBUNTU })
      const r = await h.go()
      expect(r.code).toBe(1)
      expect(r.out).toContain('install.sh can install them now (sudo):')
      expect(r.out).toContain('sudo apt-get install ca-certificates curl minisign')
      expect(r.out).toContain("Docker's apt repository (https://download.docker.com/linux/ubuntu): its key in /etc/apt/keyrings/docker.asc, then sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin")
      expect(r.out).toContain('sudo usermod -aG docker tester')
      expect(r.out).toContain('Install them now? There is no terminal to ask on (piped without one, or unattended), and install.sh never assumes yes: run it again with --yes')
      expect(h.log('sudo-calls') + h.log('sys-calls')).toBe('')
      done(h)
    })

    it('Ubuntu with --yes: apt minisign, Docker\'s apt repository and packages, the docker group, then installs', async () => {
      const h = host({ os: UBUNTU })
      const r = await h.go(['--yes'])
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('Install them now? yes (--yes)')
      const sudo = h.log('sudo-calls').split('\n').filter(Boolean)
      expect(sudo[0]).toBe('env DEBIAN_FRONTEND=noninteractive apt-get update')
      expect(sudo[1]).toBe('env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl minisign')
      expect(sudo[2]).toBe('install -m 0755 -d /etc/apt/keyrings')
      expect(sudo[3]).toMatch(/^install -m 0644 \S+\/docker\.asc \/etc\/apt\/keyrings\/docker\.asc$/)
      expect(sudo[4]).toMatch(/^install -m 0644 \S+\/docker\.list \/etc\/apt\/sources\.list\.d\/docker\.list$/)
      expect(sudo.slice(5)).toEqual([
        'env DEBIAN_FRONTEND=noninteractive apt-get update',
        'env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
        'usermod -aG docker tester',
      ])
      expect(h.log('docker.list')).toBe('deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n')
      expect(h.log('sys-calls')).toContain('curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o ')
      // Then the release, verified, unpacked and deployed in the same run.
      expect(r.out).toContain('signature and checksum verified')
      expect(existsSync(join(r.target, 'docker-compose.yml'))).toBe(true)
      expect(r.out).toContain('tester is in the docker group now: log out and back in')
      done(h)
    })

    it('Debian: Docker\'s debian repository with its release name; Ubuntu without minisign known enables universe', async () => {
      const d = host({ os: DEBIAN, have: ['curl', 'minisign'] })
      const r = await d.go(['--yes'])
      expect(r.code, r.out).toBe(0)
      expect(d.log('docker.list')).toBe('deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable\n')
      expect(d.log('sudo-calls')).toContain('apt-get install -y ca-certificates curl\n')
      done(d)
      const u = host({ os: UBUNTU, have: ['curl', 'docker'], env: { FAKE_NO_MINISIGN_PKG: '1' } })
      const r2 = await u.go(['--yes'])
      expect(r2.out).toContain('enabling the universe repository (minisign is in it)')
      expect(u.log('sudo-calls')).toContain('apt-get install -y software-properties-common\nadd-apt-repository -y universe\nenv DEBIAN_FRONTEND=noninteractive apt-get update\n')
      done(u)
    })

    it('the RHEL family: EPEL for minisign, Docker\'s dnf repository and packages', async () => {
      const h = host({ os: ROCKY, env: { FAKE_NO_MINISIGN_PKG: '1' } })
      const r = await h.go(['--yes'])
      expect(r.code, r.out).toBe(0)
      expect(h.log('sudo-calls').split('\n').filter(Boolean)).toEqual([
        'dnf install -y epel-release',
        'dnf install -y ca-certificates curl minisign',
        'dnf install -y dnf-plugins-core',
        'dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo',
        'dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
        'usermod -aG docker tester',
      ])
      done(h)
    })

    it('not root and no sudo: stops clearly, installing nothing', async () => {
      const h = host({ os: UBUNTU, sudo: false })
      const r = await h.go(['--yes'])
      expect(r.code).toBe(1)
      expect(r.out).toContain('installing the missing tools needs root, and sudo is missing: run install.sh as root, or install sudo')
      expect(h.log('sys-calls')).toBe('')
      done(h)
    })

    it.each([
      [{ FAKE_ENGINE: '23.0.1' }, '  - Docker Engine: found 23.0.1, needs 24 or later'],
      [{ FAKE_COMPOSE: '2.20.3' }, '  - Docker Compose: found 2.20.3, needs v2.24 or later'],
    ])('an old docker.io / docker-compose-v2 (%j): explained, never replaced', async (env, line) => {
      const h = host({ os: UBUNTU, have: ['curl', 'minisign', 'docker'], env })
      const r = await h.go(['--yes'])
      expect(r.code).toBe(1)
      expect(r.out).toContain(line)
      expect(r.out).toContain("docker.io and docker-compose-v2 packages can be older than Compose v2.24; install.sh does not replace them")
      expect(r.out).toContain('sudo apt-get remove docker.io docker-compose-v2 docker-compose docker-doc podman-docker')
      expect(h.log('sudo-calls') + h.log('sys-calls')).toBe('')
      done(h)
    })

    it('an old Docker from Docker\'s own repository: offers the upgrade from there', async () => {
      const h = host({ os: UBUNTU, have: ['curl', 'minisign', 'docker'], env: { FAKE_COMPOSE: '2.20.3', FAKE_DOCKER_CE: '0' } })
      const r = await h.go()
      expect(r.code).toBe(1)
      expect(r.out).toContain("Docker's apt repository (https://download.docker.com/linux/ubuntu)")
      expect(r.out).toContain('run it again with --yes')
      done(h)
    })
  })

  it('refuses to install over an existing install', async () => {
    const s = sandbox()
    const target = join(s.dir, 'srv')
    mkdirSync(target)
    writeFileSync(join(target, 'release.env'), 'YODA_VERSION=1.1.0\n')
    const r = await run('sh', [join(work, 'dist/releases', version, 'install.sh'), '--version', version, '--dir', target, '--base-url', base], {
      env: { ...s.env, YODA_RELEASE_PUBKEY: pub },
    })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('already holds an install')
    expect(readFileSync(join(target, 'release.env'), 'utf8')).toBe('YODA_VERSION=1.1.0\n')
    rmSync(s.dir, { recursive: true, force: true })
  })
})

describe.skipIf(!posix)('release assets: bundle.sh, install.sh and release.yml agree on the file names', () => {
  it('bundle.sh writes the files install.sh downloads (plus the signature the release job adds)', () => {
    const out = mkdtempSync(join(tmpdir(), 'yoda-assets-'))
    const r = spawnSync('sh', ['ops/install/bundle.sh', '1.2.0', 'ghcr.io/tantee/yoda', out], { cwd: root, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    const files = readdirSync(join(out, 'releases/1.2.0')).sort()
    expect(files).toEqual(['SHA256SUMS', 'install.sh', 'yoda-1.2.0.tar.gz'])
    expect(readFileSync(join(out, 'releases/1.2.0/SHA256SUMS'), 'utf8')).toMatch(/^[0-9a-f]{64} [ *]?yoda-1\.2\.0\.tar\.gz\n[0-9a-f]{64} [ *]?install\.sh\n$/)
    const bundleEnv = spawnSync('tar', ['-xzOf', join(out, 'releases/1.2.0/yoda-1.2.0.tar.gz'), 'bundle.env'], { encoding: 'utf8' }).stdout
    expect(bundleEnv).toBe('YODA_IMAGE_PREFIX=ghcr.io/tantee/yoda\nYODA_VERSION=1.2.0\n')
    rmSync(out, { recursive: true, force: true })

    // With the digests the release workflow pushed: one pin per image, signed with the bundle.
    const pinned = mkdtempSync(join(tmpdir(), 'yoda-assets-'))
    const p = spawnSync('sh', ['ops/install/bundle.sh', '1.2.0', 'ghcr.io/tantee/yoda', pinned, digestsFile(pinned)], { cwd: root, encoding: 'utf8' })
    expect(p.status, p.stderr).toBe(0)
    const pinnedEnv = spawnSync('tar', ['-xzOf', join(pinned, 'releases/1.2.0/yoda-1.2.0.tar.gz'), 'bundle.env'], { encoding: 'utf8' }).stdout
    expect(pinnedEnv).toBe(`YODA_IMAGE_PREFIX=ghcr.io/tantee/yoda\nYODA_VERSION=1.2.0\n${PINS}`)
    // Every image, once, as sha256:<64 hex>.
    for (const bad of [{ ...DIGESTS, backup: 'sha256:abc' }, { core: DIGESTS.core, portal: DIGESTS.portal, runner: DIGESTS.runner }]) {
      const r = spawnSync('sh', ['ops/install/bundle.sh', '1.2.0', 'ghcr.io/tantee/yoda', pinned, digestsFile(pinned, bad)], { cwd: root, encoding: 'utf8' })
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('has no valid digest for backup')
    }
    writeFileSync(join(pinned, 'twice.txt'), `${readFileSync(digestsFile(pinned), 'utf8')}core ${DIGESTS.core}\n`)
    expect(spawnSync('sh', ['ops/install/bundle.sh', '1.2.0', 'ghcr.io/tantee/yoda', pinned, join(pinned, 'twice.txt')], { cwd: root }).status).toBe(2)
    rmSync(pinned, { recursive: true, force: true })

    const sh = readFileSync(join(root, 'ops/install/install.sh'), 'utf8')
    const fetched = [...sh.matchAll(/^\s*fetch "\$\{base\}([^"]+)"/gm)].map((m) => m[1]!.replace('$bundle', 'yoda-$version.tar.gz'))
    expect(fetched).toEqual(['SHA256SUMS', 'SHA256SUMS.minisig', 'yoda-$version.tar.gz'])
    expect(sh).toContain('bundle="yoda-$version.tar.gz"')
    // The GitHub Release gets exactly those, plus install.sh on its own.
    const wf = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')
    expect(wf).toContain('set -- assets/install.sh "assets/yoda-$VERSION.tar.gz" assets/SHA256SUMS assets/SHA256SUMS.minisig')
  })
})

describe.skipIf(!posix)('ops/install/release-notes.sh', () => {
  const notes = (version: string, changelog: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'yoda-notes-'))
    writeFileSync(join(dir, 'CHANGELOG.md'), changelog)
    const r = spawnSync('sh', [join(root, 'ops/install/release-notes.sh'), version, join(dir, 'CHANGELOG.md')], { encoding: 'utf8' })
    rmSync(dir, { recursive: true, force: true })
    return r
  }
  const log = '# Changelog\n\n## Unreleased\n\n- next\n\n## 1.1.0-rc.1 — 2026-12-01\n\n- candidate\n\n## 1.0.0 — 2026-11-25\n\nFirst.\n\n### Part\n\n- one\n\n'

  it('prints the section of the version, without the heading or surrounding blank lines', () => {
    expect(notes('1.0.0', log)).toMatchObject({ status: 0, stdout: 'First.\n\n### Part\n\n- one\n' })
    expect(notes('1.1.0-rc.1', log)).toMatchObject({ status: 0, stdout: '- candidate\n' })
  })

  it('accepts the heading with any suffix, also "unreleased" (the workflow refuses to publish that one)', () => {
    expect(notes('1.2.0', '## 1.2.0 — unreleased\n\n- soon\n\n## 1.1.0\n\n- x\n')).toMatchObject({ status: 0, stdout: '- soon\n' })
    expect(notes('1.1.0', '## 1.2.0 — unreleased\n\n- soon\n\n## 1.1.0\n\n- x\n')).toMatchObject({ status: 0, stdout: '- x\n' })
  })

  it('fails for a version without a section, or an empty one, so no release goes out without notes', () => {
    expect(notes('1.0.1', log).status).toBe(1)
    expect(notes('1.0.1', log).stderr).toContain('no notes for 1.0.1')
    expect(notes('1.0.0', '## 1.0.0\n\n## 0.9.0\n- x\n').status).toBe(1)
    expect(notes('1.0', log).status).toBe(2)
  })

  it.each([['1.1.0'], ['1.2.0']])('finds the notes of the released %s in the real CHANGELOG.md', (v) => {
    const r = spawnSync('sh', ['ops/install/release-notes.sh', v], { cwd: root, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.length).toBeGreaterThan(200)
  })
})

describe.skipIf(!posix || !gnuTar)('ops/install/bundle.sh reproducibility (GNU tar)', () => {
  it('builds the same bytes twice for the same commit time, owned by 0:0', () => {
    const out = mkdtempSync(join(tmpdir(), 'yoda-repro-'))
    const build = (n: string) => {
      const r = spawnSync('sh', ['ops/install/bundle.sh', '1.2.0', 'registry.example.org/group/yoda', join(out, n)], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, SOURCE_DATE_EPOCH: '1767225600' },
      })
      expect(r.status, r.stderr).toBe(0)
      return readFileSync(join(out, n, 'releases/1.2.0/yoda-1.2.0.tar.gz'))
    }
    const a = build('a')
    expect(build('b').equals(a)).toBe(true)
    const list = spawnSync('tar', ['-tvzf', join(out, 'a/releases/1.2.0/yoda-1.2.0.tar.gz'), '--numeric-owner'], { encoding: 'utf8' }).stdout
    expect(list.split('\n').filter(Boolean).every((l) => / 0\/0 /.test(l) && l.includes('2026-01-01'))).toBe(true)
    rmSync(out, { recursive: true, force: true })
  })
})

describe.skipIf(!posix || (!ci && !has('shellcheck')))('shellcheck', () => {
  it.each([
    'ops/install/install.sh',
    'ops/install/bundle.sh',
    'ops/install/release-notes.sh',
    'ops/install/check-release.sh',
    'ops/deploy/deploy.sh',
    'ops/backup/backup.sh',
    'ops/backup/restore.sh',
    'ops/backup/restore-check.sh',
    'ops/backup/healthcheck.sh',
    'ops/backup/lib.sh',
  ])('%s is clean', (file) => {
    const r = spawnSync('shellcheck', ['-x', file], { cwd: root, encoding: 'utf8' })
    expect(r.stdout + r.stderr).toBe('')
    expect(r.status).toBe(0)
  }, 30_000) // shellcheck -x on install.sh can take >5 s on a busy CI runner
})

describe.skipIf(!posix)('install.sh defaults (GitHub Releases + GHCR, stub curl)', () => {
  // A curl that records the URL and fails: the default base URL is the GitHub Release of the version.
  it('downloads from https://github.com/tantee/yoda/releases/download/v<version>/ by default', async () => {
    const s = sandbox()
    writeFileSync(join(s.dir, 'bin', 'curl'), '#!/bin/sh\nfor a; do last=$a; done\necho "$last" >> "$FAKE/curl-calls"\nexit 22\n')
    writeFileSync(join(s.dir, 'bin', 'minisign'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(s.dir, 'bin', 'curl'), 0o755)
    chmodSync(join(s.dir, 'bin', 'minisign'), 0o755)
    const r = await run('sh', [join(root, 'ops/install/install.sh'), '--version', '1.2.0', '--dir', join(s.dir, 'srv')], {
      env: { ...s.env, YODA_RELEASE_PUBKEY: 'RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3' },
    })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('downloading Yoda 1.2.0 from https://github.com/tantee/yoda/releases/download/v1.2.0/')
    expect(readFileSync(join(s.dir, 'curl-calls'), 'utf8').split('\n')[0]).toBe('https://github.com/tantee/yoda/releases/download/v1.2.0/SHA256SUMS')
    rmSync(s.dir, { recursive: true, force: true })
  })
})

describe.skipIf(!posix)('install.sh defaults: the latest release (stub curl)', () => {
  it('looks up github.com/tantee/yoda/releases/latest, then the GitHub API, and stops when neither names a release', async () => {
    const s = sandbox()
    stub(s.dir, 'curl', 'for a; do last=$a; done\necho "$last" >> "$FAKE/curl-calls"\nexit 22')
    stub(s.dir, 'minisign', 'exit 0')
    const r = await run('sh', [join(root, 'ops/install/install.sh'), '--dir', join(s.dir, 'srv')], { env: s.env })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('finding the latest release (https://github.com/tantee/yoda/releases/latest)')
    expect(r.out).toContain('cannot find the latest release (https://github.com/tantee/yoda/releases/latest, https://api.github.com/repos/tantee/yoda/releases/latest): pass --version')
    expect(readFileSync(join(s.dir, 'curl-calls'), 'utf8')).toBe('https://github.com/tantee/yoda/releases/latest\nhttps://api.github.com/repos/tantee/yoda/releases/latest\n')
    expect(existsSync(join(s.dir, 'srv'))).toBe(false)
    rmSync(s.dir, { recursive: true, force: true })
  })

  it('takes the version from the redirect (curl -sI -w %{redirect_url}) and downloads that release', async () => {
    const s = sandbox()
    stub(s.dir, 'curl', `echo "$*" >> "$FAKE/curl-calls"
case "$*" in
  *' -w %{redirect_url} '*) printf 'https://github.com/tantee/yoda/releases/tag/v1.4.2' ;;
  *) exit 22 ;;
esac`)
    stub(s.dir, 'minisign', 'exit 0')
    const r = await run('sh', ['-c', 'cat "$0" | sh -s -- --dir "$1"', join(root, 'ops/install/install.sh'), join(s.dir, 'srv')], { env: s.env })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('latest release: 1.4.2')
    expect(r.out).toContain('downloading Yoda 1.4.2 from https://github.com/tantee/yoda/releases/download/v1.4.2/')
    const calls = readFileSync(join(s.dir, 'curl-calls'), 'utf8').split('\n')
    expect(calls[0]).toBe('-fsSI --retry 2 -o /dev/null -w %{redirect_url} https://github.com/tantee/yoda/releases/latest')
    expect(calls[1]).toMatch(/ https:\/\/github\.com\/tantee\/yoda\/releases\/download\/v1\.4\.2\/SHA256SUMS$/)
    rmSync(s.dir, { recursive: true, force: true })
  })
})

describe.skipIf(!posix)('install.sh cut short (a truncated download runs nothing)', () => {
  it('does nothing at any cut, piped or as a file: no command, no file, no temp dir; the whole script does', async () => {
    const s = sandbox()
    // Every command install.sh could start with, recording its use; none may run before the last line.
    for (const name of ['curl', 'wget', 'docker', 'sudo', 'apt-get', 'apt-cache', 'dnf', 'minisign', 'tar', 'mkdir', 'mktemp', 'id', 'usermod', 'sg', 'df', 'cp', 'chmod', 'sed', 'grep', 'awk', 'rm', 'dirname', 'cat'])
      stub(s.dir, name, `echo "${name} $*" >> "$FAKE/ran"\nexit 1`)
    mkdirSync(join(s.dir, 'tmp'))
    const script = readFileSync(join(root, 'ops/install/install.sh'))
    const cuts = new Set<number>()
    for (let i = 0; i < script.length; i++) if (script[i] === 0x0a) { cuts.add(i); cuts.add(i + 1) }
    for (let i = 0; i < script.length; i += 101) cuts.add(i)
    // The whole script, with or without its final newline, is not cut short.
    cuts.delete(script.length)
    cuts.delete(script.length - 1)
    writeFileSync(join(s.dir, 'full.sh'), script)
    writeFileSync(join(s.dir, 'cuts'), [...cuts].sort((a, b) => a - b).join('\n') + '\n')
    const driver = `set -u
check() {
  if [ -s "$FAKE/ran" ] || [ -e "$FAKE/srv" ] || [ -n "$(ls -A "$FAKE/tmp")" ]; then
    echo "SIDE EFFECT at $1 ($2): $(/bin/cat "$FAKE/ran" 2>/dev/null)"; exit 1
  fi
}
while read -r n; do
  if [ "$n" -eq 0 ]; then : > "$FAKE/cut.sh"; else head -c "$n" "$FAKE/full.sh" > "$FAKE/cut.sh"; fi
  sh -s -- --version 1.2.0 --dir "$FAKE/srv/yoda" --yes < "$FAKE/cut.sh" > /dev/null 2>&1
  check "$n" piped
  sh "$FAKE/cut.sh" --version 1.2.0 --dir "$FAKE/srv/yoda" --yes > /dev/null 2>&1
  check "$n" file
done < "$FAKE/cuts"
echo "cuts: $(wc -l < "$FAKE/cuts")"
sh -s -- --version 1.2.0 --dir "$FAKE/srv/yoda" --yes < "$FAKE/full.sh" > /dev/null 2>&1
echo "full: $(/bin/cat "$FAKE/ran")"
`
    // The driver's own head, ls, wc and /bin/cat are the real ones.
    const r = await run('/bin/sh', ['-c', driver], { env: { ...s.env, TMPDIR: join(s.dir, 'tmp') } })
    expect(r.out).toMatch(/^cuts: +\d{3,}\n/)
    expect(r.out).not.toContain('SIDE EFFECT')
    // The control: the complete script does run (its first command: grep, checking --version).
    expect(r.out).toMatch(/full: grep -Eq /)
    rmSync(s.dir, { recursive: true, force: true })
  }, 300_000)
})

describe('ops/install/install.sh text', () => {
  const read = (path: string) => readFileSync(join(root, path), 'utf8')
  const sh = read('ops/install/install.sh')

  it('embeds the published release key, keeps the placeholder refusal, and never pipes a download into a shell', () => {
    // keys/yoda-release.pub (key id C73EF0AF404BAE84) is the one source; install.sh embeds its second line.
    const pubFile = readFileSync(join(root, 'keys/yoda-release.pub'), 'utf8')
    expect(pubFile).toBe('untrusted comment: minisign public key C73EF0AF404BAE84\nRWSErktAr/A+x5Gvgr0x29wiu41FmYEVlJYoXyB6oJk4kvwQLOZs9O9j\n')
    const key = pubFile.split('\n')[1]!
    expect(sh).toContain(`RELEASE_PUBKEY_EMBEDDED='${key}'`)
    // A minisign Ed25519 public key whose key id (little-endian bytes 2..10) is the published one.
    const raw = Buffer.from(key, 'base64')
    expect(raw.length).toBe(42)
    expect(raw.subarray(0, 2).toString()).toBe('Ed')
    expect(Buffer.from(raw.subarray(2, 10)).reverse().toString('hex').toUpperCase()).toBe('C73EF0AF404BAE84')
    expect(sh).toContain("*REPLACE-WITH*) die 'this install.sh has no release public key yet (placeholder)")
    expect(sh).toContain("DEFAULT_BASE_URL='https://github.com/tantee/yoda/releases/download/v{version}/'")
    expect(sh).toContain("DEFAULT_IMAGE_PREFIX='ghcr.io/tantee/yoda'")
    expect(sh).toMatch(/^set -eu$/m)
    // The code (not its comments or usage text) never pipes anything into a shell.
    const code = sh.replace(/^usage\(\) \{[\s\S]*?^\}$/m, '').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    // (case patterns such as `sh | -sh | */sh)`, naming the shells that read a piped script, are not pipes)
    expect(code.split('\n').filter((l) => !/^\s*[\w*/ |.-]+\) /.test(l)).join('\n')).not.toMatch(/\|\s*(ba)?sh\b/)
    // sudo only through as_root (after asking) and need_root's check that it exists; never `sudo docker`.
    const unquoted = code.split('\n').map((l) => l.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''"))
    const sudo = unquoted.filter((l) => /\bsudo\b/.test(l) && !/\bhave sudo\b/.test(l))
    expect(sudo.map((l) => l.trim())).toEqual(['if is_root; then ""; else sudo ""; fi'])
    // Every URL host is GitHub, Docker's documentation and package repository, or a placeholder.
    const hosts = [...sh.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*)/gi)].map((m) => m[1]!)
    expect(hosts.filter((h) => !/(^|\.)example\.org$|^127\.0\.0\.1|^jedisct1\.github\.io$|^(api\.)?github\.com$|^(docs|download)\.docker\.com$|^acme-staging-v02\.api\.letsencrypt\.org$/.test(h))).toEqual([])
  })

  it('logs in up front only to a registry that is not ghcr.io; to ghcr.io only when a pull failed (deploy.sh exit 3)', () => {
    expect(sh).toMatch(/case "\$registry" in\n\s+ghcr\.io\) registry='' ;;/)
    // On the terminal also when piped (tty_ok: /dev/tty, never stdin, which is then the script).
    expect(sh).toContain('if [ "$rc" -eq 3 ] && [ "${prefix%%/*}" = ghcr.io ] && [ "$login" = yes ] && tty_ok; then')
    expect(sh).toContain('docker login ghcr.io <"$tty"')
    expect(read('ops/deploy/deploy.sh')).toContain('  exit 3\n')
  })
})
