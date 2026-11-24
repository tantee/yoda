import { it, expect } from 'vitest'
import { ProjectCreate, ProjectRole, MemberRolesPut } from '../src/index.js'

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
