import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig, maskedConfig } from '../src/config.js'
import { tempDir, TOKEN } from './helpers.js'

const tmp = tempDir()
afterAll(() => tmp.remove())

function file(content: unknown): string {
  const p = join(tmp.dir, `config-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content))
  return p
}

describe('loadConfig', () => {
  it('reads YODA_RUNNER_CONFIG, applies defaults and env overrides', () => {
    const path = file({ coreUrl: 'http://a.invalid', token: TOKEN, workRoot: '/w', repos: { 'g/r': { clonePath: '/c' } } })
    const cfg = loadConfig({ YODA_RUNNER_CONFIG: path, YODA_CORE_URL: 'http://b.invalid' })
    expect(cfg).toMatchObject({
      coreUrl: 'http://b.invalid',
      token: TOKEN,
      executor: 'claude',
      workRoot: '/w',
      pollSeconds: 30,
      maxTurnsMinutes: 60,
      permissionMode: 'acceptEdits',
      extraArgs: [],
    })
    const other = 'yoda_rt_OTHERtestonly' // DEV ONLY: test placeholder
    expect(loadConfig({ YODA_RUNNER_CONFIG: path, YODA_RUNNER_TOKEN: other }).token).toBe(other)
  })

  it('works from env alone when the file does not exist', () => {
    const cfg = loadConfig({ YODA_RUNNER_CONFIG: join(tmp.dir, 'missing.json'), YODA_CORE_URL: 'http://a.invalid', YODA_RUNNER_TOKEN: TOKEN })
    expect(cfg.coreUrl).toBe('http://a.invalid')
  })

  it('rejects a repo with both or neither clonePath and cloneUrl', () => {
    const base = { coreUrl: 'http://a.invalid', token: TOKEN }
    expect(() => loadConfig({ YODA_RUNNER_CONFIG: file({ ...base, repos: { 'g/r': {} } }) })).toThrow(/repos/)
    expect(() => loadConfig({ YODA_RUNNER_CONFIG: file({ ...base, repos: { 'g/r': { clonePath: '/a', cloneUrl: '/b' } } }) })).toThrow(/repos/)
  })

  it('never echoes the token in errors', () => {
    const bad = `{"coreUrl": "nope", "token": "${TOKEN}", "executor": "x"`
    expect(() => loadConfig({ YODA_RUNNER_CONFIG: file(bad) })).toThrow()
    try {
      loadConfig({ YODA_RUNNER_CONFIG: file(bad) })
    } catch (e) {
      expect(String(e)).not.toContain(TOKEN)
    }
    try {
      loadConfig({ YODA_RUNNER_CONFIG: file({ coreUrl: 'nope', token: TOKEN, executor: 'x' }) })
    } catch (e) {
      expect(String(e)).not.toContain(TOKEN)
      expect(String(e)).toMatch(/coreUrl/)
    }
  })

  it('masks the token to its prefix', () => {
    const cfg = loadConfig({ YODA_RUNNER_CONFIG: join(tmp.dir, 'missing.json'), YODA_CORE_URL: 'http://a.invalid', YODA_RUNNER_TOKEN: TOKEN })
    const shown = JSON.stringify(maskedConfig(cfg))
    expect(shown).not.toContain(TOKEN)
    expect(maskedConfig(cfg).token).toBe('yoda_rt_…')
  })
})
