import { execFile, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
case "$1" in
  version) [ -z "\${FAKE_NO_DAEMON:-}" ] || exit 1; echo "\${FAKE_ENGINE:-27.5.1}" ;;
  login) ;;
  image) [ -z "\${FAKE_NO_IMAGE:-}" ] || exit 1 ;;
  compose)
    shift
    case " $* " in
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
  const env: Record<string, string> = { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: dir, FAKE: dir }
  const calls = () => (existsSync(join(dir, 'docker-calls')) ? readFileSync(join(dir, 'docker-calls'), 'utf8') : '')
  return { dir, env, calls }
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
    expect(readFileSync(join(work, 'release.env'), 'utf8')).toBe(`YODA_VERSION=1.2.0\nYODA_IMAGE_PREFIX=registry.example.org/group/yoda\n${NO_PINS}`)
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
    expect(readFileSync(join(s.dir, 'release.env'), 'utf8')).toBe(`YODA_VERSION=1.2.0\nYODA_IMAGE_PREFIX=registry.example.org/group/yoda\n${NO_PINS}`)
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
    expect(readFileSync(join(s.dir, 'release.env'), 'utf8')).toBe(`YODA_VERSION=1.2.0\nYODA_IMAGE_PREFIX=ghcr.io/tantee/yoda\n${NO_PINS}`)
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
    expect(readFileSync(join(s.dir, 'release.env'), 'utf8')).toBe(`YODA_VERSION=1.2.0\nYODA_IMAGE_PREFIX=registry.example.org/group/yoda\n${PINS}`)
    rmSync(s.dir, { recursive: true, force: true })
  })

  it('runs the tags when bundle.env is another release, or names another prefix', async () => {
    for (const [version, prefix, note] of [
      ['1.1.0', 'registry.example.org/group/yoda', ''],
      ['1.2.0', 'ghcr.io/tantee/yoda', 'bundle.env pins the digests of ghcr.io/tantee/yoda, not registry.example.org/group/yoda'],
    ] as const) {
      const s = sandbox()
      bundleEnv(s.dir, version, prefix)
      const r = await run('sh', [deploy], { cwd: s.dir, env: { ...s.env, ...PREFIX, YODA_VERSION: '1.2.0', FAKE_SETUP: 'done' } })
      expect(r.code, r.out).toBe(0)
      if (note) expect(r.out).toContain(note)
      expect(readFileSync(join(s.dir, 'release.env'), 'utf8')).toBe(`YODA_VERSION=1.2.0\nYODA_IMAGE_PREFIX=registry.example.org/group/yoda\n${NO_PINS}`)
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
    expect(readFileSync(join(s.dir, 'release.env'), 'utf8')).toBe(`YODA_VERSION=1.2.0\n${NO_PINS}`)
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
      const prefix = `/yoda/releases/${version}/`
      const name = req.url?.startsWith(prefix) ? req.url.slice(prefix.length) : ''
      const body = served[name]
      if (!body) return void res.writeHead(404).end()
      res.writeHead(200).end(body)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    // The internal-mirror layout: "{version}" in --base-url becomes the version.
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/yoda/releases/{version}/`
  })

  afterAll(async () => {
    await new Promise((r) => server?.close(r))
    rmSync(work, { recursive: true, force: true })
  })

  const install = async (args: string[] = [], env: Record<string, string> = {}, key: string | null = pub) => {
    const s = sandbox()
    const target = join(s.dir, 'srv', 'yoda')
    const r = await run('sh', [join(work, 'dist/releases', version, 'install.sh'), '--dir', target, '--base-url', base, ...args], {
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
    expect(readFileSync(join(r.target, 'release.env'), 'utf8')).toBe(`YODA_VERSION=${version}\nYODA_IMAGE_PREFIX=registry.example.org/group/yoda\n${NO_PINS}`)
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
    expect(readFileSync(join(r.target, 'release.env'), 'utf8')).toBe(`YODA_VERSION=${version}\nYODA_IMAGE_PREFIX=ghcr.io/tantee/yoda\n${NO_PINS}`)
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

  it.each([[[]], [['--version', 'latest']], [['--version', '1.2']]])('refuses an unpinned version %j', async (args) => {
    await refuses(await install(args), /pinned release/)
  })

  it.each([
    [{ FAKE_COMPOSE: '2.20.3' }, /Compose v2\.24 or later is required \(found 2\.20\.3\)/],
    [{ FAKE_COMPOSE: 'v1.29.2' }, /Compose v2\.24 or later is required/],
    [{ FAKE_ENGINE: '23.0.1' }, /Docker Engine 24 or later is required/],
    [{ FAKE_NO_DAEMON: '1' }, /cannot talk to the Docker daemon/],
  ])('refuses a host without the prerequisites (%j)', async (env, message) => {
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
    expect(readFileSync(join(r.target, 'release.env'), 'utf8')).toBe(`YODA_VERSION=${version}\nYODA_IMAGE_PREFIX=registry.example.org/mirror/yoda\n${NO_PINS}`)
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
    const fetched = [...sh.matchAll(/^fetch "\$\{base\}([^"]+)"/gm)].map((m) => m[1]!.replace('$bundle', 'yoda-$version.tar.gz'))
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

  it('finds the notes of the released 1.0.0 in the real CHANGELOG.md', () => {
    const r = spawnSync('sh', ['ops/install/release-notes.sh', '1.0.0'], { cwd: root, encoding: 'utf8' })
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
    expect(sh).not.toMatch(/\|\s*(ba)?sh\b/)
    expect(sh).not.toMatch(/\bsudo\b(?! inside)/)
    // Every URL host is GitHub or a placeholder.
    const hosts = [...sh.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*)/gi)].map((m) => m[1]!)
    expect(hosts.filter((h) => !/(^|\.)example\.org$|^127\.0\.0\.1|^jedisct1\.github\.io$|^github\.com$/.test(h))).toEqual([])
  })

  it('logs in up front only to a registry that is not ghcr.io; to ghcr.io only when a pull failed (deploy.sh exit 3)', () => {
    expect(sh).toMatch(/case "\$registry" in\n\s+ghcr\.io\) registry='' ;;/)
    expect(sh).toContain('if [ "$rc" -eq 3 ] && [ "${prefix%%/*}" = ghcr.io ] && [ "$login" = yes ] && [ -t 0 ]; then')
    expect(read('ops/deploy/deploy.sh')).toContain('  exit 3\n')
  })
})
