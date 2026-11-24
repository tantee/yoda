# Plan 1 (Foundation) — follow-ups carried into later plans

Deferred minor findings from task and whole-branch reviews. None block plan 1.

## Pick up early in plan 2
- `requireManage` runs outside the project row lock (`apps/core/src/routes/projects.ts`); re-check after `lockProject`.
- No concurrency test exercising the last-PM row lock; last-admin test uses a fixed 300 ms wait.
- No test that `lastSeenStaff` flips in `GET /people` after removal from the staff group.
- Portal: clearing all roles on a member is silently ignored (chips show empty while server keeps roles) — reload in that case.
- Portal: admin nav stays visible after self-demotion until reload (server enforces correctly).
- Portal: 403 page state and expired-session redirect not yet exercised in a browser; Vuetify th locale and `<html lang>` only typechecked.

## Later / plan 8 (production)
- Separate token issuer from an internal JWKS URL (`OIDC_JWKS_URL`) so core in a container can fetch keys from the hospital Keycloak.
- Migrations run on every core container start — fine for a single instance, races with replicas.
- GitHub Actions build job builds but doesn't push images.
- RS256 pin is untested (needs a second key type in tests); keep it in step with the realm's signing algorithm.
- Vuetify registers all components (~5 MB bundle) — switch to tree-shaken imports.
- Local Node 22.18 is below what Nuxt 4.7 wants (22.21); vite 8 peer warning.
- Test DB connection not closed at end of test run; logger disabled via `process.env.VITEST` check inside app code.
- Switch/select not remounted when the reload after a rejected change fails (`apps/portal/app/pages/admin/people.vue`).
