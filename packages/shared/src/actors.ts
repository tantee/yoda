import { z } from 'zod'

export const ActorKind = z.enum(['person', 'system', 'ai'])
export type ActorKind = z.infer<typeof ActorKind>
