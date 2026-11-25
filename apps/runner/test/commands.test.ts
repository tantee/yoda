import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCommand } from '../src/commands.js'
import { tempDir, TOKEN } from './helpers.js'

let tmp: ReturnType<typeof tempDir>
let out: string
let err: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  tmp = tempDir()
  const path = join(tmp.dir, 'config.json')
  writeFileSync(path, JSON.stringify({ coreUrl: 'https://core.example.invalid', token: TOKEN }))
  env = { YODA_RUNNER_CONFIG: path }
  out = ''
  err = ''
})
afterEach(() => tmp.remove())

const io = () => ({ env, stdout: (s: string) => void (out += s), stderr: (s: string) => void (err += s) })

describe('runCommand', () => {
  it('mcp-config prints the Claude Code MCP config with an env placeholder instead of the token', async () => {
    expect(await runCommand(['mcp-config'], io())).toBe(0)
    expect(JSON.parse(out)).toEqual({
      mcpServers: { yoda: { type: 'http', url: 'https://core.example.invalid/mcp', headers: { Authorization: 'Bearer ${YODA_RUNNER_TOKEN}' } } },
    })
    expect(out + err).not.toContain(TOKEN)
  })

  it('mcp-config --with-token prints the token from the config', async () => {
    expect(await runCommand(['mcp-config', '--with-token'], io())).toBe(0)
    expect(JSON.parse(out).mcpServers.yoda.headers.Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('config show masks the token', async () => {
    expect(await runCommand(['config', 'show'], io())).toBe(0)
    expect(JSON.parse(out).token).toBe('yoda_rt_…')
    expect(out).not.toContain(TOKEN)
  })

  it('start refuses the experimental codex executor unless allowExperimentalCodex is set', async () => {
    const path = join(tmp.dir, 'codex.json')
    writeFileSync(path, JSON.stringify({ coreUrl: 'https://core.example.invalid', token: TOKEN, executor: 'codex' }))
    env = { YODA_RUNNER_CONFIG: path }
    expect(await runCommand(['start'], io())).toBe(1)
    expect(err).toContain('allowExperimentalCodex')
  })

  it('prints usage for an unknown command or a missing task id', async () => {
    expect(await runCommand(['bogus'], io())).toBe(1)
    expect(err).toContain('work <taskId>')
    expect(await runCommand(['work'], io())).toBe(1)
    expect(await runCommand(['help'], io())).toBe(0)
  })
})
