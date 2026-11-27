import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
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
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import {
  AccountType,
  ActorKind,
  AgentRunState,
  AuthorKind,
  ChannelName,
  ConversationKind,
  DiscussionResponseKind,
  DiscussionState,
  IssueSyncStatus,
  KnowledgeScope,
  KnowledgeStatus,
  KnowledgeType,
  MergeRequestState,
  NotificationKind,
  PipelineStatus,
  Priority,
  ProposalKind,
  ProposalState,
  RunnerCapability,
  RunnerKind,
  RunnerMode,
  SourceKind,
  TaskExecutor,
  TaskState,
  TaskType,
  TemplateRole,
  WorkItemState,
  type NotificationPrefs,
  type RunUsage,
  type TaskResult,
  type WorkingHours,
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
    requesterId: uuid('requester_id').references(() => people.id),
    currentStepKey: text('current_step_key'),
    state: text('state').notNull().default('active'),
    /** Optional, set by the PM or owner; an active item is overdue once this Asia/Bangkok date has passed. */
    targetDate: date('target_date', { mode: 'string' }),
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
    /**
     * Set when a PM reopened the work item to this task's step or an earlier one: the attempt is history and
     * no longer counts toward its step (an accepted one must be done again).
     */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    /** Set while a runner's question to people is open; the task is not offered to runners meanwhile. */
    parkedDiscussionId: uuid('parked_discussion_id').references((): AnyPgColumn => discussions.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('tasks_type_check', sql`${t.type} in (${list(TaskType.options)})`),
    check('tasks_role_check', sql`${t.role} in (${list(TemplateRole.options)})`),
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
    // The projects list's last activity: newest event per project.
    index('events_project_created_idx').on(t.projectId, t.createdAt),
    // The daily task cap counts today's automatic assignments (work/assign.ts).
    index('events_auto_assigned_idx')
      .on(t.createdAt)
      .where(sql`${t.type} = 'task.assigned' and ${t.payload}->>'auto' = 'true'`),
    check('events_actor_kind_check', sql`${t.actorKind} in (${list(ActorKind.options)})`),
  ],
)

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => people.id),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    workItemId: uuid('work_item_id').references(() => workItems.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  },
  (t) => [
    check('conversations_kind_check', sql`${t.kind} in (${list(ConversationKind.options)})`),
    check(
      'conversations_scope_ids_check',
      sql`(${t.kind} in ('personal', 'intake'))
        OR (${t.kind} = 'project' AND ${t.projectId} IS NOT NULL AND ${t.workItemId} IS NULL)
        OR (${t.kind} = 'work_item' AND ${t.projectId} IS NOT NULL AND ${t.workItemId} IS NOT NULL)`,
    ),
    uniqueIndex('conversations_one_personal')
      .on(t.ownerId)
      .where(sql`${t.kind} = 'personal'`),
  ],
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    authorKind: text('author_kind').notNull(),
    authorId: uuid('author_id').references(() => people.id),
    text: text('text').notNull(),
    attachmentIds: uuid('attachment_ids').array().notNull().default(sql`'{}'::uuid[]`),
    actions: jsonb('actions').notNull().default(sql`'[]'::jsonb`),
    /** For secretary replies (`ai` / `system`): the person message being answered. */
    replyToId: uuid('reply_to_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    index('messages_conversation_seq_idx').on(t.conversationId, t.seq),
    index('messages_reply_to_idx').on(t.replyToId),
    check('messages_author_kind_check', sql`${t.authorKind} in (${list(AuthorKind.options)})`),
  ],
)

export const conversationReads = pgTable(
  'conversation_reads',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    lastReadSeq: bigint('last_read_seq', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.personId] })],
)

export const proposals = pgTable(
  'proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    workItemId: uuid('work_item_id').references(() => workItems.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    summary: text('summary').notNull().default(''),
    reason: text('reason').notNull().default(''),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    state: text('state').notNull().default('pending'),
    createdByKind: text('created_by_kind').notNull(),
    onBehalfOf: uuid('on_behalf_of').references(() => people.id),
    decidedBy: uuid('decided_by').references(() => people.id),
    decisionNote: text('decision_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    check('proposals_kind_check', sql`${t.kind} in (${list(ProposalKind.options)})`),
    check('proposals_state_check', sql`${t.state} in (${list(ProposalState.options)})`),
    check('proposals_created_by_kind_check', sql`${t.createdByKind} in (${list(ActorKind.options)})`),
    uniqueIndex('proposals_one_pending_step_advance')
      .on(t.workItemId, t.kind)
      .where(sql`${t.state} = 'pending' and ${t.kind} = 'step_advance'`),
  ],
)

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    link: text('link'),
    dedupeKey: text('dedupe_key'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('notifications_kind_check', sql`${t.kind} in (${list(NotificationKind.options)})`),
    uniqueIndex('notifications_dedupe_unique')
      .on(t.personId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
    index('notifications_person_read_idx').on(t.personId, t.readAt, t.createdAt),
  ],
)

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
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
  },
  (t) => [check('attachments_owner_check', sql`${t.projectId} is not null or ${t.conversationId} is not null`)],
)

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

/** Department-wide settings: a single row (id 1), seeded by its migration. */
export const departmentSettings = pgTable(
  'department_settings',
  {
    id: integer('id').primaryKey().default(1),
    /** Monthly budget for project-less AI calls (null = no limit). */
    aiBudgetUsd: numeric('ai_budget_usd', { precision: 12, scale: 2 }),
    /** The optional fun touches in the portal (mark, wise-master microcopy, easter egg); cosmetic only. */
    funMode: boolean('fun_mode').notNull().default(true),
    updatedBy: uuid('updated_by').references(() => people.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('department_settings_single_row', sql`${t.id} = 1`)],
)

export const projectRepos = pgTable(
  'project_repos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    gitlabProjectId: integer('gitlab_project_id').notNull(),
    pathWithNamespace: text('path_with_namespace').notNull(),
    webUrl: text('web_url').notNull(),
    /** Null for an empty GitLab project (no commits yet). */
    defaultBranch: text('default_branch'),
    addedBy: uuid('added_by').references(() => people.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('project_repos_project_gitlab_unique').on(t.projectId, t.gitlabProjectId)],
)

export const workItemRepos = pgTable(
  'work_item_repos',
  {
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => projectRepos.id, { onDelete: 'cascade' }),
    issueIid: integer('issue_iid'),
    issueUrl: text('issue_url'),
    /** Hash of the last section pushed to the issue; a push happens only when it changes. */
    sectionHash: text('section_hash'),
    syncStatus: text('sync_status').notNull().default('pending'),
    syncError: text('sync_error'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.workItemId, t.repoId] }),
    check('work_item_repos_sync_status_check', sql`${t.syncStatus} in (${list(IssueSyncStatus.options)})`),
    // A GitLab issue belongs to at most one work item.
    uniqueIndex('work_item_repos_repo_issue_unique').on(t.repoId, t.issueIid).where(sql`${t.issueIid} is not null`),
  ],
)

export const mergeRequests = pgTable(
  'merge_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => projectRepos.id, { onDelete: 'cascade' }),
    mrIid: integer('mr_iid').notNull(),
    workItemId: uuid('work_item_id').references(() => workItems.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    url: text('url').notNull(),
    state: text('state').notNull(),
    sourceBranch: text('source_branch').notNull(),
    pipeline: text('pipeline').notNull().default('none'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('merge_requests_repo_iid_unique').on(t.repoId, t.mrIid),
    index('merge_requests_work_item_idx').on(t.workItemId),
    check('merge_requests_state_check', sql`${t.state} in (${list(MergeRequestState.options)})`),
    check('merge_requests_pipeline_check', sql`${t.pipeline} in (${list(PipelineStatus.options)})`),
  ],
)

/** De-duplicates webhook deliveries by `X-Gitlab-Event-UUID`. */
export const gitlabDeliveries = pgTable('gitlab_deliveries', {
  eventUuid: text('event_uuid').primaryKey(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
})

/** GitLab settings: a single row (id 1), seeded by its migration. */
export const gitlabSettings = pgTable(
  'gitlab_settings',
  {
    id: integer('id').primaryKey().default(1),
    lastWebhookAt: timestamp('last_webhook_at', { withTimezone: true }),
  },
  (t) => [check('gitlab_settings_single_row', sql`${t.id} = 1`)],
)

export const agendas = pgTable('agendas', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  meetingAt: timestamp('meeting_at', { withTimezone: true }).notNull(),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => people.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const discussions = pgTable(
  'discussions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    workItemId: uuid('work_item_id').references(() => workItems.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    stepKey: text('step_key'),
    question: text('question').notNull(),
    details: text('details').notNull().default(''),
    priority: text('priority').notNull().default('normal'),
    state: text('state').notNull().default('open'),
    brief: jsonb('brief'),
    raisedBy: uuid('raised_by')
      .notNull()
      .references(() => people.id),
    decision: text('decision'),
    decidedOptionKey: text('decided_option_key'),
    decidedBy: uuid('decided_by').references(() => people.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    agendaId: uuid('agenda_id').references(() => agendas.id, { onDelete: 'set null' }),
    agendaPosition: integer('agenda_position'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('discussions_state_check', sql`${t.state} in (${list(DiscussionState.options)})`),
    check('discussions_priority_check', sql`${t.priority} in (${list(Priority.options)})`),
    index('discussions_work_item_state_idx').on(t.workItemId, t.state),
    index('discussions_project_state_idx').on(t.projectId, t.state),
  ],
)

export const discussionResponses = pgTable(
  'discussion_responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    discussionId: uuid('discussion_id')
      .notNull()
      .references(() => discussions.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => people.id),
    kind: text('kind').notNull(),
    optionKey: text('option_key'),
    text: text('text').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('discussion_responses_kind_check', sql`${t.kind} in (${list(DiscussionResponseKind.options)})`),
    uniqueIndex('discussion_responses_one_vote')
      .on(t.discussionId, t.authorId)
      .where(sql`${t.kind} = 'vote'`),
  ],
)

/** A machine that works AI tasks for its owner over MCP. Only the SHA-256 of its token is stored. */
export const runners = pgTable(
  'runners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => people.id),
    accountType: text('account_type').notNull(),
    capabilities: text('capabilities').array().notNull(),
    mode: text('mode').notNull(),
    maxConcurrent: integer('max_concurrent').notNull().default(1),
    workingHours: jsonb('working_hours').$type<WorkingHours>(),
    paused: boolean('paused').notNull().default(false),
    tokenHash: text('token_hash').notNull().unique(),
    tokenPrefix: text('token_prefix').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => people.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('runners_kind_check', sql`${t.kind} in (${list(RunnerKind.options)})`),
    check('runners_account_type_check', sql`${t.accountType} in (${list(AccountType.options)})`),
    check('runners_mode_check', sql`${t.mode} in (${list(RunnerMode.options)})`),
    check(
      'runners_capabilities_check',
      sql`cardinality(${t.capabilities}) > 0 and ${t.capabilities} <@ array[${list(RunnerCapability.options)}]::text[]`,
    ),
    check('runners_max_concurrent_check', sql`${t.maxConcurrent} between 1 and 4`),
    index('runners_owner_idx').on(t.ownerId),
  ],
)

/** Runner settings: a single row (id 1), seeded by its migration. */
export const runnerSettings = pgTable(
  'runner_settings',
  {
    id: integer('id').primaryKey().default(1),
    paused: boolean('paused').notNull().default(false),
    allowPersonalUnattended: boolean('allow_personal_unattended').notNull().default(false),
  },
  (t) => [check('runner_settings_single_row', sql`${t.id} = 1`)],
)

/** One runner's attempt at one task, held by a lease that heartbeats extend. */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    runnerId: uuid('runner_id')
      .notNull()
      .references(() => runners.id),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => people.id),
    state: text('state').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    branch: text('branch'),
    error: text('error'),
    usage: jsonb('usage').$type<RunUsage>(),
  },
  (t) => [
    check('agent_runs_state_check', sql`${t.state} in (${list(AgentRunState.options)})`),
    uniqueIndex('agent_runs_one_running')
      .on(t.taskId)
      .where(sql`${t.state} = 'running'`),
    index('agent_runs_runner_state_idx').on(t.runnerId, t.state),
  ],
)

/** Admin switches for the outside channels (single row). A channel also needs its env credentials to be on. */
export const notificationChannelSettings = pgTable(
  'notification_channel_settings',
  {
    id: integer('id').primaryKey().default(1),
    emailEnabled: boolean('email_enabled').notNull().default(false),
    lineEnabled: boolean('line_enabled').notNull().default(false),
    telegramEnabled: boolean('telegram_enabled').notNull().default(false),
    updatedBy: uuid('updated_by').references(() => people.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('notification_channel_settings_single_row', sql`${t.id} = 1`)],
)

/** A person's channel choice per notification kind; no row (or a missing kind) means the role default. */
export const notificationPrefs = pgTable('notification_prefs', {
  personId: uuid('person_id')
    .primaryKey()
    .references(() => people.id, { onDelete: 'cascade' }),
  kinds: jsonb('kinds').$type<NotificationPrefs['kinds']>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** A person's linked LINE user id / Telegram chat id. One person per external id. */
export const channelLinks = pgTable(
  'channel_links',
  {
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    externalId: text('external_id').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.personId, t.channel] }),
    unique('channel_links_external_unique').on(t.channel, t.externalId),
    check('channel_links_channel_check', sql`${t.channel} in ('line', 'telegram')`),
  ],
)

/** One-time codes (`LINK-XXXXXXXX`) a person sends to the LINE account or Telegram bot to link it. */
export const channelLinkCodes = pgTable(
  'channel_link_codes',
  {
    code: text('code').primaryKey(),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [
    check('channel_link_codes_channel_check', sql`${t.channel} in ('line', 'telegram')`),
    index('channel_link_codes_person_idx').on(t.personId, t.channel),
  ],
)

/**
 * Invalid link-code attempts per chat account, for throttling guesses (rows older than a day are pruned).
 * Kept in the database so the limit holds across restarts and core instances.
 */
export const channelLinkAttempts = pgTable(
  'channel_link_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: text('channel').notNull(),
    externalId: text('external_id').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('channel_link_attempts_channel_check', sql`${t.channel} in ('line', 'telegram')`),
    index('channel_link_attempts_channel_at_idx').on(t.channel, t.at),
    index('channel_link_attempts_external_idx').on(t.channel, t.externalId, t.at),
  ],
)

/**
 * One outcome per notification and channel: a `sent` row makes delivery on that channel idempotent, and a
 * `failed` row with `permanent` set is never retried.
 */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    state: text('state').notNull(),
    errorCode: text('error_code'),
    /** The failure cannot be fixed by retrying (rejected credentials or recipient, blocked bot). */
    permanent: boolean('permanent').notNull().default(false),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.notificationId, t.channel] }),
    check('notification_deliveries_channel_check', sql`${t.channel} in (${list(ChannelName.options)})`),
    check('notification_deliveries_state_check', sql`${t.state} in ('sent', 'failed', 'skipped')`),
  ],
)

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })
const inet = customType<{ data: string }>({ dataType: () => 'inet' })

/**
 * One row per stored setting (installer proposal §10.1); env-only and default values have no row. A row holds a
 * plain `value` or an encrypted secret (AES-256-GCM envelope: a per-secret data key wrapped by the master key
 * `key_id`, the setting key as AAD), never both.
 */
export const settings = pgTable(
  'settings',
  {
    key: text('key').primaryKey(),
    value: jsonb('value'),
    keyId: text('key_id'),
    wrappedDek: bytea('wrapped_dek'),
    dekNonce: bytea('dek_nonce'),
    nonce: bytea('nonce'),
    /** AES-256-GCM output with the tag appended. */
    ciphertext: bytea('ciphertext'),
    /** Secrets: the last 4 characters when the value has 20 or more, else null. */
    hint: text('hint'),
    source: text('source').notNull(),
    /** A staged change (OIDC issuer, 8.6). */
    pending: jsonb('pending'),
    version: integer('version').notNull().default(1),
    updatedBy: uuid('updated_by').references(() => people.id, { onDelete: 'set null' }),
    updatedByLabel: text('updated_by_label'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('settings_value_or_secret', sql`${t.value} is null or ${t.ciphertext} is null`),
    check(
      'settings_secret_complete',
      sql`(${t.ciphertext} is null) = (${t.keyId} is null) and (${t.ciphertext} is null) = (${t.wrappedDek} is null) and (${t.ciphertext} is null) = (${t.dekNonce} is null) and (${t.ciphertext} is null) = (${t.nonce} is null)`,
    ),
    check('settings_source_check', sql`${t.source} in ('ui', 'setup', 'env', 'import', 'cli', 'recovery', 'upgrade')`),
  ],
)

/**
 * Every settings write, test and security event, kept forever (D10). Append-only: a trigger (migration 0022)
 * rejects UPDATE and DELETE, except the `on delete set null` of `actor_person`. Secrets are never stored, only
 * HMAC fingerprints of the old and new value. TRUNCATE fires no row trigger, so it bypasses this (the tests'
 * resetDb relies on that); it needs table ownership, which the app never uses for it. A database owner can
 * always drop the trigger: append-only guards against the application, not against the DBA.
 */
export const settingsAudit = pgTable(
  'settings_audit',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorPerson: uuid('actor_person').references(() => people.id, { onDelete: 'set null' }),
    /** Display name, `break-glass:<user>`, `system` or `cli`. */
    actorLabel: text('actor_label').notNull(),
    source: text('source').notNull(),
    /** `set`, `clear`, `import`, `test`, `apply_pending`, `rollback`, `master_key.rotated`, `recovery.signin`, ... */
    action: text('action').notNull(),
    key: text('key'),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    oldFp: text('old_fp'),
    newFp: text('new_fp'),
    result: text('result'),
    ip: inet('ip'),
    requestId: text('request_id'),
  },
  (t) => [index('settings_audit_key_at').on(t.key, t.at.desc()), index('settings_audit_at').on(t.at.desc())],
)

/**
 * The install's single state row (§10.1 `install_state`): install id, whether setup is done and how, the master key
 * canary, the forced recovery switch, the setup token (its SHA-256 only) and the staged OIDC change (8.6).
 */
export const setupState = pgTable(
  'setup_state',
  {
    id: integer('id').primaryKey().default(1),
    installId: uuid('install_id').notNull().defaultRandom(),
    setupCompletedAt: timestamp('setup_completed_at', { withTimezone: true }),
    setupCompletedBy: uuid('setup_completed_by').references(() => people.id, { onDelete: 'set null' }),
    /** `setup` (the wizard) or `upgrade` (an existing env-based install, §6.5). */
    setupCompletedSource: text('setup_completed_source'),
    setupProgress: jsonb('setup_progress').notNull().default({}),
    /** A known constant encrypted with the master key; a key that cannot decrypt it is the wrong key. */
    keyCanary: bytea('key_canary'),
    keyCanaryKeyId: text('key_canary_key_id'),
    recoveryMode: boolean('recovery_mode').notNull().default(false),
    /** SHA-256 of the current setup token (8.2); null once it is used or setup is done. */
    setupTokenHash: bytea('setup_token_hash'),
    setupTokenExpires: timestamp('setup_token_expires', { withTimezone: true }),
    /** A staged issuer / client id / JWKS URL change from /recovery and its test sign-in (shared `OidcPending`). */
    oidcPending: jsonb('oidc_pending'),
    /** The sign-in values before the last apply, kept 7 days for one-click rollback (shared `OidcRollback`). */
    oidcRollback: jsonb('oidc_rollback'),
  },
  (t) => [
    check('setup_state_single_row', sql`${t.id} = 1`),
    check('setup_state_source_check', sql`${t.setupCompletedSource} is null or ${t.setupCompletedSource} in ('setup', 'upgrade')`),
  ],
)

/**
 * The break-glass admin (§7.2, §10.1 `local_admins`): a local account for /setup and /recovery only, never a
 * portal session. The password is an argon2id PHC string (R1); the TOTP seed is encrypted with the master key
 * (one packed envelope, `totp_key_id` names the key). `totp_last_step` is the last accepted 30 s step, so a code
 * cannot be used twice (R2).
 */
export const localAdmins = pgTable('local_admins', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  totpSecret: bytea('totp_secret'),
  totpKeyId: text('totp_key_id'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  totpLastStep: bigint('totp_last_step', { mode: 'number' }),
  /** Set by `yoda-admin reset-break-glass`: a temporary password, changed before anything else. */
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
})

/** Single-use recovery codes: HMAC-SHA-256 under a key derived from the master key (R2), looked up by hash. */
export const localRecoveryCodes = pgTable(
  'local_recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminId: uuid('admin_id')
      .notNull()
      .references(() => localAdmins.id, { onDelete: 'cascade' }),
    codeHash: bytea('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('local_recovery_codes_hash').on(t.codeHash)],
)

/**
 * Setup and recovery cookie sessions (§8.3): only the SHA-256 of the cookie value is kept, bound to the user
 * agent. `data` holds the session's short-lived state (a TOTP seed being enrolled, encrypted; an OIDC test
 * sign-in's state, nonce and PKCE verifier).
 */
export const localSessions = pgTable(
  'local_sessions',
  {
    idHash: bytea('id_hash').primaryKey(),
    kind: text('kind').notNull(),
    adminId: uuid('admin_id').references(() => localAdmins.id, { onDelete: 'cascade' }),
    uaHash: bytea('ua_hash'),
    ip: inet('ip'),
    data: jsonb('data').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [check('local_sessions_kind_check', sql`${t.kind} in ('setup', 'recovery')`), index('local_sessions_expires').on(t.expiresAt)],
)
