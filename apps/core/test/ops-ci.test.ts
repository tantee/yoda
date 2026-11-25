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
    expect(jobs.sort()).toEqual(['build-backup', 'build-core', 'build-portal', 'build-runner', 'deploy', 'secrets', 'test'])
    expect(ci.stages).toEqual(['secrets', 'test', 'build', 'deploy'])
  })

  it('installs bash and flock for the ops script tests', () => {
    const test = ci.test!
    expect(String(test.image)).toMatch(/alpine/)
    expect(test.before_script?.[0]).toMatch(/^apk add --no-cache (.* )?bash( |$)/)
    expect(test.before_script?.[0]).toMatch(/ util-linux( |$)/)
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

  it('deploys only by hand, only on tags, one deploy at a time', () => {
    const deploy = ci.deploy!
    expect(deploy.stage).toBe('deploy')
    expect(deploy.rules).toEqual([{ if: '$CI_COMMIT_TAG', when: 'manual' }])
    expect(deploy.resource_group).toBe('production')
    expect(deploy.interruptible).toBe(false)
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

  it('pulls, migrates once, starts, then waits for /ready', () => {
    const pull = order(' pull')
    const migrate = order(' run --rm migrate')
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
})

type Service = {
  image?: string
  build?: unknown
  ports?: string[]
  volumes?: string[]
  environment?: Record<string, string>
}
// `!reset` / `!override` are compose merge tags; the yaml parser keeps the value and only warns about them.
const prod = parse(read('docker-compose.prod.yml'), { logLevel: 'error' }) as { services: Record<string, Service> }

describe('docker-compose.prod.yml images', () => {
  const want: Record<string, string> = { migrate: 'core', core: 'core', portal: 'portal', backup: 'backup', runner: 'runner' }

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

  it('mounts only the database volume into postgres (no dev init.sql)', () => {
    expect(text).toMatch(/^ {4}volumes: !override$/m)
    expect(prod.services.postgres!.volumes).toEqual(['pgdata:/var/lib/postgresql/data'])
  })

  it('requires PORTAL_URL', () => {
    expect(prod.services.core!.environment?.PORTAL_URL).toBe('${PORTAL_URL:?PORTAL_URL is required}')
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
