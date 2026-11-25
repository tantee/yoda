import { it, expect } from 'vitest'
import { validateTemplate, WorkItemCreate, TaskResult, type WorkflowTemplateDef } from '../src/index.js'

const t = (th: string) => ({ th, en: th })
const task = (key: string, extra: Record<string, unknown> = {}) => ({
  key, type: 'human', role: 'PM', title: t(key), instructions: t(key), dependsOn: [], ...extra,
})
const tpl = (steps: Array<{ key: string; tasks: unknown[] }>) =>
  ({ key: 'x', name: t('x'), steps: steps.map((s) => ({ ...s, name: t(s.key) })) }) as unknown as WorkflowTemplateDef

it('accepts a minimal valid template', () => {
  expect(validateTemplate(tpl([{ key: 's1', tasks: [task('a'), task('b', { dependsOn: ['a'] })] }]))).toEqual([])
})
it('flags duplicate task keys', () => {
  const p = validateTemplate(tpl([{ key: 's1', tasks: [task('dup')] }, { key: 's2', tasks: [task('dup')] }]))
  expect(p.join(' ')).toContain('dup')
})
it('flags duplicate step keys', () => {
  const p = validateTemplate(tpl([{ key: 's1', tasks: [task('a')] }, { key: 's1', tasks: [task('b')] }]))
  expect(p.join(' ')).toContain('s1')
})
it('flags dependency on a later task', () => {
  const p = validateTemplate(tpl([{ key: 's1', tasks: [task('a', { dependsOn: ['later'] }), task('later')] }]))
  expect(p.join(' ')).toContain('later')
})
it('flags dependency on a task in another step', () => {
  const p = validateTemplate(tpl([{ key: 's1', tasks: [task('other-step')] }, { key: 's2', tasks: [task('b', { dependsOn: ['other-step'] })] }]))
  expect(p.join(' ')).toContain('other-step')
})
it('requires review/approval with no deps to be first in step', () => {
  const bad = validateTemplate(tpl([{ key: 's1', tasks: [task('a'), task('rv', { type: 'review' })] }]))
  expect(bad.join(' ')).toContain('rv')
  expect(validateTemplate(tpl([{ key: 's1', tasks: [task('ap', { type: 'approval' })] }]))).toEqual([])
})
it('parses WorkItemCreate with defaults', () => {
  expect(WorkItemCreate.parse({ title: ' แก้รายงาน ', templateKey: 'bug-fix' })).toEqual({
    title: 'แก้รายงาน', description: '', templateKey: 'bug-fix', priority: 'normal',
  })
})
it('defaults TaskResult text and attachment ids; caps attachments at 20', () => {
  expect(TaskResult.parse({})).toEqual({ text: '', attachmentIds: [] })
  const id = '00000000-0000-4000-8000-000000000000'
  expect(TaskResult.safeParse({ attachmentIds: Array(21).fill(id) }).success).toBe(false)
  expect(TaskResult.safeParse({ attachmentIds: ['x'] }).success).toBe(false)
})
it('allows REQUESTER only on human and approval tasks', () => {
  const ok = tpl([{ key: 's1', tasks: [task('a', { role: 'REQUESTER' }), task('b', { type: 'approval', role: 'REQUESTER', dependsOn: ['a'] })] }])
  expect(validateTemplate(ok)).toEqual([])
  const review = validateTemplate(tpl([{ key: 's1', tasks: [task('rv', { type: 'review', role: 'REQUESTER' })] }]))
  expect(review.join(' ')).toContain('rv')
  const ai = validateTemplate(tpl([{ key: 's1', tasks: [task('ai1', { type: 'ai', role: 'REQUESTER', capability: 'draft-text' })] }]))
  expect(ai.join(' ')).toContain('ai1')
})
