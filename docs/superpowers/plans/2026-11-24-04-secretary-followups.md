# Plan 4 (Chat & Secretary) — follow-ups carried into later plans

Deferred findings from task, batch and whole-branch reviews. None block plan 4.

## Needed by upcoming plans (design input)
- **Thread audience (plan 5 discussions):** "who reads this thread" is spread across the secretary (team / hideStaffNames / requesterVisible keyed on `work_item`). Put it in one function before adding a discussion thread kind that requesters might read.
- **System messages in threads (plans 6, 8):** the secretary's "answered" rule now ignores plain system markers; keep new system posts as non-replies.
- **Runners (plan 7):** bill via `BillingTarget`, never `projectId: null`; use the runner's own identity, not the admin-equivalent system identity.
- **Notification kinds (plan 8):** budget alerts now use `budget_alert`; route kinds to email/LINE per kind.

## Small fixes
- Reopen feedback reuses the latest-ever requester change comment; PMs can't add their own reason.
- Superseded attempts aren't marked in the UI (`Task.supersededAt` not exposed); knowledge from superseded attempts stays confirmed.
- Secretary: a covered message's job still runs the model then discards the result; racing duplicate jobs bill twice; duplicate proposals within one reply; `submit_request` always uses the software-change template; AI SDK validation errors reach the model verbatim; pasted no-AI content in chat history goes to the model.
- Department budget is checked once per chat (overshoot ≤ 6 steps); a notification transaction runs on every department call above 80%.
- Stuck-work alerts repeat daily forever; orphan draft re-queue is uncapped (stops at the final `ai.failed`).
- Guard rails: G7 ignores AI tasks in no-AI projects (they go to people); a non-trailing meta note is never stripped; `<!--` inside a missing item defeats the strip.
- Admin AI page: generic error text for a fractional-cent budget; limit not shown with two decimals; `saved` flag sticky.
- RustFS has no healthcheck in prod compose; core uses the RustFS root account (use a scoped account).
- Admin to-do proposal scope is PM projects plus PM-less projects; engine ↔ proposals circular import.

## Tests to strengthen
- Portal component tests for proposal cards (requester name, note-required reject), the AI status chip, budget parsing.
- The supersede-on-accept test uses direct DB edits; the reopen-lock test checks a timeout rather than a real deadlock.
