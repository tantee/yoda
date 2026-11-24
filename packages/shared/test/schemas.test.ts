import { it, expect } from 'vitest'
import { ProjectCreate, ProjectPatch, ProjectRole, MemberRolesPut } from '../src/index.js'

it('trims project name and defaults description', () => {
  expect(ProjectCreate.parse({ name: '  ระบบรายงานแล็บ ' })).toEqual({ name: 'ระบบรายงานแล็บ', description: '' })
})
it('rejects empty project name', () => {
  expect(ProjectCreate.safeParse({ name: '   ' }).success).toBe(false)
})
it('rejects unknown role and empty role list', () => {
  expect(ProjectRole.safeParse('CEO').success).toBe(false)
  expect(MemberRolesPut.safeParse({ roles: [] }).success).toBe(false)
})
it('caps aiBudgetUsd at what numeric(12,2) can hold', () => {
  expect(ProjectPatch.safeParse({ aiBudgetUsd: 9_999_999_999 }).success).toBe(true)
  expect(ProjectPatch.safeParse({ aiBudgetUsd: 10_000_000_000 }).success).toBe(false)
  expect(ProjectPatch.safeParse({ aiBudgetUsd: -1 }).success).toBe(false)
})
