# Plan 7 (MCP Server & Runners) — follow-ups carried into later plans

These are findings from the task reviews and the whole-branch review that were deferred. None of them blocks plan 7.

## Needs the owner / admin before real use
- **Server runner:** decide where it runs, and give it an Anthropic API key (`ANTHROPIC_API_KEY`), a runner token, and a scoped git push credential (`YODA_GIT_USERNAME`/`YODA_GIT_PASSWORD`, for example a deploy token with `write_repository` on the linked repos only). Set all of these only in the deploy environment.
- **Personal subscriptions unattended:** this stays off until someone confirms that the provider's current terms allow it (spec §17.4). The switch is under Runners → admin card.
- **Codex:** it is experimental and has not been run against a real binary. `start` refuses Codex unless `allowExperimentalCodex: true` is set.
- **Smoke test:** run one real Claude Code task end to end on a dev machine, against a test repo on the hospital GitLab, before the department starts using runners.

## Security limits to know
- **Agent and runner share an OS user.** The agent can read the runner's env and config (the MCP token, the git push credential and the API key in the server image). Use per-machine tokens and scoped credentials. Later, run the agent as a separate user or in a sandbox.
- **Commit messages aren't checked.** Core strips closing keywords from the MR title and description it creates, but commit messages on a runner's branch could still contain `Closes #N`.
- **MCP endpoint protection:** it relies only on the bearer token. Origin and DNS-rebinding checks are off, which suits a server-to-server endpoint.
- **Stale staff status:** a runner owner's staff status comes from the people row, so it can be stale. Revoke a person's runners when they lose staff status.

## Behaviour to revisit
- **Multi-repo items:** the runner works on the first repo only, because the context pack has no MR state.
- **Two tasks on one work item:** if both use the same branch at once (only possible with `maxConcurrent > 1`), the second fails.
- **Skip list:** it lives in memory and resets when the runner restarts. Poll backoff is fixed at `pollSeconds`.
- **Parked runs:** a run parked by a question drops its local, unpushed commits, so the resumed run starts again from the remote branch.
- **Default agent tools:** they allow only git commands. Builds and tests need `allowedTools` extended per runner (see README), and a `run-tests` preset could ship later.
- **Runner cost:** reported cost doesn't trigger the `ai.budget_warning` event; the budget is checked only at claim time.
- **Unfenced text:** the project description and template instructions are not fenced in context packs.
- **Data problems:** "no repo linked" and "no default branch" still count as strikes.
- **Sole PM raising a discussion:** this now notifies admins, which is an intentional change.

## Small fixes
- The runner image's CI job only builds it; pushing to a registry comes with plan 8 release work.
- Pin `node:22-slim` by digest.
- The Runners page doesn't refresh when another admin pauses or revokes a runner.
- The agent prompt says "worktree on branch X" even for detached runs that don't change code.

## Tests to strengthen
- Component tests for `TokenOnce` and `RunnerDialog` (that the token is cleared on close).
- Run a real `claude -p` with the allow and deny lists in a sandboxed CI job, once an API key is available for CI.
