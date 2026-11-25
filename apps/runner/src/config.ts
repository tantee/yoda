import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'

const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)
const localPath = z.string().min(1).transform((p) => resolve(expandHome(p)))

/** A repo the runner can work: an existing local clone, or (server runners) a URL cloned once into workRoot. */
export const RepoSource = z.union([
  z.object({ clonePath: localPath }).strict(),
  z.object({ cloneUrl: z.string().min(1) }).strict(),
])
export type RepoSource = z.infer<typeof RepoSource>

/** Claude Code's `--permission-mode` choices (checked against `claude --help`, 2.1.x). */
export const PermissionMode = z.enum(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'])

export const RunnerConfig = z.object({
  coreUrl: z.string().url(),
  token: z.string().startsWith('yoda_rt_', { message: 'must be a runner token (yoda_rt_…)' }),
  executor: z.enum(['claude', 'codex', 'fake']).default('claude'),
  /** Worktrees go to `<workRoot>/<runId>/<repo-slug>`; cloneUrl repos to `<workRoot>/clones/<path>`. */
  workRoot: localPath.default(join(homedir(), '.local', 'share', 'yoda-runner')),
  /** Keyed by GitLab path with namespace (`group/repo`). */
  repos: z.record(z.string(), RepoSource).default({}),
  pollSeconds: z.number().int().min(5).max(3600).default(30),
  /** Hard timeout per task, in minutes. */
  maxTurnsMinutes: z.number().int().min(1).max(24 * 60).default(60),
  permissionMode: PermissionMode.default('acceptEdits'),
  /** Appended to the executor's command line (e.g. `["--model", "sonnet"]`). */
  extraArgs: z.array(z.string()).default([]),
})
export type RunnerConfig = z.infer<typeof RunnerConfig>

export const defaultConfigPath = () => join(homedir(), '.config', 'yoda-runner', 'config.json')

/** Config errors name the field and the problem only: never a value (the token could be one). */
export class ConfigError extends Error {
  override name = 'ConfigError'
}

/**
 * Loads the config from `YODA_RUNNER_CONFIG` or `~/.config/yoda-runner/config.json`; `YODA_CORE_URL` and
 * `YODA_RUNNER_TOKEN` override the file. A missing file is fine when env supplies the rest.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const path = env.YODA_RUNNER_CONFIG || defaultConfigPath()
  let raw: Record<string, unknown> = {}
  let text: string | undefined
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigError(`cannot read config file ${path}`)
  }
  if (text !== undefined) {
    try {
      raw = JSON.parse(text) as Record<string, unknown>
    } catch {
      // JSON.parse's message quotes the text around the error, which may be the token.
      throw new ConfigError(`config file ${path} is not valid JSON`)
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`config file ${path} must hold a JSON object`)
  }
  if (env.YODA_CORE_URL) raw = { ...raw, coreUrl: env.YODA_CORE_URL }
  if (env.YODA_RUNNER_TOKEN) raw = { ...raw, token: env.YODA_RUNNER_TOKEN }
  const parsed = RunnerConfig.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new ConfigError(`invalid runner config (${path}): ${issues}`)
  }
  return parsed.data
}

/** The token reduced to its prefix, for display. */
export const maskToken = (token: string) => (token.startsWith('yoda_rt_') ? 'yoda_rt_…' : '…')

/** The config as `config show` prints it. */
export const maskedConfig = (cfg: RunnerConfig) => ({ ...cfg, token: maskToken(cfg.token) })

/** Core's MCP endpoint: `<coreUrl>/mcp`, keeping any path prefix of coreUrl. */
export const mcpUrl = (cfg: Pick<RunnerConfig, 'coreUrl'>) => `${cfg.coreUrl.replace(/\/+$/, '')}/mcp`

/** The Claude Code MCP config for core's server. Holds the token: write it only to a private file. */
export const mcpConfig = (cfg: Pick<RunnerConfig, 'coreUrl' | 'token'>) => ({
  mcpServers: { yoda: { type: 'http', url: mcpUrl(cfg), headers: { Authorization: `Bearer ${cfg.token}` } } },
})

/**
 * Writes the MCP config to `<private temp dir>/mcp.json` (dir 0700, file 0600) and returns its path. Remove it
 * with `removeMcpConfigFile` (or use `withMcpConfigFile`) as soon as the run ends.
 */
export function mcpConfigFile(cfg: Pick<RunnerConfig, 'coreUrl' | 'token'>): string {
  const dir = mkdtempSync(join(tmpdir(), 'yoda-runner-mcp-'))
  chmodSync(dir, 0o700)
  const path = join(dir, 'mcp.json')
  try {
    writeFileSync(path, JSON.stringify(mcpConfig(cfg)), { mode: 0o600, flag: 'wx' })
    chmodSync(path, 0o600)
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
  return path
}

/** Deletes a file made by `mcpConfigFile`, with its private dir. */
export function removeMcpConfigFile(path: string): void {
  rmSync(path, { force: true })
  const dir = dirname(path)
  if (basename(dir).startsWith('yoda-runner-mcp-')) rmSync(dir, { recursive: true, force: true })
}

/** Runs `fn` with a fresh MCP config file that is deleted afterwards, even when `fn` throws. */
export async function withMcpConfigFile<T>(cfg: Pick<RunnerConfig, 'coreUrl' | 'token'>, fn: (path: string) => Promise<T>): Promise<T> {
  const path = mcpConfigFile(cfg)
  try {
    return await fn(path)
  } finally {
    removeMcpConfigFile(path)
  }
}
