import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WorkflowTemplateDef, validateTemplate, executorFor } from '@yoda/shared'

const load = (name: string) =>
  WorkflowTemplateDef.parse(
    JSON.parse(readFileSync(fileURLToPath(new URL(`../src/workflow/templates/${name}.json`, import.meta.url)), 'utf8')),
  )

for (const name of ['software-change', 'bug-fix']) {
  it(`${name} is valid`, () => {
    const def = load(name)
    expect(def.key).toBe(name)
    expect(validateTemplate(def)).toEqual([])
  })
  it(`${name}: approval/review tasks are human-executed`, () => {
    for (const task of load(name).steps.flatMap((s) => s.tasks)) {
      if (task.type === 'approval' || task.type === 'review') {
        expect(executorFor(task.type)).toBe('human')
      }
    }
  })
}
it('software-change step keys', () => {
  expect(load('software-change').steps.map((s) => s.key)).toEqual(['intake', 'ba', 'sa', 'dev', 'qc', 'close'])
})
