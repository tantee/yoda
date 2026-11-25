# Yoda — AI work portal

pnpm monorepo: `apps/core` (Fastify + Drizzle), `apps/portal` (Nuxt 4 SPA), `packages/shared`.

## Requirements

- Node 22 (`.nvmrc`), pnpm 10 (via `corepack enable`), Docker
- [gitleaks](https://github.com/gitleaks/gitleaks): `brew install gitleaks`

## Dev setup

```bash
pnpm install            # also installs the lefthook git hooks (gitleaks pre-commit)
cp .env.example .env    # adjust ports if needed
docker compose up -d    # postgres, rustfs (S3), keycloak (bound to 127.0.0.1)
pnpm --filter @yoda/core db:migrate
pnpm dev                # core on PORT, portal on PORTAL_PORT
```

The root `.env` is loaded automatically by `pnpm --filter @yoda/core dev`, `db:migrate` and
`pnpm --filter @yoda/portal dev` (so `PORTAL_PORT` and `NUXT_PUBLIC_*` apply). For local dev set
`BOOTSTRAP_ADMINS=somchai` in your `.env` to get an admin on first login. Never set a common real
username against the hospital Keycloak.

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
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

Images: `yoda-core` (runs migrations, then `node dist/server.js`) and `yoda-portal`
(`node .output/server/index.mjs`). Configuration is environment-only:

- core: `DATABASE_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `STAFF_GROUP`, `BOOTSTRAP_ADMINS`
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
- ports: `CORE_PORT` (4000), `PORTAL_PORT` (3000)

Inside containers:

- `DATABASE_URL` must use the compose service host (`postgres`), not `localhost`, e.g.
  `postgres://yoda:...@postgres:5432/yoda`. Compose also reads the root `.env` for interpolation, so
  do not leave the dev `localhost` URL there when running the overlay.
- `OIDC_ISSUER` must equal the browser-facing token `iss` AND be reachable from the core container
  (it fetches the JWKS from it). The overlay against the dev Keycloak on `localhost` therefore only
  smoke-tests; a real deployment needs a Keycloak URL reachable from both the browser and the core
  container (a separate JWKS URL is planned for plan 8).

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

The admin GitLab page shows whether core is configured, whether GitLab is reachable, the bot user and
the time of the last webhook.

**Local try-out (DEV ONLY).** `FAKE_GITLAB_PORT=4100 FAKE_GITLAB_PROJECTS=demo/app pnpm --filter @yoda/core fake-gitlab`
runs the in-memory FakeGitLab used by the tests. Start core with `GITLAB_URL=http://127.0.0.1:4100`,
any placeholder `GITLAB_TOKEN` (e.g. `fake-dev-token`) and a placeholder `GITLAB_WEBHOOK_SECRET`, then
post webhooks with `curl` using that secret. Never point a real deployment at it.

## Hospital Keycloak requirements

- Access tokens must include `preferred_username`.
- A `groups` mapper (Group Membership, **full path** enabled) must add the groups to the access token;
  `STAFF_GROUP` is matched against those paths.
- `azp` must equal the client id (`OIDC_CLIENT_ID`).
- The migrations run `CREATE EXTENSION vector` and `pg_trgm`, which needs a superuser; otherwise a DBA
  must pre-create both extensions in the database.

## CI

`.gitlab-ci.yml` (and the equivalent `.github/workflows/ci.yml`): `secrets` (gitleaks over full
history), `test` (pgvector service, typecheck, tests), `build` (images on the default branch and tags).
