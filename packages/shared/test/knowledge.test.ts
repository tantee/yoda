import { it, expect } from 'vitest'
import { KnowledgeCreate, KnowledgeUpdate, ProjectPatch, validateTemplate, type WorkflowTemplateDef } from '../src/index.js'

const id = '11111111-1111-4111-8111-111111111111'
const base = { type: 'fact', title: 'x' }

it('project scope requires projectId', () => {
  expect(KnowledgeCreate.safeParse({ ...base, scope: 'project' }).success).toBe(false)
  expect(KnowledgeCreate.safeParse({ ...base, scope: 'project', projectId: id }).success).toBe(true)
})
it('work_item scope requires workItemId', () => {
  expect(KnowledgeCreate.safeParse({ ...base, scope: 'work_item' }).success).toBe(false)
  expect(KnowledgeCreate.safeParse({ ...base, scope: 'work_item', workItemId: id }).success).toBe(true)
})
it('department scope rejects ids', () => {
  expect(KnowledgeCreate.safeParse({ ...base, scope: 'department', projectId: id }).success).toBe(false)
  expect(KnowledgeCreate.safeParse({ ...base, scope: 'department' }).success).toBe(true)
})
it('trims Thai title and applies defaults', () => {
  const r = KnowledgeCreate.parse({ scope: 'department', type: 'fact', title: '  ตารางผลแล็บ ' })
  expect(r.title).toBe('ตารางผลแล็บ')
  expect(r.body).toBe('')
  expect(r.noAi).toBe(false)
})
it('KnowledgeUpdate needs at least one field', () => {
  expect(KnowledgeUpdate.safeParse({}).success).toBe(false)
  expect(KnowledgeUpdate.safeParse({ noAi: true }).success).toBe(true)
})
it('ProjectPatch needs at least one key', () => {
  expect(ProjectPatch.safeParse({}).success).toBe(false)
  expect(ProjectPatch.safeParse({ aiBudgetUsd: null }).success).toBe(true)
  expect(ProjectPatch.safeParse({ aiBudgetUsd: -1 }).success).toBe(false)
})

const t = (th: string) => ({ th, en: th })
const task = (key: string, extra: Record<string, unknown> = {}) => ({
  key, type: 'human', role: 'PM', title: t(key), instructions: t(key), dependsOn: [], ...extra,
})
const tpl = (tasks: unknown[]) =>
  ({ key: 'x', name: t('x'), steps: [{ key: 's', name: t('s'), tasks }] }) as unknown as WorkflowTemplateDef
it('ai task needs a capability; non-ai must not have one', () => {
  expect(validateTemplate(tpl([task('a', { type: 'ai' })])).join(' ')).toContain('capability')
  expect(validateTemplate(tpl([task('a', { type: 'ai', capability: 'draft-text' })]))).toEqual([])
  expect(validateTemplate(tpl([task('a', { capability: 'draft-text' })])).join(' ')).toContain('capability')
})
