import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Isolates git from the machine's own config: an empty global config, no system config, and a fixed identity
 * through env. Nothing outside the temp dirs is touched.
 */
export function isolateGit(root: string): void {
  const globalConfig = join(root, 'gitconfig')
  writeFileSync(globalConfig, '')
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Test',
    GIT_AUTHOR_EMAIL: 'runner-test@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Test',
    GIT_COMMITTER_EMAIL: 'runner-test@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
  })
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function tempDir(prefix = 'yoda-runner-test-'): { dir: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A bare `origin.git` with one commit on `main`, and a working clone of it at `clone`. */
export function makeOrigin(root: string): { origin: string; clone: string } {
  const origin = join(root, 'origin.git')
  const seed = join(root, 'seed')
  const clone = join(root, 'clone')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', seed])
  writeFileSync(join(seed, 'README.md'), '# Demo\n')
  git(seed, 'add', 'README.md')
  git(seed, 'commit', '-q', '-m', 'init')
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', '-q', 'origin', 'main')
  execFileSync('git', ['clone', '-q', origin, clone])
  return { origin, clone }
}

export const TOKEN = 'yoda_rt_TESTONLYnotarealtoken0000000000000000000' // DEV ONLY: test placeholder
