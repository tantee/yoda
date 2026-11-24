# Plan 3 (Knowledge & AI Gateway) — follow-ups carried into later plans

Deferred findings from task and whole-branch reviews. None block plan 3.

## Needed by upcoming plans (design input)
- **Secretary (plan 4):** `AiGateway.generateText` returns final text only — chat needs streaming and tool calls. Calls with `projectId: null` skip budget and no-AI checks; decide how secretary calls are attributed (per project, or a department budget) before building it.
- **MCP runners (plan 7):** reuse `buildContextPack`, but don't reuse the admin-equivalent `SYSTEM_ME` as a runner identity — scope search to the runner's person. `createEntry(ctx, null, …)` skips permission checks, so MCP writes must pass the runner's `Me`. Fence knowledge bodies in the rendered pack so stored text can't mimic section headings.
- **Spec §14 vs plan:** project "do not send to AI" and budget are editable by the project PM or an admin (spec §14 says admin). Confirm the intended rule.

## Small fixes
- Attachments: content type trusted from the client (no magic-byte check); text extraction runs inline with no time/size guard (zip bombs, huge PDFs) — move to a job before heavy use; UTF-16 text files decoded as UTF-8 (BOM becomes replacement characters).
- Budget is soft under concurrency (in-flight calls can overshoot, bounded by `AI_WORKERS`); failed calls record no tokens; tiny calls round to 0 cost; warnings use `console.warn` instead of the app logger.
- Jobs lost if pg-boss `send` fails after commit; `embed-entry` isn't a singleton queue (repeated no-AI toggles can embed twice); a later failed embed batch discards earlier batches' vectors.
- Unscoped knowledge search embeds the query without a project budget; trigram match on very large bodies before chunking; no cosine-distance cutoff.
- Approval depending on a review builds its document from the review comment; two decision tasks on one dependency create two documents.
- pg-boss `exclusive` policy for `draft-task` only applies when the queue is created (an existing dev queue stays `standard`).
- Portal: "Copy into my result" overwrites typed text; "Retry AI" shown to all who see confirmations (server enforces); knowledge dialog editable briefly before load; tab URL sync one-way; unused i18n keys `knowledge.allTypes`, `knowledge.allStatuses`, `ai.title`.
- MinIO: core uses the MinIO root account (use a scoped service account); `S3_SECRET_KEY` must be ≥ 8 chars for MinIO to start — document it.

## Tests to strengthen
- `actor_kind` backfill on events with null actor; API test for the 21-attachment limit; pg-boss final-attempt mapping (only the inline queue is tested); context-pack trimming order and progress limit; portal UI tests for AI status; browser checks for attachment download and the attachment no-AI toggle.
