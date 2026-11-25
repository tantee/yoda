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

  it('refuses an unsafe version string', () => {
    expect(sh).toContain('YODA_VERSION')
    expect(sh).toMatch(/case "\$YODA_VERSION" in/)
  })
})

describe('docker-compose.prod.yml images', () => {
  const compose = parse(read('docker-compose.prod.yml')) as { services: Record<string, { image?: string; build?: unknown }> }
  const want: Record<string, string> = { migrate: 'core', core: 'core', portal: 'portal', backup: 'backup', runner: 'runner' }

  it.each(Object.entries(want))('%s uses the published %s image and still builds locally', (service, name) => {
    const s = compose.services[service]!
    expect(s.image).toBe(`\${YODA_IMAGE_PREFIX:-yoda}/${name}:\${YODA_VERSION:-latest}`)
    expect(s.build).toBeTruthy()
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
