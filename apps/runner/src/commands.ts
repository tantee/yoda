import { loadConfig, maskedConfig, mcpConfig, warnConfigOnce, type RunnerConfig } from './config.js'
import { connectCore, McpToolError, type CoreClient } from './core.js'
import { createExecutor } from './executors/index.js'
import { startLoop, stopOnSignals } from './loop.js'
import { workTask } from './work.js'

export const USAGE = `Usage: yoda-runner <command>

Commands:
  work <taskId>              Claim and work one task now (on demand)
  start                      Poll for available tasks and work them (unattended) until SIGINT / SIGTERM
  mcp-config [--with-token]  Print the Claude Code MCP config for core (the token only with --with-token)
  config show                Print the runner config (the token is masked)
`

export type CommandIo = {
  env: NodeJS.ProcessEnv
  stdout: (s: string) => void
  stderr: (s: string) => void
}

const defaultIo: CommandIo = {
  env: process.env,
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
}

async function withCore<T>(cfg: RunnerConfig, fn: (core: CoreClient) => Promise<T>): Promise<T> {
  const core = await connectCore(cfg)
  try {
    return await fn(core)
  } finally {
    await core.close().catch(() => undefined)
  }
}

/** Runs one CLI command and returns its exit code. */
export async function runCommand(argv: string[], io: CommandIo = defaultIo): Promise<number> {
  const [cmd, ...rest] = argv
  const log = (l: string) => io.stderr(`${l}\n`)

  if (cmd === 'config' && rest[0] === 'show') {
    const cfg = loadConfig(io.env)
    warnConfigOnce(cfg, io.stderr)
    io.stdout(`${JSON.stringify(maskedConfig(cfg), null, 2)}\n`)
    return 0
  }

  if (cmd === 'mcp-config') {
    const cfg = loadConfig(io.env)
    const withToken = rest.includes('--with-token')
    // Claude Code expands ${VAR} in MCP configs, so by default the token stays in the environment.
    io.stdout(`${JSON.stringify(mcpConfig({ coreUrl: cfg.coreUrl, token: withToken ? cfg.token : '${YODA_RUNNER_TOKEN}' }), null, 2)}\n`)
    if (!withToken) log('yoda-runner: set YODA_RUNNER_TOKEN in the environment of Claude Code, or pass --with-token')
    return 0
  }

  if (cmd === 'work' && rest[0]) {
    const taskId = rest[0]
    const cfg = loadConfig(io.env)
    warnConfigOnce(cfg, io.stderr)
    const stop = new AbortController()
    const dispose = stopOnSignals(stop)
    try {
      return await withCore(cfg, async (core) => {
        // The capability comes from the context pack (an owner's own assigned task is not in the available list).
        const result = await workTask({ cfg, core, executor: createExecutor(cfg), log, signal: stop.signal }, { taskId })
        if (result.status === 'submitted') log(`yoda-runner: submitted (${result.outcome})${result.mrUrl ? `, merge request ${result.mrUrl}` : ''}`)
        if (result.status === 'parked') log('yoda-runner: the run is waiting for a person (or was ended in core)')
        if (result.status === 'failed') log(`yoda-runner: failed: ${result.error}`)
        if (result.status === 'environment') log(`yoda-runner: this runner cannot work the task (released, no strike): ${result.error}`)
        if (result.status === 'unavailable') log('yoda-runner: the task is no longer available (cancelled, reassigned or done); released')
        if (result.status === 'stopped') log('yoda-runner: stopped; the task was released')
        return result.status === 'failed' || result.status === 'environment' ? 1 : 0
      })
    } catch (err) {
      if (err instanceof McpToolError) {
        log(`yoda-runner: core refused: ${err.message}`)
        return 1
      }
      throw err
    } finally {
      dispose()
    }
  }

  if (cmd === 'start') {
    const cfg = loadConfig(io.env)
    warnConfigOnce(cfg, io.stderr)
    const stop = new AbortController()
    const dispose = stopOnSignals(stop)
    try {
      log(`yoda-runner: polling ${cfg.coreUrl} every ${cfg.pollSeconds} s (up to ${cfg.maxConcurrent} at once)`)
      return await withCore(cfg, (core) => startLoop({ cfg, core, executor: createExecutor(cfg), log, signal: stop.signal }))
    } finally {
      dispose()
    }
  }

  io.stderr(USAGE)
  return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1
}
