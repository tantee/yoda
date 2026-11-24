# Auto-assign guard rails — proposal (awaiting owner approval)

Status: proposal only. Nothing here is built until the owner approves it.

## Where auto-assign makes decisions today

In an `auto-assign` project the system makes two kinds of decision without the PM:

1. **Assigning a task** to the member with the right role and the lowest load.
2. **Advancing a work item** to its next step once every task in the current step is accepted.

A guard rail is a check at one of those two moments. When it trips, the system does what `propose` mode does: it creates a proposal (a `task.proposed` assignment, or a `step_advance` proposal) for the PM to confirm in one click, and records the guard's reason on the proposal and in the timeline. Work that doesn't trip a guard still flows automatically.

## Proposed guard rails

| # | Trips when | Applies to | What happens instead |
|---|---|---|---|
| G1 | **Rework in this step:** any task in the step needed "Request changes" (a rejected attempt exists) | Step advance | `step_advance` proposal, reason `rework` |
| G2 | **Repeated rework:** the same task has been sent back 2 or more times | Step advance and the next assignment of that task | Proposal for both, reason `repeated_rework` (later plans can turn this into a discussion) |
| G3 | **AI not confident:** an AI draft in the step reports low confidence or missing inputs (the drafter will end every draft with a short machine-readable note: confidence high/low and any missing information) | Step advance | `step_advance` proposal, reason `ai_low_confidence`, listing what was missing |
| G4 | **High or urgent priority** | Step advance only | `step_advance` proposal, reason `high_priority`. Task assignment stays automatic so urgent work starts at once |
| G5 | **Project AI budget at 80% or more** and the next step contains AI tasks | Step advance | `step_advance` proposal, reason `ai_budget`, so the PM decides whether to spend. At 100% AI is already refused and the task returns to people |
| G6 | **Daily cap reached** for every eligible person | Assignment | `task.proposed` to the least-loaded eligible person (today the task is left unassigned), reason `daily_cap` |
| G7 | **No eligible assignee** for a human task in the next step (no member holds the role) | Step advance | `step_advance` proposal, reason `no_assignee`, so the PM can add a member before the step starts |
| G8 | **Requester asked for changes on delivery** | Step advance and close | Never automatic; the PM reopens or closes (already true today via "Reopen step") |

## Not proposed (and why)

- **Approvals** (requirements, design, merges, releases) are always human in both modes, so they need no guard.
- **Assignee availability / leave:** there's no availability data yet; add a guard once people can mark themselves away.
- **Skill matching:** work items have no area tags yet to match against people's skills.

## Design notes for when it's approved

- Each guard is a small function `(workItem, step, context) → reason | null` evaluated at the two decision points; the first non-null reason wins and is stored on the proposal.
- All guards on by default for every `auto-assign` project; an admin-only per-project switch list can come later if some prove noisy.
- G3 needs a small change to the AI drafting prompt (a final machine-readable line) and parsing it; the note is stripped before the draft is shown.
- PM notifications reuse the existing `proposal_pending` notification, with the reason shown in plain language.
