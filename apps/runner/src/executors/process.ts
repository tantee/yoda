import { spawn } from 'node:child_process'

export type ProcessResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  /** The command could not be started (e.g. `ENOENT`: not installed or not on PATH); null when it ran. */
  spawnError: string | null
}

const MAX_OUTPUT = 16 * 1024 * 1024

function killGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig)
  } catch {
    // Already gone.
  }
}

/**
 * Runs `cmd` in its own process group (detached), writing `stdin` to it. On timeout or abort the whole group
 * gets SIGTERM, then SIGKILL after `killGraceMs`. When the main process exits, leftover processes in its group
 * are terminated too. POSIX only.
 */
export function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number; signal?: AbortSignal; killGraceMs?: number },
): Promise<ProcessResult> {
  const grace = opts.killGraceMs ?? 5000
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let killTimer: NodeJS.Timeout | undefined
    let settled = false
    let spawnError: string | null = null

    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const pid = child.pid

    const terminate = () => {
      if (!pid) return
      killGroup(pid, 'SIGTERM')
      killTimer ??= setTimeout(() => killGroup(pid, 'SIGKILL'), grace)
      killTimer.unref()
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, opts.timeoutMs)
    const onAbort = () => {
      aborted = true
      terminate()
    }
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code, signal, stdout, stderr, timedOut, aborted, spawnError })
    }

    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += d
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr = (stderr + d).slice(-64 * 1024)
    })
    child.stdin.on('error', () => undefined) // the child may exit without reading
    child.stdin.end(opts.stdin)
    child.on('error', (err: NodeJS.ErrnoException) => {
      stderr += String(err.message)
      if (!pid) spawnError = err.code ?? 'spawn_failed'
      finish(null, null)
    })
    // The leader exiting does not end its group: stop whatever it left running, so 'close' can follow.
    child.on('exit', () => {
      if (pid) killGroup(pid, 'SIGTERM')
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}
