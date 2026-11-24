# Plan 2 (Work model & To-do) — follow-ups carried into later plans

Deferred findings from task and whole-branch reviews. None block plan 2.

## Needed by upcoming plans (design input)
- **AI/system actor (plans 3, 4, 7):** engine functions take `me: Me` and require assignee/PM. The AI runner and secretary need their own actor path; `events.actor_id = null` currently means "system" and can't distinguish the secretary. Record the AI's reason in `events.reason`.
- **AI task claim/submit (plan 7):** AI tasks have no claim or `submitted` path; `submitTask` requires an assignee. Until then, unassigned AI tasks show in the PM's confirmations as "Waiting for AI".
- **Step-advance confirmation in `propose` mode (plan 4):** spec §9 wants PMs to confirm step advances; `progressWorkItem` advances automatically. Add the gate in the "all tasks satisfied" branch — the same place discussions will block a step (plan 5).
- **Requesters (plan 4):** work item owners must be project members, so requester-originated items need a separate `requester_id` on `work_items`.
- **Role removal (plan 4):** removing a role via `PUT /projects/:id/members/:personId` doesn't unassign that member's tasks for the role.
- **Template validation (before templates become editable):** two review tasks sharing one dependency would collide on the one-active-attempt index; add a `validateTemplate` rule.

## Small fixes
- Removed members' open pages go stale (their stream stops receiving that project's events, including their own `task.unassigned`).
- Project autonomy and member role changes write no event and don't refresh other viewers.
- Event timeline doesn't name the task an event belongs to.
- Work item list/detail resolve template and step names from the latest template version; return names from core instead.
- `getTask` builds context before the visibility check; body validated before permission (400 vs 403) on project PATCH/PUT.
- Admin confirmations include archived projects; dialog can't submit for a non-member admin on a project with zero members.
- Three duplicate membership helpers (`tasks.ts`, `queries.ts`, `engine.ts`) — consolidate into `projects/access.ts`.
- Live stream: no back-pressure cap; one DB query per event per connection; backoff resets on a server that accepts then closes.

## Tests to strengthen
- Member-removal concurrency test may pass without observing the lock wait; assert a wait was seen.
- Constraint tests use untyped `rejects.toThrow()` — match constraint names.
- No tests for `useLiveEvents` (backoff, abort), ping, or "changes" against a pure-AI dependency.
- Not yet browser-tested: Confirm on a proposed task from `/todo`, non-PM member view of the work item page, autonomy switch to auto-assign.
