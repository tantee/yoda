import { RunUsage } from '@yoda/shared'
import type { RunnerConfig } from '../config.js'
import { runProcess } from './process.js'
import { childEnv, readMarker, tail, type Executor, type ExecutorOptions } from './types.js'

type ClaudeResult = {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: string
  total_cost_usd?: number
  usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number }
  modelUsage?: Record<string, { costUSD?: number; outputTokens?: number }>
}

/** `--output-format json` prints one JSON object; take the last line that parses as one. */
function parseResult(stdout: string): ClaudeResult | null {
  const whole = stdout.trim()
  for (const candidate of [whole, ...whole.split('\n').reverse()]) {
    try {
      const v = JSON.parse(candidate) as unknown
      if (v && typeof v === 'object' && (v as ClaudeResult).type === 'result') return v as ClaudeResult
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

function usageOf(r: ClaudeResult): RunUsage | undefined {
  const models = Object.entries(r.modelUsage ?? {})
  // The main model is the one that cost the most (Claude Code also uses a small model for side tasks).
  models.sort(([, a], [, b]) => (b.costUSD ?? 0) - (a.costUSD ?? 0) || (b.outputTokens ?? 0) - (a.outputTokens ?? 0))
  const u = r.usage ?? {}
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  const parsed = RunUsage.safeParse({
    model: (models[0]?.[0] ?? 'claude').slice(0, 100),
    inputTokens: r.usage ? input : undefined,
    outputTokens: u.output_tokens,
    costUsd: typeof r.total_cost_usd === 'number' ? Math.min(r.total_cost_usd, 1000) : undefined,
  })
  return parsed.success ? parsed.data : undefined
}

/**
 * Claude Code, headless: `claude -p --output-format json --mcp-config <file> --strict-mcp-config
 * --permission-mode <mode> ...extraArgs`, cwd = the worktree. The prompt goes on stdin (a context pack can be
 * larger than one command-line argument may be).
 */
export function claudeExecutor(cfg: Pick<RunnerConfig, 'permissionMode' | 'extraArgs'>, opts: ExecutorOptions = {}): Executor {
  return {
    name: 'claude',
    async run(input) {
      const args = [
        '-p',
        '--output-format',
        'json',
        '--mcp-config',
        input.mcpConfigPath,
        '--strict-mcp-config',
        '--permission-mode',
        cfg.permissionMode,
        ...cfg.extraArgs,
      ]
      const p = await runProcess('claude', args, {
        cwd: input.dir,
        env: childEnv(opts.env ?? process.env),
        stdin: input.prompt,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        killGraceMs: opts.killGraceMs,
      })
      if (p.timedOut) return { ok: false, summary: `claude timed out after ${Math.round(input.timeoutMs / 60_000)} min`, needsHuman: false }
      if (p.aborted) return { ok: false, summary: 'claude was stopped', needsHuman: false }
      const r = parseResult(p.stdout)
      if (!r) {
        const why = p.code === 0 ? 'claude printed no JSON result' : `claude exited with ${p.code ?? p.signal}`
        return { ok: false, summary: `${why}: ${tail(p.stderr) || tail(p.stdout)}`, needsHuman: false }
      }
      const { needsHuman, summary } = readMarker(String(r.result ?? ''))
      const usage = usageOf(r)
      const ok = p.code === 0 && !r.is_error && r.subtype === 'success'
      return {
        ok,
        summary: ok ? summary : `claude failed (${r.subtype ?? 'error'}): ${summary || tail(p.stderr)}`,
        needsHuman: ok && needsHuman,
        ...(usage ? { usage } : {}),
      }
    },
  }
}
