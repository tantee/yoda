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

/**
 * What the portal needs before anyone signs in (`GET /public-config`, no auth; installer proposal §5.6): where to
 * sign in (derived from the one OIDC issuer setting; null until sign-in is configured), the organisation lines,
 * links, fun mode and whether setup is still required. Never anything secret.
 */
export const PublicConfig = z.object({
  oidc: z.object({ url: z.string(), realm: z.string(), clientId: z.string() }).nullable(),
  org: z.object({
    name: z.string().nullable(),
    nameEn: z.string().nullable(),
    line: z.string().nullable(),
    defaultLocale: z.enum(['th', 'en']),
  }),
  runnerDocsUrl: z.string().nullable(),
  line: z.object({ addFriendUrl: z.string().nullable() }),
  funMode: z.boolean(),
  setup: z.enum(['required', 'done']),
  /** The master key is wrong or missing while secrets are stored (the /recovery route, Task 7). */
  recovery: z.boolean(),
  version: z.string(),
})
export type PublicConfig = z.infer<typeof PublicConfig>
