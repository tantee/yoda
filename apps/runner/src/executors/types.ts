import type { RunUsage } from '@yoda/shared'

export type ExecutorInput = {
  /** The worktree the agent works in (its cwd). */
  dir: string
  prompt: string
  /** Claude Code MCP config file (see `mcpConfigFile`); executors that configure MCP otherwise ignore it. */
  mcpConfigPath: string
  /** Hard timeout: the whole process tree is killed and the result is `ok: false`. */
  timeoutMs: number
  signal?: AbortSignal
}

export type ExecutorResult = {
  ok: boolean
  summary: string
  /** The agent asked a person (`ask_human`) and stopped: no push, no submit. */
  needsHuman: boolean
  usage?: RunUsage
}

export type Executor = { name: string; run(input: ExecutorInput): Promise<ExecutorResult> }

export type ExecutorOptions = {
  /** The child's environment (default `process.env`); runner secrets are removed from it. */
  env?: NodeJS.ProcessEnv
  /** Time between SIGTERM and SIGKILL when the tree is killed (default 5 s). */
  killGraceMs?: number
}

/** The agent's final message starts with this line when it called `ask_human` (see prompt.ts). */
export const ASKED_HUMAN_MARKER = 'ASKED_HUMAN'

/** Splits the marker off a final message. */
export function readMarker(message: string): { needsHuman: boolean; summary: string } {
  const text = message.trim()
  if (text === ASKED_HUMAN_MARKER || text.startsWith(`${ASKED_HUMAN_MARKER}\n`) || text.startsWith(`${ASKED_HUMAN_MARKER} `)) {
    return { needsHuman: true, summary: text.slice(ASKED_HUMAN_MARKER.length).trim() }
  }
  return { needsHuman: false, summary: text }
}

/** The child env without the runner's own secrets (the agent gets MCP access only through its config). */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env }
  delete out.YODA_RUNNER_TOKEN
  delete out.YODA_RUNNER_CONFIG
  return out
}

/** The tail of a process's stderr for an error summary. */
export const tail = (s: string, n = 500) => (s.length > n ? `…${s.slice(-n)}` : s).trim()
