# Plan 6 (GitLab) — follow-ups carried into later plans

Deferred findings from task and whole-branch reviews. None block plan 6.

## Needs the owner / admin before real use
- A GitLab bot account and a personal access token with `api` scope (`GITLAB_TOKEN`), a webhook secret of 16+ characters (`GITLAB_WEBHOOK_SECRET`), and a webhook URL GitLab can reach (`<portal>/api/gitlab/webhook`, shown on Admin → GitLab). Set them only in the deploy environment.
- Nothing was tested against a real GitLab, because it isn't reachable from the build machine. Check these first on the hospital instance: the issue-marker search, the `related_merge_requests` reconcile, and the shape of webhook payloads.
- The internal GitLab hostname is still in git history (it has been removed from the current docs). Decide whether that matters; rewriting the history of a public repo is a separate step.

## Behaviour to revisit
- **MR matching:** only `Closes|Fixes|Resolves #N` and `group/proj#N` for the same repo are matched. `Implements #N`, full issue URLs and short `proj#N` refs aren't. Consider GitLab's `merge_requests/:iid/closes_issues` as the authoritative source.
- **Merge semantics:** a merge newer than the review task approves it, even when the rework was submitted in the portal. Document this for developers.
- **Multiple review tasks** depending on a code-change task: there's no deterministic tie-break. No current template does this.
- **Imported items** are detected by "description starts with a linked issue URL". This is a heuristic (it can prefix-match `/issues/1` against `/issues/12`); a stored flag would be sturdier.
- **Import:** confidential or closed issues are imported through the bot token without a check; there's no audit event or no-AI check on import.
- **Code status in the secretary** is hidden in every work-item thread, not only the ones a requester can see.
- **Repo removal race:** a repo DELETE between issue creation and storing the iid can orphan a GitLab issue (low impact).

## Small fixes
- Pipeline status has no ordering guard (a late `running` can overwrite `failed`). A pipeline change that isn't a failure sends no live event, so the chip updates only on reload.
- Pipeline-failed and MR-closed notifications reuse the `work_item_stuck` kind; add dedicated kinds.
- Prune `gitlab_deliveries` older than about 14 days. A delivery without `X-Gitlab-Event-UUID` gets 400; fall back to a body hash.
- If posting the "updated" note fails after the issue update succeeded, the retry posts a generic note.
- MR titles go into the staff secretary's output unsanitized (a prompt-injection surface limited to staff).
- Portal: "sync pending" shows before Dev starts; copying the webhook URL fails silently when the clipboard is denied; the fake-gitlab dev script has no `NODE_ENV=production` guard.

## Tests to strengthen
- Portal component tests for the Code panel and the Repositories tab.
- The 502 `gitlab_unavailable` path, and the admin status timeout.
