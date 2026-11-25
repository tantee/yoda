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
  aiBudgetUsd: z.number().nullable(),
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
  /**
   * `GET /projects/:id` only: the member's outstanding staff tasks across all projects (assigned open or in
   * progress, plus proposed to them), for the assign picker. Absent in other responses.
   */
  openTasks: z.number().int().optional(),
})
export type ProjectMember = z.infer<typeof ProjectMember>

export const ProjectDetail = Project.extend({ members: z.array(ProjectMember) })
export type ProjectDetail = z.infer<typeof ProjectDetail>

export const MemberRolesPut = z.object({ roles: z.array(ProjectRole).min(1) })
export type MemberRolesPut = z.infer<typeof MemberRolesPut>

/** An AI budget in USD: fits numeric(12,2) exactly (whole cents, at most 9 999 999 999.99). */
export const AiBudgetUsd = z.number().min(0).max(9_999_999_999.99).multipleOf(0.01)

export const ProjectPatch = z
  .object({
    autonomy: z.enum(['propose', 'auto-assign']),
    noAi: z.boolean(),
    aiBudgetUsd: AiBudgetUsd.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' })
export type ProjectPatch = z.infer<typeof ProjectPatch>
