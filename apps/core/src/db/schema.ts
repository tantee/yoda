import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  Priority,
  ProjectRole,
  TaskExecutor,
  TaskState,
  TaskType,
  WorkItemState,
  type TaskResult,
} from '@yoda/shared'

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

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

export const workflowTemplates = pgTable(
  'workflow_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    version: integer('version').notNull(),
    definition: jsonb('definition').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('workflow_templates_key_version_unique').on(t.key, t.version)],
)

export const workItems = pgTable(
  'work_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id')
      .notNull()
      .references(() => workflowTemplates.id),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    priority: text('priority').notNull().default('normal'),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => people.id),
    currentStepKey: text('current_step_key'),
    state: text('state').notNull().default('active'),
    createdBy: uuid('created_by').references(() => people.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('work_items_priority_check', sql`${t.priority} in (${list(Priority.options)})`),
    check('work_items_state_check', sql`${t.state} in (${list(WorkItemState.options)})`),
  ],
)

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    stepKey: text('step_key').notNull(),
    templateTaskKey: text('template_task_key').notNull(),
    attempt: integer('attempt').notNull(),
    type: text('type').notNull(),
    role: text('role').notNull(),
    executor: text('executor').notNull(),
    feedback: text('feedback'),
    state: text('state').notNull(),
    assigneeId: uuid('assignee_id').references(() => people.id),
    proposedAssigneeId: uuid('proposed_assignee_id').references(() => people.id),
    result: jsonb('result').$type<TaskResult>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('tasks_type_check', sql`${t.type} in (${list(TaskType.options)})`),
    check('tasks_role_check', sql`${t.role} in (${list(ProjectRole.options)})`),
    check('tasks_executor_check', sql`${t.executor} in (${list(TaskExecutor.options)})`),
    check('tasks_state_check', sql`${t.state} in (${list(TaskState.options)})`),
    unique('tasks_attempt_unique').on(t.workItemId, t.templateTaskKey, t.attempt),
    uniqueIndex('tasks_one_active_attempt')
      .on(t.workItemId, t.templateTaskKey)
      .where(sql`${t.state} in ('proposed', 'open', 'in_progress', 'submitted')`),
    index('tasks_assignee_state_idx').on(t.assigneeId, t.state),
    index('tasks_project_state_idx').on(t.projectId, t.state),
  ],
)

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    workItemId: uuid('work_item_id').references(() => workItems.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    actorId: uuid('actor_id').references(() => people.id),
    reason: text('reason'),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('events_work_item_created_idx').on(t.workItemId, t.createdAt)],
)
