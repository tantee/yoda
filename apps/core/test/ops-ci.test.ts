import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

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
    for (const f of ['docker-compose.yml', 'docker-compose.prod.yml', 'ops/deploy/deploy.sh', 'docs/operations.md', '.env.example', 'CHANGELOG.md']) expect(copy).toContain(f)
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
})

type Step = { id?: string; name?: string; uses?: string; if?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> }
type WfJob = {
  if?: string
  needs?: string | string[]
  permissions?: Record<string, string>
  env?: Record<string, string>
  strategy?: { matrix?: { include?: { name: string; file: string; context: string }[] } }
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
    for (const p of ['.github/workflows/release.yml', 'ops/install/**', 'apps/*/Dockerfile', 'ops/backup/**', 'docker-compose.prod.yml', 'CHANGELOG.md']) expect(paths).toContain(p)
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
    expect(run).toContain('for f in package.json apps/core/package.json; do')
    expect(run).toMatch(/\[ "\$pkg" = "\$version" \] \|\|\n\s*\{ echo "::error::\$f says version \$pkg, the tag says \$version[^\n]*exit 1; \}/)
    expect(run).not.toContain('::warning::')
  })

  it('orders the jobs: images by digest, then the bundle pinning them is signed and verified, then tags, then the release', () => {
    expect(Object.keys(jobs).sort()).toEqual(['bundle', 'images', 'images-dry', 'meta', 'release', 'tag'])
    expect(jobs['images-dry']!.needs).toBe('meta')
    expect(jobs['images-dry']!.if).toBe(DRY)
    expect(jobs.images!.needs).toBe('meta')
    expect(jobs.images!.if).toBe(REAL)
    expect(jobs.bundle!.needs).toEqual(['meta', 'images-dry', 'images'])
    expect(jobs.bundle!.if).toBe('${{ !cancelled() && !failure() }}')
    expect(jobs.tag!.needs).toEqual(['meta', 'bundle'])
    expect(jobs.tag!.if).toBe(REAL)
    expect(jobs.release!.needs).toEqual(['meta', 'bundle', 'tag'])
    expect(jobs.release!.if).toBe(REAL)
  })

  it('grants minimal permissions: packages:write only to the real image and tag jobs, never to a dry run', () => {
    expect(wf.permissions).toEqual({})
    expect(jobs.meta!.permissions).toEqual({ contents: 'read' })
    expect(jobs['images-dry']!.permissions).toEqual({ contents: 'read' })
    expect(jobs.bundle!.permissions).toEqual({ contents: 'read' })
    expect(jobs.images!.permissions).toEqual({ contents: 'read', packages: 'write' })
    expect(jobs.tag!.permissions).toEqual({ contents: 'read', packages: 'write' })
    expect(jobs.release!.permissions).toEqual({ contents: 'write' })
  })

  it('runs the signing and publishing jobs in the `release` environment (v* tags only); a dry run in none', () => {
    for (const j of ['images', 'tag', 'release']) expect(jobs[j]!.environment, j).toBe('release')
    expect(jobs.bundle!.environment).toBe("${{ needs.meta.outputs.real == 'true' && 'release' || '' }}")
    for (const j of ['meta', 'images-dry']) expect(jobs[j]!.environment, j).toBeUndefined()
  })

  it('pins every action by full commit SHA, and BuildKit and binfmt by digest', () => {
    const uses = Object.values(jobs).flatMap((j) => j.steps.map((s) => s.uses).filter(Boolean)) as string[]
    expect(uses.length).toBeGreaterThan(6)
    for (const u of uses) expect(u).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/)
    for (const line of text.split('\n').filter((l) => /uses: /.test(l))) expect(line).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/)
    for (const j of ['images-dry', 'images']) {
      const buildx = step(j, (s) => !!s.uses?.startsWith('docker/setup-buildx-action@'))
      expect(String(buildx.with!['driver-opts'])).toMatch(/^image=moby\/buildkit:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/)
    }
    const qemu = step('images', (s) => !!s.uses?.startsWith('docker/setup-qemu-action@'))
    expect(String(qemu.with!.image)).toMatch(/^tonistiigi\/binfmt:qemu-v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/)
  })

  it('keeps secrets out of the file and out of run scripts (they reach scripts as env only)', () => {
    const refs = [...text.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]!)
    expect([...new Set(refs)].sort()).toEqual(['GITHUB_TOKEN', 'MINISIGN_PASSWORD', 'MINISIGN_SECRET_KEY'])
    for (const job of Object.values(jobs)) for (const s of job.steps) expect(s.run ?? '', s.name).not.toMatch(/\$\{\{/)
    expect(text).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|untrusted comment|RW[A-Za-z0-9+/]{50,}/)
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/)
  })

  it('builds the four images for amd64 and arm64: a release pushed by digest, without cache; a dry run never pushed', () => {
    for (const j of ['images-dry', 'images']) {
      // A stuck build (v1.0.0: the arm64 portal under QEMU) fails well before GitHub's 6-hour job limit.
      expect(jobs[j]!['timeout-minutes'], j).toBe(45)
      const qemuStep = step(j, (s) => !!s.uses?.startsWith('docker/setup-qemu-action@'))
      expect(qemuStep.with!.platforms, j).toBe('arm64')
      const matrix = jobs[j]!.strategy!.matrix!.include!
      expect(matrix.map((m) => m.name), j).toEqual(images)
      expect(matrix.find((m) => m.name === 'backup')).toMatchObject({ file: 'ops/backup/Dockerfile', context: 'ops/backup' })
      const build = step(j, (s) => !!s.uses?.startsWith('docker/build-push-action@'))
      expect(build.with!.platforms).toBe('${{ needs.meta.outputs.platforms }}')
      expect(build.with!.push, j).toBeUndefined()
      expect(build.with!.tags, j).toBeUndefined()
      expect(String(build.with!.labels)).toContain('org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}')
      const push = j === 'images' ? 'true' : 'false'
      expect(build.with!.outputs).toBe(`type=image,name=\${{ needs.meta.outputs.prefix }}/\${{ matrix.name }},push-by-digest=true,name-canonical=true,push=${push}`)
      const keep = step(j, (s) => s.name === 'keep the digest')
      expect(keep.env).toEqual({ NAME: '${{ matrix.name }}', DIGEST: '${{ steps.build.outputs.digest }}' })
      expect(keep.run).toContain("grep -Eqx 'sha256:[0-9a-f]{64}'")
      expect(step(j, (s) => !!s.uses?.startsWith('actions/upload-artifact@')).with!.name).toBe('digest-${{ matrix.name }}')
    }
    // A release never reads the cache pull requests write.
    const real = step('images', (s) => !!s.uses?.startsWith('docker/build-push-action@'))
    expect(real.with!['no-cache']).toBe(true)
    expect(real.with!['cache-from']).toBeUndefined()
    expect(real.with!['cache-to']).toBeUndefined()
    expect(step('images-dry', (s) => !!s.uses?.startsWith('docker/build-push-action@')).with!['cache-from']).toBe('type=gha,scope=${{ matrix.name }}')
    // The dry run has no registry login.
    expect(jobs['images-dry']!.steps.some((s) => s.uses?.startsWith('docker/login-action@'))).toBe(false)
    const login = step('images', (s) => !!s.uses?.startsWith('docker/login-action@'))
    expect(login.with).toMatchObject({ registry: 'ghcr.io', password: '${{ secrets.GITHUB_TOKEN }}' })
    expect(wf.env).toEqual({ DOCKER_BUILD_RECORD_UPLOAD: 'false' })
    // A dry run builds arm64 too, so an arm64-only problem shows on the pull request, not on the tag.
    expect(meta().match(/^\s*platforms=.*$/gm)!.map((l) => l.trim())).toEqual(['platforms=linux/amd64,linux/arm64'])
    // The image prefix and tags match what install.sh and release.env use: ghcr.io/<owner>/yoda, version without v.
    expect(meta()).toContain(`echo "prefix=ghcr.io/$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')"`)
    expect(meta()).toContain('echo "tag=v$version"')
    expect(read('ops/install/install.sh')).toContain("DEFAULT_IMAGE_PREFIX='ghcr.io/tantee/yoda'")
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
    // Only a real release keeps the bundle.
    const upload = step('bundle', (s) => !!s.uses?.startsWith('actions/upload-artifact@'))
    expect(upload.if).toBe(REAL)
    const order = jobs.bundle!.steps.map((s) => s.name ?? s.id)
    expect(order.indexOf('check the release key against install.sh')).toBeLessThan(order.indexOf('verify end to end with install.sh'))
    expect(order.indexOf('verify end to end with install.sh')).toBeLessThan(order.indexOf('keep the signed bundle for the release job'))
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
