# Installer and settings: phase 0 spike findings

Spike for [installer-proposal.md](installer-proposal.md) §13.1 (issue #17, Task 1). Everything below was run on
2026-11-26 on an arm64 Docker host (OrbStack, Docker Compose v5.5.0; amd64 runs under emulation). Prototypes
lived in a scratch directory only. No production code changed, and every container, volume and image the spike
created was removed afterwards.

## Recommendations (read this first)

| # | Question | Answer | Plan change |
| --- | --- | --- | --- |
| 1 | RustFS credential files | **Supported natively.** `rustfs/rustfs:1.0.6` reads `RUSTFS_ACCESS_KEY_FILE` / `RUSTFS_SECRET_KEY_FILE`. No shim and no derived image. | Drop the shim from §3.2. **File ownership needs a design** (see 1.3): RustFS runs as uid 10001, core as 1000 and backup as 999, so a `0700` directory with `0600` files owned by core is unreadable to the others. Use a shared group (`group_add`) and a core-only subdirectory. |
| 2 | keycloak-js after an async `/public-config` fetch | **Works.** `init()` reads the callback from `window.location.href` and needs no network call with `url`+`realm`. The fetch adds one round trip before the existing `await init()`. | The plugin and `role.global` middleware must **skip Keycloak entirely on `/setup` and `/recovery`**. Otherwise a Keycloak outage blocks the recovery page. The `NUXT_PUBLIC_KEYCLOAK_*` defaults must become `''`, or the rule "prefer a non-empty runtime value" always picks the localhost default. |
| 3 | Password hashing | **`@node-rs/argon2` 2.2.2.** It has prebuilt `linux-x64-musl` and `linux-arm64-musl` binaries, installs with the core Dockerfile's `--ignore-scripts`, has no dependencies, is MIT, and runs off the event loop. About 20 ms (OWASP params) or about 105–115 ms (proposal params) per hash on both architectures. | Keep the proposal's choice. Pick **one** parameter set: §7.2 says m=64 MiB, t=3, but the brief says the OWASP minimum, m=19 MiB, t=2 (see 3.3). Hash recovery codes with HMAC-SHA-256 instead of argon2id (see 3.4). |
| 4 | LISTEN/NOTIFY with postgres.js | **Works.** `db.$client.listen()` opens one dedicated connection and re-LISTENs on reconnect (51 ms after `pg_terminate_backend`). A NOTIFY inside a drizzle transaction is delivered on commit only. | Reload the **whole snapshot in `onlisten`**, because NOTIFYs sent while the listener is down are lost (verified). The payload limit is under 8000 bytes, so send key names only. +1 connection. Session pooling is required (not PgBouncer transaction mode). Tests on a shared DB need a per-test channel or idempotent handlers. |
| 5 | `deps.config` inventory | **61 field reads in 17 files; 3 more files pass the whole object; 8 more only carry the type** (`Pick<AppDeps, …'config'>`). Most reads are per call through `deps.config.x`. Four places capture config or a client at construction. | §13.1's "~15 files" is about 20 to edit. Make `deps.config` a **getter** over `settings.current` so existing reads stay live. Fix two route-level destructures (`channel-webhooks.ts:60`, `notification-channels.ts:19`). Holders are needed for `ai.models`, `jwks`, `gitlab` and `mailTransport`. |
| 6 | TOTP and QR | **`otpauth` 9.6.0** (MIT, one dependency, `@noble/hashes`; 3.4 kB gz in core; passes the RFC 6238 vector). **`uqr` 0.1.3** (MIT, zero dependencies, 4.6 kB gz) for the QR, rendered in the portal's setup chunk as an `<img>` data URL. | Not `qrcode`: it pulls in `yargs` and `pngjs` (22 transitive packages, 9.6 kB gz in the browser). |

Other plan-level findings:

- `envSchema` makes `OIDC_ISSUER`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` **required**. Setup mode needs `OIDC_ISSUER`
  optional (Task 2/6). The S3 keys come from the bootstrap files, so they stay required, but they may come from
  `bootstrap.env` instead of env.
- `bootstrap.env` (the aggregate read by migrate and backup) **must not contain the master key**. The backup
  container needs no access to the master key (§3.6), and with the layout in 1.3 it has none.
- `AI_WORKERS` is captured by pg-boss `work()` registration and `MCP_ENABLED` by route registration. Both are
  `restart` unless reworked (§5.3 already says this about MCP).

---

## 1. RustFS credential files

### 1.1 Evidence

The image's entrypoint (`/etc/rustfs/entrypoint.sh`) and the binary both handle `*_FILE`:

```console
$ docker run --rm --entrypoint /usr/bin/rustfs rustfs/rustfs:1.0.6 server --help | grep -A3 key-file
      --access-key-file <ACCESS_KEY_FILE>
          Access key stored in a file used for authentication
          [env: RUSTFS_ACCESS_KEY_FILE=]
      --secret-key-file <SECRET_KEY_FILE>
          Secret key stored in a file used for authentication
          [env: RUSTFS_SECRET_KEY_FILE=]
$ grep -n resolve_credential_source.*RUSTFS entrypoint.sh
181: ACCESS_SOURCE=$(resolve_credential_source "RUSTFS_ACCESS_KEY" "RUSTFS_ACCESS_KEY_FILE" "access-key" "access-key-file" "$@")
182: SECRET_SOURCE=$(resolve_credential_source "RUSTFS_SECRET_KEY" "RUSTFS_SECRET_KEY_FILE" "secret-key" "secret-key-file" "$@")
```

The image is Alpine 3.24, `User: rustfs` (`uid=10001 gid=10001`), and the entrypoint runs as that user (no root
step). The entrypoint trims CR and surrounding blanks, the same way the binary does, so a trailing newline in the
file is harmless.

End-to-end test: generated keys in a named volume, RustFS started with only the `_FILE` variables, then requests
signed with `curl --aws-sigv4`:

| Request | Result |
| --- | --- |
| Generated keys: `PUT /spike-bucket`, `GET /` | 200, bucket listed |
| `rustfsadmin:rustfsadmin` (the built-in default) | 403 |
| Right access key, wrong secret | 403 |

### 1.2 Failure modes (all verified)

| Setup | Outcome |
| --- | --- |
| File not readable by uid 10001 (owned by `node` 1000, `0600`) | `ERROR: RUSTFS_ACCESS_KEY_FILE points to an unreadable file.`, exit 1 |
| File readable, but its directory is `0700` and owned by 1000 | Same error (no traverse permission) |
| `RUSTFS_ACCESS_KEY=` (empty) **and** `RUSTFS_ACCESS_KEY_FILE` | `ERROR: Set either RUSTFS_ACCESS_KEY or RUSTFS_ACCESS_KEY_FILE, not both.` |

The last row matters for compose. The base `docker-compose.yml` sets `RUSTFS_ACCESS_KEY`, and the prod overlay
must remove it, not blank it. `!reset null` does that. Checked with `docker compose -f base.yml -f prod.yml
config`: only the `_FILE` variables remain.

```yaml
rustfs:
  group_add: ['10500']
  environment:
    RUSTFS_ACCESS_KEY: !reset null
    RUSTFS_SECRET_KEY: !reset null
    RUSTFS_ACCESS_KEY_FILE: /var/lib/yoda/s3-access-key
    RUSTFS_SECRET_KEY_FILE: /var/lib/yoda/s3-secret-key
  volumes: ['yoda-bootstrap:/var/lib/yoda:ro']
```

An existing install with `S3_ACCESS_KEY` in `.env` still works: `init` writes the env value into the file (rule 1
of §3.2).

### 1.3 Ownership layout (replaces §3.2's "0700, owned by the core image's user")

The bootstrap volume is read by four different users:

| Container | User |
| --- | --- |
| core, migrate, init (core image) | `node` 1000 |
| rustfs | 10001 |
| backup (`postgres:17-bookworm`, `USER postgres`) | 999 |
| postgres | root first; its entrypoint reads `POSTGRES_PASSWORD_FILE` as root, exports the value and then drops to `postgres` (verified: a root-owned `0600` file works and `psql` signs in with it) |

Tested and working: a shared group, gid 10500, added with `group_add` / `--group-add`. With it, rustfs, `node` and
uid 999 each read a `0640 root:10500` file, and rustfs without the group cannot. Proposed layout (`init` runs with
`user: '0:0'`):

```text
/var/lib/yoda                 0750 root:10500
  postgres-password           0640 root:10500   postgres (as root), core and backup via bootstrap.env
  s3-access-key, s3-secret-key 0640 root:10500  rustfs (group_add)
  bootstrap.env               0640 root:10500   core, migrate, backup: DATABASE_URL and S3_* only, no master key
  install-id                  0644
  core/                       0700 1000:1000    core only
    master-key                0600
    setup-token               0600   written by core (it owns core/, so it can create and delete it)
```

Each container gets `group_add: ['10500']` except postgres, which reads the file as root. The setup-token
subdirectory also fixes a second gap: in a root-owned `0750` directory, core (1000) could not create or delete
`setup-token`.

## 2. keycloak-js init after an async `/public-config` fetch

Today `apps/portal/app/plugins/keycloak.client.ts` builds `new Keycloak({ url, realm, clientId })` from
`useRuntimeConfig().public` and awaits `init({ onLoad: 'login-required', pkceMethod: 'S256', checkLoginIframe:
false, locale })`. A `router.afterEach` strips the OAuth fragment, because the Nuxt router captured the initial URL
before init.

### 2.1 Evidence (keycloak-js 26.2.5, `node_modules/keycloak-js/lib/keycloak.js`; Nuxt 4.7.0)

- `init()` throws on a second call (`:188`, "A 'Keycloak' instance can only be initialized once"), so construct the
  instance only after the config has arrived. Never construct it with placeholders and re-init.
- `#loadConfig()` (`:716`): with `{ url, realm, clientId }` it only builds the endpoint URLs, with no network call
  (unless DPoP is on). With `{ oidcProvider }` it fetches `.well-known/openid-configuration` from the browser, which
  costs an extra round trip and needs CORS on Keycloak. **Keep `url`+`realm`** derived from `oidc.issuer`
  (`<url>/realms/<realm>`), as §5.6 says.
- `#processInit()` (`:891`) parses the callback from `window.location.href` when `init()` runs. An `await
  $fetch(...)` before it does not change the URL, so the `#state=…&code=…` callback still validates. The PKCE
  verifier and state wait in localStorage (`createCallbackStorage`).
- The Nuxt router plugin captures `initialURL` (`pages/runtime/plugins/router.js:89`) before user plugins run and
  replays it on `app:created` (`:259`). The existing `afterEach` fragment strip is therefore still needed and still
  sufficient. Plugins run in order, and an `async` plugin already blocks mount, so the extra fetch only adds
  latency (one same-origin request through the `/api` proxy).

### 2.2 Sketch

```ts
// plugins/keycloak.client.ts (sketch, not production code)
export default defineNuxtPlugin(async () => {
  const route = useRouter().resolve(window.location.pathname)
  const pub = await loadPublicConfig()          // $fetch('/api/public-config'); stored in useState('publicConfig')
  // Setup and recovery never touch Keycloak: they work when it is unset, wrong or down.
  if (pub.setup === 'required' || isLocalAuthPath(route.path)) {
    if (pub.setup === 'required' && !isLocalAuthPath(route.path)) await navigateTo('/setup', { replace: true })
    return { provide: { keycloak: null } }
  }
  const env = useRuntimeConfig().public          // NUXT_PUBLIC_KEYCLOAK_* still win while deprecated
  const keycloak = new Keycloak({
    url: env.keycloakUrl || pub.oidc!.url,
    realm: env.keycloakRealm || pub.oidc!.realm,
    clientId: env.keycloakClientId || pub.oidc!.clientId,
  })
  await keycloak.init({ onLoad: 'login-required', pkceMethod: 'S256', checkLoginIframe: false, locale: loginLocale(document.cookie) })
  // … unchanged afterEach fragment strip
  return { provide: { keycloak } }
})
```

### 2.3 Pitfalls

1. **Recovery must not depend on Keycloak.** With `login-required`, a down or wrong issuer means a redirect to a
   dead page before any route renders. Decide by `location.pathname` (`/setup*`, `/recovery*`) **before** creating
   the instance.
2. **`role.global.ts` calls `useMe()` and then `useApi()`, which reads `$keycloak`.** It must return early on
   `/setup` and `/recovery`, and those pages must use a cookie-based `$fetch` (with `X-Yoda-CSRF`), not `useApi`.
   `useUpload`, `useLiveEvents` and `UserMenu` also read `$keycloak` and must never mount there.
3. **The runtime-config defaults are not empty** (`keycloakUrl: 'http://localhost:8080'`, `keycloakRealm: 'yoda'`,
   `keycloakClientId: 'yoda-portal'` in `nuxt.config.ts`). "Prefer a non-empty runtime value" would always pick
   them. Set them to `''`, and keep dev values in `.env` and `.env.example`.
4. **`/public-config` failure** (core down or restarting): show an error state with a retry, not a blank page or a
   login loop. Fetch it with `cache: 'no-store'` (or honour the `ETag`) so a just-completed setup is not hidden for
   60 s by a cached `setup: 'required'`.
5. **Config change between redirect and callback.** If the issuer changes while a user is at Keycloak, the code
   exchange goes to the new realm and fails. This is rare, and `login-required` simply starts again. The issuer
   change is staged anyway (§8.6).
6. **Silent check-SSO is not needed.** The portal is `login-required`, and `check-sso` with
   `silentCheckSsoRedirectUri` would add a static `silent-check-sso.html` and third-party-cookie problems in
   Safari and Firefox. Keep it off.
7. The other public values (`orgLine` in `layouts/default.vue:12`, `lineAddFriendUrl` in
   `pages/settings/notifications.vue:11`, `runnerDocsUrl` in `pages/runners.vue:9`) are read once in `setup()`. A
   `usePublicConfig()` filled by the plugin before mount is enough, and no reactivity is needed.

## 3. Password hashing

### 3.1 Method

The test is in a scratch directory: `node:22-alpine` (the base of `apps/core/Dockerfile`, musl), `pnpm@10.15.0`
(the repo's `packageManager`), `pnpm install --ignore-scripts` (the same flag as the core Dockerfile, so no
node-gyp), and `docker buildx build --platform linux/{arm64,amd64}`. The benchmark warms up once and averages
N runs (arm64 N=10, amd64 N=5). Every library's PHC string verifies with `@node-rs/argon2` (cross-compatible).

### 3.2 Results

| | `@node-rs/argon2` 2.2.2 | `argon2` 0.45.2 | `hash-wasm` 4.13.0 |
| --- | --- | --- | --- |
| How it installs with `--ignore-scripts` | optionalDependency `@node-rs/argon2-linux-{x64,arm64}-musl` (also pulls the `-gnu` one, ~650 kB) | prebuilds shipped in the package (`linux-x64/argon2.musl.node`, `linux-arm64/argon2.armv8.musl.node`) | pure wasm |
| Runtime dependencies | none | `node-addon-api`, `node-gyp-build`, `@phc/format`, `cross-env` | none |
| Size on disk | 68 kB + 650 kB binary | 1.0 MB + 452 kB `node-addon-api` | 2.0 MB |
| arm64, m=19456 t=2 p=1 | 19.9 ms | 13.5 ms | 26.1 ms |
| arm64, m=65536 t=3 p=1 | 112.8 ms | 78.8 ms | 128.4 ms |
| amd64 (emulated), m=19456 t=2 p=1 | 21.2 ms | 15.9 ms | 38.7 ms |
| amd64 (emulated), m=65536 t=3 p=1 | 103.8 ms | 91.5 ms | 156.3 ms |
| Event-loop delay while hashing (arm64, `monitorEventLoopDelay`, max) | 4.5 ms (libuv thread) | 5.3 ms (libuv thread) | **31.6 ms (blocks the main thread)** |
| Licence | MIT | MIT | MIT |

amd64 numbers are from emulation on an arm64 host, so they are an upper bound; real x86-64 is faster.

**Recommendation: `@node-rs/argon2`**, as in the proposal. It installs cleanly for both architectures with the
existing Dockerfile and has no runtime dependencies. `argon2` is about 30 % faster and works too, but brings 4
dependencies. `hash-wasm` blocks the event loop for the whole hash, which is unacceptable on a server that also
streams SSE. `build.mjs` already marks every dependency external, so the native module is loaded from
`node_modules` and not bundled.

### 3.3 Parameters

§7.2 says m=64 MiB, t=3, p=1 (RFC 9106's second recommendation): about 110 ms and 64 MiB per concurrent hash.
OWASP's minimum (m=19 MiB, t=2, p=1) takes about 20 ms. Both are fine behind the §8.4 rate limits (5 per 15 min
per IP). Proposal: **keep 64 MiB / t=3** for the break-glass password, since it is one account and a rare
sign-in. Store the PHC string, so the parameters can change later and `verify` still reads old hashes.

### 3.4 Recovery codes

§7.2 stores the 10 recovery codes as argon2id hashes. Verifying an unknown code means trying every unused hash:
10 × 110 ms ≈ 1.1 s, which ties up the 4-thread libuv pool. The codes are random (≥ 80 bits). Store
**HMAC-SHA-256(key derived from the master key, code)** and look the code up by hash, in constant time and
O(1). Argon2 only matters for low-entropy secrets.

## 4. LISTEN/NOTIFY with postgres.js

### 4.1 Evidence

Versions are postgres 3.4.9, drizzle-orm 0.45.4 and pg-boss 12.39.0. Core creates one client:
`drizzle(postgres(url), { schema })` in `src/db/client.ts`; the default pool is `max: 10`, `src/index.js:449`.
`listen()` (`src/index.js:147`) lazily creates a **second postgres.js instance** with `max: 1, idle_timeout: null,
max_lifetime: null`. On `onclose` it re-runs `LISTEN` for every channel and calls each `onlisten` again.

A scratch script ran against the dev Postgres (`postgres://yoda:yoda@localhost:5432/yoda`, channel
`spike_settings_changed`, no writes):

```text
07:10:08.631 onlisten #1 (reload all settings here)
07:10:08.632 listener backend pid 234843
07:10:08.688 connections after listen: spike-app=2          (1 pool + 1 listener)
07:10:08.690 in tx, before commit; got so far 0
07:10:08.692 notify ["smtp.host"]                             (delivered on commit)
07:10:09.099 after rollback got 1 (expect 1)                  (rolled-back NOTIFY never delivered)
07:10:09.316 after 3 identical notifies in one tx got 2       (Postgres folds duplicates per transaction)
07:10:09.325 terminated listener pid 234843
07:10:09.361 onlisten #2 (reload all settings here)          (re-listened after 51 ms, new pid)
07:10:09.383 notify after-reconnect
07:10:09.683 payloads ["[\"smtp.host\"]","dup","after-reconnect"]   ("sent-while-down" was lost)
07:10:09.691 8000 bytes: payload string too long
```

### 4.2 Design consequences

- Use `db.$client.listen('settings_changed', onKeys, onListen)`. `$client` is already used in `server.ts`
  shutdown. No new client or URL handling is needed, and `client.end()` at shutdown also closes the listener
  (`src/index.js:374`).
- **`onListen` reloads the whole snapshot.** It runs at start and after every reconnect, which covers
  notifications lost while the listener was down. `onKeys` reloads only the named keys. Both are idempotent, and
  the writing process also receives its own NOTIFY.
- `NOTIFY` goes inside the settings transaction (`select pg_notify('settings_changed', $keys)`), so nothing
  arrives for a rolled-back write and the reader sees committed rows. The payload is a JSON array of key names,
  well under the ~8000-byte limit, and never values.
- **Connections:** +1 dedicated connection for core. Today core opens up to 10 (postgres.js) plus up to 10
  (pg-boss's `pg` pool), against Postgres `max_connections` = 100. pg-boss's own LISTEN (`useListenNotify`) is off
  by default and the app does not enable it, so there is no interaction. `yoda-admin` (a short-lived `exec`)
  sends NOTIFY over its own connection. The backup container polls with `psql` before each sleep (§5.3) and does
  not listen.
- **Requirement for external Postgres:** LISTEN needs a session-pinned connection, so a `DATABASE_URL` through
  PgBouncer in transaction mode breaks live apply. Add that to operations.md, and log a warning if `listen` has
  not fired `onlisten` within N seconds.
- **Tests:** the core tests use a real shared Postgres (`test/helpers.ts`, `TEST_DATABASE_URL`). NOTIFY is
  database-wide, so parallel test files would hear each other. Make the channel name injectable (default
  `settings_changed`), or keep handlers idempotent and tolerant of foreign keys.

## 5. Config inventory

`apps/core/src/config.ts` defines `Config` with 41 fields, parsed once from `process.env` at `server.ts:16`. The
only other `process.env` reads are `app.ts:81` (`VITEST`, logger) and `db/migrate.ts:10` (`DATABASE_URL`). The
grep for `(deps.)config.<field>` finds **61 field reads in 17 files**. Three more files pass the whole object on
(`notifications/channels/index.ts`, `notifications/prefs.ts`, `routes/notification-channels.ts`), so about 20
files read config. Eight more only carry `config` in a type (`Pick<AppDeps, … 'config'>` or `config: Config`):
`ai/drafter.ts`, `ai/gateway.ts`, `discussions/brief.ts`, `secretary/{chat,events,sweep}.ts`, `status/weekly.ts`
and `jobs/handlers.ts`.

Legend: **per call** means read through `deps.config.x` (or a `config` parameter) on each request or job, so it
stays live if `deps.config` is a getter. **Boot** means read once in `server.ts` or `buildApp`. **Captured** means
held in a closure or object built at boot, so it needs a holder or a fix.

### 5.1 Bootstrap only (never in the DB; §8)

| Field | Where | When |
| --- | --- | --- |
| `port` | `server.ts:55` | boot |
| `databaseUrl` | `server.ts:17` (drizzle), `server.ts:28` (pg-boss), `db/migrate.ts:10` | boot |
| `migrateOnStart` | `server.ts:20` | boot |
| `s3Endpoint`, `s3Region`, `s3Bucket`, `s3AccessKey`, `s3SecretKey` | `storage/s3.ts:26–31` (`createS3Storage`, `server.ts:26`) | **captured** in the S3 client; stays restart (D9) |

### 5.2 Organisation (general)

| Field | Where | When |
| --- | --- | --- |
| `portalUrl` | `gitlab/sync.ts:132`, `notifications/deliver.ts:72`, `channels/email.ts:58`, `channels/line.ts:34`, `channels/telegram.ts:45`, `routes/channel-webhooks.ts:100,140` | per call (the webhooks use the **captured** `config`, see 5.9) |
| (portal) `orgLine` | `layouts/default.vue:12` (`NUXT_PUBLIC_ORG_LINE`) | per mount |
| (portal) `runnerDocsUrl` | `pages/runners.vue:9` (`NUXT_PUBLIC_RUNNER_DOCS_URL`) | per mount |

### 5.3 Sign-in

| Field | Where | When |
| --- | --- | --- |
| `oidcIssuer` | `auth/plugin.ts:83` (jwtVerify issuer); `auth/jwks.ts:9` via `remoteJwks` at `server.ts:25` | issuer per call; **JWKS captured** (`deps.jwks`) |
| `oidcJwksUrl` | `auth/jwks.ts:9` | **captured** in `deps.jwks` |
| `oidcClientId` | `auth/plugin.ts:87` | per call |
| `staffGroup` | `auth/plugin.ts:119`, `auth/people.ts:33` | per call |
| `bootstrapAdmins` | `auth/people.ts:41` | per call (on every upsert) |
| (portal) `keycloakUrl`, `keycloakRealm`, `keycloakClientId` | `plugins/keycloak.client.ts` (`NUXT_PUBLIC_KEYCLOAK_*`) | once at app start; replaced by `/public-config` |

### 5.4 AI

| Field | Where | When |
| --- | --- | --- |
| `anthropicApiKey`, `openaiApiKey`, `openaiBaseUrl` | `ai/models.ts:34–36` | **captured**: `buildModels(config)` at `server.ts:29`, passed into `AiGateway.deps.models` |
| `aiModelDraft`, `aiModelFast`, `aiEmbeddingModel` | `ai/models.ts:54–56` | **captured** (same `ModelSet`) |
| `aiWorkers` | `server.ts:28` → pg-boss `work({ localConcurrency })` (`jobs/queue.ts:107`) | boot, so **restart** |
| `dailyTaskCap` | `work/context.ts:50` | per call |

### 5.5 GitLab

| Field | Where | When |
| --- | --- | --- |
| `gitlabUrl`, `gitlabToken` | `server.ts:30` → `new GitLabClient` → `deps.gitlab` (read per call in `routes/gitlab.ts`, `gitlab/{sync,reconcile}.ts`, `runners/merge-requests.ts`, `secretary/sweep.ts`, `routes/attachments.ts`, `auth/plugin.ts`) | **captured** client; the bot user is fetched once (`server.ts:32`) |
| `gitlabWebhookSecret` | `routes/gitlab.ts:35` (`app.deps.config` per request) | per call |

### 5.6 Notification channels

| Field | Where | When |
| --- | --- | --- |
| `smtpHost`, `mailFrom` | `channels/email.ts:11` (`emailConfigured`), `:55` | per call |
| `smtpHost`, `smtpPort`, `smtpSecure`, `smtpUser`, `smtpPassword` | `channels/email.ts:16–19` (`createMailTransport`) | **captured**: `server.ts:33` builds `deps.mailTransport`; `emailChannel` falls back to `transport ??= createMailTransport(deps.config)` per `createChannels()` call (`deliver.ts:71`, per delivery) |
| `lineChannelAccessToken`, `lineChannelSecret` | `channels/line.ts:10,20`; `routes/channel-webhooks.ts:86,92` | per call (webhooks **captured**, see 5.9) |
| `lineApiUrl` | `channels/line.ts:22` | per call (bootstrap-only per the global constraints) |
| `telegramBotToken`, `telegramBotUsername`, `telegramWebhookSecret` | `channels/telegram.ts:12,20`; `notifications/linking.ts:56`; `routes/channel-webhooks.ts:134–135` | per call (webhooks **captured**) |
| `telegramApiUrl` | `channels/telegram.ts:22` | per call (bootstrap only) |
| `configured()` checks | `channels/index.ts:43–56`, `notifications/prefs.ts:78–125`, `work/context.ts:43`, `routes/notification-channels.ts:23–56` | per call (route **captured**, see 5.9) |
| (portal) `lineAddFriendUrl` | `pages/settings/notifications.vue:11` (`NUXT_PUBLIC_LINE_ADD_FRIEND_URL`) | per mount |

### 5.7 Runners

| Field | Where | When |
| --- | --- | --- |
| `runnerLeaseSeconds` | `runners/claims.ts:37` | per call |
| `mcpEnabled` | `app.ts:130` (`if (deps.config.mcpEnabled) mcpRoutes(app)`) | boot, so **restart**, or live with a per-request guard (§5.3) |

### 5.8 Backups (not core)

`BACKUP_AT` and `BACKUP_KEEP_DAYS` are read by `ops/backup/backup.sh` from env (`docker-compose.prod.yml`
backup service). They move to a `psql` read before each sleep (§5.3). The backup image runs as uid 999 (see 1.3).

### 5.9 Places that capture config or clients (need holders or a small fix)

| Where | What is captured | Fix |
| --- | --- | --- |
| `server.ts:25` `remoteJwks(config)` → `deps.jwks` | JWKS URL | holder: rebuild on `oidc.*` and swap `deps.jwks` |
| `server.ts:29` `buildModels(config)` → `AiGateway.deps.models` | keys and model ids | `AiGateway.setModels()` (or a getter); in-flight calls keep their `lm` |
| `server.ts:30` `new GitLabClient(...)` → `deps.gitlab` | URL and token | holder: swap `deps.gitlab`, refresh the bot user |
| `server.ts:33` `createMailTransport(config)` → `deps.mailTransport` | SMTP transport | holder: swap and `close()` the old one after in-flight sends |
| `routes/channel-webhooks.ts:60` `const { config, db } = app.deps` | **the config object itself**, at route registration | read `app.deps.config` inside each handler |
| `routes/notification-channels.ts:19` `const { db, config } = app.deps` | same | same |
| `jobs/queue.ts:107` `localConcurrency` | `aiWorkers` | restart |
| `app.ts:130` MCP route registration | `mcpEnabled` | restart, or a per-request guard |
| `storage/s3.ts` | S3 credentials | restart (bootstrap only) |

Every other read goes through `deps.config.x` (or `app.deps.config.x`) at call time. The `deps` object is
`app.deps`, shared by reference with `registerJobHandlers` (there is no `...deps` spread anywhere in `src`). So
`Object.defineProperty(deps, 'config', { get: () => settings.current })` keeps those reads live with no
call-site change, and the rename to `deps.settings.current` (§5.3) can be gradual. `Config` typed parameters
(`prefs.ts`, `channels/*.ts`, `people.ts`) receive the current snapshot per call and need no change.

## 6. TOTP and QR code

| Package | Version | Licence | Runtime dependencies | Minified + gzip | Notes |
| --- | --- | --- | --- | --- | --- |
| `otpauth` | 9.6.0 | MIT | `@noble/hashes` | 3.4 kB (node) / 10.5 kB (browser) | Passes the RFC 6238 test vector (SHA1, 8 digits, T=59 → `94287082`). `validate({ token, window: 1 })` returns the drift or `null`. Builds the `otpauth://` URI. |
| `uqr` | 0.1.3 (2026-04) | MIT | none | 4.6 kB | unjs. `renderSVG(uri)` gives a 16 kB SVG string. |
| `qrcode` | 1.5.4 (2024-08) | MIT | `pngjs`, `yargs`, `dijkstrajs` (22 transitive packages) | 9.6 kB (browser) / 20 kB (node) | The CLI dependencies end up in the install. |

The commands were `pnpm install --ignore-scripts` in a scratch directory and `esbuild --bundle --minify
--platform={browser,node}`.

Recommendation: **`otpauth` in core**: generate the seed, encrypt it with the master key, and verify with
`window: 1`. Reject a code that was already used in the same 30-second step (store the last accepted counter on
`local_admins`), which the proposal does not yet say. Use **`uqr` in the portal's `/setup` and `/recovery` chunk**:
the enrolment API returns the `otpauth://` URI (and the base32 secret for manual entry) once, and the page shows
`<img :src="'data:image/svg+xml;utf8,' + encodeURIComponent(renderSVG(uri))">`. Use `<img>`, not `v-html`, so
there is no markup injection. Neither value is stored in the portal or logged.
