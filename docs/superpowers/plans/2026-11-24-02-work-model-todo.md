# Work Model & To-do (Plan 2 of 8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Work items move through workflow steps (seeded "Software change" and "Bug fix" templates), the system creates and assigns tasks per step, people work their tasks from a real To-do screen, PMs confirm proposed assignments, and everything is recorded in an append-only event log pushed live to the portal.

**Architecture:** New core module `apps/core/src/work/` holds the workflow engine (task creation, assignment, step progression, review "request changes" loops) running inside one DB transaction per action; events are written to an `events` table and published after commit on an in-process `LiveBus`, which an authenticated SSE endpoint streams to the portal. Templates are JSON files in core, validated by a shared zod schema and seeded into `workflow_templates` at startup with versioning. Portal gets a working To-do list/detail, work items on the project page, and a work item detail page with steps, tasks and timeline.

**Tech Stack:** as plan 1 (Fastify 5, Drizzle + postgres.js, zod 3, Vitest, Nuxt 4 SPA + Vuetify 3 + @nuxtjs/i18n). No new runtime dependencies.

**Not in this plan (later plans):** attachments and knowledge links on tasks (plan 3), AI execution of `ai` tasks (plans 3/7 — until then PMs assign them to people), "ask a question" from a task and discussions (plans 4/5), due dates and overdue sweeps (plan 4), template-defined structured result fields (later, when a template needs one).

**Spec:** `docs/superpowers/specs/2026-11-24-ai-work-portal-design.md` (§7 domain model, §8 workflow engine, §9 autonomy levels, §13 To-do screen). Plan 1 follow-ups: `docs/superpowers/plans/2026-11-24-01-foundation-followups.md`.

## Global Constraints

- Workflow templates are data: stored in DB, seeded from config files in the repo; v1 ships "Software change" and "Bug fix"; no template editor UI. Work items keep the template version they started with.
- Autonomy (per project): `propose` (default) — assignments appear as a one-click "confirm" item in the PM's to-do list; `auto-assign` — assignments happen directly.
- Always human, at every autonomy level: approval of requirements, design, merges, releases. Template validation rejects `approval` tasks with anything but a human executor (approval/review tasks are never `ai`).
- Assignment hard rule: an assignee must be a project member holding the task's role (or be explicitly assigned by a PM/admin, who may pick any project member).
- Every state change writes an `events` row (append-only; never updated or deleted) with actor (person or system) and optional reason.
- Requesters (non-staff) get 403 on every work item, task, template and stream route. Staff who are not project members (and not admin) get 404 for that project's work items/tasks.
- UI is Thai default + English; every visible string via i18n keys; `th.json` and `en.json` must have identical key sets.
- Single core instance: an in-process event bus is sufficient (no Redis/LISTEN-NOTIFY).
- Repo is public: no secrets; follow plan 1's gitleaks guard.
- Follow plan 1 patterns: `HttpError` + helper constructors in `apps/core/src/auth/plugin.ts`, zod `.parse` on params/body in routes, tests via `makeApp()` / `login()` / `auth()` from `apps/core/test/support.ts`, `resetDb` truncation, root `fileParallelism: false`.

## Review Focus

1. **Two sibling tasks accepted concurrently that complete a step** → the step advances exactly once; no duplicate next-step tasks. Test in Task 4 (`concurrent completion advances once`), backed by the partial unique index from Task 2.
2. **A project member removed while holding open or proposed tasks** → those tasks become unassigned and appear in the PM's confirmations; nothing stays assigned to a non-member. Test in Task 5.
3. **No project member holds the required role** → the task is created unassigned and appears in the PM's confirmations (and, for a project with no PM, in admins' confirmations). Tests in Task 3 and Task 5.
4. **Requester or non-member staff probing task/work-item ids or the live stream** → 403/404 and no live events leak. Tests in Task 5 and Task 6.
5. **Live stream outliving the access token** → the server ends the stream at the token's `exp` so the client reconnects with a fresh token. Test in Task 6.

---

### Task 1: Shared work schemas and workflow templates

**Files:**
- Create: `packages/shared/src/work.ts`; Modify: `packages/shared/src/index.ts` (re-export)
- Create: `apps/core/src/workflow/templates/software-change.json`, `apps/core/src/workflow/templates/bug-fix.json`
- Test: `packages/shared/test/work.test.ts`, `apps/core/test/templates.test.ts`

**Interfaces:**
- Produces (`@yoda/shared`, each schema also exported as a same-named `z.infer` type):
  - `LocalizedText = z.object({ th: z.string().min(1), en: z.string().min(1) })`
  - `TaskType = z.enum(['ai','human','review','approval'])`, `TaskExecutor = z.enum(['ai','human'])`
  - `TaskState = z.enum(['proposed','open','in_progress','submitted','accepted','rejected'])` (`submitted` is reserved for plan 7 runner results; plan 2 submits resolve immediately)
  - `Priority = z.enum(['low','normal','high','urgent'])`, `WorkItemState = z.enum(['active','done','cancelled'])`
  - `TemplateTask = z.object({ key: z.string().regex(/^[a-z0-9-]+$/), type: TaskType, role: ProjectRole, title: LocalizedText, instructions: LocalizedText, dependsOn: z.array(z.string()).default([]) })` — executor is derived: `type === 'ai' ? 'ai' : 'human'`.
  - `TemplateStep = z.object({ key: z.string().regex(/^[a-z0-9-]+$/), name: LocalizedText, tasks: z.array(TemplateTask).min(1) })`
  - `WorkflowTemplateDef = z.object({ key: z.string().regex(/^[a-z0-9-]+$/), name: LocalizedText, steps: z.array(TemplateStep).min(1) })`
  - `validateTemplate(def: WorkflowTemplateDef): string[]` — returns problems (empty = valid): duplicate step keys; duplicate task keys within the whole template; a `dependsOn` entry that isn't an *earlier* task in the *same* step; a `review` or `approval` task with empty `dependsOn` is allowed only if it is the first task of its step.
  - `WorkflowTemplateSummary = z.object({ key: z.string(), version: z.number().int(), name: LocalizedText, steps: z.array(z.object({ key: z.string(), name: LocalizedText })) })`
  - `TaskResult = z.object({ text: z.string().max(50000).default(''), decision: z.enum(['approve','changes']).optional() })`
  - `Task = z.object({ id: uuid, workItemId: uuid, projectId: uuid, stepKey: z.string(), templateTaskKey: z.string(), attempt: z.number().int().min(1), type: TaskType, role: ProjectRole, executor: TaskExecutor, title: LocalizedText, instructions: LocalizedText, feedback: z.string().nullable(), state: TaskState, assigneeId: uuid.nullable(), assigneeName: z.string().nullable(), proposedAssigneeId: uuid.nullable(), proposedAssigneeName: z.string().nullable(), result: TaskResult.nullable(), createdAt: z.string(), updatedAt: z.string() })`
  - `TaskWithContext = Task.extend({ workItemTitle: z.string(), projectName: z.string() })`
  - `Todo = z.object({ tasks: z.array(TaskWithContext), confirmations: z.array(TaskWithContext) })`
  - `TaskAssign = z.object({ personId: z.string().uuid() })`
  - `WorkItemCreate = z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(10000).default(''), templateKey: z.string(), priority: Priority.default('normal'), ownerId: z.string().uuid().optional() })`
  - `WorkItem = z.object({ id: uuid, projectId: uuid, title: z.string(), description: z.string(), templateKey: z.string(), templateVersion: z.number().int(), currentStepKey: z.string().nullable(), priority: Priority, ownerId: uuid, ownerName: z.string(), state: WorkItemState, createdAt: z.string(), updatedAt: z.string() })`
  - `EventType = z.enum(['work_item.created','work_item.step_advanced','work_item.done','work_item.cancelled','task.created','task.proposed','task.assigned','task.unassigned','task.started','task.accepted','task.rejected'])`
  - `EventEntry = z.object({ id: uuid, type: EventType, actorId: uuid.nullable(), actorName: z.string().nullable(), taskId: uuid.nullable(), reason: z.string().nullable(), payload: z.record(z.unknown()), createdAt: z.string() })`
  - `WorkItemDetail = WorkItem.extend({ steps: z.array(z.object({ key: z.string(), name: LocalizedText, status: z.enum(['done','current','pending']) })), tasks: z.array(Task), events: z.array(EventEntry) })`
  - `LiveEvent = z.object({ type: EventType, projectId: uuid, workItemId: uuid.nullable(), taskId: uuid.nullable() })`
- Template files (keys exactly as below; Thai + English titles/instructions are the implementer's wording, short and plain):
  - `software-change` ("เปลี่ยนแปลงระบบ" / "Software change"):
    - `intake` [PM]: `accept-intake` approval PM
    - `ba` [BA]: `draft-requirements` ai BA → `clarify-requirements` human BA (dependsOn draft-requirements) → `approve-requirements` approval BA (dependsOn clarify-requirements)
    - `sa` [SA]: `draft-design` ai SA → `approve-design` approval SA (dependsOn draft-design)
    - `dev` [DEV]: `implement` ai DEV; `draft-tests` ai QC; `review-code` review DEV (dependsOn implement)
    - `qc` [QC]: `verify` human QC → `approve-release` approval QC (dependsOn verify)
    - `close` [PM]: `close` approval PM
  - `bug-fix` ("แก้ไขข้อผิดพลาด" / "Bug fix"): `intake` (as above, task key `accept-bug`), `dev` (as above), `qc` (as above), `close` (task key `close-bug`).
  - Task keys must be unique across a template, so `bug-fix` uses `accept-bug` and `close-bug`; its `dev`/`qc` task keys may reuse the software-change names (uniqueness is per template).

- [ ] **Step 1: Write failing tests.** `work.test.ts`: `validateTemplate` returns `[]` for a minimal valid template; returns a problem mentioning `dup` for duplicate task key `dup`; mentions `later` when a task depends on a later task key `later`; mentions `other-step` when a task depends on a task in another step; `WorkItemCreate.parse({ title: ' แก้รายงาน ', templateKey: 'bug-fix' })` → `title 'แก้รายงาน'`, `priority 'normal'`, `description ''`; `TaskResult.parse({})` → `{ text: '' }`. `templates.test.ts`: both JSON files parse with `WorkflowTemplateDef` and `validateTemplate` returns `[]`; every `approval`/`review` task's derived executor is `human`; `software-change` step keys equal `['intake','ba','sa','dev','qc','close']`.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared apps/core/test/templates.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** schemas, `validateTemplate`, and the two template files.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(shared): work model schemas and workflow templates"`

---

### Task 2: Work tables, migration, template seeding

**Files:**
- Modify: `apps/core/src/db/schema.ts`, `apps/core/src/db/client.ts` (export `Tx`), `apps/core/test/helpers.ts` (`resetDb` truncates new tables), `apps/core/src/server.ts` (call `seedTemplates` after migrations)
- Create: `apps/core/drizzle/0003_*.sql` (generated), `apps/core/src/workflow/seed.ts`
- Modify: `apps/core/src/routes/projects.ts` (import `Tx` from client instead of the local type)
- Test: `apps/core/test/work-db.test.ts`

**Interfaces:**
- Produces:
  - `export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]` in `db/client.ts`.
  - Tables (snake_case columns; uuid pks `defaultRandom()`; timestamps `timestamptz not null default now()`):
    - `workflow_templates`: `id`, `key text not null`, `version int not null`, `definition jsonb not null`, `created_at`; unique `(key, version)`.
    - `work_items`: `id`, `project_id → projects on delete cascade`, `template_id → workflow_templates`, `title text not null`, `description text not null default ''`, `priority text not null default 'normal'` (check in Priority values), `owner_id → people not null`, `current_step_key text null`, `state text not null default 'active'` (check in WorkItemState values), `created_by → people`, `created_at`, `updated_at`.
    - `tasks`: `id`, `work_item_id → work_items on delete cascade`, `project_id → projects on delete cascade`, `step_key text not null`, `template_task_key text not null`, `attempt int not null`, `type text not null` (check), `role text not null` (check in PM/BA/SA/DEV/QC), `executor text not null` (check ai/human), `feedback text null`, `state text not null` (check TaskState values), `assignee_id → people null`, `proposed_assignee_id → people null`, `result jsonb null`, `created_at`, `updated_at`; unique `(work_item_id, template_task_key, attempt)`; **partial unique index** `tasks_one_active_attempt` on `(work_item_id, template_task_key)` where `state in ('proposed','open','in_progress','submitted')`; index `(assignee_id, state)`; index `(project_id, state)`.
    - `events`: `id`, `project_id → projects on delete cascade`, `work_item_id → work_items on delete cascade null`, `task_id → tasks on delete cascade null`, `type text not null`, `actor_id → people null`, `reason text null`, `payload jsonb not null default '{}'`, `created_at`; index `(work_item_id, created_at)`.
  - `seedTemplates(db: Db, dir?: string): Promise<void>` — reads every `*.json` in `apps/core/src/workflow/templates` (resolve relative to the module so it works from `src` and `dist`; the core Dockerfile/build must copy the folder), parses + `validateTemplate` (throw listing problems), and for each key inserts `version = latest + 1` only when the definition differs (deep-equal on parsed JSON) from the latest stored version.
  - `latestTemplate(db: Db | Tx, key: string): Promise<{ id: string; version: number; definition: WorkflowTemplateDef } | null>`
  - `resetDb` truncates `events, tasks, work_items, workflow_templates` too, then calls `seedTemplates`.

- [ ] **Step 1: Write failing tests** (`work-db.test.ts`): after `resetDb`, `latestTemplate(db,'software-change')` has `version 1`; calling `seedTemplates` again keeps `version 1`; seeding from a temp dir with a changed `software-change` definition yields `version 2` and `latestTemplate` returns it; seeding a temp dir holding an invalid template throws with the problem text; inserting two `tasks` rows with the same `work_item_id`, `template_task_key` and state `open` (attempts 1 and 2) throws, while `accepted` + `open` succeeds; inserting a task with `role 'CEO'` throws.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/work-db.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** schema, `pnpm --filter @yoda/core db:generate` (then hand-add the partial unique index if drizzle can't express it), `seed.ts`, helper and server changes; make the core build copy `src/workflow/templates` next to `dist`.
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS (plan 1 tests still green).
- [ ] **Step 5: Commit** `git commit -m "feat(core): work item, task, event tables and template seeding"`

---

### Task 3: Event recording, live bus, task creation and assignment

**Files:**
- Create: `apps/core/src/live/bus.ts`, `apps/core/src/work/context.ts`, `apps/core/src/work/assign.ts`, `apps/core/src/work/tasks.ts`
- Modify: `apps/core/src/app.ts` (`AppDeps` gains `bus: LiveBus`), `apps/core/src/server.ts`, `apps/core/test/helpers.ts` (`testDeps` gives a fresh `LiveBus`)
- Test: `apps/core/test/work-assign.test.ts`

**Interfaces:**
- Consumes: `Tx`, tables, `latestTemplate` (Task 2); shared types (Task 1).
- Produces:
  - `class LiveBus { publish(e: LiveEvent): void; subscribe(fn: (e: LiveEvent) => void): () => void }` (Node `EventEmitter`; listener errors are caught and logged, never thrown to the publisher).
  - `type WorkCtx = { tx: Tx; actorId: string | null; emitted: LiveEvent[] }`
  - `runWork<T>(deps: { db: Db; bus: LiveBus }, actorId: string | null, fn: (ctx: WorkCtx) => Promise<T>): Promise<T>` — runs `fn` in one transaction; publishes `ctx.emitted` on the bus only after commit; publishes nothing if it throws.
  - `recordEvent(ctx: WorkCtx, e: { type: EventType; projectId: string; workItemId: string | null; taskId: string | null; reason?: string | null; payload?: Record<string, unknown> }): Promise<void>` — inserts into `events` with `actor_id = ctx.actorId`, pushes the `LiveEvent`.
  - `pickAssignee(tx: Tx, projectId: string, role: ProjectRole): Promise<string | null>` — project members holding `role`; lowest load wins, where load = count of tasks in that member's name with state `open`/`in_progress` (as assignee) plus `proposed` (as proposed assignee) across all projects; ties by `display_name` then `id`; `null` if none.
  - `createTaskAttempt(ctx: WorkCtx, input: { workItemId: string; projectId: string; stepKey: string; task: TemplateTask; attempt: number; feedback: string | null; assigneeHint: string | null; executor: TaskExecutor }): Promise<string>` (returns task id). Rules:
    - `executor 'ai'` → state `open`, no assignee; event `task.created`.
    - else if `assigneeHint` → state `open`, assignee = hint; events `task.created`, `task.assigned`.
    - else candidate = `pickAssignee`; none → `open` unassigned, event `task.created` with `reason 'no_candidate'`;
    - project autonomy `propose` → state `proposed`, `proposed_assignee_id` = candidate; events `task.created`, `task.proposed`;
    - `auto-assign` → `open`, assignee = candidate; events `task.created`, `task.assigned`.

- [ ] **Step 1: Write failing tests** (`work-assign.test.ts`, building rows directly with the db plus `login()` for people):
  - `pickAssignee` returns the DEV member with fewer open tasks; on equal load returns the one whose display name sorts first; returns `null` when no member holds `QC`; a non-member with the role is never picked.
  - `createTaskAttempt` in a `propose` project → `state 'proposed'`, `proposedAssigneeId` set, `assigneeId null`, events `['task.created','task.proposed']`; in an `auto-assign` project → `state 'open'`, assignee set, events `['task.created','task.assigned']`; with `executor 'ai'` → `open`, no assignee; with no candidate → `open`, unassigned, event reason `'no_candidate'`.
  - `runWork`: a subscriber receives the emitted events only after the transaction commits; when `fn` throws, nothing is published and no `events` rows exist.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/work-assign.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** bus, context (`runWork`, `recordEvent`), `pickAssignee`, `createTaskAttempt`; wire `bus` into `AppDeps`.
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(core): event log, live bus, task creation and assignment"`

---

### Task 4: Workflow engine — start, progress, submit, review loops

**Files:**
- Create: `apps/core/src/work/engine.ts`
- Modify: `apps/core/src/auth/plugin.ts` (new error bodies/helpers)
- Test: `apps/core/test/engine.test.ts`

**Interfaces:**
- Consumes: Task 3's `WorkCtx`, `recordEvent`, `createTaskAttempt`; `Me`.
- Produces (all run inside a `WorkCtx`; all lock the `work_items` row `FOR UPDATE` first, then the task row, always in that order):
  - New `HttpError` bodies + helpers: `invalidState()` 409 `{ error: 'invalid_state' }`, `notMember()` 422 `{ error: 'not_member' }`, `decisionRequired()` 422 `{ error: 'decision_required' }`, `commentRequired()` 422 `{ error: 'comment_required' }`.
  - `createWorkItem(ctx: WorkCtx, me: Me, projectId: string, input: WorkItemCreate): Promise<string>` — creator must be a project member or admin (else `notFound`); owner defaults to `me.id` and must be a project member (else `notMember`); unknown `templateKey` → `notFound`; inserts with the template's latest version id; event `work_item.created`; then `startWorkItem`.
  - `startWorkItem(ctx: WorkCtx, workItemId: string): Promise<void>` — sets `current_step_key` to the first step, then `progressWorkItem`.
  - `progressWorkItem(ctx: WorkCtx, workItemId: string): Promise<void>` — the algorithm below.
  - `startTask(ctx, me, taskId)`: assignee only (else `forbidden`); `open → in_progress`; event `task.started`. Other states → `invalidState`.
  - `submitTask(ctx, me, taskId, result: TaskResult)`: assignee only; state must be `open` or `in_progress`. For `review`/`approval`: `decision` required (`decisionRequired`); `decision 'changes'` requires non-blank `text` (`commentRequired`). Outcomes:
    - `ai`/`human` tasks or `decision 'approve'` → state `accepted`, `result` stored, event `task.accepted`.
    - `decision 'changes'` → state `rejected`, `result` stored, event `task.rejected` with `reason` = comment; then for each key in the task's `dependsOn`, create the next attempt of that template task with `feedback` = comment, `assigneeHint` = that task's latest attempt's assignee, `executor` = that latest attempt's executor.
    - Then `progressWorkItem`.
  - `cancelWorkItem(ctx, me, workItemId)`: owner, project PM or admin (else `forbidden`); `active → cancelled`; all active tasks → `rejected` with event `task.rejected` reason `'work_item_cancelled'`; event `work_item.cancelled`.
- `progressWorkItem` algorithm (not determined by the signature — implement exactly):

```text
loop:
  item = work item (locked); if item.state != 'active': return
  step = template step with key item.current_step_key
  latest(T) = highest-attempt task row for template task T on this item
  satisfied(T) = latest(T)?.state == 'accepted'
  if every T in step.tasks is satisfied:
      record work_item.step_advanced {payload: {from: step.key, to: next?.key ?? null}}
      if no next step: set state 'done', current_step_key null, record work_item.done; return
      set current_step_key = next.key; continue loop
  for each T in step.tasks (template order):
      active = a task row for T in proposed/open/in_progress/submitted
      if not satisfied(T) and no active and all dependsOn satisfied:
          createTaskAttempt(attempt = (latest(T)?.attempt ?? 0) + 1,
                            feedback = null, assigneeHint = latest(T)?.assignee_id ?? null,
                            executor = T.type == 'ai' ? 'ai' : 'human')
  return
```

- [ ] **Step 1: Write failing tests** (`engine.test.ts`; helper sets up a project with members per role, `auto-assign` unless stated):
  - creating a `bug-fix` item → `currentStepKey 'intake'`, one task `accept-bug` assigned to the PM; events include `work_item.created`, `task.created`.
  - full `bug-fix` happy path (PM approves intake, DEV submits `implement`, `draft-tests` submitted, DEV approves `review-code`, QC submits `verify`, QC approves release, PM approves close) → item `state 'done'`, `currentStepKey null`, last event `work_item.done`.
  - in `dev`, `review-code` is not created until `implement` is accepted; `draft-tests` is created at step entry.
  - `review-code` with `decision 'changes'`, text `'แก้ชื่อตัวแปร'` → review task `rejected`; a new `implement` attempt 2 exists with `feedback 'แก้ชื่อตัวแปร'` and the attempt-1 assignee; after it's accepted a new `review-code` attempt 2 appears; the step doesn't advance in between.
  - approval without decision → 422 `decision_required`; `changes` with blank text → 422 `comment_required`; non-assignee submit → 403; submitting an accepted task → 409 `invalid_state`.
  - **concurrent completion advances once:** in `dev`, accept `review-code` and `draft-tests` via `Promise.all` of two `runWork` calls → exactly one `work_item.step_advanced` from `dev`, exactly one `verify` task.
  - owner not a project member → 422 `not_member`; unknown template key → 404.
  - cancel → item `cancelled`, every previously active task `rejected`, no new tasks on further `progressWorkItem` calls.
  - `propose` project: first task is `proposed` with a `proposedAssigneeId` and no assignee.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/engine.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `engine.ts` and the new error helpers.
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(core): workflow engine with review loops"`

---

### Task 5: Work item and task REST API, to-do query, member removal

**Files:**
- Create: `apps/core/src/work/queries.ts`, `apps/core/src/routes/work.ts`
- Modify: `apps/core/src/app.ts` (register `workRoutes`), `apps/core/src/routes/projects.ts` (member removal + follow-up + `PATCH /projects/:id`), `packages/shared/src/projects.ts` (`ProjectPatch`), `apps/core/src/work/engine.ts` (add `confirmTask`, `assignTask`, `unassignMemberTasks`)
- Test: `apps/core/test/work-api.test.ts`, `apps/core/test/projects.test.ts` (extend)

**Interfaces:**
- Consumes: engine (Task 4), `runWork` (Task 3).
- Produces engine additions:
  - `confirmTask(ctx, me, taskId)`: PM of the project or admin (else `forbidden`); `proposed → open`, assignee = proposed assignee, proposed cleared; event `task.assigned`.
  - `assignTask(ctx, me, taskId, personId)`: PM or admin; task must be active (else `invalidState`); person must be a project member (else `notMember`); sets assignee, clears proposed, `proposed → open`; an `ai` executor becomes `human` (payload `{ takeover: true }`); event `task.assigned`.
  - `unassignMemberTasks(ctx, projectId, personId)`: every active task in the project with that assignee or proposed assignee → assignee/proposed cleared, state `open`; event `task.unassigned` reason `'member_removed'`.
- Produces queries:
  - `getWorkItemDetail(db: Db, me: Me, id: string): Promise<WorkItemDetail>` (404 when not visible; events oldest first; tasks ordered by step order then template order then attempt).
  - `listWorkItems(db: Db, me: Me, projectId: string): Promise<WorkItem[]>` (newest first).
  - `getTask(db: Db, me: Me, id: string): Promise<TaskWithContext>`.
  - `getTodo(db: Db, me: Me): Promise<Todo>` — `tasks`: assignee = me, state `open`/`in_progress`, ordered by work item priority (`urgent`, `high`, `normal`, `low`) then `created_at`. `confirmations`: active tasks that are `proposed` or unassigned-with-executor-`human`, in projects where me is PM; for admins also in projects that have no PM.
  - Visibility: admin, or member of the task's/work item's project. Requesters → 403 before any lookup.
- Routes (`workRoutes(app)`; all `requireStaff`; bodies parsed with shared schemas; every mutation goes through `runWork(app.deps, me.id, …)` and returns the fresh resource):
  - `GET /workflow-templates` → `WorkflowTemplateSummary[]` (latest versions, sorted by key)
  - `GET /projects/:id/work-items` → `WorkItem[]`; `POST /projects/:id/work-items` body `WorkItemCreate` → 201 `WorkItemDetail`
  - `GET /work-items/:id` → `WorkItemDetail`; `POST /work-items/:id/cancel` → `WorkItemDetail`
  - `GET /me/todo` → `Todo`
  - `GET /tasks/:id` → `TaskWithContext`; `POST /tasks/:id/start` | `/submit` (body `TaskResult`) | `/confirm` | `/assign` (body `TaskAssign`) → `TaskWithContext`
- `PATCH /projects/:id` body shared `ProjectPatch = z.object({ autonomy: z.enum(['propose','auto-assign']) })` (add to `packages/shared/src/projects.ts`) → `ProjectDetail`; PM of the project or admin (else 403).
- `projects.ts` changes: `DELETE /projects/:id/members/:personId` calls `unassignMemberTasks` in the same transaction (run the delete through `runWork` so events publish); re-check `canManageProject` after `lockProject` in both PUT and DELETE (plan 1 follow-up).

- [ ] **Step 1: Write failing tests** (`work-api.test.ts`):
  - requester gets 403 on `GET /workflow-templates`, `GET /me/todo`, `GET /tasks/<random uuid>`; non-member staff gets 404 on another project's `GET /work-items/:id` and `GET /tasks/:id`.
  - `GET /workflow-templates` returns keys `['bug-fix','software-change']`.
  - `POST /projects/:id/work-items` `{ title: 'แก้รายงานแล็บ', templateKey: 'bug-fix' }` by a member → 201, `title 'แก้รายงานแล็บ'`, one task in `tasks`, events non-empty.
  - propose flow: the PM's `GET /me/todo` `confirmations` contains the proposed task; `POST /tasks/:id/confirm` → task `open`, now in the assignee's `todo.tasks`; a DEV-only member confirming → 403.
  - no-candidate flow: project without a QC member → the `verify` task appears unassigned in the PM's confirmations; `POST /tasks/:id/assign` to a non-member → 422 `not_member`; to a member → 200 and assignee set.
  - project without any PM: an admin's confirmations include its unassigned tasks; a non-admin staff member's don't.
  - AI takeover: assigning an `ai` task → `executor 'human'`, the assignee can submit it.
  - `todo.tasks` ordering: an `urgent` item's task comes before a `normal` one's.
  - (`projects.test.ts`) `PATCH /projects/:id { autonomy: 'auto-assign' }` by PM → 200 and `autonomy 'auto-assign'`; by a DEV-only member → 403; `{ autonomy: 'sometimes' }` → 400.
  - (`projects.test.ts`) removing a member who has an `open` task and a `proposed` task → both become unassigned `open`, appear in the PM's confirmations, events `task.unassigned` with reason `member_removed`.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/work-api.test.ts apps/core/test/projects.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** queries, engine additions, routes, projects.ts changes.
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(core): work item and task API, to-do, member removal unassigns"`

---

### Task 6: Live event stream (SSE)

**Files:**
- Create: `apps/core/src/routes/stream.ts`
- Modify: `apps/core/src/auth/people.ts` (`TokenClaims` gains `exp: z.number()`), `apps/core/src/auth/plugin.ts` (`request.tokenExp: number` in ms), `apps/core/src/app.ts` (register)
- Test: `apps/core/test/stream.test.ts`

**Interfaces:**
- Consumes: `LiveBus` (Task 3), visibility rule (Task 5).
- Produces: `GET /stream` (`requireStaff`): headers `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`; writes `: connected\n\n` immediately; for each bus event the user may see (admin, or member of `projectId` — checked per event against the DB), writes `event: live\ndata: <LiveEvent JSON>\n\n`; writes `: ping\n\n` every 25 s; ends the response at `request.tokenExp`; unsubscribes and clears timers on client close.

- [ ] **Step 1: Write failing tests** (`stream.test.ts`; `app.listen({ port: 0 })` and Node `fetch` reading `res.body`):
  - member connects, then a work item is created in their project via `inject` → within 2 s the stream yields an `event: live` whose data parses as `LiveEvent` with that `projectId` and `type 'work_item.created'`.
  - non-member staff connected at the same time receives no `event: live` within 1 s.
  - requester → 403; no token → 401.
  - token with `exp` 2 s ahead → stream ends (reader `done`) within 4 s.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/stream.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the route via `reply.hijack()` and `reply.raw` writes.
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Verify through the portal proxy:** start core and portal (`PORTAL_PORT=3100`), get a token for `somchai` in a browser session (Playwright) and run `fetch('/api/stream')` in the page → the first chunk `: connected` arrives within 2 s (proves the Nitro proxy streams instead of buffering; if it buffers, make `server/routes/api/[...path].ts` stream `text/event-stream` responses). Stop the servers.
- [ ] **Step 6: Commit** `git commit -m "feat(core): authenticated live event stream"`

---

### Task 7: Portal — To-do list and task detail, live updates

**Files:**
- Modify: `apps/portal/app/pages/todo.vue`; Create: `apps/portal/app/pages/todo/[id].vue`, `apps/portal/app/composables/useLiveEvents.ts`, `apps/portal/app/utils/sse.ts`, `apps/portal/app/utils/localized.ts`
- Modify: `apps/portal/i18n/locales/th.json`, `en.json`, `apps/portal/app/utils/errors.ts`
- Test: `apps/portal/test/sse.test.ts`, `apps/portal/test/i18n.test.ts`

**Interfaces:**
- Consumes: `GET /me/todo`, `GET /tasks/:id`, `POST /tasks/:id/start|submit|confirm|assign`, `GET /projects/:id` (members for "change assignee"), `GET /stream`; shared types.
- Produces:
  - `parseSse(buffer: string): { events: { event: string; data: string }[]; rest: string }` in `utils/sse.ts` (handles `\n\n` and `\r\n\r\n` separators, comment lines starting with `:`, multi-line `data:`).
  - `localized(text: LocalizedText, locale: string): string` (falls back to `th`).
  - `useLiveEvents(onEvent: (e: LiveEvent) => void): void` — streams `/api/stream` with `fetch` + bearer token (refresh via `updateToken(30)` before each connect), parses with `parseSse`, validates with `LiveEvent.safeParse`, reconnects with backoff 1 s doubling to 30 s (reset after a successful connect), stops on component unmount.
  - `errorKey` maps `invalid_state`, `not_member`, `decision_required`, `comment_required` to `errors.invalidState`, `errors.notMember`, `errors.decisionRequired`, `errors.commentRequired`.
- UI:
  - `/todo`: two sections — "My tasks" (title, project, work item, state chip, priority) and, when non-empty, "Waiting for your confirmation" (task, proposed assignee or "needs assignee", **Confirm** button for proposed ones, link to detail). Refreshes on any live event. Empty state text.
  - `/todo/[id]`: title, state/type chips, work item + project names (link to `/work-items/:id`), instructions, `feedback` (if any) highlighted as "Changes requested", result text area. Actions by type/state for the assignee: **Start** (open), **Submit** (ai/human), **Approve** / **Request changes** (review/approval; request changes requires a comment). For PM/admin on proposed or unassigned tasks: **Confirm** and **Change assignee** (select from project members). Accepted/rejected tasks show the stored result read-only. Errors shown via `errorKey`.

- [ ] **Step 1: Write failing tests:** `sse.test.ts` — `parseSse(': connected\n\nevent: live\ndata: {"a":1}\n\nevent: li')` → `events [{ event: 'live', data: '{"a":1}' }]`, `rest 'event: li'`; CRLF input parses the same; two `data:` lines join with `\n`. `i18n.test.ts` — flattened key sets of `th.json` and `en.json` are equal.
- [ ] **Step 2: Run** `pnpm vitest run apps/portal` — Expected: FAIL.
- [ ] **Step 3: Implement** utilities, composable, pages, i18n keys (`todo.*`, `task.state.*`, `task.type.*`, `priority.*`, new `errors.*`).
- [ ] **Step 4: Run** `pnpm vitest run apps/portal && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Browser check (Playwright, port 3100):** as `somchai` (admin + PM on a project with an `auto-assign` setting and members for all roles — create via the API) create a `bug-fix` item via the API, open `/todo` → the intake task shows; approve it → it disappears without reload and the next task appears in the right person's to-do; request changes without a comment → `errors.commentRequired` text shows. Record results in the report. Stop servers.
- [ ] **Step 6: Commit** `git commit -m "feat(portal): to-do list and task detail with live updates"`

---

### Task 8: Portal — Work items on projects, work item detail

**Files:**
- Modify: `apps/portal/app/pages/projects/[id].vue`; Create: `apps/portal/app/pages/work-items/[id].vue`, `apps/portal/app/components/WorkItemCreateDialog.vue`, `apps/portal/app/components/EventTimeline.vue`
- Modify: `apps/portal/app/utils/nav.ts` (`/work-items` is a staff path), i18n files
- Test: `apps/portal/test/nav.test.ts` (extend)

**Interfaces:**
- Consumes: `PATCH /projects/:id` (Task 5), `GET /workflow-templates`, `GET|POST /projects/:id/work-items`, `GET /work-items/:id`, `POST /work-items/:id/cancel`, `POST /tasks/:id/confirm|assign`; `useLiveEvents`, `localized`.
- UI:
  - Project page: "Work items" section listing items (title, template name, current step name, priority, state, owner) with **New work item** (dialog: title, description, template select, priority, owner select from members) for members/admin; also a project **autonomy** switch (propose / auto-assign) for PM/admin using `PATCH /projects/:id` (Task 5).
  - `/work-items/[id]`: header (title, priority, state, owner, template); step stepper with done/current/pending; tasks grouped by step (title, attempt if > 1, executor chip "AI" / person, state, assignee or proposed assignee, **Confirm** / **Assign** for PM/admin, link to `/todo/[id]`); "Waiting for AI" label on unassigned `ai` tasks with an **Assign to person** action; event timeline (localized event type, actor or "System", reason, time); **Cancel** for owner/PM/admin with a confirm dialog. Refreshes on live events for this work item.
  - Plan 1 follow-up: in the member roles editor, clearing every role reloads the member so chips match the server.
- `isStaffPath('/work-items/x') === true`.

- [ ] **Step 1: Write failing test:** extend `nav.test.ts`: `isStaffPath('/work-items/abc')` is `true`.
- [ ] **Step 2: Run** `pnpm vitest run apps/portal` — Expected: FAIL.
- [ ] **Step 3: Implement** pages, components, i18n (`workItems.*`, `events.*`, `steps.*`).
- [ ] **Step 4: Run** `pnpm vitest run && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Browser check (Playwright, port 3100):** as `somchai` create a `software-change` item from the project page; open it → stepper on Intake, the PM task present; switch autonomy to propose and create another item → its task shows "proposed" with **Confirm**, confirming updates the page live; assign an AI task in the BA step to a person after approving intake; cancel an item → state cancelled, timeline shows the cancel event. Record results. Stop servers.
- [ ] **Step 6: Commit** `git commit -m "feat(portal): work items on projects and work item detail"`
