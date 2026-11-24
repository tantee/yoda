import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Config } from '../config.js'
import type { Db } from '../db/client.js'
import { people } from '../db/schema.js'

export type PersonRow = typeof people.$inferSelect

/** The subset of Keycloak access-token claims the portal relies on. */
export const TokenClaims = z.object({
  sub: z.string().min(1),
  preferred_username: z.string().min(1),
  name: z.string().optional(),
  email: z.string().optional(),
  groups: z.array(z.string()).optional(),
})
export type TokenClaims = z.infer<typeof TokenClaims>

/**
 * Insert the person on first sight, otherwise refresh profile fields from the token.
 * A single INSERT ... ON CONFLICT so concurrent first requests yield exactly one row.
 * `is_admin` is only set on insert (bootstrap); it is never touched on update.
 */
export async function upsertPersonFromClaims(
  db: Db,
  claims: TokenClaims,
  config: Config,
): Promise<PersonRow> {
  const username = claims.preferred_username
  const displayName = claims.name?.trim() || username
  const email = claims.email?.trim() || null
  const groupStaff = (claims.groups ?? []).includes(config.staffGroup)
  const [row] = await db
    .insert(people)
    .values({
      keycloakSub: claims.sub,
      username,
      displayName,
      email,
      isAdmin: config.bootstrapAdmins.includes(username),
      lastSeenStaff: groupStaff,
    })
    .onConflictDoUpdate({
      target: people.keycloakSub,
      set: {
        username,
        displayName,
        email,
        lastSeenAt: sql`now()`,
        // Informational only (shown to other staff); authorization recomputes per request.
        lastSeenStaff: sql`coalesce(${people.staffOverride}, ${groupStaff})`,
      },
    })
    .returning()
  if (!row) throw new Error('person upsert returned no row')
  return row
}

/** Staff status from the current token's groups, overridable per person. Never stored. */
export function isStaff(person: PersonRow, claims: TokenClaims, staffGroup: string): boolean {
  return person.staffOverride ?? (claims.groups ?? []).includes(staffGroup)
}
