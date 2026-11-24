# AI Work Portal ("Yoda") — System Design

Date: 2026-11-24
Status: Draft for approval

## 1. Intent

Change *who does the work* in the IT/DEV department. Today BA, SA, Dev, Tester/QC
and PM each produce their own work and the PM moves work between people. In the
target model **AI produces the first draft of every step**, and people shift to
**commenting, correcting, approving and deciding**. Success is the same team
delivering more, with human time spent mostly on judgment rather than producing
drafts.

The tool starts in IT/DEV but the working pattern (a coordinator orchestrating
people through steps) is general, so the design must not hard-code
software-development concepts into its core.

Nothing is broken today; this is an efficiency and way-of-working change.

## 2. Goals, non-goals, anti-goals

**Goals (first release, all required before real use)**
1. A portal where every staff member works, with four areas:
   - **Chat** with an AI secretary (text, files, images) — the main channel
     between staff and the system.
   - **To-do** — tasks asking a specific human to do something, with a place to
     submit the result.
   - **Pending discussions** — decisions the AI cannot or should not make,
     each with an AI-prepared brief; usable as a meeting agenda; staff post
     decisions/opinions back.
   - **Status** — overview of all projects and drill-down per project.
2. A per-project **knowledge store** (facts, memory, progress, documentation,
   decisions) shared by people and AI, so any AI session can resume work
   without its own persistent state.
3. An **AI task queue** that AI agents pick up, complete, and report back on.
4. **Automatic assignment** of work to the right staff member or agent.
5. GitLab integration: coding work flows through GitLab issues and merge
   requests.

**Non-goals (first release)**
- Replacing GitLab for code, review, or CI.
- Patient data handling (the department rarely works with it; see §4).
- Departments other than IT/DEV (design for it, don't build for it yet).
- Mobile apps (responsive web is enough).
- Time tracking, HR, or performance evaluation features.

**Anti-goals (would be failure even if it "works")**
- AI silently making decisions that belong to humans (approvals of
  requirements, designs, merges, releases).
- Staff having to maintain the same information in two places by hand.
- A knowledge store that fills with unverified AI guesses presented as fact.
- Lock-in to a single AI vendor.
- The AI becoming a nag: flooding people with low-value tasks and messages.

## 3. Users and roles

| Role | AI drafts | Human does |
|---|---|---|
| BA | Questions to ask the requester, list of data the project needs, first draft of requirements | Asks the questions, corrects, approves requirements |
| SA | Design proposal, data model, effort estimate | Comments, corrects, approves |
| Dev | Code as a merge request (from a GitLab issue) | Reviews, fixes, merges |
| Tester/QC | Test cases from requirements, test execution where automatable | Checks results, approves release |
| PM | Assignment, tracking, chasing, meeting briefs | Sets priorities, decides escalated discussions, controls AI autonomy |

A person may hold several roles; roles are per project (someone can be SA on one
project and Dev on another). There is also a system **Admin** role.

**Requester** (hospital staff outside IT/DEV — wards, finance, labs, etc.) uses
the portal with a limited view: their own chat thread with the secretary to
submit and discuss requests, status of their own requests, and to-dos the BA
step raises for them (answer questions, provide data/samples, accept the
delivered result). Requesters never see other projects, internal discussions,
knowledge beyond what's attached to their own requests, or GitLab links.

## 4. Constraints

- **Data:** cloud AI is acceptable for requirements, database schemas and source
  code. No patient data is expected. Provide a per-project and per-file
  "do not send to AI" flag; content so flagged is never included in AI context.
- **AI providers:** must support Anthropic and others (OpenAI, Gemini, possibly
  local). Server-side AI must use API keys or cloud-provider credentials
  (Anthropic does not permit third-party products to use claude.ai
  subscription login). Staff's personal subscriptions may be used only by
  coding agents running on their own machines (Claude Code / Codex, often via
  Orca), which is normal use of those tools.
- **Team stack:** the team works in Nuxt (with `@ramathibodi/nuxt-commons`) and
  Spring Boot (`rama-spring-starter`). The AI orchestration part is better
  served by TypeScript/Node than Spring; Spring remains the choice for any
  future integration with hospital systems.
- **GitLab:** self-hosted at `gitlab.example.org`, reachable only on the
  internal network.
- **Hosting:** on the department's own infrastructure (inside the network that
  can reach GitLab).
- **Scale:** ~30 IT staff, ~10 active projects at a time, plus an unknown but
  modest number of requesters. No horizontal scaling needed in v1; a single
  instance of each app is enough.
- **Builder:** one person working with AI coding agents; no fixed date. Favour
  fewer moving parts, boring well-documented libraries, and depth over breadth
  per screen: each of the four screens ships with its core flow, polish later.

## 5. Approaches considered

**A. Core service + separate agent runners + knowledge exposed via MCP — CHOSEN.**
Nuxt portal; a TypeScript core service holding tasks, the AI secretary, GitLab
integration and job queue; Postgres (+pgvector) as the single store; tasks and
knowledge exposed as an MCP server so any agent (Claude Code, Codex, Orca
workers, server-side agents) uses the same tools; runners that pull AI tasks.
Trade-off: we host and operate everything; in exchange we own the data, can
switch models per job, and can extend to other departments.

**B. Anthropic Managed Agents hosts the agents.** Less infrastructure, but
Claude-only, beta, billed per session runtime, conflicts with the multi-provider
requirement, and can't use staff subscriptions. Rejected.

**C. Assemble open-source tools** (Plane/OpenProject + Mattermost + Outline + an
AI bot). Fast screens, but the AI-first flow (result boxes, AI briefs, AI
deciding next steps) fights each tool's model, and knowledge is scattered over
four systems. Rejected.

**Orca's role:** Orca is a desktop app that runs coding agents in isolated git
worktrees. It is a good *worker* for dev tasks but cannot host the always-on
secretary or shared memory, so it is one runner option, not the core.

## 6. Architecture

```
                 ┌──────────────────────────────┐
  Staff browser ─►  portal  (Nuxt 4, SSR/SPA)    │
                 └──────────────┬───────────────┘
                                │ REST + SSE (realtime)
                 ┌──────────────▼───────────────────────────────┐
                 │  core  (Node/TypeScript)                      │
                 │  ├─ API (tasks, chat, discussions, status)    │
                 │  ├─ Secretary (event-driven AI coordinator)   │
                 │  ├─ Workflow engine (step templates)          │
                 │  ├─ Knowledge service (write rules, search)   │
                 │  ├─ AI gateway (provider-neutral, cost log)   │
                 │  ├─ GitLab integration (API + webhooks)       │
                 │  ├─ Job queue (pg-boss)                       │
                 │  └─ MCP server (tasks + knowledge tools)      │
                 └───┬──────────────┬──────────────┬────────────┘
                     │              │              │
          Postgres + pgvector   MinIO (files)   GitLab (issues, MRs, CI)
                     ▲
                     │ MCP (HTTP, token per runner)
      ┌──────────────┴────────────────────────────┐
      │ runners                                    │
      │  ├─ server runner: Claude Agent SDK / AI   │
      │  │   gateway, API key, sandboxed workdir   │
      │  └─ dev-machine runner: Claude Code/Codex  │
      │      (often via Orca), staff subscription  │
      └────────────────────────────────────────────┘
```

**Deployables:** `portal`, `core`, `runner` (+ Postgres, MinIO). One pnpm
monorepo: `apps/portal`, `apps/core`, `apps/runner`, `packages/shared` (types,
zod schemas, MCP tool definitions, API client).

**Stack (builder's starting point; my calls unless stated):**
- Portal: Nuxt 4 + the team's existing UI kit (`@ramathibodi/nuxt-commons` /
  Vuetify) for familiarity. Realtime via SSE from core.
- Core: Node 22, Fastify, Drizzle ORM, pg-boss for jobs, Vercel AI SDK as the
  provider-neutral layer for server-side AI calls, official MCP TypeScript SDK
  for the MCP server.
- Runner: Node CLI. Server runner uses the Claude Agent SDK for open-ended
  agent work (API key, or Bedrock/Vertex/Foundry). Dev-machine runner launches
  Claude Code or Codex locally.
- Storage: Postgres 16 + pgvector; MinIO for attachments.

## 7. Core domain model

Kept generic so non-IT departments can reuse it; IT-specific behavior lives in
workflow templates (§8).

- **Project** — name, description, members (person + roles), GitLab project
  link(s), AI settings (autonomy level, "no-AI" flag, model choices), status.
- **WorkItem** — a unit of business value moving through steps (e.g. "Add export
  to lab report screen"). Has a workflow template, current step, priority, owner
  (accountable human), state, links to GitLab issue/MR.
- **Task** — a concrete piece of work inside a WorkItem step. Fields: type
  (`human` | `ai` | `review` | `approval`), role required, assignee (person or
  runner), instructions, inputs (knowledge refs, attachments), result
  (text + attachments + structured fields), state
  (`proposed` → `open` → `in_progress` → `submitted` → `accepted` | `rejected`),
  due date, parent/child links.
- **Discussion** — a decision needed from humans. Fields: question, AI brief
  (context, options, trade-offs, AI recommendation), related WorkItem/Task,
  participants, responses (opinion/vote/decision), final decision, decided-by,
  state (`open` → `scheduled` (on a meeting agenda) → `decided` | `withdrawn`).
- **Conversation / Message** — chat threads between a person and the secretary
  (one default thread per person, plus threads attached to a project or work
  item). Messages carry text and attachments; AI messages can carry
  structured "actions" (created task X, raised discussion Y).
- **KnowledgeEntry** — see §10.
- **Event** — append-only log of everything that happens (task submitted, MR
  merged, decision made, message received). Drives the secretary and the
  status views; also the audit trail.
- **AgentRun** — one execution of an AI task: runner, model, tokens/cost,
  transcript reference, outcome.
- **Person** — staff member, roles, skills/areas tags, current load (computed),
  availability.

## 8. Workflow engine

A **workflow template** is an ordered set of steps, each with: role, task kind
(AI draft → human review/approval, or human task), entry conditions, outputs to
store as knowledge, and what triggers the next step.

Default IT template "Software change":

1. **Intake** — secretary gathers the request in chat, creates WorkItem, drafts
   a summary. Human (PM or BA) accepts the intake.
2. **BA** — AI drafts: questions for the requester, list of needed data, draft
   requirements. Human BA task: get answers, correct, submit. Approval task:
   BA approves requirements.
3. **SA** — AI drafts design proposal, data model, estimate (reads repo via
   GitLab for existing code/schema). SA reviews/corrects/approves.
4. **Dev** — core creates GitLab issue (§12). AI coding task is queued for a
   runner (or a human dev picks it). Output: MR. Human dev reviews and merges.
5. **QC** — AI drafts test cases from approved requirements (done in parallel
   with Dev), runs automatable tests. Tester checks results, approves release.
6. **Release/close** — PM or owner closes; AI writes the WorkItem summary into
   knowledge.

Templates are data (stored in DB, editable by Admin), not code, so smaller
change types ("bug fix": skip BA/SA) and other departments' processes can be
added without code changes. First release ships "Software change" and
"Bug fix"; a template editor UI is not required in v1 (seed via config file).

Any step may raise a **Discussion** instead of proceeding (e.g. conflicting
requirements, design options with real trade-offs, scope change). The WorkItem
waits on that step until the discussion is decided.

## 9. The secretary (AI coordinator)

An event-driven loop in `core`, not a long-lived chat session.

**Triggers:** new chat message; task submitted/accepted/rejected; discussion
decided; GitLab webhook (MR opened, pipeline status, review comment, merged);
scheduled sweep (every N minutes: overdue tasks, stuck work, idle people).

**On each trigger** it builds a context pack (§10.4) for the affected
project/work item and decides actions via tool calls against core's own API:
`create_task`, `assign`, `propose_assignment`, `advance_step`,
`raise_discussion`, `post_message`, `write_knowledge`, `request_info`,
`queue_ai_task`. Every action is recorded as an Event with the AI's stated
reason.

**Assignment logic:** candidates = project members with the required role;
ranked by AI using skills/areas tags, current open load, history on this work
item, availability. Hard rules (role required, not over a load cap) are applied
in code before/after the AI ranks.

**Autonomy levels** (per project, set by PM):
- `propose` (default): assignments, priority changes, and step advances appear
  as a one-click "confirm" item in the PM's to-do list.
- `auto-assign`: assignments and step advances happen directly; PM is notified.
- Always human, at every level: approval of requirements, design, merges,
  releases, and decisions in discussions.

**Anti-nag rules:** batch notifications into a digest; never create a task
without a clear expected result; deduplicate (don't re-ask what's in
knowledge); per-person cap on new tasks per day before escalating to PM.

**Chat behavior:** staff can ask anything ("what's blocking project X?",
"draft the BA questions for this request", attach a screenshot of an error).
The secretary answers from knowledge, turns requests into WorkItems/Tasks (with
confirmation), and files attachments into the project knowledge.

## 10. Knowledge store

### 10.1 Entry types
- **Fact** — short statement about the project ("Lab report screen uses table
  `lab_result_v2`"). Has source and confidence.
- **Decision** — outcome of a discussion or an approval, with who decided and why.
- **Document** — longer content: approved requirements, design, meeting brief,
  uploaded files (with extracted text).
- **Progress note** — what happened on a work item (written by AI after each
  task/run).
- **Memory** — AI working notes for continuing work (open questions, next
  steps), scoped to a work item.

### 10.2 Scope
Department → Project → WorkItem. Department-level holds shared standards
(coding conventions, architecture guidelines, glossary).

### 10.3 Trust rules (anti-goal: no AI guesses as fact)
- Every entry records `source` (person, AI run, GitLab, upload) and `status`:
  `draft` (AI-written, unverified) or `confirmed` (human-approved, or derived
  from an approved artifact/decision).
- Approved step outputs and decided discussions become `confirmed`
  automatically.
- AI context packs label drafts as unverified.
- Entries are versioned; superseded entries are kept but excluded from search.
- Respect "no-AI" flags: flagged entries are never placed in AI context.

### 10.4 Context packs (how AI sessions resume without persistence)
Any AI session (secretary call, server agent, dev-machine agent via MCP) starts
from a **context pack** assembled by core for a given task: task instructions;
work item summary and current step; confirmed decisions and requirements;
relevant facts/documents (pgvector similarity + explicit links); latest progress
notes and memory; links to GitLab issue/MR. On finishing, the agent must write a
progress note and update memory via MCP. This is what makes sessions
disposable.

### 10.5 Retrieval
Hybrid: Postgres full-text + pgvector embeddings, filtered by scope and status.
Embedding model is configurable through the AI gateway.

## 11. AI task execution

### 11.1 Task queue
AI tasks are `Task` rows with type `ai`, plus a pg-boss job. Each declares a
required **capability** (`draft-text`, `analyze-repo`, `code-change`,
`run-tests`) and preferred runner type.

- Simple drafting (`draft-text`) runs inside core via the AI gateway — no runner
  needed.
- Repo work (`analyze-repo`, `code-change`, `run-tests`) is claimed by a runner.

### 11.2 Runner protocol (MCP tools exposed by core)
`list_available_tasks(capabilities)`, `claim_task(id)` (lease with heartbeat;
lease expiry returns the task to the queue), `get_context_pack(task_id)`,
`search_knowledge(query, scope)`, `write_knowledge(entry)`,
`post_progress(task_id, note)`, `submit_result(task_id, result)`,
`ask_human(task_id, question)` (creates a to-do or discussion and parks the
task).

Because these are MCP tools, a developer can also run Claude Code/Codex
interactively, connected to the portal's MCP server, and work a task by hand
with full context.

### 11.3 Runner types
- **Server runner** — container on department infra; clones repo into an
  ephemeral workdir; runs Claude Agent SDK (API key or Bedrock/Vertex/Foundry);
  pushes a branch and opens an MR via GitLab API; sandboxed (no access beyond
  GitLab and core).
- **Dev-machine runner** — same protocol, started by a developer (e.g. as an
  Orca automation or a CLI); uses their local Claude Code/Codex and their own
  subscription; the developer stays in the loop.

Runner auth: each runner has a token tied to a person or service account;
results are attributed accordingly.

### 11.4 Cost control
AI gateway logs tokens and cost per call, per project, per task. Per-project
monthly budget with warning at 80% and hard stop (tasks go to human) at 100%.
Model per job type is configurable (cheap model for summaries/classification,
strong model for SA design and code).

## 12. GitLab integration

- Portal is the source of truth for tasks; GitLab holds code, MRs, CI.
- **Every coding task gets a GitLab issue, created by core**, containing: goal,
  approved requirements and design (summaries + link back to portal), relevant
  decisions, acceptance criteria, QC test cases. The issue is a snapshot core
  maintains; when requirements change, core edits the issue and adds a comment.
- MRs reference and close their issue (`Closes #N`); runners do this
  automatically and the portal's guidance tells human devs to.
- Result: a coding agent or a new developer can understand what was done and
  why by exploring the GitLab project alone.
- Webhooks from GitLab (MR events, pipeline events, notes) feed the Event log;
  the secretary advances the WorkItem (e.g. merged → open QC approval).
- Auth: a GitLab service account (bot user) per instance with API access to
  linked projects.

## 13. Portal screens

**Chat** — left: thread list (personal thread with secretary + project/work
item threads). Main: messages with attachments and image paste; AI action cards
("Created task: Draft BA questions → assigned to Somchai [Confirm] [Change]").

**To-do** — my tasks grouped by state and project; filters. Task detail:
instructions, context (linked knowledge, AI draft if any), result box (rich
text + attachments + structured fields from the template), actions (Submit,
Reject AI draft with reason, Ask question, Reassign request). Review/approval
tasks show the artifact with inline comments and Approve / Request changes.

**Pending discussions** — list sortable by priority/project; "agenda" view for
a meeting (select items → ordered agenda, printable/presentable). Discussion
detail: AI brief (context, options, trade-offs, recommendation), responses
thread, record decision (decision text + who decided). Decision flows back to
the work item and knowledge.

**Requester view** — the same app with a reduced menu: "My requests" (list +
status timeline in plain language), chat with the secretary, and "Things I need
to answer" (their to-dos). Intake starts here: the secretary interviews the
requester, collects attachments, and creates the WorkItem for IT to accept.

**Status** — department overview: projects with health (on track / at risk /
blocked), counts by step, overdue items, AI spend. Project view: work items
board by step, recent events timeline, open discussions, people load, links to
GitLab. AI-written weekly summary per project.

## 14. Security and access

- Authentication: hospital **Keycloak** via OIDC for both IT staff and
  requesters; a local Keycloak realm (or dev-only bypass) for development.
  A Person record is created on first login from the Keycloak profile.
- Distinguishing staff from requesters: membership of an IT/DEV Keycloak group
  (or a portal-side flag set by Admin if no such group exists). Everyone else
  who logs in is a Requester.
- Skills/areas tags and per-project roles are maintained in the portal by
  Admin/PM (Keycloak doesn't hold them).
- Authorization: project membership + role; Admin for templates, AI settings,
  runner tokens. Staff see projects they belong to; department-level knowledge
  visible to all staff. Requesters see only their own requests (§3).
- All AI actions are auditable via the Event log with model, prompt reference,
  and reason.
- Secrets (AI keys, GitLab token) in environment/secret store, never in DB rows
  readable by the portal.

## 15. Deployment and operations

Docker Compose for first release on department infrastructure (portal, core,
runner, Postgres, MinIO), deployed via GitLab CI. Structured logs; health
endpoints; daily Postgres backups. Kubernetes is not required for v1.

## 16. Left to the builder

- Exact table schemas, API routes, and component structure.
- Prompt design for each step, the secretary, and context-pack assembly.
- Choice between Fastify vs. similar, Drizzle vs. Prisma, if there's a strong
  reason.
- Embedding model choice and chunking strategy.
- Notification channel beyond the portal (email/LINE) — portal-only is
  acceptable for v1.
- Build order within the first release (all four screens must ship together).

## 17. Designer's calls (settled after builder review — check these)

1. **Language:** staff and AI work in mixed Thai/English. UI is bilingual
   (Thai default, English toggle) via i18n. Because Postgres full-text search
   doesn't segment Thai, retrieval uses pgvector + `pg_trgm` trigram matching
   instead of FTS. Embedding model must handle Thai well. GitLab issues are
   written in the language of the source requirements.
2. **Network/providers:** core and server runner can make outbound HTTPS calls
   to AI providers (proxy configurable). v1 ships Anthropic (direct API key)
   plus one OpenAI-compatible provider through the gateway; Bedrock/Vertex and
   local models are config additions later, not v1 work.
3. **GitLab sync is one-way for issue content:** core owns a marked section of
   the issue body and rewrites only that section. Dev comments and label changes
   on the issue are pulled in as Events (and comments as draft knowledge), never
   overwritten. No bulk import of existing GitLab issues in v1: projects are
   linked and start fresh; an individual issue can be imported by hand into a
   new WorkItem.
4. **Dev-machine runners are on-demand only:** a developer starts each task
   (e.g. "work task 123" from the portal, Orca, or CLI). No unattended polling
   on personal subscriptions. Unattended work runs only on the server runner
   with API keys.
5. **"Run automatable tests" in v1** = read GitLab CI pipeline results and have
   AI generate test cases (and, where the repo has a test suite, add tests in
   the MR). No deployment of test environments or end-to-end runs by the system
   in v1.
6. **Multi-repo work items:** one GitLab issue per repo involved, cross-linked;
   the WorkItem tracks all of them; the Dev step completes (and QC opens) only
   when every linked MR is merged.

## 18. Open questions

None blocking. Resolved with the requester: requesters use the portal with a
limited view; SSO is hospital Keycloak; ~30 staff / ~10 projects; built by one
person with AI.
