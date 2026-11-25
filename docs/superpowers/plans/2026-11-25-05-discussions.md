# Discussions (Plan 5 of 8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a decision needs people rather than AI, anyone on the team (or the secretary, with the person's confirmation) raises a discussion; AI prepares a brief (context, options, trade-offs, recommendation); staff add opinions and votes; PMs put discussions on a meeting agenda, present it, and record decisions — which unblock the work item and become confirmed knowledge.

**Architecture:** New core module `discussions/` (discussions, options, responses, agendas) with a REST API; a `discussion-brief` job using the AI gateway with structured output; the workflow engine treats an open discussion linked to a work item step as a blocker for advancing that step; decisions write a confirmed `decision` knowledge entry and resume the work item. The secretary gets a `raise_discussion` tool that creates a proposal the person confirms. Thread-audience rules move into one function first (plan 4 follow-up). Portal gets the Discussions page, a discussion detail page, an agenda page with a presentable/printable view, and "Raise discussion" entry points on tasks and work items.

**Tech Stack:** as plans 1–4.

**Spec:** `docs/superpowers/specs/2026-11-24-ai-work-portal-design.md` (§2 goal 1, §7 Discussion, §8 "any step may raise a Discussion", §9 `raise_discussion`, §13 Pending discussions). Follow-ups: `docs/superpowers/plans/2026-11-24-04-secretary-followups.md`.

**Not in this plan:** GitLab-linked discussions (plan 6), runners raising discussions (plan 7), status dashboards (plan 8), calendar integration for meetings.

## Defaults chosen in this plan (owner can override)

These have a sensible default, so the plan doesn't stop on them; they're listed so the owner can change them.

1. **Who records a decision:** the project's PM or an admin. Department-wide discussions (no project): admins.
2. **Who can raise a discussion:** any staff member of the project (or admin); the secretary only via a proposal the person confirms.
3. **Who sees discussions:** staff who can see the project (admins: all). Requesters never — discussions are internal.
4. **Agendas** are department-level meetings (title, date) that can hold discussions from any project; created and ordered by PMs and admins.
5. **Votes:** one vote per person per discussion (changeable until decided); votes are advisory — the decider picks the option.

## Global Constraints

- Discussion states: `open` → `scheduled` (on an agenda) → `decided` | `withdrawn`. Only `decided` and `withdrawn` are final.
- An open or scheduled discussion linked to a work item blocks that work item's step from advancing (both autonomy modes); the item shows as waiting on a discussion.
- Decisions record decision text, the chosen option (optional), who decided, and when; they create a `confirmed` `decision` knowledge entry on the work item (or project, or department).
- AI briefs respect "do not send to AI" and are billed to the project (department budget when there's no project); briefs are drafts — labelled AI-prepared, editable by the raiser/PM.
- Requesters get 403/404 on every discussion and agenda route and never receive discussion live events or notifications.
- The secretary may only *propose* raising a discussion.
- Thai default UI, all strings via i18n, th/en parity. Repo is public: no secrets.
- Follow plans 1–4 patterns (runWork actor kinds, jobs after commit, lock order project → work item → task → proposal; conversation → work item; HttpError helpers; test helpers; mock AI models; TEST_STORAGE=memory in CI).

## Review Focus

1. **A discussion raised on a step that's otherwise complete** → the step doesn't advance (no proposal, no automatic advance) until the discussion is decided or withdrawn; then it continues exactly once. Test in Task 4.
2. **Two people deciding at once / deciding a withdrawn discussion** → exactly one decision; the other gets 409. Test in Task 3.
3. **A requester or a staff member outside the project** probing discussion/agenda ids or the live stream → 404/403, no events. Tests in Tasks 3, 6.
4. **AI brief for a no-AI project or with the budget exhausted** → no AI call; the discussion still works with a manually written brief; the failure reason is visible. Test in Task 5.
5. **Thai text** in questions, options, responses and decisions round-trips, renders on the printable agenda, and is findable as knowledge after the decision. Tests in Tasks 3, 4, 8.

---

### Task 1: Thread audience in one place

**Files:**
- Create: `apps/core/src/chat/audience.ts`
- Modify: `apps/core/src/secretary/chat.ts`, `apps/core/src/secretary/tools.ts`, `apps/core/src/chat/service.ts` (wherever thread kind decides visibility/scoping)
- Test: `apps/core/test/audience.test.ts`

**Interfaces:**
- `type ThreadAudience = { kind: ConversationKind; own: boolean; team: boolean; projectId: string | null; workItemId: string | null; requesterVisible: boolean; hideStaffNames: boolean }`
- `threadAudience(db: Db | Tx, conversation: ConversationRow): Promise<ThreadAudience>` — the single source of truth: `own` for personal/intake; `team` for project/work_item; `requesterVisible` = work_item thread whose item currently has a requester; `hideStaffNames` = any thread a non-staff person can read (work_item threads). All existing callers use it; behavior unchanged.

- [ ] **Step 1: Write failing tests** for each conversation kind (personal, intake, project, work_item with and without requester) asserting every field.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/audience.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** and switch callers; the existing secretary/chat tests must still pass unchanged.
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "refactor(core): thread audience in one place"`

---

### Task 2: Shared schemas and tables

**Files:**
- Create: `packages/shared/src/discussions.ts`; Modify: `packages/shared/src/index.ts`, `packages/shared/src/work.ts` (EventType, WorkItem), `packages/shared/src/proposals.ts` (ProposalKind), `packages/shared/src/notifications.ts`
- Modify: `apps/core/src/db/schema.ts` + migration; `apps/core/test/helpers.ts` (truncate)
- Test: `packages/shared/test/discussions.test.ts`, `apps/core/test/discussions-db.test.ts`

**Interfaces:**
- Shared (each with `z.infer` type):
  - `DiscussionState = z.enum(['open','scheduled','decided','withdrawn'])`
  - `DiscussionOption = z.object({ key: z.string().regex(/^[a-z0-9-]{1,40}$/), title: z.string().trim().min(1).max(200), pros: z.string().max(4000).default(''), cons: z.string().max(4000).default('') })`
  - `DiscussionBrief = z.object({ context: z.string().max(20000), options: z.array(DiscussionOption).max(8), recommendation: z.string().max(4000), recommendedKey: z.string().nullable(), source: z.enum(['ai','person']), status: z.enum(['pending','ready','failed']), failReason: z.string().nullable() })`
  - `Discussion = z.object({ id: uuid, projectId: uuid.nullable(), projectName: z.string().nullable(), workItemId: uuid.nullable(), workItemTitle: z.string().nullable(), taskId: uuid.nullable(), stepKey: z.string().nullable(), question: z.string(), details: z.string(), priority: Priority, state: DiscussionState, brief: DiscussionBrief.nullable(), raisedById: uuid, raisedByName: z.string(), decision: z.string().nullable(), decidedOptionKey: z.string().nullable(), decidedById: uuid.nullable(), decidedByName: z.string().nullable(), decidedAt: z.string().nullable(), agendaId: uuid.nullable(), voteCounts: z.record(z.number().int()), myVote: z.string().nullable(), responseCount: z.number().int(), createdAt: z.string(), updatedAt: z.string() })`
  - `DiscussionCreate = z.object({ projectId: uuid.optional(), workItemId: uuid.optional(), taskId: uuid.optional(), question: z.string().trim().min(1).max(500), details: z.string().max(20000).default(''), priority: Priority.default('normal'), options: z.array(DiscussionOption).max(8).default([]), requestBrief: z.boolean().default(true) })` (refine: taskId ⇒ workItemId; workItemId ⇒ projectId optional but must match if given).
  - `DiscussionResponseKind = z.enum(['opinion','vote'])`; `DiscussionResponse = z.object({ id: uuid, discussionId: uuid, authorId: uuid, authorName: z.string(), kind: DiscussionResponseKind, optionKey: z.string().nullable(), text: z.string(), createdAt: z.string() })`; `DiscussionResponseCreate = z.object({ kind: DiscussionResponseKind, optionKey: z.string().optional(), text: z.string().trim().max(10000).default('') })` (refine: vote ⇒ optionKey; opinion ⇒ non-empty text).
  - `DiscussionDecide = z.object({ decision: z.string().trim().min(1).max(10000), optionKey: z.string().optional() })`; `DiscussionWithdraw = z.object({ reason: z.string().trim().min(1).max(2000) })`; `DiscussionBriefEdit = DiscussionBrief.pick({ context: true, options: true, recommendation: true, recommendedKey: true })`.
  - `Agenda = z.object({ id: uuid, title: z.string(), meetingAt: z.string(), createdById: uuid, items: z.array(z.object({ discussionId: uuid, position: z.number().int(), question: z.string(), projectName: z.string().nullable(), state: DiscussionState, priority: Priority })) , createdAt: z.string() })`; `AgendaCreate = z.object({ title: z.string().trim().min(1).max(200), meetingAt: z.string().datetime({ offset: true }) })`; `AgendaItemsPut = z.object({ discussionIds: z.array(uuid).max(50) })` (ordered).
  - `EventType` adds `'discussion.raised','discussion.brief_ready','discussion.brief_failed','discussion.scheduled','discussion.decided','discussion.withdrawn'`; `ProposalKind` adds `'raise_discussion'`; `NotificationKind` adds `'discussion'`; `WorkItem` gains `openDiscussions: z.number().int()`.
- Tables: `discussions` (all fields above; `brief jsonb null`; `project_id → projects cascade null`, `work_item_id → work_items cascade null`, `task_id → tasks set null null`, `step_key text null`, `raised_by → people`, `decided_by → people null`, `agenda_id → agendas set null null`, state check, priority check, created/updated timestamps); index `(work_item_id, state)`, `(project_id, state)`. `discussion_responses` (`discussion_id cascade`, `author_id`, `kind` check, `option_key null`, `text`, `created_at`); partial unique `(discussion_id, author_id) where kind = 'vote'`. `agendas` (`id`, `title`, `meeting_at timestamptz`, `created_by`, `created_at`). Agenda order is `discussions.agenda_position int null`.

- [ ] **Step 1: Write failing tests:** schema refinements (vote without option fails; opinion with blank text fails; taskId without workItemId fails; Thai question trims); DB: a second vote by the same person inserts → unique violation, two opinions allowed; state check rejects `closed`.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared apps/core/test/discussions-db.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**, generate the migration, migrate the dev DB; core compiles with `openDiscussions: 0` stubs where `WorkItem` is built.
- [ ] **Step 4: Run** `pnpm vitest run && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: discussion schemas and tables"`

---

### Task 3: Discussion service and API

**Files:**
- Create: `apps/core/src/discussions/service.ts`, `apps/core/src/discussions/queries.ts`, `apps/core/src/routes/discussions.ts`
- Modify: `apps/core/src/app.ts`, `apps/core/src/notifications/service.ts`, `apps/core/src/routes/stream.ts` (delivery for discussion events = project rule; department discussions → staff only)
- Test: `apps/core/test/discussions.test.ts`

**Interfaces:**
- Visibility: staff who can see the project (admin always); department discussions (no project) visible to all staff; requesters → 403 on every route.
- Routes:
  - `GET /discussions?state=&projectId=&sort=priority|created|project` → `Discussion[]` (default: open+scheduled, priority desc then oldest first).
  - `POST /discussions` (`DiscussionCreate`) → 201 `Discussion`: raiser must be a project member or admin (department: any staff); work item must be active; records `discussion.raised`; notifies the project's PMs (kind `discussion`, dedupe `discussion:<id>:raised`); if `requestBrief` and the project isn't no-AI, enqueues `discussion-brief` after commit and sets `brief.status 'pending'`; else stores provided `options` as a `person` brief with `status 'ready'`.
  - `GET /discussions/:id` → `Discussion`; `GET /discussions/:id/responses` → `DiscussionResponse[]` (oldest first).
  - `POST /discussions/:id/responses` (`DiscussionResponseCreate`) → `DiscussionResponse`: open/scheduled only (409 otherwise); a vote's `optionKey` must exist in the brief options (422 `invalid_state`); a second vote replaces the first.
  - `PUT /discussions/:id/brief` (`DiscussionBriefEdit`) → `Discussion` (raiser, project PM, admin; sets `source 'person'`, `status 'ready'`; open/scheduled only).
  - `POST /discussions/:id/decide` (`DiscussionDecide`) → `Discussion`: project PM or admin (department: admin); locks the work item row (if any) then the discussion row; non-open/scheduled → 409; `optionKey`, if given, must exist; sets decided fields; records `discussion.decided`; creates a `confirmed` `decision` knowledge entry (scope work item, else project, else department; title = question; body = decision + chosen option + brief summary); notifies the raiser and responders (dedupe `discussion:<id>:decided`); then (Task 4) resumes the work item.
  - `POST /discussions/:id/withdraw` (`DiscussionWithdraw`) → raiser, PM, admin; same locking; records `discussion.withdrawn` with the reason; resumes the work item.
- `Discussion.voteCounts` per option key; `myVote` for the caller.

- [ ] **Step 1: Write failing tests:** member raises on a work item → 201, PMs notified once; non-member staff → 404 on GET/respond/decide; requester → 403 everywhere; opinion and vote (vote replaces previous; unknown option → 422); decide by DEV-only member → 403; PM decides with Thai text → decided, knowledge `decision` entry confirmed and findable by `searchKnowledge('ตัดสิน…')`; concurrent decide twice → one 200, one 409; decide after withdraw → 409; respond after decide → 409; department discussion (no project) by staff, decided by admin only.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/discussions.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(core): discussions API"`

---

### Task 4: Discussions block and resume work items

**Files:**
- Modify: `apps/core/src/work/engine.ts` (`stepStatus` / `progressWorkItem` / `advanceWorkItem` / `proposeStepAdvance`), `apps/core/src/work/queries.ts` (`awaitingAdvance`, `openDiscussions`), `apps/core/src/work/guards.ts` (no change in order; blocked items never reach guards), `apps/core/src/discussions/service.ts`
- Create: `POST /tasks/:id/raise-discussion` in `apps/core/src/routes/work.ts`
- Test: `apps/core/test/discussions-engine.test.ts`

**Interfaces:**
- A work item with any `open`/`scheduled` discussion whose `work_item_id` is the item is **blocked**: `progressWorkItem` doesn't advance or create a step-advance proposal; `advanceWorkItem` → 409 `invalid_state`; `awaitingAdvance` false; `WorkItem.openDiscussions` = count.
- Tasks keep working while blocked (people can still submit; only the step advance waits).
- On decide/withdraw (inside the same transaction, after the work item lock): call `progressWorkItem` so the item continues — in `propose` projects this creates the step-advance proposal; in `auto-assign` it advances (guards still apply).
- `POST /tasks/:id/raise-discussion` (body `DiscussionCreate` minus ids): assignee of the task (or PM/admin); creates a discussion linked to the task's work item, task and step.
- Cancelling or reopening a work item withdraws its open discussions (reason `work_item_cancelled` / `work_item_reopened`).

- [ ] **Step 1: Write failing tests:** auto-assign item: raise a discussion during the dev step, complete the step → no advance, `awaitingAdvance false`, `openDiscussions 1`; decide → advances exactly once; propose item: same → after decide a step-advance proposal appears (not before); concurrent decide + task accept → one advance; withdraw also resumes; cancel withdraws open discussions; assignee can raise from a task, another member can't (403), PM can.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/discussions-engine.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(core): discussions block and resume work"`

---

### Task 5: AI briefs

**Files:**
- Create: `apps/core/src/discussions/brief.ts`
- Modify: job registration (`discussion-brief`), `apps/core/src/ai/gateway.ts` (structured output helper if needed)
- Test: `apps/core/test/discussion-brief.test.ts`

**Interfaces:**
- Job `discussion-brief` `{ id }`: skip unless the discussion is open/scheduled and `brief.status` is `pending`; builds context from the question/details, the linked work item (title, description, current step, confirmed documents, decisions, recent progress) and related knowledge (`searchKnowledge(..., { forAi: true, limit: 6 })`), all without no-AI content; calls the gateway with structured output (`DiscussionBrief` fields context/options/recommendation/recommendedKey; 2–5 options with keys `a`..`e`; language follows the question), `job: 'draft'`, `maxOutputTokens 6000`, billed to the project (department when none). Stores `source 'ai'`, `status 'ready'`, records `discussion.brief_ready`.
- Failures: no-AI project or refusal → `status 'failed'`, `failReason` (`no_ai`, `budget_exceeded`, `ai_unavailable`, `ai_failed`), event `discussion.brief_failed`; transient errors retry; final attempt → failed. A failed brief can be edited by people (Task 3 `PUT …/brief`) or retried: `POST /discussions/:id/brief/retry` (raiser/PM/admin) → `pending` + enqueue.
- Existing person-provided options are kept as hints in the prompt; the AI may refine them.

- [ ] **Step 1: Write failing tests** (mock model returning structured JSON): raise with `requestBrief` → brief ready with options and a recommendation; prompt contains the work item's confirmed document but not a no-AI entry; no-AI project → failed `no_ai`, no model call; budget exhausted → failed `budget_exceeded`; malformed model output → retried then failed `ai_failed`; retry endpoint re-enqueues; a vote on an option from the AI brief works.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/discussion-brief.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** (check AI SDK v7 structured output API in `node_modules/ai`).
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(core): AI discussion briefs"`

---

### Task 6: Agendas

**Files:**
- Create: `apps/core/src/discussions/agendas.ts`; Modify: `apps/core/src/routes/discussions.ts`
- Test: `apps/core/test/agendas.test.ts`

**Interfaces:**
- Routes (staff; create/update/delete by PMs of any project or admins): `GET /agendas?upcoming=true` → `Agenda[]` (items filtered to discussions the caller can see), `POST /agendas` (`AgendaCreate`), `GET /agendas/:id`, `PUT /agendas/:id/items` (`AgendaItemsPut`, ordered; each discussion must be visible to the caller and open/scheduled; adding sets `scheduled` + `agenda_id` + position and records `discussion.scheduled`; removing returns it to `open`), `DELETE /agendas/:id` (returns its undecided discussions to `open`).
- A discussion can be on one agenda at a time; putting it on another moves it.
- Requesters → 403; a staff member who can't see a project never sees that project's items on an agenda (they're omitted, not 404).

- [ ] **Step 1: Write failing tests:** PM creates an agenda, adds 3 discussions in order → positions 0..2 and states `scheduled`; reorder; remove one → `open`; delete agenda → undecided back to `open`, decided stay decided; DEV-only member can view but not edit (403); requester → 403; staff outside project B sees the agenda without B's item.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/agendas.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(core): meeting agendas"`

---

### Task 7: Secretary `raise_discussion`

**Files:**
- Modify: `apps/core/src/secretary/tools.ts`, `apps/core/src/proposals/service.ts` (accept `raise_discussion`), `apps/core/src/secretary/prompt.ts`
- Test: extend `apps/core/test/secretary.test.ts`, `apps/core/test/proposals.test.ts`

**Interfaces:**
- Staff tool `raise_discussion({ question, details, workItemId?, projectId?, options? })` → `raise_discussion` proposal on behalf of the person (scope rules from `threadAudience`: team threads limited to the thread's project/work item; not offered in requester-visible threads) + `proposal` card. Accepting (by the person it was proposed for, or a PM/admin) creates the discussion as that person (Task 3 rules) with `requestBrief: true`.
- Prompt: suggest raising a discussion when the person faces a decision with real trade-offs or conflicting requirements.

- [ ] **Step 1: Write failing tests:** the tool creates a pending proposal and a card, no discussion; accepting creates the discussion with the brief pending; a non-member target project → tool error; not available in a requester-visible thread.
- [ ] **Step 2: Run** the tests — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(core): secretary can propose discussions"`

---

### Task 8: Portal — Discussions, detail, agendas

**Files:**
- Modify: `apps/portal/app/pages/discussions.vue` → `apps/portal/app/pages/discussions/index.vue`; Create: `apps/portal/app/pages/discussions/[id].vue`, `apps/portal/app/pages/agendas/index.vue`, `apps/portal/app/pages/agendas/[id].vue`, `apps/portal/app/pages/agendas/[id]/present.vue`, `apps/portal/app/components/discussions/*` (RaiseDiscussionDialog, BriefView, BriefEditor, Responses, DecideDialog), `apps/portal/app/utils/discussions.ts`; Modify: `apps/portal/app/pages/todo/[id].vue`, `apps/portal/app/pages/work-items/[id].vue`, `apps/portal/app/utils/nav.ts` (staff paths), `apps/portal/app/components/chat/ActionCard.vue` (raise_discussion proposals), i18n files
- Test: `apps/portal/test/discussions.test.ts`

**Interfaces:**
- `sortDiscussions(list: Discussion[], by: 'priority' | 'created' | 'project'): Discussion[]` and `voteSummary(d: Discussion): { key: string; title: string; votes: number; recommended: boolean }[]` in `utils/discussions.ts`.
- Discussions page: tabs Open / Scheduled / Decided; filter by project; sort; each row shows question, project/work item, priority, brief status ("AI is preparing a brief…", "Brief failed: reason"), vote count, agenda.
- Detail: question and details; brief (context, options with pros/cons, recommendation marked "AI-prepared"; edit for raiser/PM/admin; retry when failed); responses thread with opinion box and vote buttons per option (my vote highlighted); Decide (PM/admin) with option picker and decision text; Withdraw with reason; link to work item; live updates.
- Raise discussion: dialog from the work item page (PM/members) and the task page (assignee), with question, details, priority, optional options, "ask AI for a brief" (default on; hidden for no-AI projects).
- Work item page: "Waiting on N discussions" banner with links; Advance button hidden while blocked.
- Agendas: list (upcoming first), create (title, date/time), detail with drag-to-reorder (or up/down buttons), add discussions from the open list; **Present** view: one discussion per screen with brief, vote summary and a Decide button, keyboard arrows to move; **Print**: a clean printable layout (browser print, CSS `@media print`) listing items with brief, options, votes, and blank space for notes.
- Staff only: `/discussions/*` and `/agendas/*` are staff paths.

- [ ] **Step 1: Write failing tests** for `sortDiscussions` (priority order urgent > high > normal > low, ties oldest first) and `voteSummary` (counts per option, recommended flag); nav test for the new staff paths.
- [ ] **Step 2: Run** `pnpm vitest run apps/portal` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Browser check (Playwright, port 3100):** as `somchai` raise a discussion from a task in Thai, see "AI is preparing a brief" then "Brief failed: AI is not set up" without a key; write options manually; vote; create an agenda, add it, open Present and Print preview; decide → work item continues and the decision appears in project Knowledge; `nurse1` can't open `/discussions`. Stop only processes you start.
- [ ] **Step 6: Commit** `git commit -m "feat(portal): discussions and meeting agendas"`
