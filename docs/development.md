# Development

How to run Yoda from source, test it, build the images, and the reference for the GitLab integration and runners.
For the user-facing guides see [the documentation index](README.md); for production see the
[operations runbook](operations.md). Changes per release: [CHANGELOG.md](../CHANGELOG.md).

pnpm monorepo: `apps/core` (Fastify + Drizzle), `apps/portal` (Nuxt 4 SPA), `apps/runner`, `packages/shared`.
## Requirements

- Node 22 (`.nvmrc`), pnpm 10 (via `corepack enable`), Docker
- [gitleaks](https://github.com/gitleaks/gitleaks): `brew install gitleaks`

## Dev setup

```bash
pnpm install            # also installs the lefthook git hooks (gitleaks pre-commit)
cp .env.example .env    # adjust ports if needed
docker compose up -d    # postgres, rustfs (S3), keycloak, mailpit (bound to 127.0.0.1)
pnpm --filter @yoda/core db:migrate
pnpm dev                # core on PORT, portal on PORTAL_PORT
```

The root `.env` is loaded automatically by `pnpm --filter @yoda/core dev`, `db:migrate` and
`pnpm --filter @yoda/portal dev` (so `PORTAL_PORT` and `NUXT_PUBLIC_*` apply). For local dev set
`BOOTSTRAP_ADMINS=somchai` in your `.env` to get an admin on first login. Never set a common real
username against the organisation's Keycloak.

### Object storage (RustFS)

The S3 API is on `127.0.0.1:${S3_PORT:-9000}` and the web console on `127.0.0.1:${S3_CONSOLE_PORT:-9001}`;
log in to the console with `S3_ACCESS_KEY` / `S3_SECRET_KEY`. Both ports are set in `.env`.

**Migrating from MinIO.** The `rustfsdata` volume starts empty. Before switching, copy existing objects
from the old MinIO endpoint to RustFS with `aws s3 sync` (or `mc mirror`) using each endpoint's
credentials. Afterwards remove the old volume with `docker volume rm <project>_miniodata`. A `.env`
copied from the old example still works (compose passes whatever `S3_*` is set) but should switch to
the new dev secret from `.env.example`.

Keycloak dev realm `yoda` is imported from `infra/keycloak` (dev test users, password `dev`; see
`infra/keycloak/README.md`). If you change `KEYCLOAK_PORT`, update `OIDC_ISSUER` and
`NUXT_PUBLIC_KEYCLOAK_URL` to match.

`infra/postgres/init.sql` only creates the `yoda_test` database (the `vector` and `pg_trgm` extensions come from the migrations) and only runs on a fresh Postgres volume. To
re-run it: `docker compose down -v && docker compose up -d` (this deletes dev data).

## Tests

Tests need Postgres and a `yoda_test` database (created by `init.sql`):

```bash
pnpm typecheck
pnpm test            # uses TEST_DATABASE_URL, default postgres://yoda:yoda@localhost:5432/yoda_test
```

## Containers and production

```bash
YODA_IMAGE_PREFIX=yoda YODA_VERSION=latest docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

Images: `core` (`node dist/server.js`), `portal` (`node .output/server/index.mjs`), `runner` and `backup`,
named `${YODA_IMAGE_PREFIX}/<name>:${YODA_VERSION}` by the overlay. Both are required (locally `yoda` and
`latest`, giving `yoda/core:latest` and so on; there is no default prefix, so a deploy host never pulls a
`yoda/...` image from Docker Hub by mistake); a deploy host pulls the release from the registry and pins both in
`release.env` (see the runbook, `docs/operations.md`).
The core server runs the migrations itself when `MIGRATE_ON_START=true` (the default, so a plain
`docker run` works). The prod overlay sets it to `false` and runs a one-shot `migrate` service
(`node dist/migrate.js`, same image) first; core starts only after it completes, so only one
container ever migrates. Configuration is environment-only:

- core: `DATABASE_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_JWKS_URL` (optional), `STAFF_GROUP`,
  `BOOTSTRAP_ADMINS`, `MIGRATE_ON_START` (`true`|`false`)
- health: core `GET /health` (liveness, with the version) and `GET /ready` (200 when the database,
  storage and job queue answer within 2 s each, else 503; `{ status, checks }`); portal `GET /health`.
  The overlay's healthchecks use them, and the portal waits for a healthy core.
- core object storage (the compose `rustfs` service): `S3_ACCESS_KEY`, `S3_SECRET_KEY` (required; the
  overlay also uses them as the RustFS credentials), `S3_REGION` (`us-east-1`), `S3_BUCKET` (`yoda`,
  created on startup). `S3_ENDPOINT` is fixed to `http://rustfs:9000` by the overlay.
- RustFS in prod: bind-mounted data directories must be owned by the image's `rustfs` user. The image
  has no healthcheck, so core only waits for the container to start and relies on
  `restart: unless-stopped` if RustFS is not ready on first start.
- core AI: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` (all optional; jobs whose provider
  has no key are unavailable), `AI_MODEL_DRAFT` (`anthropic:claude-opus-5-5`), `AI_MODEL_FAST`
  (`anthropic:claude-haiku-5-5`), `AI_EMBEDDING_MODEL` (empty = no embeddings, trigram search only),
  `AI_WORKERS` (2). A model id missing from `apps/core/src/ai/prices.json` is logged at startup and
  refused for projects with a budget.
- portal: `NUXT_CORE_URL`, `NUXT_PUBLIC_KEYCLOAK_URL`, `NUXT_PUBLIC_KEYCLOAK_REALM`,
  `NUXT_PUBLIC_KEYCLOAK_CLIENT_ID` (read at runtime, not baked into the image)
- ports: `CORE_PORT` (4000), `PORTAL_PORT` (3000), published on `127.0.0.1` (`CORE_BIND`, `PORTAL_BIND`)
  for a reverse proxy in front; Postgres and RustFS publish no ports in the overlay (use `docker compose exec`)

Inside containers:

- `DATABASE_URL` must use the compose service host (`postgres`), not `localhost`, e.g.
  `postgres://yoda:...@postgres:5432/yoda`. Compose also reads the root `.env` for interpolation, so
  do not leave the dev `localhost` URL there when running the overlay.
- `OIDC_ISSUER` must equal the browser-facing token `iss`. Core fetches the signing keys from
  `OIDC_JWKS_URL` when set (e.g. Keycloak's internal address,
  `http://keycloak.internal.example.org/realms/yoda/protocol/openid-connect/certs`), otherwise from
  `${OIDC_ISSUER}/protocol/openid-connect/certs`, which must then be reachable from the core container.
  Tokens are checked against `OIDC_ISSUER` either way.

- Postgres: the overlay requires `POSTGRES_PASSWORD` (and takes `POSTGRES_USER` / `POSTGRES_DB`,
  default `yoda`) instead of the dev password; `DATABASE_URL` must use the same credentials. Postgres
  only applies them when it creates a fresh `pgdata` volume, so change an existing database's password
  with `ALTER ROLE` as well.
- The dev `keycloak` and `mailpit` services are behind the `dev-only` profile in the overlay and never
  start in production: sign-in uses the organisation's Keycloak at `OIDC_ISSUER`.

- Backups: the overlay's `backup` service (image `backup`, `ops/backup`) writes
  `pg-<YYYYMMDD-HHMM>.dump` (`pg_dump -Fc`) and `storage-<YYYYMMDD-HHMM>/` (a mirror of the bucket) to
  the `backups` volume every day at `BACKUP_AT` (`02:00`, Asia/Bangkok), updates a `latest` marker and
  deletes backups older than `BACKUP_KEEP_DAYS` (14). A failed run is retried 3 times, 15 minutes
  apart; the container turns unhealthy when the last backup is older than 26 hours (a new container
  gets 26 hours for its first one). Only one backup or restore runs at a time (a lock on the volume).
  The volume lives on the same host: copy it off
  the server as well. Back up now with `docker compose ... run --rm backup --now`. To restore, stop
  `core` and `portal`, run `docker compose ... run --rm -e RESTORE_CONFIRM=yes --entrypoint restore.sh
  backup <stamp|latest>` (`pg_restore --clean --if-exists` plus a sync of the bucket), then run
  `migrate` and start the services again. Restoring into an empty database is the clean path: tables
  that are not in the backup are left in place. `ops/backup/restore-check.sh` (dev only) runs the whole
  round trip against the dev stack on a scratch database and bucket and prints `restore ok`.

Production secrets come only from the deploy environment / CI variables, never from committed files.
The dev compose services use throwaway credentials and must not be exposed publicly.

## GitLab integration

GitLab is optional: with `GITLAB_URL` / `GITLAB_TOKEN` unset the portal works as before and GitLab
features show "not connected". Configure core with:

- `GITLAB_URL`: the GitLab base URL, e.g. `https://gitlab.example.org`
- `GITLAB_TOKEN`: a personal (or group/project) access token of a dedicated bot user with the `api`
  scope, and at least Developer access to every repository linked in the portal
- `GITLAB_WEBHOOK_SECRET`: a random string of at least 16 characters
- `PORTAL_URL`: the portal's public base URL (links from GitLab issues back to the portal)

The token and secret come only from the deploy environment; never commit them.

**Webhook.** In each linked GitLab project (or once on the group), Settings → Webhooks:

- URL: `<PORTAL_URL>/api/gitlab/webhook` (shown on the portal's admin GitLab page). The portal's
  `/api` proxy forwards the `X-Gitlab-Token` / `X-Gitlab-Event-UUID` headers and the raw JSON body to
  core's `/gitlab/webhook` unchanged; core's own `/gitlab/webhook` works too if it is reachable.
- Secret token: the value of `GITLAB_WEBHOOK_SECRET`
- Trigger: **Merge request events**, **Pipeline events**, **Comments** (notes)
- Keep SSL verification enabled for an HTTPS portal.

GitLab does **not** retry a failed delivery by itself, and it disables a webhook that keeps failing. If
the portal was down or answered with an error, open the webhook's **Recent events** in GitLab and use
**Resend request** for each failed delivery (re-enable the webhook first if GitLab disabled it). Resending
a delivery that was already processed is harmless: MR states, notes and pipelines are recorded once. As a safety net, core also pulls the
merge requests related to each portal issue when a code-change task starts and on every secretary sweep
(every 15 minutes) for work items whose code is in progress or under review.

The admin GitLab page shows whether core is configured, whether GitLab is reachable, the bot user and
the time of the last webhook.

**Local try-out (DEV ONLY).** `FAKE_GITLAB_PORT=4100 FAKE_GITLAB_PROJECTS=demo/app pnpm --filter @yoda/core fake-gitlab`
runs the in-memory FakeGitLab used by the tests. Start core with `GITLAB_URL=http://127.0.0.1:4100`,
any placeholder `GITLAB_TOKEN` (e.g. `fake-dev-token`) and a placeholder `GITLAB_WEBHOOK_SECRET`, then
post webhooks with `curl` using that secret. Never point a real deployment at it. To try a runner
against it, add `FAKE_GITLAB_ANY_BRANCH=1` (the fake hosts no git, so MRs open from any branch) and give
the runner a `clonePath` whose `origin` is a local bare repo.

## Runners

A runner is a program on a staff machine or a server that works AI tasks with a coding agent (Claude
Code, or Codex). It talks to core's MCP endpoint (`<core>/mcp`) with a runner token, works in a git
worktree on a `yoda/<8hex>-<slug>` branch, pushes that branch, and core opens the merge request. Runners
act for their owner: results and notes show as "AI on behalf of <owner>".

**Create a runner.** In the portal's **Runners** page, staff create runners for their own machines;
admins create server runners and choose the staff owner. Pick the account type, capabilities
(`code-change`, `analyze-repo`, `run-tests`), mode (on demand or unattended), max concurrency and
optional working hours. The token (`yoda_rt_…`) is shown once: copy it into the runner's config. Use a
**dedicated token per machine**, and revoke it in the portal if the machine is lost; a revoked token
stops working at once.

**Account types.** A runner on a **personal subscription** works tasks only on demand
(`yoda-runner work <taskId>`); unattended claims are refused (`personal_unattended_not_allowed`, and
`yoda-runner start` exits with code 2). An admin can turn on "Allow personal subscriptions unattended"
in the runner settings, but only after checking the provider's current terms. API-key and org-plan
runners can work unattended.

**Install and configure** (from this repo: `pnpm --filter @yoda/runner build`, then
`node apps/runner/dist/cli.js …`, or link it as `yoda-runner`). The config lives in
`~/.config/yoda-runner/config.json` (or the path in `YODA_RUNNER_CONFIG`); `YODA_CORE_URL` and
`YODA_RUNNER_TOKEN` override the file. Placeholders only:

```json
{
  "coreUrl": "https://yoda-core.example.org",
  "token": "yoda_rt_<paste-the-token-shown-once>",
  "executor": "claude",
  "repos": {
    "group/app": { "clonePath": "~/src/app" },
    "group/lib": { "cloneUrl": "https://gitlab.example.org/group/lib.git" }
  },
  "pollSeconds": 30,
  "maxConcurrent": 1,
  "maxTurnsMinutes": 60,
  "permissionMode": "acceptEdits",
  "extraArgs": ["--model", "sonnet"]
}
```

Keep the file private (`chmod 600`). `repos` maps GitLab paths to an existing local clone
(`clonePath`) or a URL cloned once into `workRoot` (`cloneUrl`; keep credentials out of the URL and use
a git credential helper). Set `maxConcurrent` to the runner's max concurrency in the portal: core
refuses claims beyond it (`at_capacity`) and the runner waits for the next poll.
`yoda-runner config show` prints the config with the token masked, and warns about
`bypassPermissions` or a plain-http `coreUrl` off this machine.

**On demand vs unattended.**

- `yoda-runner work <taskId>` claims one task now (your own assigned task, or an AI task in the
  queue), works it and exits.
- `yoda-runner start` polls every `pollSeconds`, claims and works up to `maxConcurrent` tasks, and
  waits when core refuses with `outside_hours`, a pause or `at_capacity`. SIGINT / SIGTERM stops
  polling, aborts the agents and gives their tasks back to the queue (not counted as failures).
  A runner set to **on demand** in the portal may not poll: core refuses (`on_demand_runner`) and
  `start` exits with code 2.
- A run that asks a person (`ask_human`) stops without pushing; it is picked up again once the
  question is decided. A failed run (agent error, refused push) is released as failed; after 3 failed
  runs the task goes back to people.
- A problem with the machine rather than the task (no clone configured for the repo, a clone or fetch
  that fails, a worktree in the way, the agent CLI not installed) gives the task back without counting
  as a failure (reason `runner_environment: …`). `start` skips that task for 10 minutes, and exits with
  code 3 when the agent CLI cannot be started at all. A worktree a killed run left under `workRoot` is
  removed before the next run; if the run's branch is checked out somewhere else (e.g. in your own
  clone), the run is given back with a message saying where.
- When the task is cancelled, reassigned or done while the agent works, core ends the run at the next
  heartbeat and the runner stops (not a failure). Heartbeats go every min(60 s, lease / 3); core's
  `RUNNER_LEASE_SECONDS` is at least 180.

**What the agent may do (Claude Code).** Runs are headless with `--permission-mode` from the config
(default `acceptEdits`; avoid `bypassPermissions` outside a sandbox) and tool lists from
`allowedTools` / `disallowedTools`. The defaults allow the `yoda` MCP tools and `git add` / `commit` /
`status` / `diff` / `log`, and deny `git push` / `checkout` / `switch` / `branch` / `reset --hard` /
`remote` plus the run lifecycle tools (`claim_task`, `heartbeat`, `open_merge_request`,
`submit_result`, `release_task`, `list_available_tasks`), which the runner calls itself. Whatever the
agent does, the runner refuses to push anything but the run's branch, and core refuses MRs from the
default branch. The default `allowedTools` permit only git, so an agent cannot build or run tests until
you allow it. Add the commands your projects need to `allowedTools`, per runner and capability, e.g. a
`run-tests` or `code-change` runner for a pnpm repo:

```json
"allowedTools": [
  "mcp__yoda", "Bash(git add:*)", "Bash(git commit:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
  "Bash(pnpm install:*)", "Bash(pnpm test:*)", "Bash(pnpm vitest:*)", "Bash(pnpm -r typecheck:*)"
]
```

An `analyze-repo` runner usually needs nothing beyond the defaults (reading files is always allowed).
Setting either list replaces its defaults, so copy them in, and keep the allowed commands narrow: a
build or test script runs whatever the repo's scripts say.

**The agent can read the runner's secrets.** The agent runs as the same OS user as the runner, so it
can read anything that user can: the MCP config file the runner writes for it, the runner config (with
its token), the runner's environment (e.g. via `/proc`) and any credentials in that user's home. Use
scoped credentials only: a runner token per machine with just the capabilities it needs, git
credentials limited to the repos it works, and no personal tokens; on a shared machine run the runner
as its own OS user. Revoke the token if in doubt.

**Interactive Claude Code.** To use the Yoda tools in your own Claude Code session,
`yoda-runner mcp-config` prints the MCP config with `Bearer ${YODA_RUNNER_TOKEN}` (Claude Code expands
the variable from its environment); `--with-token` prints the real token instead, so do not paste that
output anywhere shared. Save it as an MCP config file and start `claude --mcp-config <file>`.

**Codex (experimental, untested).** `"executor": "codex"` runs `codex exec` with the yoda MCP server
configured through `-c` overrides and the token in the child environment only. The agent gets the same
yoda tools as Claude's defaults (`mcp_servers.yoda.enabled_tools`: the yoda tools minus those
`disallowedTools` denies). It has not been tested against a real Codex; it needs a Codex version with
streamable-HTTP MCP servers, `bearer_token_env_var` and `enabled_tools` (roughly 0.50 or later, not
verified). `yoda-runner start` refuses Codex unless the config sets `"allowExperimentalCodex": true`;
`yoda-runner work <taskId>` runs it either way.

**Server runner container.** `apps/runner/Dockerfile` (node:22-slim, git, a pinned
`@anthropic-ai/claude-code`, non-root `node` user, no secrets in the image) runs `yoda-runner start`.
With the prod overlay on a deploy host: `dc --profile runner up -d --no-build runner` (`dc` as in
`docs/operations.md`, section 4).
Environment (from the deploy environment only):

- `YODA_RUNNER_TOKEN`: the server runner's token (required); `YODA_RUNNER_CORE_URL` (default
  `http://core:4000` inside the compose network, so `config show` warns about plain http; use https
  when core is elsewhere)
- `YODA_RUNNER_ANTHROPIC_API_KEY`: passed to Claude Code as `ANTHROPIC_API_KEY`
- git credentials for clone and push: `YODA_GIT_USERNAME` (default `oauth2`) / `YODA_GIT_PASSWORD`
  (e.g. a GitLab project or group access token with `write_repository`), answered through the image's
  `GIT_ASKPASS` helper and removed from the agent's environment; or mount your own credential helper.
  Like the MCP token, the push credential is still readable by the agent (same OS user, e.g. via
  `/proc`), so give each runner its own scoped credential: a deploy or project/group access token
  limited to the repos it works, with `write_repository` only, never a personal token.
- `YODA_RUNNER_GIT_NAME` / `YODA_RUNNER_GIT_EMAIL`: the commit identity
- `YODA_RUNNER_CONFIG_FILE` (default `./runner-config.json`): mounted read-only as the config file. It
  holds `repos` with `cloneUrl` entries and executor settings, and no token (that comes from env).
  Create the file before starting, or Docker mounts an empty directory in its place.

Worktrees and clones live in the `runner-work` volume.

## Hospital Keycloak requirements

- Access tokens must include `preferred_username`.
- A `groups` mapper (Group Membership, **full path** enabled) must add the groups to the access token;
  `STAFF_GROUP` is matched against those paths.
- `azp` must equal the client id (`OIDC_CLIENT_ID`).
- The migrations run `CREATE EXTENSION vector` and `pg_trgm`, which needs a superuser; otherwise a DBA
  must pre-create both extensions in the database.

## CI and releases

`.gitlab-ci.yml`: `secrets` (gitleaks over full history), `test` (pgvector service, typecheck, tests),
`build-core` / `build-portal` / `build-runner` / `build-backup` (on the default branch and on tags: push to
`$CI_REGISTRY_IMAGE/<name>` tagged with the short commit SHA, plus the git tag on tags and `latest` on the
default branch), and a manual `deploy` job on tags that runs `ops/deploy/deploy.sh` on the deploy host over
SSH (pull, migrate, up, wait for `/ready`); it is the optional internal mirror. `.github/workflows/ci.yml` runs
the same checks and builds the images without pushing them. `.github/workflows/release.yml` publishes releases:
on a `v*` tag it pushes the images to `ghcr.io/tantee/yoda/<name>` and creates the GitHub Release with the signed
bundle; on a pull request that touches the release files it runs as a dry run ([docs/releasing.md](releasing.md)).

**Versioning.** Releases follow [semantic versioning](https://semver.org) and are git tags `v<version>`
(`v1.0.0`); the version without the `v` is the image tag and the `YODA_VERSION` a host runs. Bump `version` in the root and `apps/core` `package.json` with the
release (core reports it on `/health`) and add a `CHANGELOG.md` entry. Upgrade and rollback steps are in the
[runbook](operations.md#5-upgrade-and-rollback).
