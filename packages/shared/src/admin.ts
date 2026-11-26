import { z } from 'zod'
import { AiUsage } from './knowledge.js'
import { AiBudgetUsd } from './projects.js'

/**
 * Department-wide settings on the admin AI page: the AI budget (project-less AI calls are billed to it, null = no
 * limit) and the cosmetic fun-mode switch (docs/design/jedi-touch.md).
 */
export const DepartmentAiSettings = z.object({
  aiBudgetUsd: z.number().nullable(),
  funMode: z.boolean(),
  usage: AiUsage,
})
export type DepartmentAiSettings = z.infer<typeof DepartmentAiSettings>

/** Change either setting; at least one must be given. */
export const DepartmentAiSettingsPatch = z
  .object({
    aiBudgetUsd: AiBudgetUsd.nullable().optional(),
    funMode: z.boolean().optional(),
  })
  .refine((p) => p.aiBudgetUsd !== undefined || p.funMode !== undefined, { message: 'empty_patch' })
export type DepartmentAiSettingsPatch = z.infer<typeof DepartmentAiSettingsPatch>

/** Read-only look-and-feel settings for every signed-in user's portal shell (`GET /ui-config`). */
export const UiConfig = z.object({ funMode: z.boolean() })
export type UiConfig = z.infer<typeof UiConfig>
