import type { RunnerConfig } from '../config.js'
import { claudeExecutor } from './claude.js'
import { codexExecutor } from './codex.js'
import { fakeExecutor, type FakeRun } from './fake.js'
import type { Executor, ExecutorOptions } from './types.js'

export * from './types.js'
export { claudeExecutor, codexExecutor, fakeExecutor, type FakeRun }

/** The executor named in the config. `fake` runs `opts.fake` when given (tests), else the dev README change. */
export function createExecutor(cfg: RunnerConfig, opts: ExecutorOptions & { fake?: FakeRun } = {}): Executor {
  switch (cfg.executor) {
    case 'claude':
      return claudeExecutor(cfg, opts)
    case 'codex':
      return codexExecutor(cfg, opts)
    case 'fake':
      return fakeExecutor(opts.fake)
  }
}
