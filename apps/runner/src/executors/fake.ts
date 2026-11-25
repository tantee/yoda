import { execFile } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Executor, ExecutorInput, ExecutorResult } from './types.js'

export type FakeRun = (input: ExecutorInput) => Promise<ExecutorResult> | ExecutorResult

const git = (cwd: string, args: string[]) =>
  new Promise<void>((resolve, reject) => execFile('git', args, { cwd }, (err) => (err ? reject(err) : resolve())))

/** Dev only (`executor: 'fake'`): appends a line to README.md and commits it, for checking the flow in a browser. */
export const devFakeRun: FakeRun = async ({ dir }) => {
  await appendFile(join(dir, 'README.md'), `\n- yoda fake runner change at ${new Date().toISOString()}\n`)
  await git(dir, ['add', 'README.md'])
  await git(dir, ['commit', '--quiet', '-m', 'chore: yoda fake runner change'])
  return { ok: true, summary: 'Appended a line to README.md (fake executor).', needsHuman: false }
}

/** Runs `run` instead of an agent (tests supply it). A run that outlives the timeout is reported as failed. */
export function fakeExecutor(run: FakeRun = devFakeRun): Executor {
  return {
    name: 'fake',
    async run(input) {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<ExecutorResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, summary: 'fake executor timed out', needsHuman: false }), input.timeoutMs)
      })
      try {
        return await Promise.race([Promise.resolve(run(input)), timeout])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
