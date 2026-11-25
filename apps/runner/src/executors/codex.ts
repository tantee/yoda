import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunUsage } from '@yoda/shared'
import { agentYodaTools, mcpUrl, type RunnerConfig } from '../config.js'
import { runProcess } from './process.js'
import { childEnv, notStarted, readMarker, tail, type Executor, type ExecutorOptions } from './types.js'

/** The env var codex reads the bearer token from (`bearer_token_env_var`), so it never appears in argv. */
const TOKEN_ENV = 'YODA_RUNNER_TOKEN'

/** A TOML basic string (JSON string escapes are valid TOML for these values). */
const toml = (s: string) => JSON.stringify(s)

/** The worktree's shared git dir: commits write there, outside the sandbox's cwd. */
function gitCommonDir(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir }, (err, stdout) =>
      resolve(err ? null : String(stdout).trim() || null),
    )
  })
}

function modelFromArgs(args: string[]): string {
  const i = args.findIndex((a) => a === '-m' || a === '--model')
  if (i >= 0 && args[i + 1]) return args[i + 1].slice(0, 100)
  const eq = args.find((a) => a.startsWith('--model='))
  return eq ? eq.slice('--model='.length).slice(0, 100) : 'codex'
}

/** Sums `turn.completed` usage from `codex exec --json` events; notes a failed turn or error event. */
function readEvents(stdout: string): { inputTokens: number; outputTokens: number; turns: number; failed: string | null } {
  let inputTokens = 0
  let outputTokens = 0
  let turns = 0
  let failed: string | null = null
  for (const line of stdout.split('\n')) {
    let e: { type?: string; usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string }; message?: string }
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type === 'turn.completed') {
      turns++
      inputTokens += e.usage?.input_tokens ?? 0
      outputTokens += e.usage?.output_tokens ?? 0
    } else if (e.type === 'turn.failed' || e.type === 'error') {
      failed = e.error?.message ?? e.message ?? e.type
    }
  }
  return { inputTokens, outputTokens, turns, failed }
}

/**
 * OpenAI Codex CLI, headless (best effort, untested against a real codex): `codex exec --json --cd <dir>
 * --sandbox workspace-write --output-last-message <file> -c mcp_servers.yoda.url=… -c
 * mcp_servers.yoda.bearer_token_env_var=YODA_RUNNER_TOKEN -c mcp_servers.yoda.enabled_tools=[…] ...extraArgs -`, prompt on stdin. Needs a codex
 * that supports streamable HTTP MCP servers with `bearer_token_env_var`.
 */
export function codexExecutor(cfg: Pick<RunnerConfig, 'coreUrl' | 'token' | 'extraArgs' | 'disallowedTools'>, opts: ExecutorOptions = {}): Executor {
  return {
    name: 'codex',
    async run(input) {
      const tmp = await mkdtemp(join(tmpdir(), 'yoda-runner-codex-'))
      const lastMessage = join(tmp, 'last-message.txt')
      try {
        const common = await gitCommonDir(input.dir)
        const args = [
          'exec',
          '--json',
          '--cd',
          input.dir,
          '--sandbox',
          'workspace-write',
          '--output-last-message',
          lastMessage,
          '-c',
          `mcp_servers.yoda.url=${toml(mcpUrl(cfg))}`,
          '-c',
          `mcp_servers.yoda.bearer_token_env_var=${toml(TOKEN_ENV)}`,
          // Same as Claude's defaults: the agent gets context, search, knowledge, progress and ask_human; the
          // runner calls the lifecycle tools itself (key from the Codex config reference: an allow list).
          '-c',
          `mcp_servers.yoda.enabled_tools=[${agentYodaTools(cfg).map(toml).join(', ')}]`,
          ...(common ? ['-c', `sandbox_workspace_write.writable_roots=[${toml(common)}]`] : []),
          ...cfg.extraArgs,
          '-',
        ]
        const p = await runProcess('codex', args, {
          cwd: input.dir,
          env: { ...childEnv(opts.env ?? process.env), [TOKEN_ENV]: cfg.token },
          stdin: input.prompt,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
          killGraceMs: opts.killGraceMs,
        })
        if (p.spawnError) return notStarted('codex', p.spawnError)
        if (p.timedOut) return { ok: false, summary: `codex timed out after ${Math.round(input.timeoutMs / 60_000)} min`, needsHuman: false }
        if (p.aborted) return { ok: false, summary: 'codex was stopped', needsHuman: false }
        const events = readEvents(p.stdout)
        const last = await readFile(lastMessage, 'utf8').catch(() => '')
        const { needsHuman, summary } = readMarker(last)
        const usage = RunUsage.safeParse({
          model: modelFromArgs(cfg.extraArgs),
          inputTokens: events.inputTokens,
          outputTokens: events.outputTokens,
        })
        const ok = p.code === 0 && !events.failed && summary.length > 0
        return {
          ok,
          summary: ok ? summary : `codex failed (${events.failed ?? `exit ${p.code ?? p.signal}`}): ${summary || tail(p.stderr)}`,
          needsHuman: ok && needsHuman,
          ...(events.turns && usage.success ? { usage: usage.data } : {}),
        }
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
    },
  }
}
