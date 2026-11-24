import { z } from 'zod'

export const Me = z.object({
  id: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  isStaff: z.boolean(),
  isAdmin: z.boolean(),
})
export type Me = z.infer<typeof Me>

export const Person = Me.extend({
  skills: z.array(z.string()),
  staffOverride: z.boolean().nullable(),
})
export type Person = z.infer<typeof Person>

export const PersonPatch = z.object({
  skills: z.array(z.string().min(1)).optional(),
  staffOverride: z.boolean().nullable().optional(),
  isAdmin: z.boolean().optional(),
})
export type PersonPatch = z.infer<typeof PersonPatch>
