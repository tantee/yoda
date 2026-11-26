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
    expect(script).toMatch(/CI_COMMIT_TAG/)
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

  describe('release-bundle (installer proposal §3.4, D1)', () => {
    const job = ci['release-bundle'] as Job & { artifacts?: { paths?: string[] } }
    const script = lines(job)

    it('runs on tags only, building the bundle with ops/install/bundle.sh for the tag and the registry path', () => {
      expect(job.stage).toBe('release')
      expect(job.rules).toEqual([{ if: '$CI_COMMIT_TAG' }])
      expect(script).toMatch(/case "\$CI_COMMIT_TAG" in/)
      expect(script).toContain('sh ops/install/bundle.sh "$CI_COMMIT_TAG" "$CI_REGISTRY_IMAGE" dist')
      expect(job.artifacts?.paths).toEqual(['dist/releases/'])
    })

    it('signs SHA256SUMS with the protected file key, naming the release, and checks it against install.sh\'s key', () => {
      expect(script).toContain('test -s "$YODA_RELEASE_SIGNING_KEY"')
      expect(script).toContain('minisign -S -s "$YODA_RELEASE_SIGNING_KEY" -m "dist/releases/$CI_COMMIT_TAG/SHA256SUMS" -t "yoda release $CI_COMMIT_TAG"')
      expect(script).toContain('RELEASE_PUBKEY_EMBEDDED')
      expect(script).toMatch(/minisign -V -P "\$pub"/)
      // The trusted comment install.sh expects.
      expect(read('ops/install/install.sh')).toContain('Trusted comment: yoda release $version')
    })

    it('uploads with the token on stdin only, and skips the upload while no URL is set', () => {
      expect(script).toContain('if [ -z "${YODA_RELEASE_UPLOAD_URL:-}" ]')
      expect(script).toMatch(/printf 'header = "Authorization: Bearer %s"\\n' "\$YODA_RELEASE_UPLOAD_TOKEN" \|\s*curl [^\n]*-K -/)
      expect(script).not.toMatch(/curl [^\n|]*\$YODA_RELEASE_UPLOAD_TOKEN/)
    })
  })

  it('checks the host key and keeps the SSH key private', () => {
    const script = lines(ci.deploy!)
    expect(script).toContain('chmod 600 "$DEPLOY_SSH_KEY"')
    expect(script).toContain('$DEPLOY_KNOWN_HOSTS')
    expect(script).toContain('StrictHostKeyChecking=yes')
    expect(script).not.toMatch(/StrictHostKeyChecking=(no|accept-new)/)
    expect(script).not.toMatch(/ssh-keyscan/)
    for (const v of ['$DEPLOY_HOST', '$DEPLOY_USER', '$DEPLOY_PATH', '$CI_COMMIT_TAG']) expect(script).toContain(v)
    expect(script).toContain('ops/deploy/deploy.sh')
  })

  it('copies the compose files and the deploy script, not the dev init.sql', () => {
    const copy = (ci.deploy!.script ?? []).find((l) => /\btar -cf\b/.test(l)) ?? ''
    for (const f of ['docker-compose.yml', 'docker-compose.prod.yml', 'ops/deploy/deploy.sh']) expect(copy).toContain(f)
    expect(copy).not.toContain('init.sql')
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
    expect(s.image).toBe(`\${YODA_IMAGE_PREFIX:-yoda}/${name}:\${YODA_VERSION:?YODA_VERSION is required (see release.env)}`)
    expect(s.build).toBeTruthy()
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

  it('requires nothing but YODA_VERSION (installer proposal §13.3)', () => {
    const text = read('docker-compose.prod.yml')
    const required = [...text.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)].map((m) => m[1])
    expect(new Set(required)).toEqual(new Set(['YODA_VERSION']))
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

  it('builds every image and pushes none', () => {
    const runs = gh.jobs.build!.steps.map((s) => s.run ?? '').join('\n')
    for (const name of images) expect(runs).toMatch(new RegExp(`docker build( .*)? -t yoda/${name}( |$)`, 'm'))
    expect(runs).not.toMatch(/docker (push|login)/)
  })
})
