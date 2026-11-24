import { sql } from 'drizzle-orm'
import { boolean, check, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const people = pgTable('people', {
  id: uuid('id').primaryKey().defaultRandom(),
  keycloakSub: text('keycloak_sub').notNull().unique(),
  username: text('username').notNull(),
  displayName: text('display_name').notNull(),
  email: text('email'),
  isAdmin: boolean('is_admin').notNull().default(false),
  staffOverride: boolean('staff_override'),
  lastSeenStaff: boolean('last_seen_staff').notNull().default(false),
  skills: text('skills').array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
})

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    status: text('status').notNull().default('active'),
    noAi: boolean('no_ai').notNull().default(false),
    autonomy: text('autonomy').notNull().default('propose'),
    createdBy: uuid('created_by').references(() => people.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('projects_status_check', sql`${t.status} in ('active', 'archived')`),
    check('projects_autonomy_check', sql`${t.autonomy} in ('propose', 'auto-assign')`),
  ],
)

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id),
    roles: text('roles').array().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.personId] }),
    check(
      'project_members_roles_check',
      sql`cardinality(${t.roles}) > 0 AND ${t.roles} <@ ARRAY['PM','BA','SA','DEV','QC']::text[]`,
    ),
  ],
)
