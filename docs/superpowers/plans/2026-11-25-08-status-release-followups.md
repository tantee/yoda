# Plan 8 (Status & Release) — follow-ups

These are findings from the task reviews and the whole-branch review that were deferred. None of them blocks release 1.0.0.

## Needs the owner / admin before real use
`docs/operations.md` has the full checklists for each of these.
- **Deploy host:** a host with Docker and Compose v2.24 or newer, behind a TLS reverse proxy. Core and portal bind to loopback by default.
- **CI variables:** `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` and `DEPLOY_PATH`. The host also needs a read-only registry deploy token.
- **GitLab CI runner:** docker executor, privileged, with `/certs/client`, and the `DOCKER_HOST`, `DOCKER_TLS_VERIFY` and `DOCKER_CERT_PATH` variables.
- **Keycloak:** the realm or client on the hospital Keycloak, plus `OIDC_ISSUER` and optionally `OIDC_JWKS_URL`.
- **SMTP:** host, port, user, password and `MAIL_FROM`. Then enable email in Admin → Notifications.
- **LINE:** an Official Account with a Messaging API channel (access token and secret), the webhook URL `https://<portal>/api/webhooks/line` with the webhook turned on and auto-reply turned off, and optionally the add-friend URL. Then enable LINE in Admin → Notifications.
- **Telegram:** a BotFather token, the bot username and a webhook secret, then run the `setWebhook` call with `secret_token` from the runbook. Then enable Telegram in Admin → Notifications.
- **Backups:** where copies of `/backups` go off the host, and who watches the backup container's health.
- **AI and GitLab:** the AI provider keys and budgets, and the GitLab bot and webhook from plan 6.
- **Release:** after merging, tag `v1.0.0` in GitLab and run the manual deploy job.

## Behaviour to revisit
- **Health thresholds:** 5 days stuck, an urgent discussion open 3 days, a high-priority one open 7 days, 80% of budget. They are constants in `apps/core/src/status/health.ts`, and the owner may tune them.
- **Stored notification preferences:** once saved, they freeze the role defaults for that person. Store only the differences from the defaults later.
- **Account-move notification:** it is Thai-only and uses the `secretary_message` kind.
- **Weekly summary:** redaction misses nicknames and the text of attachments. There is no cooldown on Regenerate.
- **Outside notifications:**
  - Delivery is at least once after the job is queued.
  - A job that fails to queue right after the transaction commits is lost.
  - An outage longer than about 30 minutes drops outside messages; the portal feed is unaffected.
- **Telegram blocked detection:** it relies on the error description text.

## Small fixes
- The S3 readiness ping has no AbortSignal, and `JobQueue.started()` doesn't notice a lost database connection.
- The MDI icon font is about 3.5 MB; subset it or switch to SVG icons.
- The weekly summary card's empty-state text partly repeats the "AI not configured" note.
- Backups keep 14 full copies of the bucket. Consider incremental copies (`--copy-dest` or hard links).
- The status page change in the final fix round (finished week plus the in-progress draft) was typechecked but not browser-checked.

## Tests to strengthen
- `glab ci lint` against the real GitLab, which isn't reachable from the build machine.
- Component tests for the status cards and the notification settings grid.
