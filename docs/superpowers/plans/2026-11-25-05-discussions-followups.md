# Plan 5 (Discussions) — follow-ups carried into later plans

Deferred findings from task and whole-branch reviews. None block plan 5.

## Needed by upcoming plans (design input)
- **Runners (plan 7):** `createDiscussion` requires a staff `Me` and `raised_by` references a person; runners need a person to act on behalf of, or an actor kind.
- **Status (plan 8):** department-wide discussion events are live-only (events need a project), so pending-discussion counts and history must come from the `discussions` table.
- **GitLab (plan 6):** decision knowledge and notifications contain server-side Thai labels; don't mirror them verbatim.
- **Lock rule:** work item rows are locked with `FOR NO KEY UPDATE` so foreign-key checks from child inserts don't block; keep this for any new row-lock helper.

## Small fixes
- Editing a brief records no live event (other viewers don't refresh).
- Work item timeline has no labels for `discussion.*` events.
- `discussion-brief`'s exclusive queue policy only applies when the queue is created (recreate it in environments that ran this branch earlier); a retry sent as the previous job finishes may be dropped until the 35-minute window.
- Deciding a discussion re-runs progress even after a PM rejected the step advance (re-asks in propose mode, may advance in auto-assign if no guard trips) — document or gate.
- Empty AI brief context/recommendation accepted; department knowledge in briefs can be crowded out by project hits; search embedding is billed before the department budget check.
- `TaskDiscussionCreate` strips ids silently; engine ↔ discussions circular import.
- Secretary `raise_discussion` doesn't offer department-wide discussions; no cap on proposals per turn.
- Portal: agenda pages refetch each item per live event; responses fetched twice after posting; print view shows Markdown markers; upcoming/past split uses a stale `now`; agenda permission refreshes only on mount/user change.

## Tests to strengthen
- DB tests for the discussion priority check and set-null foreign keys; agenda race test is non-falsifiable; department `discussion.scheduled` live event unasserted; kept decided/withdrawn agenda items and 404 on missing agenda untested; accept-after-project-turns-no-AI for `raise_discussion`; portal UI gating tests.
