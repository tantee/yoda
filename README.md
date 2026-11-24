# Yoda — AI work portal

pnpm monorepo: `apps/core` (Fastify + Drizzle), `apps/portal` (Nuxt 4 SPA), `packages/shared`.

## Requirements

- Node 22 (`.nvmrc`), pnpm 10 (via `corepack enable`), Docker
- [gitleaks](https://github.com/gitleaks/gitleaks): `brew install gitleaks`

## Dev setup

```bash
pnpm install            # also installs the lefthook git hooks (gitleaks pre-commit)
cp .env.example .env    # adjust ports if needed
docker compose up -d    # postgres, minio, keycloak (bound to 127.0.0.1)
pnpm --filter @yoda/core db:migrate
pnpm dev                # core on PORT, portal on PORTAL_PORT
```

Keycloak dev realm `yoda` is imported from `infra/keycloak` (dev test users, password `dev`; see
`infra/keycloak/README.md`). If you change `KEYCLOAK_PORT`, update `OIDC_ISSUER` and
`NUXT_PUBLIC_KEYCLOAK_URL` to match.

`infra/postgres/init.sql` (extensions, test database) only runs on a fresh Postgres volume. To
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
- portal: `NUXT_CORE_URL`, `NUXT_PUBLIC_KEYCLOAK_URL`, `NUXT_PUBLIC_KEYCLOAK_REALM`,
  `NUXT_PUBLIC_KEYCLOAK_CLIENT_ID` (read at runtime, not baked into the image)
- ports: `CORE_PORT` (4000), `PORTAL_PORT` (3000)

Production secrets come only from the deploy environment / CI variables, never from committed files.
The dev compose services use throwaway credentials and must not be exposed publicly.

## CI

`.gitlab-ci.yml` (and the equivalent `.github/workflows/ci.yml`): `secrets` (gitleaks over full
history), `test` (pgvector service, typecheck, tests), `build` (images on the default branch and tags).
