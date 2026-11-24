import { z } from 'zod'
import { AiUsage } from './knowledge.js'

/** Department-wide AI budget: project-less AI calls are billed to it (null = no limit). */
export const DepartmentAiSettings = z.object({
  aiBudgetUsd: z.number().nullable(),
  usage: AiUsage,
})
export type DepartmentAiSettings = z.infer<typeof DepartmentAiSettings>

export const DepartmentAiSettingsPatch = z.object({
  aiBudgetUsd: z.number().min(0).max(9_999_999_999).nullable(),
})
export type DepartmentAiSettingsPatch = z.infer<typeof DepartmentAiSettingsPatch>
