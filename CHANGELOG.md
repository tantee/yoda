# Changelog

Releases follow [semantic versioning](https://semver.org); each is a git tag of the same name (`1.0.0`) and the
image tag the deploy job runs. Upgrade steps: [docs/operations.md](docs/operations.md#5-upgrade-and-rollback).

## Unreleased

### System settings (in the portal)

- One rail item, **System settings** (การตั้งค่าระบบ), for every setting that used to be a variable: general and
  organisation, sign-in, email, LINE, Telegram, GitLab, AI, runners, backups, storage (read-only) and security.
  The GitLab and channel pages moved there.
- Precedence is env > database > default. A value set in env shows **Set by environment** with the variable name
  and cannot be edited; bootstrap values (database, master key, ports, S3, API base URLs) are never editable.
- Secrets are stored encrypted (AES-256-GCM per secret under a master key, with a key canary); they are never
  shown again after saving (only "set", the last 4 characters where safe, the time). Saving one needs a recent
  sign-in. Env values, secrets too, are imported into the database on start (`YODA_SETTINGS_IMPORT=false` turns
  that off).
- Changes apply live on every core instance (no restart, except the AI workers and MCP); each category has a
  **Test** through an outbound policy (private addresses allowed, cloud metadata, loopback and compose names
  blocked); an audit log of every change (hashes only, kept forever).
- `GET /api/public-config`: the portal reads where to sign in, the organisation line and its links from core.
  `NUXT_PUBLIC_KEYCLOAK_*` and the other `NUXT_PUBLIC_*` values default to `''` and are deprecated overrides (a
  value still wins; a Keycloak mismatch with `OIDC_ISSUER` is logged at boot).

### Setup wizard, break-glass admin and /recovery

- A fresh install starts in setup mode: `/setup` (Thai by default) takes a setup token
  (`yoda-admin setup-token`), then the organisation and public URL, the break-glass admin (password, TOTP unless
  the URL is localhost), sign-in with a test (Keycloak issuers only, `/realms/<realm>`), a system check, the
  optional channels, the recovery kit and the claim (the first admin signs in through Keycloak).
- The recovery kit is one file: the master key, the break-glass recovery codes, and the Postgres password and
  storage keys for a lost bootstrap volume.
- `/recovery`: the break-glass account (password plus TOTP or a recovery code) can stage, check, test and apply
  new sign-in settings, roll back for 7 days, grant or revoke portal admins (with pre-grants for new usernames),
  and turn fun mode off. Every use notifies the portal admins; admin pages show a banner while a session is
  open. A wrong master key gives a status-only session.
- `yoda-admin` (`docker compose exec core yoda-admin …`): `setup-token`, `create-break-glass` (for installs set
  up from `.env`), `reset-break-glass`, `status`, `recovery-kit`, `rotate-master-key` (`--dry-run`, `--finish`),
  `reset-master-key --yes` and `recovery on|off`.
- Master key rotation re-wraps every secret and the TOTP seed in one transaction, gives a new kit, and running
  cores switch without a restart (the old key stays decrypt-only until `--finish`).

### Installer and release bundle

- `install.sh` installs a pinned release on a fresh host from the internal file server: it checks the
  prerequisites, verifies the bundle's minisign signature and SHA-256, unpacks it with an empty `.env` and
  deploys. A `release-bundle` CI job builds and signs the bundle on tags.
- The one-shot `init` service generates the Postgres password, the storage keys and the master key into the
  `yoda-bootstrap` volume (a value in `.env` wins and is copied there; a replaced value is kept as `.prev`).
- `deploy.sh` creates an empty `.env` when there is none, runs `init` before the migrations and prints the setup
  wizard's address and the setup-token command while setup is not finished. The deploy job also copies the
  runbook, `.env.example` and the changelog.
- Backups read the backup time and days kept from System settings → Backups (a change applies within a minute);
  `BACKUP_AT` / `BACKUP_KEEP_DAYS` in `.env` still win.
- The runbook and `.env.example` now start from "nothing is required"; env values are advanced overrides.

### Upgrade notes

- **`YODA_IMAGE_PREFIX` is required** (no Docker Hub fallback): `install.sh` and `deploy.sh` pin it in
  `release.env`; an older install keeps it in `.env`.
- **`YODA_TRUSTED_PROXY_HOPS`**: set `2` when a reverse proxy is in front of the portal (and pass `Host` and the
  `X-Forwarded-*` headers), so client addresses and the detected public URL are right.
- **An env-based install upgrades unchanged**: values are imported, setup is marked done, the env values stay
  locked until removed from `.env`. Then create the break-glass account and the recovery kit
  (`yoda-admin create-break-glass`, then `yoda-admin recovery-kit`).
- The prod compose passes every UI-editable setting with an empty default, so only a variable in `.env` locks a
  setting; it no longer sets `BACKUP_AT` / `BACKUP_KEEP_DAYS` defaults.

## 1.0.0 — 2026-11-25

The first release: an AI work portal for the IT department, in Thai (default) and English.

### Foundation (plan 1)

- pnpm monorepo: `apps/core` (Fastify, Drizzle, PostgreSQL with pgvector), `apps/portal` (Nuxt 4 SPA,
  Vuetify), `packages/shared`.
- Sign-in through Keycloak (OIDC, PKCE); staff come from a Keycloak group, everyone else is a requester;
  first admins from `BOOTSTRAP_ADMINS`.
- People and projects with members and roles; role-based navigation.
- Container images, a production compose overlay, GitLab and GitHub CI with gitleaks.

### Work model and to-do (plan 2)

- Work items move through workflow steps from templates ("Software change", "Bug fix"); the engine creates
  and assigns a task per step, with review loops.
- A To-do screen and task detail; PMs confirm proposed assignments.
- An append-only event log, streamed live to the portal (SSE).

### Knowledge and AI gateway (plan 3)

- A knowledge store per project (facts, decisions, documents, progress notes, memory, uploaded files) with
  draft and confirmed trust, and search with embeddings or trigram matching.
- A provider-neutral AI gateway (Anthropic, OpenAI-compatible) that logs every call's cost against project
  budgets.
- Context packs, and AI drafting of requirements, designs and test cases for human review.
- Object storage for attachments (RustFS).

### Chat and secretary (plan 4)

- An AI secretary chat for staff and requesters that answers from project knowledge and turns requests into
  work items, with confirmation.
- "My requests" and "Things I need to answer" for requesters.
- One confirmation list for PMs in `propose` projects (step advances, priority changes); auto-assign guard
  rails and a daily task cap.
- A de-duplicated notification feed; a department AI budget, admin-only AI settings.

### Discussions (plan 5)

- Discussions for decisions that need people, raised by anyone or by the secretary; AI briefs with options,
  trade-offs and a recommendation; opinions and votes.
- Meeting agendas; recorded decisions unblock work items and become confirmed knowledge.

### GitLab (plan 6)

- Projects link to GitLab repositories; every coding task gets a GitLab issue whose marked section the portal
  keeps up to date.
- Merge requests that close those issues move work items forward; pipeline and comment activity shows in the
  portal; a single existing issue can be imported as a work item.
- A signed webhook and an admin status page.

### MCP server and runners (plan 7)

- Core's MCP server; runners on servers or staff machines claim AI tasks that need a repository, work them with
  Claude Code (Codex experimental) in a git worktree, push a `yoda/…` branch and have core open the merge
  request.
- Runner tokens, leases and heartbeats, working hours, on-demand and unattended modes, asking a person through a
  discussion; a server runner image.

### Status and release (plan 8)

- Status screens: department and project health (on track, at risk, blocked, with reasons), counts by step,
  overdue items (optional target dates), open discussions, people load and AI spend. Staff only.
- A weekly AI summary per active project, every Monday 08:00 Asia/Bangkok, stored as draft knowledge.
- Notifications by email (SMTP), LINE (Messaging API) and Telegram (Bot API), each enabled by an admin and chosen
  per person and kind; account linking with one-time codes and verified webhooks.
- Production hardening: a one-shot `migrate` service, `/ready` readiness checks, production database
  credentials.
- Daily backups (database dump and storage mirror, 14 days) with a tested restore.
- Release pipeline: images `core`, `portal`, `runner` and `backup` published to the GitLab registry, a manual
  `deploy` job on tags, and the [operations runbook](docs/operations.md).
