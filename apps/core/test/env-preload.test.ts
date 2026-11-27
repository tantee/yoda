import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The prod compose passes OPENAI_BASE_URL empty; @ai-sdk/openai throws at import on an empty base URL, so core
// crashed before it listened (found on the first container run).
const core = fileURLToPath(new URL('../', import.meta.url))

describe('env-preload', () => {
  it('drops empty AI base URLs and keeps set ones', async () => {
    const saved = { o: process.env.OPENAI_BASE_URL, a: process.env.ANTHROPIC_BASE_URL }
    process.env.OPENAI_BASE_URL = ''
    process.env.ANTHROPIC_BASE_URL = 'https://llm.example.org/v1'
    try {
      await import('../src/env-preload.js')
      expect('OPENAI_BASE_URL' in process.env).toBe(false)
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://llm.example.org/v1')
    } finally {
      for (const [k, v] of [['OPENAI_BASE_URL', saved.o], ['ANTHROPIC_BASE_URL', saved.a]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('every bundled entry imports it first, so the built CLI starts with an empty OPENAI_BASE_URL', () => {
    execFileSync(process.execPath, ['build.mjs'], { cwd: core, stdio: 'pipe' })
    for (const entry of ['server', 'yoda-admin', 'init', 'migrate']) {
      expect(readFileSync(`${core}dist/${entry}.js`, 'utf8').split('\n')[0], entry).toBe('import "./env-preload.js";')
    }
    const run = spawnSync(process.execPath, ['dist/yoda-admin.js'], { cwd: core, env: { ...process.env, OPENAI_BASE_URL: '', ANTHROPIC_BASE_URL: '' }, encoding: 'utf8' })
    expect(run.stderr + run.stdout).toContain('usage: yoda-admin')
    expect(run.stderr).not.toContain('baseURL')
  }, 60_000)
})
