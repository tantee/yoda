# Knowledge & AI Gateway (Plan 3 of 8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each project gets a shared knowledge store (facts, decisions, documents, progress notes, memory, uploaded files) that people and AI both read and write with draft/confirmed trust; a provider-neutral AI gateway logs every call's cost against a per-project budget; and AI "drafting" tasks (requirements, design, test cases) are now actually written by AI from a context pack and handed to the next human step for review.

**Architecture:** New core modules: `storage/` (S3-compatible object storage on MinIO), `knowledge/` (versioned entries, chunking, embeddings, hybrid search, context packs), `ai/` (gateway over the Vercel AI SDK with model routing, price table, cost log, budget guard), and `jobs/` (pg-boss queue for embedding and drafting). The workflow engine gains an actor kind (`person`/`system`/`ai`), writes knowledge when tasks are accepted/approved, and enqueues a drafting job whenever an `ai` task with capability `draft-text` is created. Portal gets a project Knowledge tab, AI settings, and shows AI drafts and attachments on tasks.

**Tech Stack:** as plans 1–2, plus `ai` (Vercel AI SDK, current major) with `@ai-sdk/anthropic` and `@ai-sdk/openai` (OpenAI-compatible base URL configurable); `pg-boss`; `@aws-sdk/client-s3`; `@fastify/multipart`; `unpdf` (PDF text) and `mammoth` (DOCX text). Tests use the AI SDK's mock models (`ai/test`) — no network calls in tests.

**Spec:** `docs/superpowers/specs/2026-11-24-ai-work-portal-design.md` (§10 knowledge store, §11.1 task queue, §11.4 cost control, §4 data constraints, §17 calls 1–2). Plan 2 follow-ups: `docs/superpowers/plans/2026-11-24-02-work-model-todo-followups.md`.

**Not in this plan:** the chat secretary and step-advance confirmation (plan 4), discussions (plan 5), GitLab issues (plan 6), MCP server and repo-working runners — `analyze-repo`/`code-change`/`run-tests` capabilities stay "Waiting for AI" for a person to take (plan 7), images sent to multimodal models (later).

## Global Constraints

- Knowledge entry types: `fact`, `decision`, `document`, `progress`, `memory`. Scopes: department → project → work item. Department-level entries are visible to all staff.
- Every entry records `source` (person, ai run, upload, task) and `status` `draft` (AI-written, unverified) or `confirmed` (human-approved, or derived from an approved artifact). AI context labels drafts as unverified.
- Entries are versioned; superseded versions are kept but excluded from search and context.
- "Do not send to AI": project `noAi`, per-entry and per-attachment `noAi` flags — such content is never placed in AI context; a `noAi` project gets no AI calls at all.
- Retrieval is hybrid: pgvector embeddings + `pg_trgm` trigram matching (Postgres full-text doesn't segment Thai). Embedding dimension is fixed at **1024**. If no embedding model is configured, search falls back to trigram only.
- AI providers in v1: Anthropic (API key) and one OpenAI-compatible provider (base URL configurable). Server-side AI never uses personal subscriptions.
- Model routing per job: `AI_MODEL_DRAFT` default `anthropic:claude-opus-5-5`; `AI_MODEL_FAST` default `anthropic:claude-haiku-5-5`; `AI_EMBEDDING_MODEL` default unset (format `openai:text-embedding-3-small`).
- Cost: every AI call logs tokens and cost per project/task. Per-project monthly budget: warning event at 80%, hard stop at 100% (AI tasks go to humans).
- Approvals stay human; AI output enters the workflow only as the result of an `ai` task, which the following human task reviews.
- Requesters get 403 on every knowledge, attachment and AI route; non-member staff get 404 for project-scoped items.
- Repo is public: API keys only from env; `.env.example` has empty placeholders; no keys in tests or fixtures.
- Follow plan 1–2 patterns (HttpError helpers, `runWork`, `recordEvent`, test helpers, i18n parity, Thai default).

## Review Focus

1. **An entry or file flagged "no AI" (or any content in a `noAi` project)** never reaches a prompt — not via search, context packs, task inputs, or drafting. Tests in Task 6 and Task 8.
2. **Budget reached mid-month** → the next AI call is refused before contacting the provider, the drafting task returns to humans with reason `budget_exceeded`, and the 80% warning fires once per month, not on every call. Tests in Task 4 and Task 8.
3. **Provider down / model error / empty output during drafting** → task stays unassigned and visible to the PM with reason `ai_failed`, job not retried endlessly (max 2 retries), no partial result stored. Test in Task 8.
4. **Thai text** in entries, file names and extracted text round-trips and is findable by trigram search with a short Thai query. Test in Task 5.
5. **Large or unsupported uploads** (over 25 MB, executables) → rejected with 413/415 before writing to storage; PDFs/DOCX with no extractable text still upload, just without searchable text. Test in Task 3.

---

### Task 1: Shared schemas, template capabilities, config

**Files:**
- Create: `packages/shared/src/knowledge.ts`; Modify: `packages/shared/src/work.ts`, `packages/shared/src/projects.ts`, `packages/shared/src/index.ts`
- Modify: `apps/core/src/workflow/templates/software-change.json`, `bug-fix.json`, `apps/core/src/config.ts`, `.env.example`
- Test: `packages/shared/test/knowledge.test.ts`, extend `packages/shared/test/work.test.ts`, `apps/core/test/templates.test.ts`, `apps/core/test/app.test.ts` (config)

**Interfaces:**
- Produces (shared, each with same-named `z.infer` type):
  - `KnowledgeType = z.enum(['fact','decision','document','progress','memory'])`, `KnowledgeStatus = z.enum(['draft','confirmed'])`, `KnowledgeScope = z.enum(['department','project','work_item'])`, `SourceKind = z.enum(['person','ai','upload','task'])`
  - `KnowledgeEntry = z.object({ id: uuid, lineageId: uuid, version: z.number().int(), scope: KnowledgeScope, projectId: uuid.nullable(), workItemId: uuid.nullable(), type: KnowledgeType, title: z.string(), body: z.string(), status: KnowledgeStatus, sourceKind: SourceKind, sourceRef: z.string().nullable(), noAi: z.boolean(), attachmentId: uuid.nullable(), createdById: uuid.nullable(), createdByName: z.string().nullable(), createdAt: z.string() })`
  - `KnowledgeCreate = z.object({ scope: KnowledgeScope, projectId: uuid.optional(), workItemId: uuid.optional(), type: KnowledgeType, title: z.string().trim().min(1).max(300), body: z.string().max(200000).default(''), noAi: z.boolean().default(false) })` with refine: `department` → no ids; `project` → projectId required; `work_item` → workItemId required.
  - `KnowledgeUpdate = z.object({ title: ..., body: ..., noAi: z.boolean().optional() })` (all optional, at least one).
  - `KnowledgeSearchHit = KnowledgeEntry.extend({ score: z.number(), snippet: z.string() })`
  - `Attachment = z.object({ id: uuid, projectId: uuid, workItemId: uuid.nullable(), taskId: uuid.nullable(), fileName: z.string(), contentType: z.string(), sizeBytes: z.number().int(), noAi: z.boolean(), hasText: z.boolean(), uploadedById: uuid, uploadedByName: z.string(), createdAt: z.string() })`
  - `TaskCapability = z.enum(['draft-text','analyze-repo','code-change','run-tests'])`; `TemplateTask` gains `capability: TaskCapability.optional()`; `validateTemplate` adds: an `ai` task must have a capability; a non-`ai` task must not.
  - `TaskInput = z.object({ templateTaskKey: z.string(), title: LocalizedText, executor: TaskExecutor, result: TaskResult, attachments: z.array(Attachment) })`; `TaskWithContext` gains `inputs: z.array(TaskInput)` and `attachments: z.array(Attachment)`.
  - `ActorKind = z.enum(['person','system','ai'])`; `EventEntry` gains `actorKind: ActorKind`; `EventType` adds `'ai.drafted','ai.failed','ai.budget_warning','ai.budget_exceeded','knowledge.created','knowledge.updated','knowledge.confirmed'`.
  - `AiUsage = z.object({ month: z.string(), costUsd: z.number(), budgetUsd: z.number().nullable(), calls: z.number().int() })`
  - `Project` gains `aiBudgetUsd: z.number().nullable()`; `ProjectPatch` becomes `z.object({ autonomy: ..., noAi: z.boolean(), aiBudgetUsd: z.number().min(0).nullable() }).partial()` refined to at least one key.
- Templates: `draft-requirements`, `draft-design`, `draft-tests` → `capability 'draft-text'`; `implement` → `'code-change'`.
- Config additions (`Config` fields in parentheses): `ANTHROPIC_API_KEY` (`anthropicApiKey?`), `OPENAI_API_KEY` (`openaiApiKey?`), `OPENAI_BASE_URL` (`openaiBaseUrl?`), `AI_MODEL_DRAFT` (`aiModelDraft`, default above), `AI_MODEL_FAST` (`aiModelFast`), `AI_EMBEDDING_MODEL` (`aiEmbeddingModel?`), `S3_ENDPOINT` (`s3Endpoint`, default `http://localhost:9000`), `S3_REGION` (default `us-east-1`), `S3_BUCKET` (default `yoda`), `S3_ACCESS_KEY` / `S3_SECRET_KEY` (required; dev values in `.env.example` marked `# DEV ONLY` matching docker-compose MinIO), `AI_WORKERS` (`aiWorkers`, default `2`). Model strings validated as `provider:model` with provider in `anthropic|openai`.

- [ ] **Step 1: Write failing tests:** `KnowledgeCreate` with scope `project` and no `projectId` fails; scope `department` with a `projectId` fails; title `'  ตารางผลแล็บ '` trims; `validateTemplate` flags an `ai` task without capability and a `human` task with one; both shipped templates still validate; `loadConfig` rejects `AI_MODEL_DRAFT='claude-opus-5-5'` (no provider) and accepts `anthropic:claude-opus-5-5`; `ProjectPatch.parse({})` fails, `{ aiBudgetUsd: null }` passes.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared apps/core/test/templates.test.ts apps/core/test/app.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** schemas, template edits, config, `.env.example` (empty `ANTHROPIC_API_KEY=`, `OPENAI_API_KEY=`).
- [ ] **Step 4: Run** the same — Expected: PASS; then `pnpm vitest run` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(shared): knowledge, attachment, AI schemas and task capabilities"`

---

### Task 2: Tables and migration

**Files:**
- Modify: `apps/core/src/db/schema.ts`, `apps/core/test/helpers.ts` (`resetDb` truncates new tables)
- Create: `apps/core/drizzle/0005_*.sql` (generated + hand edits noted below)
- Test: `apps/core/test/knowledge-db.test.ts`

**Interfaces:**
- Produces tables (uuid pks, timestamptz `not null default now()`):
  - `attachments`: `id`, `project_id → projects cascade`, `work_item_id → work_items cascade null`, `task_id → tasks cascade null`, `storage_key text not null unique`, `file_name text not null`, `content_type text not null`, `size_bytes bigint not null`, `no_ai bool not null default false`, `extracted_text text null`, `uploaded_by → people not null`, `created_at`.
  - `knowledge_entries`: `id`, `lineage_id uuid not null`, `version int not null`, `scope text` (check), `project_id → projects cascade null`, `work_item_id → work_items cascade null`, `type text` (check), `title text not null`, `body text not null default ''`, `status text` (check), `source_kind text` (check), `source_ref text null`, `no_ai bool not null default false`, `attachment_id → attachments cascade null`, `created_by → people null`, `superseded_at timestamptz null`, `created_at`; unique `(lineage_id, version)`; partial unique `(lineage_id) where superseded_at is null`; check scope/ids consistency (`department` ⇒ both ids null; `project` ⇒ project_id not null and work_item_id null; `work_item` ⇒ both not null); GIN trigram indexes on `title` and `body` (`gin_trgm_ops`).
  - `knowledge_chunks`: `id`, `entry_id → knowledge_entries cascade`, `idx int`, `text text not null`, `embedding vector(1024) null`, `created_at`; unique `(entry_id, idx)`; HNSW index on `embedding vector_cosine_ops`; GIN trigram index on `text`.
  - `ai_calls`: `id`, `project_id → projects cascade null`, `task_id → tasks set null null`, `job text not null`, `provider text`, `model text`, `input_tokens int`, `output_tokens int`, `cost_usd numeric(12,6) null`, `ok bool not null`, `error text null`, `created_at`; index `(project_id, created_at)`.
  - `projects` gains `ai_budget_usd numeric(12,2) null`.
  - `events` gains `actor_kind text not null default 'person'` (check person/system/ai); existing rows with `actor_id null` updated to `'system'` in the migration.

- [ ] **Step 1: Write failing tests:** inserting two non-superseded rows with the same `lineage_id` throws; a `project` scope row without `project_id` throws; a 1024-dim embedding inserts and a 3-dim one throws; `events.actor_kind` defaults to `person`; `pg_indexes` contains the HNSW index on `knowledge_chunks`.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/knowledge-db.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** schema (drizzle `vector` column type with `dimensions: 1024`), generate migration, hand-add anything drizzle can't express (trigram GIN ops, HNSW, partial unique, the `actor_kind` backfill).
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(core): knowledge, attachment, ai call tables"`

---

### Task 3: Object storage and attachments API

**Files:**
- Create: `apps/core/src/storage/s3.ts`, `apps/core/src/attachments/extract.ts`, `apps/core/src/attachments/service.ts`, `apps/core/src/routes/attachments.ts`
- Modify: `apps/core/src/app.ts` (`AppDeps` gains `storage: Storage`; register `@fastify/multipart` with `limits.fileSize = 25 * 1024 * 1024`), `apps/core/src/server.ts`, `apps/core/test/helpers.ts` (`testDeps` storage uses a unique key prefix per test run against the dev MinIO), `docker-compose.yml` (nothing to change if MinIO is present — verify bucket auto-create works)
- Test: `apps/core/test/attachments.test.ts`

**Interfaces:**
- Produces:
  - `interface Storage { put(key: string, body: Buffer, contentType: string): Promise<void>; get(key: string): Promise<NodeJS.ReadableStream>; remove(key: string): Promise<void> }`; `createS3Storage(config): Promise<Storage>` (creates the bucket if missing; `forcePathStyle: true`).
  - `extractText(buf: Buffer, contentType: string, fileName: string): Promise<string | null>` — `text/plain`, `text/markdown`, `text/csv`, `application/json` → UTF-8 text; `application/pdf` → `unpdf`; DOCX (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`) → `mammoth`; images and others → `null`; extraction errors → `null` (never throws); result trimmed, empty → `null`, capped at 500 000 chars.
  - Allowed content types: the text types above, PDF, DOCX, XLSX, PPTX, `image/png`, `image/jpeg`, `image/gif`, `image/webp`; anything else → 415 `{ error: 'unsupported_type' }`. Over 25 MB → 413 `{ error: 'too_large' }`.
  - Routes (`requireStaff`; project member or admin, else 404):
    - `POST /projects/:id/attachments` multipart fields `file`, optional `workItemId`, `taskId`, `noAi` → 201 `Attachment`. Storage key `projects/<projectId>/<uuid>/<sanitized file name>`. When text was extracted, also creates a `document` knowledge entry (scope `work_item` if `workItemId` else `project`, `sourceKind 'upload'`, status `confirmed`, `title` = file name, `body` = extracted text, `attachmentId`, `noAi` copied) via the knowledge service from Task 5 — **until Task 5 lands, call a `onAttachmentStored` hook that Task 5 fills in** (default no-op).
    - `GET /projects/:id/attachments?workItemId=&taskId=` → `Attachment[]` newest first.
    - `GET /attachments/:id/download` → streams the object with `Content-Type` and `Content-Disposition: attachment; filename*=UTF-8''<encoded name>`.
    - `PATCH /attachments/:id` body `{ noAi: boolean }` → `Attachment` (uploader, project PM, or admin; propagates to its knowledge entry).
  - `workItemId`/`taskId` must belong to the project, else 404.

- [ ] **Step 1: Write failing tests:** uploading `ผลแล็บ.txt` with Thai content → 201, `hasText true`, download returns identical bytes and a UTF-8 `filename*`; a tiny generated PDF with text → `hasText true`; a PDF with no text layer (generate one with only a drawn rectangle, or use a fixture created in the test) → 201 `hasText false`; `application/x-msdownload` → 415 and nothing in storage; a 26 MB buffer → 413; requester → 403; non-member staff → 404 on upload, list and download; `PATCH noAi true` by the uploader → 200, by an unrelated member → 403.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/attachments.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(core): object storage and attachments with text extraction"`

---

### Task 4: AI gateway — providers, routing, cost log, budgets

**Files:**
- Create: `apps/core/src/ai/models.ts`, `apps/core/src/ai/prices.json`, `apps/core/src/ai/gateway.ts`
- Modify: `apps/core/src/app.ts` (`AppDeps` gains `ai: AiGateway`), `apps/core/src/server.ts`, `apps/core/test/helpers.ts` (`testDeps` uses a gateway built from mock models)
- Test: `apps/core/test/ai-gateway.test.ts`

**Interfaces:**
- Produces:
  - `type AiJob = 'draft' | 'fast' | 'embed'`
  - `type ModelSet = { draft: LanguageModel; fast: LanguageModel; embed: EmbeddingModel<string> | null; ids: Record<AiJob, string | null> }` (AI SDK types); `buildModels(config: Config): ModelSet` — parses `provider:model`, `anthropic` via `@ai-sdk/anthropic` (`anthropicApiKey`), `openai` via `@ai-sdk/openai` with `baseURL = openaiBaseUrl`; embeddings requested with `dimensions: 1024` (provider option); a configured provider whose API key is missing does **not** crash startup — log one warning naming the env var and mark that job's model unavailable (`ids[job] = null`).
  - `prices.json`: `{ "claude-opus-5-5": { "inputPerMTok": 4, "outputPerMTok": 20 }, "claude-sonnet-5-5": { "inputPerMTok": 2, "outputPerMTok": 10 }, "claude-haiku-5-5": { "inputPerMTok": 0.1, "outputPerMTok": 0.5 }, "text-embedding-3-small": { "inputPerMTok": 0.02, "outputPerMTok": 0 } }`; unknown model → `cost_usd null` (logged once as a warning).
  - `class AiGateway { constructor(deps: { db: Db; bus: LiveBus; models: ModelSet }); generateText(input: { job: 'draft' | 'fast'; projectId: string | null; taskId?: string | null; system: string; prompt: string; maxOutputTokens?: number }): Promise<{ text: string; model: string }>; embed(input: { projectId: string | null; texts: string[] }): Promise<number[][] | null> }`
    - Before calling: if `projectId` and the project is `noAi` → throws `AiRefused('no_ai')`; if the project's budget is set and this month's `sum(cost_usd)` ≥ budget → records event `ai.budget_exceeded` (once per project per month — skip if one exists this month) and throws `AiRefused('budget_exceeded')`.
    - After each call (success or failure) inserts an `ai_calls` row (`ok`, `error` message, tokens from usage, cost from the price table).
    - After a successful call, if month-to-date cost crosses 80% of budget and no `ai.budget_warning` event exists for this project this month → record `ai.budget_warning` (actor kind `system`, payload `{ costUsd, budgetUsd }`).
    - `generateText` uses streaming internally with the AI SDK and returns the final text; empty text → throws `AiFailed('empty_output')`; unavailable model → throws `AiFailed('not_configured')` without logging an `ai_calls` row.
    - `embed` returns `null` when no embedding model is configured.
  - `class AiRefused extends Error { reason: 'no_ai' | 'budget_exceeded' }`, `class AiFailed extends Error { reason: string }`.
  - `monthUsage(db: Db, projectId: string): Promise<AiUsage>` (calendar month in `Asia/Bangkok`).
  - Route `GET /projects/:id/ai-usage` → `AiUsage` (member or admin).
  - `PATCH /projects/:id` accepts `noAi` and `aiBudgetUsd` (existing PM/admin rule).

- [ ] **Step 1: Write failing tests** (mock models from `ai/test` returning fixed text and usage `{ inputTokens: 1000, outputTokens: 500 }` on model id `claude-opus-5-5`):
  - successful `generateText` → returns the text, one `ai_calls` row with `ok true`, `cost_usd 0.014`.
  - mock throwing → `AiFailed`, `ai_calls` row with `ok false` and the error message.
  - `noAi` project → `AiRefused('no_ai')`, the mock was never called, no row.
  - budget `0.02`: first call ok (cost 0.014 → 70%), second call ok (0.028 ≥ 80% → one `ai.budget_warning`), third call refused `budget_exceeded` without calling the mock, fourth call refused again with still exactly one `ai.budget_exceeded` event this month.
  - `embed` with no embedding model → `null`; with a mock embedding model returning 1024-length vectors → those vectors.
  - `GET /projects/:id/ai-usage` → `{ costUsd, budgetUsd, calls }` matching; requester 403.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/ai-gateway.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Check the installed AI SDK's API (streaming text call, usage field names, mock model class names) against its README in `node_modules/ai` rather than memory.
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(core): provider-neutral AI gateway with cost log and budgets"`

---

### Task 5: Knowledge service, jobs, search, REST API

**Files:**
- Create: `apps/core/src/jobs/queue.ts`, `apps/core/src/knowledge/service.ts`, `apps/core/src/knowledge/chunk.ts`, `apps/core/src/knowledge/search.ts`, `apps/core/src/routes/knowledge.ts`
- Modify: `apps/core/src/app.ts` (`AppDeps` gains `jobs: JobQueue`), `apps/core/src/server.ts` (start workers), `apps/core/src/attachments/service.ts` (fill the `onAttachmentStored` hook), `apps/core/test/helpers.ts` (`testDeps` jobs run inline: `InlineJobQueue` executes handlers immediately after commit)
- Test: `apps/core/test/knowledge.test.ts`, `apps/core/test/chunk.test.ts`

**Interfaces:**
- Produces:
  - `type JobName = 'embed-entry' | 'draft-task'`; `type JobRun = { id: string; attempt: number; isFinalAttempt: boolean }` (`attempt` starts at 1; with retryLimit 2 the 3rd attempt is final).
  - `interface JobQueue { send(name: JobName, data: { id: string }): Promise<void>; work(name: JobName, handler: (run: JobRun) => Promise<void>): Promise<void>; stop(): Promise<void> }`; `createPgBossQueue(databaseUrl: string, concurrency: number): Promise<JobQueue>` (pg-boss, retryLimit 2, retryDelay 30 s, expireIn 10 min); `InlineJobQueue` for tests: same retry semantics without delays (a throwing handler is re-run until it succeeds or its final attempt throws, which is then swallowed), `drain(): Promise<void>` resolves when every sent job has finished. Jobs are sent only after the surrounding transaction commits.
  - `chunkText(text: string, maxChars = 1500, overlap = 200): string[]` — splits on blank lines, then sentence ends (`.`, `?`, `!`, Thai has no sentence punctuation so also split on `\n` and on spaces near the limit), never cuts a chunk longer than `maxChars`, consecutive chunks overlap by up to `overlap` chars.
  - Service (all mutations run in `runWork`, record `knowledge.*` events with the work item/project ids, and enqueue `embed-entry` after commit):
    - `createEntry(ctx: WorkCtx, me: Me | null, input: KnowledgeCreate & { status?: KnowledgeStatus; sourceKind?: SourceKind; sourceRef?: string | null; attachmentId?: string | null }): Promise<string>` — `status` defaults to `confirmed` when `sourceKind 'person'`, `draft` when `'ai'`; department scope requires admin.
    - `updateEntry(ctx, me, id, patch: KnowledgeUpdate): Promise<string>` — inserts version+1 with the same lineage, sets `superseded_at` on the old row, status becomes `confirmed` if `me` is a person (a human edit verifies it); returns new id.
    - `confirmEntry(ctx, me, id)` — `draft → confirmed` (new version, event `knowledge.confirmed`).
    - Department-scope entries record no events (events need a project); project/work-item entries do.
    - Permissions: read = department entries for all staff; project/work-item entries for members or admin. Write = project members (any role) or admin; department = admin.
  - Embedding job `embed-entry`: deletes the entry's chunks, re-chunks `title + '\n\n' + body`, embeds via `ai.embed` (skips vectors when `null`), inserts chunks; entries with `noAi` are chunked but never embedded (no text leaves the system).
  - `searchKnowledge(db: Db, me: Me, q: { query: string; projectId?: string; workItemId?: string; limit?: number; forAi?: boolean }): Promise<KnowledgeSearchHit[]>` — visible, non-superseded entries in scope (work item → its project → department); hybrid ranking with reciprocal rank fusion `score = Σ 1/(60 + rank)` over (a) trigram `word_similarity(query, chunk.text)` top 50 and (b) cosine distance top 50 when the query can be embedded; `forAi: true` excludes `noAi` entries, entries of `noAi` attachments, and all entries of `noAi` projects; snippet = best chunk text cut to 300 chars; default limit 10.
  - Routes (`requireStaff`): `GET /knowledge?projectId=&workItemId=&type=&status=` (list current versions, newest first), `GET /knowledge/search?q=&projectId=&workItemId=`, `GET /knowledge/:id` (current or any version), `GET /knowledge/:id/versions`, `POST /knowledge` (`KnowledgeCreate`), `PATCH /knowledge/:id` (`KnowledgeUpdate`), `POST /knowledge/:id/confirm`.
  - Upload hook: text-bearing attachments create their `document` entry (Task 3 rule).

- [ ] **Step 1: Write failing tests:** `chunkText` on 4000 chars of Thai without punctuation → every chunk ≤ 1500 chars and joined chunks cover the text; create → update → `GET /knowledge/:id/versions` lists 2 with the first superseded; search excludes the superseded version's text; Thai trigram search `'ผลแล็บ'` finds an entry titled `'ตารางผลแล็บผู้ป่วยนอก'` with no embedding model; with a mock embedding model, a query whose vector equals an entry's chunk vector ranks that entry first; `forAi: true` excludes a `noAi` entry that `forAi: false` returns; non-member staff → 404 on a project entry, 200 on a department entry; requester → 403; creating a department entry as non-admin → 403; uploading a `.txt` attachment creates a confirmed `document` entry with `attachmentId`.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/knowledge.test.ts apps/core/test/chunk.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(core): knowledge service with versioning, jobs and hybrid search"`

---

### Task 6: Engine hooks — actor kind, knowledge on accept/approve, task inputs

**Files:**
- Modify: `apps/core/src/work/context.ts`, `apps/core/src/work/engine.ts`, `apps/core/src/work/queries.ts`, `apps/core/src/routes/work.ts` (if needed)
- Test: extend `apps/core/test/engine.test.ts`, `apps/core/test/work-api.test.ts`

**Interfaces:**
- Produces:
  - `WorkCtx` gains `actorKind: ActorKind`; `runWork(deps, actor: { id: string | null; kind: ActorKind }, fn)` (update all callers: people → `{ id: me.id, kind: 'person' }`); `recordEvent` writes `actor_kind`. `EventEntry.actorKind` returned by queries.
  - On `task.accepted` of an `ai` or `human` task with non-empty result text: create a `progress` entry (scope `work_item`, title = template task title in Thai, body = result text, `sourceKind 'task'`, `sourceRef = taskId`, status `draft` if the task's executor is `ai`, else `confirmed`).
  - On `approve` of an `approval` task: for each `dependsOn` task's latest accepted attempt, create a `document` entry (scope `work_item`, title = that task's Thai title, body = its result text, `sourceKind 'task'`, `sourceRef` = that task id, status `confirmed`), and mark that task's earlier `progress` draft entry (same `sourceRef`) confirmed.
  - `TaskWithContext.inputs`: for each `dependsOn` key, the latest accepted attempt's result, executor, title and its attachments; `TaskWithContext.attachments`: attachments with this `taskId`.
  - `submitTask` accepts `attachmentIds?: string[]` in the body (extend shared `TaskResult` with `attachmentIds: z.array(uuid).max(20).default([])`); they must belong to the task's project and are linked to the task (`attachments.task_id`).

- [ ] **Step 1: Write failing tests:** in a bug-fix flow, after `implement` (taken over by a human) is accepted, a `progress` entry with `sourceRef` = that task exists, status `confirmed`; after `review-code` approves, a `document` entry for `implement` exists, status `confirmed`; an `ai`-executor task accepted with result text produces a `draft` progress entry that becomes `confirmed` when the approval approves it; `GET /tasks/:reviewTaskId` has one input with the implement result text; events created by a person carry `actorKind 'person'`, events from `runWork` with kind `system` carry `'system'`; submitting with an attachment id from another project → 404.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/engine.test.ts apps/core/test/work-api.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(core): actor kinds, knowledge from accepted work, task inputs"`

---

### Task 7: Context packs

**Files:**
- Create: `apps/core/src/knowledge/context-pack.ts`
- Modify: `packages/shared/src/knowledge.ts` (`ContextPack` schema)
- Test: `apps/core/test/context-pack.test.ts`

**Interfaces:**
- Produces:
  - `ContextPack = z.object({ task: z.object({ id, title: LocalizedText, instructions: LocalizedText, feedback: z.string().nullable(), stepKey, attempt }), workItem: z.object({ id, title, description, priority }), project: z.object({ id, name, description }), inputs: z.array(z.object({ title: z.string(), text: z.string() })), documents: z.array(PackEntry), decisions: z.array(PackEntry), progress: z.array(PackEntry), memory: z.array(PackEntry), related: z.array(PackEntry) })` where `PackEntry = z.object({ id, title, text, status: KnowledgeStatus, type: KnowledgeType })`.
  - `buildContextPack(db: Db, taskId: string, opts?: { maxChars?: number }): Promise<ContextPack>` — throws `AiRefused('no_ai')` if the project is `noAi`. Fills: `inputs` = Task 6 inputs (attachment extracted text appended when not `noAi`); `documents`/`decisions` = current confirmed entries of the work item then project (department decisions too); `progress` = latest 10 work-item progress entries; `memory` = work-item memory entries; `related` = `searchKnowledge(..., { forAi: true, limit: 8 })` with query = work item title + task English title, minus entries already included. Excludes every `noAi` entry/attachment. Trims to `maxChars` (default 60 000) by dropping `related` from the bottom, then `progress`, then truncating document texts — never trimming `task`, `workItem`, or `inputs` below what fits (truncate inputs last with a `…[truncated]` marker).
  - `renderContextPack(pack: ContextPack): string` — Markdown with sections in this order: Task (English + Thai title, instructions, "Changes requested" feedback if any), Work item, Project, Inputs from previous steps, Confirmed documents, Decisions, Recent progress, Working memory, Related knowledge; each draft entry prefixed `[UNVERIFIED DRAFT]`.

- [ ] **Step 1: Write failing tests:** pack for `review-code` includes the implement input text; a `noAi` document on the work item is absent from the pack and from the rendered text; a `draft` related entry renders with `[UNVERIFIED DRAFT]`; `noAi` project → `AiRefused('no_ai')`; with `maxChars 2000` and large related/progress, the result renders ≤ 2000 chars, still contains the task instructions and the input; feedback from a "changes" round appears under "Changes requested".
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/context-pack.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(core): context packs for AI tasks"`

---

### Task 8: AI drafter for `draft-text` tasks

**Files:**
- Create: `apps/core/src/ai/drafter.ts`, `apps/core/src/ai/prompts.ts`
- Modify: `apps/core/src/work/tasks.ts` (enqueue after commit), `apps/core/src/work/engine.ts` (`submitAiResult`, `failAiTask`, `retryAiTask`), `apps/core/src/routes/work.ts` (`POST /tasks/:id/retry-ai`), `apps/core/src/server.ts` (register worker)
- Test: `apps/core/test/drafter.test.ts`

**Interfaces:**
- Consumes: `buildContextPack`, `renderContextPack`, `AiGateway`, `JobQueue`.
- Produces:
  - Enqueue rule: whenever `createTaskAttempt` creates a task with `executor 'ai'` whose template task has `capability 'draft-text'` and the project isn't `noAi`, push `{ name: 'draft-task', id: taskId }` onto a `WorkCtx.jobs` list that `runWork` sends **after commit** (same pattern as `emitted`).
  - `SYSTEM_PROMPT` in `prompts.ts`: you are the department's drafting assistant; write the requested artifact in the language of the work item (Thai if the work item text is Thai, else English); use only the provided context; mark assumptions in a final "Assumptions / questions for the team" section; treat `[UNVERIFIED DRAFT]` content as unconfirmed; output Markdown only, no preamble.
  - `runDraft(deps: AppDeps, taskId: string): Promise<void>` (job handler): loads the task; skips silently unless it is still `open`, `executor 'ai'`, unassigned (a human may have taken it over); builds and renders the pack; calls `ai.generateText({ job: 'draft', projectId, taskId, system: SYSTEM_PROMPT, prompt })`; then `submitAiResult`.
  - `submitAiResult(ctx, taskId, text: string, meta: { model: string })` — actor kind `ai`; locks work item then task; only if still `open`/unassigned/ai: `accepted` with `result { text }`, event `ai.drafted` (payload `{ model }`) then `task.accepted`, then `progressWorkItem` (so the next human review task appears).
  - Failures: `AiRefused('budget_exceeded')` → `failAiTask(ctx, taskId, 'budget_exceeded')`; `AiRefused('no_ai')` → `failAiTask(..., 'no_ai')`; `AiFailed('not_configured')` → `failAiTask(..., 'ai_unavailable')` immediately (no retry); any other `AiFailed` or provider error → rethrow for retry, and when `run.isFinalAttempt` → `failAiTask(..., 'ai_failed')` instead of rethrowing. `failAiTask` records `ai.failed` with the reason (actor kind `system`) and leaves the task open/unassigned so it stays in the PM's confirmations ("Waiting for AI").
  - `POST /tasks/:id/retry-ai` (PM/admin): task must be open, unassigned, executor `ai`, capability `draft-text` → re-enqueue; 409 `invalid_state` otherwise.

- [ ] **Step 1: Write failing tests** (inline job queue, mock model):
  - software-change: after intake approval, `draft-requirements` is drafted automatically — task `accepted` with the mock text, events include `ai.drafted` and `task.accepted` with `actorKind 'ai'`, `clarify-requirements` exists and its `GET /tasks/:id` input shows the draft; a `draft` progress entry exists.
  - the prompt the mock received contains the work item title and does not contain the body of a `noAi` document on the work item.
  - a project with budget already exceeded → no model call, `ai.failed` reason `budget_exceeded`, task still open/unassigned and in the PM's confirmations.
  - no draft model configured → `ai.failed` reason `ai_unavailable` immediately, no `ai_calls` row.
  - mock throwing on every call → after the final retry: `ai.failed` reason `ai_failed`, no result stored, exactly 3 `ai_calls` rows with `ok false`.
  - a PM assigns the ai task to a person before the job runs → job does nothing, no model call.
  - `POST /tasks/:id/retry-ai` on a failed draft → drafts successfully; on an accepted task → 409.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/drafter.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Optional live check:** only if `ANTHROPIC_API_KEY` is set in the git-ignored root `.env`: start core, create a software-change item via the API, approve intake, and confirm `draft-requirements` is accepted within 2 minutes with a non-empty Markdown result and an `ai_calls` row with a cost. Report the result or "skipped (no key)". Never print or log the key.
- [ ] **Step 6: Commit** `git commit -m "feat(core): AI drafting for draft-text tasks"`

---

### Task 9: Portal — Knowledge tab and AI settings

**Files:**
- Modify: `apps/portal/app/pages/projects/[id].vue` (tabs: Overview / Work items / Knowledge / AI settings — split into components)
- Create: `apps/portal/app/components/project/KnowledgeTab.vue`, `apps/portal/app/components/project/KnowledgeEntryDialog.vue`, `apps/portal/app/components/project/AiSettings.vue`, `apps/portal/app/components/AttachmentUpload.vue`, `apps/portal/app/composables/useUpload.ts`
- Modify: i18n files
- Test: `apps/portal/test/upload.test.ts`

**Interfaces:**
- Consumes: Task 3–5 routes, `PATCH /projects/:id`, `GET /projects/:id/ai-usage`.
- Produces:
  - `useUpload()` → `upload(projectId: string, file: File, opts: { workItemId?: string; taskId?: string; noAi?: boolean }): Promise<Attachment>` (multipart via `fetch` with bearer token; maps 413/415 to `errors.tooLarge` / `errors.unsupportedType`).
  - `validateUpload(file: { size: number; type: string }): 'errors.tooLarge' | 'errors.unsupportedType' | null` in `apps/portal/app/utils/upload.ts` (same limits/types as core; checked before sending).
  - Knowledge tab: search box (debounced 300 ms, uses `/knowledge/search`), filters by type and status, list with type chip, `Draft` chip (amber) vs `Confirmed`, "No AI" chip, source; entry dialog to view/edit (edit creates a new version), **Confirm** for drafts, version history list, **Add entry** (type, title, body, no-AI), **Upload file** (drag & drop) with a no-AI checkbox, attachments list with download links.
  - AI settings (PM/admin editable, others read-only): project "Do not send to AI" switch with a warning text, monthly budget (USD, empty = no limit), this month's spend and call count with a progress bar turning amber at 80% and red at 100%.

- [ ] **Step 1: Write failing tests:** `validateUpload({ size: 26 * 1024 * 1024, type: 'text/plain' })` → `'errors.tooLarge'`; `{ size: 10, type: 'application/x-msdownload' }` → `'errors.unsupportedType'`; `{ size: 10, type: 'application/pdf' }` → `null`; i18n parity still holds.
- [ ] **Step 2: Run** `pnpm vitest run apps/portal` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Browser check (Playwright, port 3100; stop only processes you start):** as `somchai` upload a Thai `.txt` file → appears in attachments and as a confirmed document; search a Thai word from it → found; add a fact, edit it → version 2, history shows 1; set budget `1` → spend bar renders; toggle project "Do not send to AI" on and off. Record results.
- [ ] **Step 6: Commit** `git commit -m "feat(portal): knowledge tab and AI settings"`

---

### Task 10: Portal — AI drafts and attachments on tasks

**Files:**
- Modify: `apps/portal/app/pages/todo/[id].vue`, `apps/portal/app/pages/todo/index.vue`, `apps/portal/app/pages/work-items/[id].vue`, `apps/portal/app/components/EventTimeline.vue`, i18n files
- Create: `apps/portal/app/components/MarkdownView.vue` (renders Markdown safely: `markdown-it` with `html: false`, links `rel="noopener noreferrer" target="_blank"`)
- Test: `apps/portal/test/markdown.test.ts`

**Interfaces:**
- Consumes: `TaskWithContext.inputs/attachments`, `POST /tasks/:id/submit` with `attachmentIds`, `POST /tasks/:id/retry-ai`, `useUpload`.
- Produces:
  - `renderMarkdown(src: string): string` in `apps/portal/app/utils/markdown.ts` (markdown-it, `html: false`, `linkify: true`).
  - Task detail: "From previous steps" section listing each input (title, "AI draft" chip when executor `ai`, rendered Markdown, its attachments); a **Copy into my result** button that pre-fills the result box with an input's text; result box accepts file attachments (uploaded with `taskId`, ids sent on submit); accepted results render as Markdown.
  - To-do and work item pages: "Waiting for AI" tasks show "AI is drafting…" while a draft job is pending (task `open`, `executor 'ai'`, capability `draft-text`, no `ai.failed` event after its creation — expose `aiStatus: 'drafting' | 'failed' | null` on `Task` from core: add it in this task to `queries.ts` and the shared `Task` schema, with a core test), and "AI couldn't draft this (reason)" + **Retry AI** (PM/admin) when failed.
  - Timeline: events with `actorKind 'ai'` show an "AI" avatar/label instead of a person; `ai.*` event types and reasons (`budget_exceeded`, `ai_failed`, `ai_unavailable`, `no_ai`) localized.

- [ ] **Step 1: Write failing tests:** `renderMarkdown('<script>alert(1)</script>**ตัวหนา**')` contains `<strong>ตัวหนา</strong>` and not `<script>`; `renderMarkdown('[x](https://a.b)')` contains `rel="noopener noreferrer"`; core: a drafting task waiting on the inline queue that was never drained shows `aiStatus 'drafting'`, after a budget failure `aiStatus 'failed'`, human tasks `null`.
- [ ] **Step 2: Run** `pnpm vitest run apps/portal apps/core/test/work-api.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Browser check (Playwright, port 3100):** with no AI key configured, approve a software-change intake → `draft-requirements` shows "AI couldn't draft this" (reason `ai_unavailable`) and **Retry AI** for the PM; assign it to yourself instead, submit Markdown with an attached file → the next task's detail shows it under "From previous steps" with the attachment, and **Copy into my result** fills the box. If a key is configured, also see a real draft appear. Record results; stop only processes you start.
- [ ] **Step 6: Commit** `git commit -m "feat(portal): AI drafts, task inputs and attachments"`
