import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../src/prompt.js'
import { TOKEN } from './helpers.js'

const RUN_ID = '00000000-0000-4000-8000-000000000001'
const pack = {
  text: '# Task\n\n**Fix the login button**\n',
  code: {
    branch: 'yoda/abcd1234-fix-login',
    repos: [
      {
        repoId: '00000000-0000-4000-8000-0000000000aa',
        path: 'group/demo',
        webUrl: 'https://gitlab.example.invalid/group/demo',
        defaultBranch: 'main',
        issueIid: 3,
        issueUrl: null,
      },
    ],
  },
}

describe('buildPrompt', () => {
  const prompt = buildPrompt(pack, RUN_ID)

  it('contains the run id, the branch and the pack text', () => {
    expect(prompt).toContain(RUN_ID)
    expect(prompt).toContain('yoda/abcd1234-fix-login')
    expect(prompt).toContain(pack.text)
  })

  it('gives the fixed instructions', () => {
    expect(prompt).toMatch(/only in the current directory/i)
    expect(prompt).toMatch(/commit/i)
    expect(prompt).toMatch(/never push/i)
    expect(prompt).toContain('post_progress')
    expect(prompt).toContain('ask_human')
    expect(prompt).toMatch(/summary/i)
  })

  it('never contains the token', () => {
    expect(prompt).not.toContain(TOKEN)
    expect(prompt).not.toContain('yoda_rt_')
  })
})
