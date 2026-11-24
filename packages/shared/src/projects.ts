import { z } from 'zod'

export const ProjectRole = z.enum(['PM', 'BA', 'SA', 'DEV', 'QC'])
export type ProjectRole = z.infer<typeof ProjectRole>

export const Project = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  status: z.enum(['active', 'archived']),
  noAi: z.boolean(),
  autonomy: z.enum(['propose', 'auto-assign']),
  createdAt: z.string(),
})
export type Project = z.infer<typeof Project>

export const ProjectCreate = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(''),
})
export type ProjectCreate = z.infer<typeof ProjectCreate>

export const ProjectMember = z.object({
  personId: z.string().uuid(),
  displayName: z.string(),
  roles: z.array(ProjectRole).min(1),
})
export type ProjectMember = z.infer<typeof ProjectMember>

export const ProjectDetail = Project.extend({ members: z.array(ProjectMember) })
export type ProjectDetail = z.infer<typeof ProjectDetail>

export const MemberRolesPut = z.object({ roles: z.array(ProjectRole).min(1) })
export type MemberRolesPut = z.infer<typeof MemberRolesPut>

export const ProjectPatch = z.object({ autonomy: z.enum(['propose', 'auto-assign']) })
export type ProjectPatch = z.infer<typeof ProjectPatch>
