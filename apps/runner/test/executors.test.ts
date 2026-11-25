import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mcpConfigFile, removeMcpConfigFile, RunnerConfig, withMcpConfigFile } from '../src/config.js'
import { claudeExecutor } from '../src/executors/claude.js'
import { codexExecutor } from '../src/executors/codex.js'
import { fakeExecutor } from '../src/executors/fake.js'
import { createExecutor } from '../src/executors/index.js'
import { git, isolateGit, makeOrigin, tempDir, TOKEN } from './helpers.js'

const tmp = tempDir()
const bin = join(tmp.dir, 'bin')
const out = join(tmp.dir, 'out')
let clone: string

const cfg = (over: Record<string, unknown> = {}) =>
  RunnerConfig.parse({ coreUrl: 'http://core.invalid/base/', token: TOKEN, workRoot: join(tmp.dir, 'work'), ...over })

/** Writes an executable stub named `name` into the temp PATH dir. */
function stub(name: string, script: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`)
  chmodSync(join(bin, name), 0o755)
}
const env = () => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_OUT: out, YODA_RUNNER_TOKEN: TOKEN })

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeAll(() => {
  isolateGit(tmp.dir)
  ;({ clone } = makeOrigin(tmp.dir))
  mkdirSync(bin)
  mkdirSync(out)
})
afterAll(() => tmp.remove())

const claudeResult = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Fixed the login button.',
  total_cost_usd: 0.42,
  usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 50 },
  modelUsage: {
    'claude-haiku-x': { inputTokens: 5, outputTokens: 5, costUSD: 0.01 },
    'claude-main-x': { inputTokens: 145, outputTokens: 45, costUSD: 0.41 },
  },
}

describe('mcpConfigFile', () => {
  it('writes the yoda server with a bearer header, mode 0600 in a private dir, and removes it', () => {
    const path = mcpConfigFile(cfg())
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: { yoda: { type: 'http', url: 'http://core.invalid/base/mcp', headers: { Authorization: `Bearer ${TOKEN}` } } },
    })
    removeMcpConfigFile(path)
    expect(existsSync(path)).toBe(false)
    expect(existsSync(dirname(path))).toBe(false)
  })

  it('removes the file even when the run throws', async () => {
    let seen = ''
    await expect(
      withMcpConfigFile(cfg(), async (p) => {
        seen = p
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(seen).not.toBe('')
    expect(existsSync(seen)).toBe(false)
  })
})

describe('claude executor', () => {
  it('passes the MCP config flags, sends the prompt on stdin and parses the JSON result', async () => {
    stub(
      'claude',
      `printf '%s\\n' "$@" > "$STUB_OUT/claude-args"
pwd > "$STUB_OUT/claude-cwd"
cat > "$STUB_OUT/claude-stdin"
printf '%s' "\${YODA_RUNNER_TOKEN:-unset}" > "$STUB_OUT/claude-token-env"
printf '%s\\n' '${JSON.stringify(claudeResult)}'`,
    )
    const ex = claudeExecutor(cfg({ extraArgs: ['--model', 'sonnet'] }), { env: env() })
    const mcp = mcpConfigFile(cfg())
    try {
      const r = await ex.run({ dir: clone, prompt: 'do the thing', mcpConfigPath: mcp, timeoutMs: 10_000 })
      expect(r).toEqual({
        ok: true,
        summary: 'Fixed the login button.',
        needsHuman: false,
        usage: { model: 'claude-main-x', inputTokens: 150, outputTokens: 50, costUsd: 0.42 },
      })
    } finally {
      removeMcpConfigFile(mcp)
    }
    const args = readFileSync(join(out, 'claude-args'), 'utf8').trim().split('\n')
    expect(args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--mcp-config',
      mcp,
      '--strict-mcp-config',
      '--permission-mode',
      'acceptEdits',
      '--model',
      'sonnet',
    ])
    expect(args.join(' ')).not.toContain(TOKEN)
    expect(readFileSync(join(out, 'claude-stdin'), 'utf8')).toBe('do the thing')
    expect(realpathSync(readFileSync(join(out, 'claude-cwd'), 'utf8').trim())).toBe(realpathSync(clone))
    expect(readFileSync(join(out, 'claude-token-env'), 'utf8')).toBe('unset')
  })

  it('reports needsHuman when the agent asked a person', async () => {
    const asked = { ...claudeResult, result: 'ASKED_HUMAN\nWhich colour should the button be?' }
    stub('claude', `cat > /dev/null\nprintf '%s\\n' '${JSON.stringify(asked)}'`)
    const r = await claudeExecutor(cfg(), { env: env() }).run({ dir: clone, prompt: 'p', mcpConfigPath: '/nonexistent', timeoutMs: 10_000 })
    expect(r.ok).toBe(true)
    expect(r.needsHuman).toBe(true)
    expect(r.summary).toBe('Which colour should the button be?')
  })

  it('fails on an error result, a non-zero exit or output that is not JSON', async () => {
    stub('claude', `cat > /dev/null\nprintf '%s\\n' '${JSON.stringify({ ...claudeResult, subtype: 'error_max_turns', is_error: true })}'`)
    const run = () => claudeExecutor(cfg(), { env: env() }).run({ dir: clone, prompt: 'p', mcpConfigPath: '/x', timeoutMs: 10_000 })
    expect((await run()).ok).toBe(false)
    stub('claude', 'cat > /dev/null\necho "something broke" >&2\nexit 3')
    const failed = await run()
    expect(failed.ok).toBe(false)
    expect(failed.summary).toContain('something broke')
    stub('claude', 'cat > /dev/null\necho not json')
    expect((await run()).ok).toBe(false)
  })

  it('kills the whole process tree on timeout', async () => {
    stub(
      'claude',
      `cat > /dev/null
sleep 30 &
echo $! > "$STUB_OUT/child-pid"
echo $$ > "$STUB_OUT/parent-pid"
wait`,
    )
    const started = Date.now()
    const r = await claudeExecutor(cfg(), { env: env(), killGraceMs: 500 }).run({
      dir: clone,
      prompt: 'p',
      mcpConfigPath: '/x',
      timeoutMs: 700,
    })
    expect(r.ok).toBe(false)
    expect(r.summary).toMatch(/timed out/)
    expect(Date.now() - started).toBeLessThan(10_000)
    const child = Number(readFileSync(join(out, 'child-pid'), 'utf8'))
    const parent = Number(readFileSync(join(out, 'parent-pid'), 'utf8'))
    expect(alive(parent)).toBe(false)
    expect(alive(child)).toBe(false)
  })

  it('stops when the signal aborts', async () => {
    stub('claude', 'cat > /dev/null\nsleep 30')
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 200)
    const r = await claudeExecutor(cfg(), { env: env(), killGraceMs: 500 }).run({
      dir: clone,
      prompt: 'p',
      mcpConfigPath: '/x',
      timeoutMs: 60_000,
      signal: ac.signal,
    })
    expect(r.ok).toBe(false)
    expect(r.summary).toMatch(/stopped/)
  })
})

describe('codex executor', () => {
  it('configures the MCP server with -c overrides, keeps the token out of argv and reads the last message', async () => {
    stub(
      'codex',
      `printf '%s\\n' "$@" > "$STUB_OUT/codex-args"
cat > "$STUB_OUT/codex-stdin"
printf '%s' "$YODA_RUNNER_TOKEN" > "$STUB_OUT/codex-token-env"
last=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then last="$a"; fi
  prev="$a"
done
printf 'Did it.' > "$last"
echo '{"type":"thread.started","thread_id":"t"}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":3}}'
echo '{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":0,"output_tokens":2}}'`,
    )
    const r = await codexExecutor(cfg(), { env: env() }).run({ dir: clone, prompt: 'do it', mcpConfigPath: '/unused', timeoutMs: 10_000 })
    expect(r).toEqual({ ok: true, summary: 'Did it.', needsHuman: false, usage: { model: 'codex', inputTokens: 15, outputTokens: 5 } })
    const args = readFileSync(join(out, 'codex-args'), 'utf8').trim().split('\n')
    expect(args[0]).toBe('exec')
    expect(args).toContain('mcp_servers.yoda.url="http://core.invalid/base/mcp"')
    expect(args).toContain('mcp_servers.yoda.bearer_token_env_var="YODA_RUNNER_TOKEN"')
    expect(args.at(-1)).toBe('-')
    expect(args.join(' ')).not.toContain(TOKEN)
    expect(readFileSync(join(out, 'codex-stdin'), 'utf8')).toBe('do it')
    expect(readFileSync(join(out, 'codex-token-env'), 'utf8')).toBe(TOKEN)
  })
})

describe('fake executor', () => {
  it('runs the supplied function', async () => {
    const ex = fakeExecutor(async ({ dir }) => ({ ok: true, summary: `worked in ${dir}`, needsHuman: false }))
    expect(ex.name).toBe('fake')
    expect(await ex.run({ dir: '/w', prompt: 'p', mcpConfigPath: '/x', timeoutMs: 1000 })).toEqual({
      ok: true,
      summary: 'worked in /w',
      needsHuman: false,
    })
  })

  it('by default appends a line to README.md and commits', async () => {
    const before = git(clone, 'rev-parse', 'HEAD')
    const r = await fakeExecutor().run({ dir: clone, prompt: 'p', mcpConfigPath: '/x', timeoutMs: 10_000 })
    expect(r.ok).toBe(true)
    expect(git(clone, 'rev-list', '--count', `${before}..HEAD`)).toBe('1')
    expect(readFileSync(join(clone, 'README.md'), 'utf8')).toMatch(/yoda fake runner/)
  })

  it('createExecutor picks by config', () => {
    expect(createExecutor(cfg({ executor: 'claude' })).name).toBe('claude')
    expect(createExecutor(cfg({ executor: 'codex' })).name).toBe('codex')
    expect(createExecutor(cfg({ executor: 'fake' })).name).toBe('fake')
  })
})
