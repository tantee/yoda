import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'
import {
  ActorKind,
  KnowledgeScope,
  KnowledgeStatus,
  KnowledgeType,
  Priority,
  ProjectRole,
  SourceKind,
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
    aiBudgetUsd: numeric('ai_budget_usd', { precision: 12, scale: 2 }),
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
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    workItemId: uuid('work_item_id').references(() => workItems.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    actorId: uuid('actor_id').references(() => people.id),
    actorKind: text('actor_kind').notNull().default('person'),
    reason: text('reason'),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    index('events_work_item_seq_idx').on(t.workItemId, t.seq),
    check('events_actor_kind_check', sql`${t.actorKind} in (${list(ActorKind.options)})`),
  ],
)

export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  workItemId: uuid('work_item_id').references(() => workItems.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  storageKey: text('storage_key').notNull().unique(),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  noAi: boolean('no_ai').notNull().default(false),
  extractedText: text('extracted_text'),
  uploadedBy: uuid('uploaded_by')
    .notNull()
    .references(() => people.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const knowledgeEntries = pgTable(
  'knowledge_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lineageId: uuid('lineage_id').notNull(),
    version: integer('version').notNull(),
    scope: text('scope').notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    workItemId: uuid('work_item_id').references(() => workItems.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    status: text('status').notNull(),
    sourceKind: text('source_kind').notNull(),
    sourceRef: text('source_ref'),
    noAi: boolean('no_ai').notNull().default(false),
    attachmentId: uuid('attachment_id').references(() => attachments.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => people.id),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('knowledge_entries_scope_check', sql`${t.scope} in (${list(KnowledgeScope.options)})`),
    check('knowledge_entries_type_check', sql`${t.type} in (${list(KnowledgeType.options)})`),
    check('knowledge_entries_status_check', sql`${t.status} in (${list(KnowledgeStatus.options)})`),
    check('knowledge_entries_source_kind_check', sql`${t.sourceKind} in (${list(SourceKind.options)})`),
    check(
      'knowledge_entries_scope_ids_check',
      sql`(${t.scope} = 'department' AND ${t.projectId} IS NULL AND ${t.workItemId} IS NULL)
        OR (${t.scope} = 'project' AND ${t.projectId} IS NOT NULL AND ${t.workItemId} IS NULL)
        OR (${t.scope} = 'work_item' AND ${t.projectId} IS NOT NULL AND ${t.workItemId} IS NOT NULL)`,
    ),
    unique('knowledge_entries_lineage_version_unique').on(t.lineageId, t.version),
    uniqueIndex('knowledge_entries_one_live_version')
      .on(t.lineageId)
      .where(sql`${t.supersededAt} is null`),
    index('knowledge_entries_title_trgm_idx').using('gin', t.title.op('gin_trgm_ops')),
    index('knowledge_entries_body_trgm_idx').using('gin', t.body.op('gin_trgm_ops')),
  ],
)

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => knowledgeEntries.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: 1024 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('knowledge_chunks_entry_idx_unique').on(t.entryId, t.idx),
    index('knowledge_chunks_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('knowledge_chunks_text_trgm_idx').using('gin', t.text.op('gin_trgm_ops')),
  ],
)

export const aiCalls = pgTable(
  'ai_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    job: text('job').notNull(),
    provider: text('provider'),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    ok: boolean('ok').notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_calls_project_created_idx').on(t.projectId, t.createdAt)],
)
