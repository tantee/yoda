# Yoda operations runbook

The reference for the people who run Yoda. For a guided walk-through start with the
[install and upgrade guide](guides/install.md); the [admin guide](guides/admin.md) covers System settings in the
portal, and [docs/README.md](README.md) lists every guide.

How to install, configure, upgrade, back up and troubleshoot a production Yoda. Every hostname here is a
placeholder (`portal.example.org`, `sso.example.org`, `gitlab.example.org`, `registry.example.org`,
`files.example.org`, `smtp.example.org`); use your own. Secrets live only in the deploy host's `.env` (mode `600`),
in System settings (encrypted with the master key, section 4a), in GitHub repository secrets and in GitLab CI/CD
variables, never in the repository, tickets or chat. Releases are published on GitHub (GitHub Release assets and
`ghcr.io/tantee/yoda` images, [docs/releasing.md](releasing.md)); `files.example.org` and `registry.example.org`
stand for an optional internal mirror.

Contents:

1. [Prerequisites](#1-prerequisites)
2. [Keycloak](#2-keycloak)
3. [Settings](#3-settings)
4. [First install](#4-first-install)
   - [4a. Bootstrap volume and master key](#4a-bootstrap-volume-and-master-key)
5. [Upgrade and rollback](#5-upgrade-and-rollback)
6. [Backups and restore](#6-backups-and-restore)
7. [GitLab integration](#7-gitlab-integration)
8. [Runners](#8-runners)
9. [Email, LINE and Telegram](#9-email-line-and-telegram)
10. [Rotating secrets](#10-rotating-secrets)
11. [Troubleshooting](#11-troubleshooting)

## 1. Prerequisites

- **Host.** One Linux server (4 CPU, 8 GB RAM and enough disk for the database, the files bucket and 14 days of
  backups is a reasonable start) with Docker Engine 24+ and the Compose plugin v2.24+. A deploy user that may
  run `docker` (member of the `docker` group), and, for an internal GitLab mirror's deploy job, an SSH key pair
  (section 5).
- **Registry access.** The host pulls the public images from `ghcr.io/tantee/yoda` (no login; outbound HTTPS to
  `ghcr.io` and `github.com`). **From an internal mirror** instead (D1, [releasing](releasing.md#internal-mirror)):
  create a GitLab **deploy token** on the mirror project with the `read_registry` scope only, and log in once on
  the host as the deploy user: `docker login registry.example.org` (the user name and token are entered
  interactively, so they stay out of shell history; `install.sh` runs this for you for a registry other than
  ghcr.io when there is no saved login).
- **Tools for `install.sh`:** `curl` (or `wget`), `sha256sum` (or `shasum`), `tar` and `minisign`
  (`apt install minisign` / `dnf install minisign`), to check the release signature.
- **DNS and TLS.** A reverse proxy (nginx, Traefik, the organisation's load balancer) terminates HTTPS for
  `https://portal.example.org` and forwards to the portal on `PORTAL_PORT` (3000). Only the portal is public:
  - The prod overlay publishes the portal (`PORTAL_PORT`, 3000) and core (`CORE_PORT`, 4000) on `127.0.0.1`
    only, for a reverse proxy on the same host. Core is not exposed to users. When the proxy runs on another
    machine, set `PORTAL_BIND` (and `CORE_BIND` only if that proxy also serves core's `/mcp`, section 8) to the
    host's internal address and firewall the ports to the proxy.
  - Postgres and RustFS publish no ports in production. Reach them through compose (`dc`, section 4): the
    database with `dc exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`, the bucket with
    `dc run --rm --no-deps --entrypoint bash backup -c 'source /opt/backup/lib.sh && setup_store && rclone lsf "store:$S3_BUCKET"'`
    (the backup image has `rclone` and the storage credentials). The RustFS web console is off in production.
  - Readiness (`/ready` on core, `/api/ready` through the portal) reports which dependency is down. Let the
    load balancer's health check use it, but **do not expose it beyond the load balancer**: deny
    `/api/ready` at the reverse proxy for outside clients.
  - Webhooks from GitLab, LINE and Telegram reach core through the portal's `/api` proxy, so the portal must be
    reachable from them (LINE and Telegram need a public HTTPS URL with a valid certificate).
- **Reaching the setup wizard.** The first open of `/setup` goes through the reverse proxy
  (`https://portal.example.org/setup`) or, before the proxy exists, an SSH tunnel to the loopback-only portal:
  `ssh -L 3000:127.0.0.1:3000 <deploy host>`, then `http://127.0.0.1:3000/setup`.
  **Setup over plain HTTP (D8).** The public URL must be `https://`, unless its host is this machine:
  `localhost`, a `*.localhost` name, 127.0.0.0/8 (`127.0.0.1`) or `::1`. The wizard and System settings → General
  refuse anything else on `http://` (a LAN address such as `http://10.0.0.5:3000`, a host name, `0.0.0.0`) with
  `https_required`, and setup does not finish while such a URL is in effect (also one set in `PORTAL_URL`):
  browsers allow the portal's Keycloak sign-in only on https or localhost, so nobody could sign in. The wizard
  page itself may be plain HTTP (the tunnel is), and says so. To put HTTPS in front: a reverse proxy with a
  certificate for the portal's name, forwarding to `PORTAL_PORT` (3000) and passing `Host` and the
  `X-Forwarded-*` headers (section 5), plus `YODA_TRUSTED_PROXY_HOPS=2` in `.env` and a restart.
- **Outbound network.** Core needs HTTPS to the AI providers, to GitLab, to `api.line.me` and
  `api.telegram.org` when those channels are used, and SMTP to the mail relay.

## 2. Keycloak

Yoda signs everyone in through the organisation's Keycloak (OpenID Connect). The dev realm in
`infra/keycloak` is for development only; never import it in production.

Owner checklist (realm `yoda` here; an existing organisation realm works the same way):

- [ ] **Client** `yoda-portal`: OpenID Connect, **Client authentication off** (public client), **Standard
      flow** on, direct access grants off, **PKCE method `S256`** (Advanced → Proof Key for Code Exchange).
      Valid redirect URIs `https://portal.example.org/*`, valid post-logout redirect URIs
      `https://portal.example.org/*`, web origins `https://portal.example.org`.
- [ ] **Claims in the access token:** `preferred_username` (default), and a **Group Membership** mapper named
      `groups` with **Full group path** on and **Add to access token** on. `azp` must equal the client id, which
      Keycloak does for tokens issued to `yoda-portal`.
- [ ] **Staff group**, e.g. `/it-dev`, with every IT staff member in it. `STAFF_GROUP` is its full path.
      Everyone else who signs in is a requester. An admin can override staff status per person in
      Admin → People.
- [ ] **First admin:** the setup wizard's last step (claim) signs you in through Keycloak and makes you admin;
      later admins are made in Admin → People. (An env-based install can still set `BOOTSTRAP_ADMINS` to Keycloak
      usernames before those people first sign in; it applies only when a person is first created.)
- [ ] **Issuer:** the browser-facing issuer, e.g. `https://sso.example.org/realms/yoda` (it must equal the
      token's `iss`), entered in the wizard's sign-in step, which tests discovery, the signing keys and the
      client. If core cannot reach the public Keycloak URL, also give the internal certs URL (JWKS URL); tokens
      are still checked against the issuer. The portal no longer needs `NUXT_PUBLIC_KEYCLOAK_*`: it reads where
      to sign in from core's `/public-config`. After setup, the sign-in values change only through `/recovery`
      (section 11), so a mistake there can never lock every admin out.

### Login theme (optional)

`infra/keycloak/themes/yoda` is Yoda's own sign-in page: the portal's navy and blue, IBM Plex Sans Thai and IBM
Plex Sans (bundled in the theme with their OFL licence, no CDN), Thai and English. It is a `login` theme on top of
Keycloak's `base` theme and is built for Keycloak 26 (the dev version). Install it on the hospital Keycloak in one
of two ways:

- **Copy the folders.** Copy both theme folders, `infra/keycloak/themes/yoda` and `infra/keycloak/themes/yoda-plain`
  (the same theme without the fun touches, see below), to `/opt/keycloak/themes/` on every Keycloak node (or mount
  `infra/keycloak/themes` there read-only in a container). A theme folder needs no build step.
- **Theme JAR** (when the server is built or images are baked). From `infra/keycloak/themes`, add a
  `META-INF/keycloak-themes.json` listing both themes and zip it with both theme folders under `theme/`:

  ```bash
  mkdir -p /tmp/yoda-theme/META-INF /tmp/yoda-theme/theme
  cp -r infra/keycloak/themes/yoda infra/keycloak/themes/yoda-plain /tmp/yoda-theme/theme/
  echo '{"themes": [{"name": "yoda", "types": ["login"]}, {"name": "yoda-plain", "types": ["login"]}]}' > /tmp/yoda-theme/META-INF/keycloak-themes.json
  (cd /tmp/yoda-theme && zip -r ../yoda-login-theme.jar META-INF theme)
  ```

  Put `yoda-login-theme.jar` in `/opt/keycloak/providers/`, then run `kc.sh build` (or rebuild the image) and
  restart.

Then, in the admin console for the realm Yoda uses:

- [ ] **Realm settings → Themes → Login theme:** `yoda`. If the realm is shared with other systems, set it on the
      client instead (**Clients → yoda-portal → Settings → Login settings → Login theme**) so only Yoda's sign-in
      changes.
- [ ] **Realm settings → Localization:** internationalisation on, supported locales `th` and `en`, default `th`.
      The portal sends its language as `ui_locales`, so the page follows the language chosen in the portal.

Fun touches on the sign-in page (docs/design/jedi-touch.md): the theme shows a faint starfield, the fun mark and
one playful line by default. The portal's admin switch (side menu ระบบ → งบประมาณ AI / System → AI budget, card
"Fun touches", switch "Playful touches in the portal") cannot reach Keycloak at runtime, so the sign-in page has
its own switch. Pick one:

- [ ] **Environment variable:** set `YODA_LOGIN_FUN_MODE=false` on the Keycloak server (read through the theme
      property `funMode=${env.YODA_LOGIN_FUN_MODE:true}`), then restart Keycloak.
- [ ] **Plain theme:** choose `yoda-plain` instead of `yoda` as the login theme (both folders are installed
      above; `yoda-plain` is a two-line child of `yoda` with `funMode=false`).

Caching: production Keycloak caches themes and templates (`--spi-theme-cache-themes`, `--spi-theme-cache-templates`
and `--spi-theme-static-max-age` are on by default), so after updating the files restart Keycloak (every node) and,
if a browser still shows the old look, clear its cache: static files are cached for 30 days by default. Never turn
the caches off in production; `start-dev` turns them off for development.

## 3. Settings

Configure Yoda in the portal: the setup wizard on the first install (section 4), then **Admin → System settings**
(การตั้งค่าระบบ). Nothing in the deploy host's `.env` is required for a standard install. Every setting can still
be forced from the environment: a variable set in `.env` (next to the compose files; compose reads it for
interpolation) wins over the database, and the setting shows **Set by environment** with the variable's name and
cannot be changed in the UI until the line is removed. Precedence is env, then System settings, then the default.
`YODA_VERSION` (and, after `install.sh`, `YODA_IMAGE_PREFIX`) live in `release.env` beside it, written by
`deploy.sh`.

Every name below is read by core (`apps/core/src/config.ts`), by the portal (`NUXT_*`, read at runtime) or by
`docker-compose.prod.yml`; a test keeps these tables in sync with them and with the settings registry.
"Fixed" means the prod overlay sets the value itself and ignores `.env`. **UI setting** is the System settings
page that holds it ("bootstrap" ones never are: they are needed before the database can be read); **Apply** is
when a change in the UI takes effect: *live* at once on every core instance, *live (reconnects)* at once with a
fresh connection to that service, *restart* after `dc up -d --no-build` (flagged in the UI).

Bootstrap only: release and host (compose reads them before any container exists):

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `YODA_IMAGE_PREFIX` | Registry path of the images; compose uses `<prefix>/<name>:<version>`. `install.sh` pins it in `release.env` (from the bundle); `deploy.sh` uses `ghcr.io/tantee/yoda` when it is set nowhere (never Docker Hub) | optional (`ghcr.io/tantee/yoda`) | `registry.example.org/group/yoda` |
| `YODA_VERSION` | Release tag to run; `deploy.sh` pins it in `release.env`, never in `.env` (compose refuses to start without it) | yes, in `release.env` | `1.0.0` |
| `YODA_CORE_DIGEST` | Manifest digest of the core image; compose then runs `<prefix>/core:<version>@<digest>`. `deploy.sh` pins it in `release.env` from the signed `bundle.env` of the same release (any prefix: a digest names content), else empty (the tag); never set it by hand | no (`deploy.sh`) | `sha256:4f…` |
| `YODA_PORTAL_DIGEST` | Manifest digest of the portal image; compose then runs `<prefix>/portal:<version>@<digest>`. `deploy.sh` pins it in `release.env` from the signed `bundle.env` of the same release (any prefix: a digest names content), else empty (the tag); never set it by hand | no (`deploy.sh`) | `sha256:4f…` |
| `YODA_RUNNER_DIGEST` | Manifest digest of the runner image; compose then runs `<prefix>/runner:<version>@<digest>`. `deploy.sh` pins it in `release.env` from the signed `bundle.env` of the same release (any prefix: a digest names content), else empty (the tag); never set it by hand | no (`deploy.sh`) | `sha256:4f…` |
| `YODA_BACKUP_DIGEST` | Manifest digest of the backup image; compose then runs `<prefix>/backup:<version>@<digest>`. `deploy.sh` pins it in `release.env` from the signed `bundle.env` of the same release (any prefix: a digest names content), else empty (the tag); never set it by hand | no (`deploy.sh`) | `sha256:4f…` |
| `CORE_PORT` | Host port for core | optional (`4000`) | `4000` |
| `CORE_BIND` | Host address core is published on | optional (`127.0.0.1`) | `127.0.0.1` |
| `PORTAL_PORT` | Host port for the portal | optional (`3000`) | `3000` |
| `PORTAL_BIND` | Host address the portal is published on; another address only for a proxy on another machine | optional (`127.0.0.1`) | `10.0.0.5` |
| `PORT` | Port core listens on inside its container | fixed (`4000`) | `4000` |

Bootstrap only: database and storage (generated into the bootstrap volume when empty, section 4a; shown
read-only in System settings → Storage):

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `POSTGRES_USER` | Database owner created on a fresh volume | optional (`yoda`) | `yoda` |
| `POSTGRES_PASSWORD` | Its password; only applied when the volume is created. Empty: generated into the bootstrap volume (section 4a); set, it is copied there | optional | `<random 32 chars>` |
| `POSTGRES_DB` | Database name | optional (`yoda`) | `yoda` |
| `DATABASE_URL` | Core, `migrate` and `backup` connection. Empty: derived from the bootstrap volume (host `postgres`); set it for an external Postgres | optional | `postgres://yoda:<password>@postgres:5432/yoda` |
| `MIGRATE_ON_START` | Core migrates on start; production runs the `migrate` service instead | fixed (`false`) | `false` |
| `S3_ENDPOINT` | Object storage endpoint | fixed (`http://rustfs:9000`) | `http://rustfs:9000` |
| `S3_REGION` | Storage region | optional (`us-east-1`) | `us-east-1` |
| `S3_BUCKET` | Bucket for uploaded files, created on start | optional (`yoda`) | `yoda` |
| `S3_ACCESS_KEY` | Storage access key; also RustFS's own credentials. Empty: generated into the bootstrap volume; set, it is copied there | optional | `<random 20 chars>` |
| `S3_SECRET_KEY` | Storage secret key (as `S3_ACCESS_KEY`) | optional | `<random 40 chars>` |

Bootstrap only: master key and settings import (installer proposal §3.5, §6):

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `YODA_MASTER_KEY` | Master key for secrets saved in the admin settings, base64 of 32 bytes; never stored in the database. Empty: no secrets stored there (env secrets still work); a wrong key starts core in recovery | optional | `<openssl rand -base64 32>` |
| `YODA_MASTER_KEY_FILE` | File holding the master key instead; `YODA_MASTER_KEY` wins when both are set | fixed (`/var/lib/yoda/core/master-key`) | `/var/lib/yoda/core/master-key` |
| `YODA_BOOTSTRAP_FILE` | The bootstrap volume's `bootstrap.env`: fills `DATABASE_URL` and the S3 keys when env leaves them empty (core, `migrate`, `backup`) | fixed (`/var/lib/yoda/bootstrap.env`) | `/var/lib/yoda/bootstrap.env` |
| `YODA_DEV_SKIP_SETUP` | Dev only: setup counts as done without the setup wizard. Never set in production | optional (`false`) | `true` |
| `YODA_SETTINGS_IMPORT` | `false` = env secrets are not copied into the database on start (other values still are) | optional (`true`) | `true` |
| `YODA_TRUSTED_PROXY_HOPS` | How many proxies in front of core add a believed `X-Forwarded-For` entry; decides the client address in rate limits, the audit log and break-glass alerts. `1` = the portal only (the portal published directly, or reached through an SSH tunnel). Set `2` when a reverse proxy (nginx, Caddy, a load balancer) sits in front of the portal and adds `X-Forwarded-For`; otherwise every browser shows as the reverse proxy's address. Never higher than the proxies really there: a client could then choose its own address. The portal reads it too: with `1` it tells core its own `Host` (what the setup wizard detects as the public URL) and honours an incoming `X-Forwarded-Proto: https` (upgrade only); with `2` it passes on the reverse proxy's scheme and host, so the proxy must set them (see the upgrade notes in section 5) | optional (`1`) | `2` |
| `YODA_OUTBOUND_ALLOW_LOOPBACK` | Dev only: the admin settings tests may connect to loopback (the dev fakes). Never set in production | optional (`false`) | `false` |

In production core reads the master key from the bootstrap volume (section 4a): the `init` service generates it,
or copies `YODA_MASTER_KEY` there when `.env` sets it (so core itself never gets the key in its environment).
In development core reads the repository's `.env` (`pnpm dev` or `pnpm --filter @yoda/core dev`), so set
`YODA_MASTER_KEY` there.

On start core copies every env value it reads into the database (D4; secrets too, with a usable master key and
`YODA_SETTINGS_IMPORT` not `false`). In System settings such a value shows **Imported from environment**. So
**removing a variable from `.env` does not turn the feature off**: after the restart the imported value stays in
effect, now editable. To really disable something (email, LINE, Telegram, GitLab, an AI provider), remove the
variable and restart, then clear the value in System settings (for a secret, **Remove**), or switch the channel
off there. With `YODA_SETTINGS_IMPORT=false` (or no usable master key) env secrets are not copied, so removing one
disconnects that service until it is entered in System settings. The prod compose file passes every setting the
UI can edit with an empty default, and an empty value counts as unset, so a variable that is not in `.env` never
locks anything (only bootstrap values such as the ports and S3 have compose defaults). The portal reads the organisation name and line, its links and
where to sign in from core's `GET /api/public-config`, so those are edited in System settings (a
`NUXT_PUBLIC_*` value in `.env` still wins and locks it). The `backup` container reads the backup time and the
days kept from the database too (section 6), so they are edited in System settings → Backups.

A setting saved in the database applies without a restart, on every core instance: each one listens for
`NOTIFY settings_changed` (key names only, never values) and reloads its settings, and reloads them again after
any reconnect. That needs a session-pinned database connection, so a `DATABASE_URL` through PgBouncer in
transaction mode breaks it. `AI_WORKERS` and `MCP_ENABLED` still need a restart: a change to either is flagged as restart-required.

Saving a secret (or a sign-in setting) in the admin settings needs a sign-in within the last 10 minutes: core
reads the access token's `auth_time` claim, and the portal signs in again when it is older. Keycloak puts
`auth_time` in access tokens through the realm's default **basic** client scope (Keycloak 25 and later); keep that
scope on the `yoda-portal` client, or every secret save is refused with `reauth_required`. The settings **Test**
buttons connect only through core's outbound guard: private addresses are allowed, cloud metadata, link-local and
loopback addresses and the compose service names are not, and redirects are not followed. The service names'
addresses and core's own are looked up once at start and blocked too; that is best effort, since a container
restarted later may get an address not on the list, and other containers on the compose network (private
addresses, like the hospital's own hosts) stay reachable by design.

Backups (section 6; the `backup` container reads System settings → Backups every minute, and a value set here wins):

| Variable | Purpose | UI setting | Apply | Required | Example |
| --- | --- | --- | --- | --- | --- |
| `BACKUP_AT` | Daily backup time, Asia/Bangkok | Backups | within a minute | optional (`02:00`) | `02:00` |
| `BACKUP_KEEP_DAYS` | Days of backups kept on the `backups` volume | Backups | within a minute | optional (`14`) | `14` |

Sign-in (section 2):

| Variable | Purpose | UI setting | Apply | Required | Example |
| --- | --- | --- | --- | --- | --- |
| `OIDC_ISSUER` | Keycloak realm issuer, as in the token's `iss`. Empty: core starts in setup mode and refuses every sign-in with `503 not_configured` until it is set | Sign-in (the wizard, then `/recovery`) | live (reconnects) | optional | `https://sso.example.org/realms/yoda` |
| `OIDC_CLIENT_ID` | Client id; tokens' `azp` must match | Sign-in | live (reconnects) | optional (`yoda-portal`) | `yoda-portal` |
| `OIDC_JWKS_URL` | Internal URL for the signing keys, when core cannot reach the issuer | Sign-in (the wizard, then `/recovery`) | live (reconnects) | optional | `http://keycloak.internal.example.org/realms/yoda/protocol/openid-connect/certs` |
| `STAFF_GROUP` | Full path of the staff group | Sign-in | live | optional (`/it-dev`) | `/it-dev` |
| `BOOTSTRAP_ADMINS` | Usernames made admin on first sign-in, comma-separated | read-only (Sign-in) | live | optional | `somchai.p` |

Portal:

| Variable | Purpose | UI setting | Apply | Required | Example |
| --- | --- | --- | --- | --- | --- |
| `NUXT_CORE_URL` | Where the portal's `/api` proxy sends requests | — (bootstrap) | restart | fixed (`http://core:4000`) | `http://core:4000` |
| `NUXT_PUBLIC_KEYCLOAK_URL` | Deprecated: browser-facing Keycloak base URL. Empty: derived from `OIDC_ISSUER` (`<url>/realms/<realm>`) via `/public-config`; set, it wins, and core logs loudly at start when it disagrees with `OIDC_ISSUER` | — (bootstrap) | restart | optional | `https://sso.example.org` |
| `NUXT_PUBLIC_KEYCLOAK_REALM` | Deprecated: realm (as `NUXT_PUBLIC_KEYCLOAK_URL`) | — (bootstrap) | restart | optional | `yoda` |
| `NUXT_PUBLIC_KEYCLOAK_CLIENT_ID` | Deprecated: public client; empty = `OIDC_CLIENT_ID` | — (bootstrap) | restart | optional | `yoda-portal` |
| `NUXT_PUBLIC_RUNNER_DOCS_URL` | Setup docs linked from the Runners page | General | live | optional (README "Runners", which links to `docs/development.md`) | `https://portal.example.org/docs/runners` |
| `NUXT_PUBLIC_LINE_ADD_FRIEND_URL` | The LINE Official Account's add-friend link, shown when linking LINE | LINE | live | optional | `https://line.me/R/ti/p/@example` |
| `NUXT_PUBLIC_ORG_LINE` | Organisation line at the foot of the side menu, e.g. the department or hospital name | General | live | optional (empty: no line) | `ฝ่ายเทคโนโลยีสารสนเทศ` |
| `PORTAL_URL` | The portal's public base URL, used in links in emails, chats and GitLab issues; also System settings → General | General | live | optional (`http://localhost:3000`) | `https://portal.example.org` |

AI:

| Variable | Purpose | UI setting | Apply | Required | Example |
| --- | --- | --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic API key; jobs on a provider without a key are unavailable | AI | live (reconnects) | optional | `<from the provider console>` |
| `OPENAI_API_KEY` | OpenAI (or compatible) API key | AI | live (reconnects) | optional | `<from the provider console>` |
| `OPENAI_BASE_URL` | Base URL of an OpenAI-compatible provider | AI | live (reconnects) | optional | `https://llm.example.org/v1` |
| `AI_MODEL_DRAFT` | Model for drafting, briefs and the secretary, `provider:model` | AI | live (reconnects) | optional (`anthropic:claude-opus-5-5`) | `anthropic:claude-opus-5-5` |
| `AI_MODEL_FAST` | Model for quick jobs and weekly summaries | AI | live (reconnects) | optional (`anthropic:claude-haiku-5-5`) | `anthropic:claude-haiku-5-5` |
| `AI_EMBEDDING_MODEL` | Embedding model; empty = trigram search only | AI | live (reconnects) | optional | `openai:text-embedding-3-small` |
| `AI_WORKERS` | AI jobs run at once | AI | restart | optional (`2`) | `2` |
| `DAILY_TASK_CAP` | Most automatic assignments per person per day (Asia/Bangkok) | General | live | optional (`8`) | `8` |

GitLab (section 7):

| Variable | Purpose | UI setting | Apply | Required | Example |
| --- | --- | --- | --- | --- | --- |
| `GITLAB_URL` | GitLab base URL; empty = GitLab features off | GitLab | live (reconnects) | optional | `https://gitlab.example.org` |
| `GITLAB_TOKEN` | The bot user's access token (`api` scope) | GitLab | live (reconnects) | with `GITLAB_URL` | `<bot token>` |
| `GITLAB_WEBHOOK_SECRET` | Webhook secret token, at least 16 characters | GitLab | live | with `GITLAB_URL` | `<random 32 chars>` |

Runners (section 8):

| Variable | Purpose | UI setting | Apply | Required | Example |
| --- | --- | --- | --- | --- | --- |
| `RUNNER_LEASE_SECONDS` | How long a runner's claim lasts without a heartbeat (at least 180) | Runners | live | optional (`600`) | `600` |
| `MCP_ENABLED` | Serve the runner MCP endpoint at `/mcp` | Runners | restart | optional (`true`) | `true` |
| `YODA_RUNNER_TOKEN` | Server runner's token from the Runners page | — (runner container) | restart | with the `runner` profile | `yoda_rt_<shown once>` |
| `YODA_RUNNER_CORE_URL` | Core URL for the server runner | — (runner container) | restart | optional (`http://core:4000`) | `http://core:4000` |
| `YODA_RUNNER_ANTHROPIC_API_KEY` | Model key for the server runner's Claude Code | — (runner container) | restart | with the `runner` profile | `<from the provider console>` |
| `YODA_GIT_USERNAME` | Git user for clone and push | — (runner container) | restart | optional (`oauth2`) | `oauth2` |
| `YODA_GIT_PASSWORD` | Git token for clone and push (`write_repository`, limited to the repos) | — (runner container) | restart | with the `runner` profile | `<project or group access token>` |
| `YODA_RUNNER_GIT_NAME` | Commit author name | — (runner container) | restart | optional (`Yoda runner`) | `Yoda runner` |
| `YODA_RUNNER_GIT_EMAIL` | Commit author email | — (runner container) | restart | optional | `yoda-runner@example.org` |
| `YODA_RUNNER_CONFIG_FILE` | Runner config file mounted read-only (repos, executor; no token) | — (runner container) | restart | optional (`./runner-config.json`) | `./runner-config.json` |

Notifications (section 9):

| Variable | Purpose | UI setting | Apply | Required | Example |
| --- | --- | --- | --- | --- | --- |
| `SMTP_HOST` | Mail relay; host and `MAIL_FROM` both set = email configured | Email | live (reconnects) | optional | `smtp.example.org` |
| `SMTP_PORT` | Relay port | Email | live (reconnects) | optional (`587`) | `587` |
| `SMTP_SECURE` | `true` = TLS from the start (port 465); `false` = STARTTLS when offered | Email | live (reconnects) | optional (`false`) | `false` |
| `SMTP_USER` | Relay user | Email | live (reconnects) | optional | `yoda@example.org` |
| `SMTP_PASSWORD` | Relay password | Email | live (reconnects) | optional | `<relay password>` |
| `MAIL_FROM` | Sender address | Email | live | with `SMTP_HOST` | `Yoda <yoda@example.org>` |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API channel access token (long-lived) | LINE | live (reconnects) | for LINE | `<from LINE Developers>` |
| `LINE_CHANNEL_SECRET` | LINE channel secret, the key of `X-Line-Signature` | LINE | live | for LINE | `<from LINE Developers>` |
| `LINE_API_URL` | LINE API base URL | — (bootstrap) | restart | optional (`https://api.line.me`) | `https://api.line.me` |
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather | Telegram | live (reconnects) | for Telegram | `<from BotFather>` |
| `TELEGRAM_BOT_USERNAME` | Bot username, without `@` | read-only (Telegram) | live | for Telegram | `example_yoda_bot` |
| `TELEGRAM_WEBHOOK_SECRET` | Webhook secret token, 16-256 of `A-Z a-z 0-9 _ -` | Telegram | live | for Telegram | `<random 48 chars>` |
| `TELEGRAM_API_URL` | Bot API base URL | — (bootstrap) | restart | optional (`https://api.telegram.org`) | `https://api.telegram.org` |

Generate random values with `openssl rand -hex 24` (hex suits every field above, including the Telegram
secret). Only the server runner variables are passed to the `runner` container; core never sees them.

## 4. First install

On the deploy host, as the deploy user (it may run `docker`, and owns the deploy directory, e.g. `/srv/yoda`;
create that as root once: `install -d -o <deploy user> /srv/yoda`).

**Commands.** In this runbook `dc` stands for this alias, run in `DEPLOY_PATH` (define it once in the deploy
user's shell):

```bash
alias dc='docker compose --env-file .env --env-file release.env -f docker-compose.yml -f docker-compose.prod.yml'
```

`release.env` holds `YODA_VERSION=<tag>`, `YODA_IMAGE_PREFIX` and the image digests (`YODA_<NAME>_DIGEST`, empty
when the release was deployed by tag), written by `deploy.sh`
once it has pulled that release, so every `dc` command runs the deployed images; without it compose stops with
"YODA_VERSION is required". Never build on the host: `dc up` always gets `--no-build`. A `YODA_VERSION` exported
in your shell overrides `release.env`, so leave it unset.

1. **Install the release.** Download `install.sh` and its checksums for a pinned release (the latest on
   https://github.com/tantee/yoda/releases; `1.2.0` here is an example) from its GitHub Release, check them, then
   run it (never pipe a download into `sh`):

   ```bash
   curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.2.0/install.sh
   curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.2.0/SHA256SUMS
   curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.2.0/SHA256SUMS.minisig
   out=$(minisign -Vm SHA256SUMS -P RWSErktAr/A+x5Gvgr0x29wiu41FmYEVlJYoXyB6oJk4kvwQLOZs9O9j) &&
     printf '%s\n' "$out" | grep -Fx 'Trusted comment: yoda release 1.2.0' &&
     sha256sum --check --ignore-missing SHA256SUMS &&
     sh install.sh --version 1.2.0 --dir /srv/yoda
   ```

   Each command runs only when the one before it passed: the signature, then that the signed trusted comment
   names this release (`Trusted comment: yoda release 1.2.0`), then the checksum of `install.sh`. From an
   internal mirror add `--base-url 'https://files.example.org/yoda/releases/{version}/'` and
   `--image-prefix registry.example.org/group/yoda` (`{version}` becomes the version; section 5, "Internal
   mirror").

   `install.sh` checks the prerequisites (Docker Engine 24+, Compose v2.24+, docker access, about 10 GB free),
   downloads the release bundle, verifies its signature (the release key is built into the script) and checksum
   and refuses on any mismatch, refuses `latest` or an existing install, unpacks the bundle (compose files,
   `ops/deploy/deploy.sh`, `.env.example`, this runbook), creates an empty `.env` (`0600`), logs in to a mirror's
   registry if needed (to ghcr.io only when a pull failed, because the packages are not public), and runs
   `deploy.sh`. **Without the script:** copy `docker-compose.yml`,
   `docker-compose.prod.yml` and `ops/deploy/deploy.sh` (keep the paths) from the bundle or the release tag
   into the deploy directory, for a mirror put its path in `.env` as `YODA_IMAGE_PREFIX` (without one `deploy.sh` uses
   `ghcr.io/tantee/yoda`), log in to a mirror's registry (section 1), and run `cd /srv/yoda && YODA_VERSION=1.2.0 sh ops/deploy/deploy.sh`.
2. **Deploy** (what `install.sh` runs; later releases: section 5): it creates an empty
   `.env` when there is none, pulls the images, writes `release.env`, fills the bootstrap volume (`init`),
   runs the migrations, starts everything and waits until `/api/ready` answers. While setup is not finished it
   ends by printing the setup address and the token command.
3. **Open `/setup`** through the reverse proxy (`https://portal.example.org/setup`) or the SSH tunnel
   (section 1). The wizard asks for the setup token: `dc exec core yoda-admin setup-token` prints it (it is also
   in the "Yoda setup" banner of `dc logs core`; it is valid 24 hours, single use, and changes when core
   restarts). Behind a reverse proxy, set `YODA_TRUSTED_PROXY_HOPS=2` first (section 5, upgrade notes), so the
   wizard detects the public URL and the client addresses correctly. **Tunnel or public URL:** through the SSH
   tunnel the wizard detects `http://127.0.0.1:3000` as the public URL; replace it with the real one
   (`https://portal.example.org`) in the organisation step, or the portal links, the TOTP rule (D3: TOTP is
   skipped only for a localhost URL) and the Keycloak redirect will be wrong. The claim (the last step) signs in
   through Keycloak, which sends the browser back to `<public URL>/setup`, where the setup session cookie of the
   tunnel address does not exist. So do the claim on the public URL: once the reverse proxy works, open
   `https://portal.example.org/setup`, enter a new token (`dc exec core yoda-admin setup-token --new`; the steps
   done so far are kept) and finish there.
4. **The wizard** (Thai by default, switchable): organisation and public URL, the break-glass admin (password
   and, unless the URL is localhost, TOTP), sign-in (Keycloak, section 2, with a test), a system check, then the
   optional email, LINE, Telegram, GitLab, AI and backup settings (each can be skipped and set later in System
   settings), and the claim: you sign in through Keycloak and become the first admin.
5. **Store the recovery kit.** The last step gives one file, `yoda-recovery-kit-<first 8 characters of the
   install id>.txt` (the install id is the one the wizard shows): the master key, the break-glass username and
   its recovery codes, and the bootstrap values (the Postgres password and the storage keys of the bundled services,
   section 4a). It is
   shown once. Print it or put it in the organisation's
   password vault, **off this host and apart from the backups**: anyone with it and a database backup can read
   every secret. Setup finishes only once you confirm you stored it; a new kit can be made later on the host
   with `(umask 077; dc exec -T core yoda-admin recovery-kit > yoda-recovery-kit.txt)` (it replaces the
   recovery codes; section 10). The `umask` keeps the file readable by you only.
6. Finish the services around it:
   - [ ] **AI budgets.** In Admin → AI budget set the department's monthly budget, and on each project's AI
         settings tab its budget or no-AI. A model that is not in `apps/core/src/ai/prices.json` is logged at
         startup and refused for projects with a budget. Set a spending limit in the provider's console as well.
   - [ ] **GitLab** bot and webhook (section 7).
   - [ ] **Runners** (section 8).
   - [ ] **Email, LINE and Telegram** (section 9), then enable each channel in System settings → Notification
         channels.
   - [ ] **Backups** copied off the host (section 6), and a test restore.
   - [ ] **Monitoring:** alert on the `core`, `portal` and `backup` containers turning unhealthy (section 11).

**Advanced: external Postgres or S3, or infra-as-code.** Put the values in `.env` before step 2, starting from the
"Advanced overrides" part of `.env.example` (never copy its development part): `DATABASE_URL` for an external
Postgres, `S3_ENDPOINT` and the S3 keys for an external bucket, or any setting from section 3 you want fixed from
outside the UI (it then shows locked). An install whose `.env` sets `OIDC_ISSUER` skips the wizard: setup counts
as done, and the first admins come from `BOOTSTRAP_ADMINS`. It has no break-glass account then: create it with
`dc exec core yoda-admin create-break-glass` and make the recovery kit (section 5, upgrade notes). To run the server runner too, add
`COMPOSE_PROFILES=runner` (and create `runner-config.json`, section 8).

## 4a. Bootstrap volume and master key

The one-shot `init` service (in the core image, run by `deploy.sh` and before every start) fills the named
volume `yoda-bootstrap`, mounted at `/var/lib/yoda`:

| File | Mode | Read by |
| --- | --- | --- |
| `postgres-password` | `0640 root:10500` | postgres (`POSTGRES_PASSWORD_FILE`) |
| `s3-access-key`, `s3-secret-key` | `0640 root:10500` | rustfs (`RUSTFS_*_FILE`) |
| `bootstrap.env` | `0640 root:10500` | core, `migrate`, `backup`: `DATABASE_URL` and the S3 keys, never the master key |
| `core/master-key` | `0600`, in `core/` (`0700`, the core image's user) | core only |
| `core/setup-token` | `0600` | core, while setup is not finished |

For each value: set in `.env` → written to the file (`.env` wins, so an existing install upgrades unchanged; the
replaced value is kept as `<file>.prev`); already in the volume → kept; neither → generated. While a
`<file>.prev` holds an earlier replaced value, `init` refuses a second, different replacement (it would destroy
that value) and says so: check which value is right, remove the `.prev` once nothing needs it, and deploy again.
Going back to the `.prev` value is allowed (the two swap). `init` prints the file names, never a value. Read a
value on the host with `dc run --rm --entrypoint cat init /var/lib/yoda/<file>`. The install id (in the kit's
name) is kept in the database, not in this volume.

**Lost bootstrap volume.** When the database volume already holds a database but neither the volume nor `.env`
knows its password (the bootstrap volume was deleted or is new), `init` stops with "an existing database was
found but its password is unknown". Never let it generate a new one:

1. **With the recovery kit:** put the values of its section 3 in `.env` (`POSTGRES_PASSWORD`, `S3_ACCESS_KEY`,
   `S3_SECRET_KEY`, and `YODA_MASTER_KEY` from section 1; `POSTGRES_USER` if the kit lists one), then
   `dc up -d --no-build`. `init` writes them back into the volume; you may delete the lines afterwards. A kit made
   before the Postgres password or the storage keys were changed holds the old values: use the newest kit. The
   kit carries them only for the bundled `postgres` and `rustfs` services; for an external database or bucket it
   says "external service — credentials managed outside Yoda" (keep those with the service's owners).
2. **Without a kit, reset the Postgres password** (host access is the root of trust). The database is
   untouched; only the role's password changes. Postgres must not be running (it is not while `init` fails):

   ```bash
   dc stop postgres
   NEW=$(openssl rand -hex 24)
   printf 'ALTER ROLE "yoda" WITH PASSWORD '"'"'%s'"'"';\n' "$NEW" |
     dc run --rm -T --no-deps -u postgres --entrypoint postgres postgres --single -D /var/lib/postgresql/data postgres
   (umask 077; printf 'POSTGRES_PASSWORD=%s\n' "$NEW" >> .env)
   dc up -d --no-build
   ```

   (Use your `POSTGRES_USER` in place of `yoda` if you set one.) New storage keys are generated (RustFS
   accepts them, but a bucket written under the old keys may refuse them: set the old `S3_ACCESS_KEY` /
   `S3_SECRET_KEY` in `.env` if you know them). A new master key is generated too, so core starts in recovery
   mode: put the old key back if you have it, else `yoda-admin reset-master-key --yes` and enter the secrets
   again (section 11).

- **Never delete this volume.** `deploy.sh` never touches it, and no `dc down -v`. It is deliberately not in the
  `backups` volume (section 6).
- **The master key** encrypts every secret saved in System settings (AES-256-GCM, per-secret data keys); the
  database holds only ciphertext, and the key never reaches the database, the logs or the API. Losing it loses
  only those secrets: core starts in recovery mode and they are entered again (requests, chats and files are
  intact).
- **Restoring on a new host:** run `install.sh` (or copy the bundle), put the recovery kit's master key in `.env`
  as `YODA_MASTER_KEY=<key>` before the first deploy (`init` copies it into the volume; remove the line again
  afterwards if you like, the volume keeps it), then restore the backup (section 6). Without the key the secrets
  must be re-entered.
- **Rotating the master key:** see section 10 ("Master key rotation"). A rotation keeps the replaced key as
  `core/master-key.prev` (decrypt-only) until `yoda-admin rotate-master-key --finish` deletes it. Backups taken
  before the rotation need the old key: keep the old kit until they have all aged out (section 6).

## 5. Upgrade and rollback

Releases are git tags `v<version>` (`v1.0.0`, `v1.0.1`, …, see `CHANGELOG.md`); the version without the `v` is
what a host runs (`YODA_VERSION=1.0.0`). The GitHub release workflow (`.github/workflows/release.yml`) publishes
each one: the images `core`, `portal`, `runner` and `backup` on `ghcr.io/tantee/yoda/<name>` (linux/amd64 and
linux/arm64, tagged `<version>` and `sha-<short commit>`, their digests pinned in the bundle) and the signed release bundle as the GitHub Release's
assets, which `install.sh` downloads. How to cut a release, the signing key and the repository secrets:
[docs/releasing.md](releasing.md).

**Internal mirror (optional, GitLab CI).** For hosts that cannot reach GitHub, `.gitlab-ci.yml` keeps a mirror
inside the network: it builds the four images for every pipeline on the default branch and on tags, and pushes
them to `$CI_REGISTRY_IMAGE/<name>` tagged with the commit SHA, plus the version on tags (a mirrored tag `v1.2.0`
is `1.2.0`) and `latest` on the default branch. On tags the `release-bundle` job also builds and signs the release
bundle for the internal file server (below), and the manual `deploy` job deploys a tag over SSH. The rest of this
part covers that pipeline; a host that installs from GitHub needs none of it.

**GitLab CI runner.** The build jobs use Docker-in-Docker (`docker:27.5.1` with the `docker:27.5.1-dind`
service and `DOCKER_TLS_CERTDIR=/certs`). They need a runner with the **docker executor** in **privileged** mode
and a `/certs/client` volume, in the runner's `config.toml`:

```toml
[runners.docker]
  privileged = true
  volumes = ["/certs/client", "/cache"]
```

If the runner does not set them itself, add the CI/CD variables DOCKER_HOST = `tcp://docker:2376`,
DOCKER_TLS_VERIFY = `1` and DOCKER_CERT_PATH = `/certs/client`. The `deploy` job runs in a plain `alpine`
image and needs no privileges.

**CI/CD variables** (Settings → CI/CD → Variables, all **protected**; protect the release tags under
Settings → Repository → Protected tags so only maintainers can create them):

- DEPLOY_HOST: the deploy host's name, e.g. `yoda-host.example.org`
- DEPLOY_USER: the deploy user
- DEPLOY_PATH: the deploy directory, e.g. `/srv/yoda`
- DEPLOY_SSH_KEY: type **File**, the private key whose public half is in the deploy user's
  `~/.ssh/authorized_keys`. Use a key made for this job only (`ssh-keygen -t ed25519 -C yoda-deploy`).
- DEPLOY_KNOWN_HOSTS: the host's public key lines. Get them with `ssh-keyscan <host>` and check the
  fingerprint against the host itself (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) before saving. The
  job checks the host key strictly and never accepts an unknown one.

**Release bundle on the mirror** (installer proposal §3.4, D1). On every tag the `release-bundle` job runs
`ops/install/bundle.sh`, which writes `dist/releases/<version>/` with the same files as a GitHub Release:
`yoda-<version>.tar.gz` (the compose files, `ops/deploy/deploy.sh`, `ops/install/install.sh`, `.env.example`,
`CHANGELOG.md`, this runbook and `bundle.env` with the mirror's registry path), `install.sh` on its own, and
`SHA256SUMS` of both. It signs `SHA256SUMS` with minisign (trusted comment `yoda release <version>`, which
`install.sh` checks, so an older signed file cannot be replayed for a newer version), checks the signature against
the key embedded in `install.sh`, keeps the directory as a job artifact for 90 days and uploads it to the file
server. A bundle that fails to sign or upload never blocks the deploy job. Hosts then install with
`install.sh --base-url 'https://files.example.org/yoda/releases/{version}/' --image-prefix <$CI_REGISTRY_IMAGE>`.
Simpler, when the mirror only needs to copy what GitHub publishes: put the GitHub Release's four assets under
`releases/<version>/` on the file server and copy the images to the registry
([releasing, internal mirror](releasing.md#internal-mirror)). Setup of the pipeline path, once:

- [ ] **Release signing key.** The same minisign key pair as the GitHub releases ([releasing](releasing.md#one-time-setup)):
      `install.sh` embeds one public key. Store `yoda.key` as the CI/CD variable YODA_RELEASE_SIGNING_KEY, type
      **File**, **protected**, and its password as YODA_RELEASE_SIGNING_PASSWORD (**masked**, **protected**; the
      job sends it to minisign on stdin). Until `ops/install/install.sh` embeds the matching public key
      (`RELEASE_PUBKEY_EMBEDDED`), the `release-bundle` job fails its self-check and `install.sh` refuses to run.
- [ ] **File server.** Any static HTTPS server; releases live under `<base>/releases/<version>/`, the layout
      `install.sh --base-url '<base>/releases/{version}/'` (or `YODA_RELEASE_BASE_URL`) expects.
- [ ] **Upload.** Set YODA_RELEASE_UPLOAD_URL (the same base, as the uploader sees it) and
      YODA_RELEASE_UPLOAD_TOKEN (**masked**, **protected**). The job's upload is a template: one HTTP `PUT` per
      file to `<URL>/releases/<version>/<file>`, with the token as a bearer header passed to curl on stdin. Change
      that step in `.gitlab-ci.yml` to what your file server takes (WebDAV, the GitLab generic package registry,
      `rsync` over SSH). With no URL set the upload is skipped and the bundle stays a job artifact, which you can
      copy to the server by hand.

**Upgrade.**

1. Read `CHANGELOG.md` for the release, especially new required variables; add them to the host's `.env`
   yourself (most new options are System settings now). **The deploy never changes `.env`** (it only creates an
   empty one when there is none): it replaces the compose files, `ops/deploy/deploy.sh` and the runbook files
   (`docs/operations.md`, `.env.example`, `CHANGELOG.md`), and rewrites
   `release.env`, keeping a `YODA_IMAGE_PREFIX` pinned there.
2. **Take a backup** on the host, every time: `cd /srv/yoda && dc run --rm backup --now`
   (wait for it to finish; it is the restore point if the upgrade or a later rollback goes wrong).
3. The release is published (a maintainer pushed the tag `v1.1.0`, [releasing](releasing.md#cut-a-release)).
   **From GitHub:** on the host, in `/srv/yoda`, download the new bundle, check it and unpack it over the deploy
   directory (it holds no `.env` or `release.env`), then deploy:

   ```bash
   curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.1.0/yoda-1.1.0.tar.gz
   curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.1.0/SHA256SUMS
   curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.1.0/SHA256SUMS.minisig
   out=$(minisign -Vm SHA256SUMS -P RWSErktAr/A+x5Gvgr0x29wiu41FmYEVlJYoXyB6oJk4kvwQLOZs9O9j) &&
     printf '%s\n' "$out" | grep -Fx 'Trusted comment: yoda release 1.1.0' &&
     sha256sum --check --ignore-missing SHA256SUMS &&
     tar -xzf yoda-1.1.0.tar.gz --no-same-owner &&
     rm yoda-1.1.0.tar.gz SHA256SUMS SHA256SUMS.minisig &&
     YODA_VERSION=1.1.0 sh ops/deploy/deploy.sh
   ```

   Each command runs only when the one before it passed (the `grep` checks the signature is for `1.1.0`).
   `deploy.sh` does what step 4 describes, and pins the image digests of the unpacked `bundle.env` (signed with
   the bundle) in `release.env`, so the host runs exactly the images built for the release. **From the internal GitLab mirror:** wait for the tag pipeline's build
   jobs, then step 4.
4. Run the manual **deploy** job in that tag pipeline (mirror only). It copies the tag's compose files and
   `ops/deploy/deploy.sh` to `DEPLOY_PATH` and runs it there with `YODA_VERSION=<version>`:
   `docker compose pull`, then it pins the tag in `release.env` (only once every image is on the host), then
   `docker compose run --rm init` (the bootstrap volume) and `docker compose run --rm migrate` (a failed
   migration stops the deploy before any running container is replaced), then `docker compose up -d --no-build`, then it polls the portal's `/api/ready`
   for up to 2 minutes and fails the job if it never answers 200. Only one deploy runs at a time.
5. Check the portal, and the last line of the output (or the job log), `deploy: <version> ready`.

**Upgrade notes.**

- **Image prefix (the registry path).** The prod compose has no default prefix, so a host without one never
  pulls `yoda/...` images from Docker Hub: compose stops with "YODA_IMAGE_PREFIX is required". `deploy.sh` uses
  the public release images, `ghcr.io/tantee/yoda`, when no prefix is given or pinned anywhere, and pins it.
  `install.sh` pins the prefix in `release.env` (from the bundle, or `--image-prefix`), and
  `deploy.sh` keeps it there on every deploy. Precedence: the `YODA_IMAGE_PREFIX` given to `deploy.sh`, then
  `release.env`, then `.env` (an install from before `install.sh` keeps it in `.env`; `release.env` wins when both
  hold one). **Change the registry** by logging in to the new one (`docker login`), then
  `cd /srv/yoda && YODA_IMAGE_PREFIX=<new path> YODA_VERSION=<current tag> sh ops/deploy/deploy.sh`, which pulls
  from there and pins the new prefix (editing `.env` alone has no effect while `release.env` holds one).
- **Image digests.** A GitHub release's `bundle.env` names the digest of each image; `deploy.sh` pins them in
  `release.env` (`YODA_<NAME>_DIGEST`) whenever that `bundle.env` is the release being deployed, whatever the
  prefix, and compose then runs `<prefix>/<name>:<version>@<digest>`: Docker pulls that digest, whatever the tag
  points to. A digest names content, not a registry, so a mirror that copied the images serves the same digests;
  a registry that rebuilt them has others, and the pull fails (closed). For such a registry deploy with
  `YODA_IGNORE_BUNDLE_DIGESTS=1` (it warns, and runs the tags). A deploy of another version than the unpacked
  `bundle.env` (the GitLab deploy job) runs the tags too: the variables are pinned empty.

- **From an env-based install** (a full `.env`, before the setup wizard existed): upgrade as usual with the same
  `deploy.sh`. `init` copies the Postgres password, the storage keys and `YODA_MASTER_KEY` from `.env` into the
  bootstrap volume, core imports the other values into System settings and marks setup done, and those values
  show **Set by environment** until you delete their lines from `.env` (section 3). Nothing else changes. Such an
  install has no break-glass account yet, so `/recovery` cannot help in a lockout until you create one, right
  after the upgrade:
  1. `dc exec core yoda-admin create-break-glass` prints a temporary password once (`--username <name>`
     chooses the name; `admin` by default).
  2. Sign in at `/recovery` with it (through the SSH tunnel or the public URL), choose a new password and enrol
     the authenticator (TOTP); the recovery codes are shown then.
  3. Make the recovery kit and store it off the host (section 4 step 5):
     `(umask 077; dc exec -T core yoda-admin recovery-kit > yoda-recovery-kit.txt)`.
  `yoda-admin rotate-master-key` works on such an install too.
- **The runbook and `.env.example` on the host.** The deploy job copies `docs/operations.md`, `.env.example` and
  `CHANGELOG.md` with the compose files (never `.env`). After an upgrade by hand with `deploy.sh`, copy them from
  the new release bundle (or the release tag) into the deploy directory yourself, so the runbook on the host
  matches the release it runs.
- **Backups:** the prod compose no longer passes `BACKUP_AT=02:00` / `BACKUP_KEEP_DAYS=14` by default; the
  `backup` container reads System settings → Backups (same defaults). A value in `.env` still wins.

- **A reverse proxy in front of the portal** (nginx, Caddy, a load balancer, usually where TLS ends): set
  `YODA_TRUSTED_PROXY_HOPS=2` in the host's `.env`, and have the proxy send `X-Forwarded-For`,
  `X-Forwarded-Proto` and `X-Forwarded-Host`, and keep the browser's `Host` (nginx: `proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-Host $host;`; nginx's `$host` has no port, so a proxy on a port other than 443 uses `$http_host` in both `Host` lines, or the wizard detects the URL without the port and the CSRF check refuses). With the default `1`, the portal still honours the proxy's `https` (so the setup and recovery cookies
  stay `Secure`), but every client shows as the proxy's address in rate limits, the audit log and break-glass
  alerts, and the setup wizard detects the portal's own `Host` as the public URL. Core logs a warning once when it
  sees a proxy in front of the portal while the value is `1`.

**Rollback.** On the host, in `/srv/yoda`: always unpack the bundle of the release you go back to, so the compose
files, `deploy.sh` and the image digests in `bundle.env` are that release's (`1.0.0` stands for it):

```bash
curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.0.0/yoda-1.0.0.tar.gz
curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.0.0/SHA256SUMS
curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.0.0/SHA256SUMS.minisig
out=$(minisign -Vm SHA256SUMS -P RWSErktAr/A+x5Gvgr0x29wiu41FmYEVlJYoXyB6oJk4kvwQLOZs9O9j) &&
  printf '%s\n' "$out" | grep -Fx 'Trusted comment: yoda release 1.0.0' &&
  sha256sum --check --ignore-missing SHA256SUMS &&
  tar -xzf yoda-1.0.0.tar.gz --no-same-owner &&
  rm yoda-1.0.0.tar.gz SHA256SUMS SHA256SUMS.minisig &&
  YODA_VERSION=1.0.0 sh ops/deploy/deploy.sh
```

Each command runs only when the one before it passed, as in step 3; `deploy.sh` then pins that release's
digests in `release.env`. On a mirror, run the deploy job again in the **previous tag's** pipeline (CI/CD →
Pipelines, filter by tag); it pins that version in `release.env` again. Migrations only move
forward: an older release usually runs on a newer schema, but if the changelog says a release changed data in a
way the older one cannot read, restore the backup taken in step 2 of the upgrade instead (section 6).

**Try a release locally.** The overlay needs `YODA_IMAGE_PREFIX` and `YODA_VERSION`; for a prod-like stack built from your checkout
(images `yoda/<name>:latest`), with a local `.env` holding the overlay's required variables:
`YODA_IMAGE_PREFIX=yoda YODA_VERSION=latest docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d`.

## 6. Backups and restore

`dc` as in section 4.

The `backup` service writes, every day at the backup time (Asia/Bangkok), `pg-<YYYYMMDD-HHMM>.dump`
(`pg_dump -Fc`) and `storage-<YYYYMMDD-HHMM>/` (a full mirror of the bucket) to the `backups` volume, updates a
`latest` marker and deletes backups older than the days kept. Set both in **System settings → Backups** (02:00
and 14 days by default): the container reads them from the database every minute while it waits, so a change
applies within a minute, without a restart; `BACKUP_AT` / `BACKUP_KEEP_DAYS` in `.env` win and lock them there.
While the database cannot be read it keeps the last values and logs that once. A failed run is retried 3 times,
15 minutes apart. Back up now with `dc run --rm backup --now`.

**The master key is not in the backups.** Database dumps hold the System settings secrets encrypted, so a copy of
the backups alone does not expose them; but a restore on a new host needs the master key from the recovery kit
(section 4a), or the secrets must be entered again. Keep the recovery kit with your backups, but not in the same
place. **After a master key rotation, keep the old kit as well** (or at least its key): every backup taken before
the rotation needs the old key, so keep it until the last pre-rotation backup (including the off-host copies) has
aged out, then destroy it.

**Watch it.** The container turns **unhealthy** when the last backup is older than 26 hours. Alert on that
(`docker inspect -f '{{.State.Health.Status}}' <backup container>`), and read `dc logs backup` after a
failure.

**Disk usage.** Each day keeps a full copy of the bucket, so the volume holds about
`days kept × (database dump + bucket size)`. Check it with
`docker system df -v | grep backups` and lower the days kept or add disk before it fills.

**Copy backups off the host.** The `backups` volume is on the same host as the database: a lost disk or host
loses both. Copy it elsewhere every day after the backup time, e.g. from a cron job on the host:

```bash
# Path of the volume on the host (one time): docker volume inspect -f '{{.Mountpoint}}' <project>_backups
rsync -a --delete /var/lib/docker/volumes/<project>_backups/_data/ backup-user@backup.example.org:/srv/yoda-backups/
```

or with `rclone sync` to the organisation's object storage. Keep the copy at least as long as
the days kept, restrict who can read it (it holds every request, chat and file), and test a restore from
it now and then.

**Restore.** Restore into an empty database: `pg_restore --clean` replaces the objects in the backup but leaves
tables created by a newer release in place.

1. Stop everything that writes: `dc stop portal core backup` (and `runner` if you run it).
2. Recreate the database empty:
   `dc exec postgres sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'`.
3. If the backup is only on the off-host copy, copy its `pg-<stamp>.dump`, `storage-<stamp>/` and (for `latest`)
   the `latest` marker back into the `backups` volume.
4. Restore the database and the bucket:
   `dc run --rm -e RESTORE_CONFIRM=yes --entrypoint restore.sh backup <YYYYMMDD-HHMM|latest>`. It ends by
   printing the master key id the restored database needs (`key id …`); compare it with the `Key id:` line of
   your kits (and `yoda-admin status`) to know which kit's key to put back.
5. Bring the schema up to the running release and start again: `dc run --rm migrate`, then
   `dc up -d --no-build`.
6. Check `/api/ready` (section 11) and a few recent items in the portal. On a new host, or after the
   bootstrap volume was lost, core starts in recovery mode if the master key does not match the restored
   database (a backup from before a rotation needs the old key): put the key of the kit whose key id matches
   back (section 4a), or re-enter the secrets (section 11). A lost bootstrap volume also needs the Postgres
   password (section 4a, "Lost bootstrap volume").

`ops/backup/restore-check.sh` (dev only) runs the whole round trip against the dev stack and prints
`restore ok`.

## 7. GitLab integration

Owner checklist (details in [docs/development.md, "GitLab integration"](development.md#gitlab-integration)):

- [ ] A dedicated **bot user** on `gitlab.example.org` (e.g. `yoda-bot`) with **Developer** access to every
      repository linked in the portal (Maintainer only where protected branches require it).
- [ ] A **personal access token** of the bot with the `api` scope and an expiry date you will track (section
      10). Enter it in System settings → GitLab with the URL `https://gitlab.example.org` (or the wizard's
      GitLab step; `GITLAB_TOKEN` / `GITLAB_URL` in `.env` still work), and press **Test**.
- [ ] A **webhook** on each linked project, or once on the group: URL
      `https://portal.example.org/api/gitlab/webhook`, secret token = the webhook secret (System settings →
      GitLab can generate it, shown once; or `GITLAB_WEBHOOK_SECRET`), triggers
      **Merge request events**, **Pipeline events** and **Comments**, SSL verification on.
- [ ] System settings → GitLab shows core configured, GitLab reachable, the bot user, and the time of the last webhook.

GitLab does not retry failed deliveries and disables a webhook that keeps failing. After an outage, open the
webhook's **Recent events**, re-enable it if needed and **Resend** the failed deliveries; resending is harmless.
Core also re-reads the merge requests of active work items every 15 minutes.

## 8. Runners

Runners work the AI tasks that need a repository; see [docs/development.md, "Runners"](development.md#runners) for the full guide.

- **Server runner.** Add `COMPOSE_PROFILES=runner` to `.env` so deploys pull and restart it. Create the token in
  the portal's Runners page (admin, choosing the staff owner), put it in `YODA_RUNNER_TOKEN`, set
  `YODA_RUNNER_ANTHROPIC_API_KEY` and `YODA_GIT_PASSWORD` (a project or group access token with
  `write_repository`, limited to the repos the runner works), and create `runner-config.json` in
  `DEPLOY_PATH` with `repos` (`cloneUrl` entries such as `https://gitlab.example.org/group/app.git`) and no
  token. The agent can read everything the runner can, so give it scoped credentials only.
- **Staff machines.** Each staff member creates a runner for their own machine in the Runners page; the token
  is shown once. Core must be reachable from those machines over HTTPS (e.g. a reverse-proxy host
  `https://yoda-core.example.org` that serves only core's `/mcp`, limited to the networks runners use).
- **Revoke** a runner's token in the portal when a machine is lost or a person leaves; it stops at once.
- `RUNNER_LEASE_SECONDS` (600) is how long a claim survives without a heartbeat; `MCP_ENABLED=false` turns
  the runner endpoint off.

## 9. Email, LINE and Telegram

The portal feed always works. Each outside channel is on only when its variables are set **and** an admin
enables it in System settings → Notification channels; then each person chooses channels per notification kind in
their settings. Messages carry only the notification's title, body and a portal link. Delivery is at least
once from the moment it is queued: after a crash during sending a person may rarely get the same message twice.
A channel error is retried 6 times with exponential backoff (about 30 seconds, doubling up to about 16
minutes; roughly half an hour in all) and then given up: an SMTP, LINE or Telegram outage longer than that
window drops the outside messages queued during it (they are not sent later). The portal feed is never
affected. Set each channel up in System settings (Email, LINE, Telegram; or the wizard's optional steps) with
its **Test** button; the matching variables in `.env` still work and lock the values there. Credentials are
stored encrypted with the master key, never logged, and never returned by the API.

### 9.1 Email (SMTP)

- [ ] Ask the mail team for a relay account for `yoda@example.org` on `smtp.example.org` (port 587 with
      STARTTLS, or 465 with `SMTP_SECURE=true`), and that the relay accepts the deploy host.
- [ ] In System settings → Email set the host, port, TLS, user, password and sender (`SMTP_*`, `MAIL_FROM`), and
      press **Test**.
- [ ] Enable email in System settings → Notification channels and send a test (assign yourself a task).
- [ ] SPF/DKIM for the sender domain are the mail team's; without them messages land in spam.

### 9.2 LINE Official Account (Messaging API)

- [ ] Create a **LINE Official Account** for the department and, in the LINE Developers console, a
      **Messaging API channel** for it.
- [ ] Messaging API tab: issue a **channel access token (long-lived)** and, Basic settings tab, the **Channel
      secret**; enter both in System settings → LINE (`LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`) and
      press **Test**.
- [ ] Messaging API tab → Webhook settings: **Webhook URL** `https://portal.example.org/api/webhooks/line`,
      press **Verify** (expects 200), and turn **Use webhook** on.
- [ ] LINE Official Account Manager → Response settings: turn **auto-reply messages off** (and greeting
      messages off, or reword them), so people see Yoda's own linking replies only. Chat mode off.
- [ ] Copy the account's add-friend link (`https://line.me/R/ti/p/@<id>`) into System settings → LINE
      (`NUXT_PUBLIC_LINE_ADD_FRIEND_URL`).
- [ ] Enable LINE in System settings → Notification channels. A person links from Settings: add the account, then send
      the `LINK-XXXXXXXX` code shown in the portal (valid 15 minutes). Blocking the account unlinks them.

### 9.3 Telegram

- [ ] In Telegram, talk to **@BotFather**: `/newbot`, choose a name and a username ending in `bot`. The token it
      returns goes in System settings → Telegram (`TELEGRAM_BOT_TOKEN`); core reads the bot's
      username from Telegram.
- [ ] Generate the webhook secret there (or set `TELEGRAM_WEBHOOK_SECRET`, `openssl rand -hex 24`), then press
      **Register webhook**: core calls `setWebhook` with `https://portal.example.org/api/webhooks/telegram` and the
      secret.
- [ ] Fallback, when the button cannot be used (values in `.env`): register the webhook from `DEPLOY_PATH` on the
      deploy host. The snippet reads the two values out of
      `.env` with `sed` (it never sources `.env`, so nothing in it runs as shell code; values must be unquoted
      `NAME=value` lines) and hands them to curl on stdin (`-K -`), so the token stays out of shell history
      and of other users' `ps`:

      ```bash
      env_get() { sed -n "s/^$1=//p" .env | tail -n 1; }
      printf 'url = "https://api.telegram.org/bot%s/setWebhook"\ndata-urlencode = "secret_token=%s"\n' \
          "$(env_get TELEGRAM_BOT_TOKEN)" "$(env_get TELEGRAM_WEBHOOK_SECRET)" |
        curl -fsS -K - \
          --data-urlencode "url=https://portal.example.org/api/webhooks/telegram" \
          --data-urlencode 'allowed_updates=["message","my_chat_member"]' \
          --data-urlencode "drop_pending_updates=true"
      ```

      Expect `{"ok":true,...}`. Check later with `.../getWebhookInfo` (look at `last_error_message`).
- [ ] Enable Telegram in System settings → Notification channels. A person links from Settings with the
      `t.me/<bot>?start=<code>` link; blocking the bot unlinks them.

## 10. Rotating secrets

Most secrets now live in System settings: **enter the new value there; it applies within a second on every core
instance (saving a secret needs a recent sign-in), then revoke the old one.** A secret set in `.env` instead is
changed there and applied with `dc up -d --no-build` (`dc` as in section 4; compose recreates the containers whose
environment changed). Rotate on a schedule, when a person with access leaves, and at once after a suspected leak.

| Secret | How |
| --- | --- |
| Postgres password | Host side. `dc exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`, then `\password yoda` (prompts, so the password stays out of history); put the same value in `.env` as `POSTGRES_PASSWORD` (and in `DATABASE_URL` if you set one), then `dc up -d --no-build` (`init` copies it into the bootstrap volume) and `dc restart core backup` (they read the bootstrap volume at start; core's environment did not change, so `up` leaves it running), then make a new recovery kit (`yoda-admin recovery-kit`; section 4 step 5). |
| Storage keys | Host side. RustFS takes its credentials from the bootstrap volume: set both `S3_ACCESS_KEY` and `S3_SECRET_KEY` in `.env` and `dc up -d --no-build` (restarts `rustfs`, `core`, `backup`), then make a new recovery kit (`yoda-admin recovery-kit`; section 4 step 5). |
| AI provider keys | Create the new key in the provider console, enter it in System settings → AI, then delete the old key. |
| GitLab bot token | Create a new token (`api`), enter it in System settings → GitLab (**Test** shows the bot), revoke the old one. |
| GitLab webhook secret | Generate a new one in System settings → GitLab, then put it in every webhook right away; deliveries in between are refused (resend them). |
| SMTP password | Change it with the mail team, enter it in System settings → Email, **Test**. |
| LINE token / secret | Issue a new long-lived token (or reissue the channel secret) in LINE Developers, enter it in System settings → LINE, then revoke the old token. |
| Telegram token | Save first, revoke after: BotFather `/revoke` gives the new token at once, so enter it in System settings → Telegram straight away and press **Register webhook**. |
| Telegram webhook secret | Generate a new one in System settings → Telegram and press **Register webhook**. |
| Master key | `(umask 077; dc exec -T core yoda-admin rotate-master-key > yoda-recovery-kit.txt)`, then store the new kit (see "Master key rotation" below). After a leak, also rotate every secret above: whoever had the old key and a database copy could read them. |
| Break-glass admin | Change its password (and the authenticator) at `/recovery`. `(umask 077; dc exec -T core yoda-admin recovery-kit > yoda-recovery-kit.txt)` makes a new recovery kit, which replaces the recovery codes. Lost password or authenticator: `dc exec core yoda-admin reset-break-glass` prints a temporary password (section 11). |
| Runner tokens | Revoke and re-create in the Runners page; update the runner's config or `YODA_RUNNER_TOKEN`. |
| Deploy SSH key | New key pair, add the public key to `authorized_keys`, update `DEPLOY_SSH_KEY`, remove the old public key. |
| Registry deploy token | Create a new `read_registry` token, `docker login registry.example.org` on the host, revoke the old one. |
| Release signing key, upload token | New key or token as in section 5 ("Release bundle"); embed the new public key in `install.sh` before the next tag. |

### Master key rotation

The master key wraps the data key of every secret in System settings and the break-glass authenticator seed
(proposal §3.5). Rotate it on a schedule, when someone who held a recovery kit leaves, and after a suspected leak.

1. **Try it:** `dc exec core yoda-admin rotate-master-key --dry-run` does every step inside a transaction that is
   rolled back and prints what it would change (how many secrets and seeds). Nothing is written.
2. **Rotate:** `(umask 077; dc exec -T core yoda-admin rotate-master-key > yoda-recovery-kit.txt)`. In one database
   transaction it re-wraps every data key and the TOTP seed under a new random key (the ciphertexts stay), replaces
   the break-glass recovery codes (they are keyed by the master key and cannot be carried over), ends every
   setup and recovery session, writes the key canary with the new key id and records `master_key.rotated` in the
   audit log (key ids and counts only). The new key goes to `core/master-key.next` before the transaction and
   becomes `core/master-key` after it; the old key is kept as `core/master-key.prev`. Anything the current key
   cannot open stops the rotation and nothing changes; the command names the settings (clear or re-enter them in
   System settings first). An existing `core/master-key.next` (an earlier rotation that did not finish) is never
   overwritten: the command refuses and says how to finish the move. When `YODA_MASTER_KEY` comes from this
   process's environment (not the key file), the command refuses unless `--allow-env-key` is given, because core
   cannot use the new key until the environment changes and core restarts.
3. **Store the new kit.** Standard output carries only the new recovery kit (the new key and the new recovery
   codes); messages go to standard error. The old kit's recovery codes no longer work, but **keep the old kit**
   (its key) until every backup taken before the rotation has aged out, on the host and off it: restoring one
   needs the old key (section 6). Move the new file off the host as in section 4 step 5, then delete it there.
4. **Running cores switch by themselves** on the change notification (they read the key file again and keep the
   old key, decrypt-only). If `.env` sets `YODA_MASTER_KEY`, replace it with the new key now or remove the line:
   `init` copies `.env` over the key file on every start. (If it is forgotten, core notices that the key in
   `.prev` opens the canary, uses it and logs a warning until `.env` is fixed.)
5. **Finish:** once every core runs with the new key, `dc exec core yoda-admin rotate-master-key --finish`
   re-wraps anything still under the old key (a value saved by a core in the seconds before it switched) and
   deletes `core/master-key.prev`. `yoda-admin status` shows a previous key until then. **Never delete
   `master-key.prev` by hand while core logs "the previous key does":** then `.prev` holds the only working key
   (the key file was overwritten from a stale `.env`). `--finish` and a new rotation both refuse in that state;
   fix `.env` first.

Audit fingerprints of secrets are keyed by the master key too: changes recorded before and after a rotation
cannot be compared by fingerprint (the log still shows who changed what, and when).

**The commit-to-move window.** Between the database commit and renaming the files (milliseconds), the database
names the new key while `core/master-key` still holds the old one. If the command dies there (it says so when the
rename fails), the new key is in the kit on stdout and in `core/master-key.next`: finish by hand with
`mv master-key master-key.prev && mv master-key.next master-key` inside `/var/lib/yoda/core`, then
`dc restart core`. A core that restarts inside the window starts in recovery (mismatch) until the move is done.

**Save first, revoke after (LINE and Telegram).** While core still holds a revoked token, deliveries fail with
401, which counts as a **permanent** failure: those messages are not retried for that channel, although the
portal feed has them. So save the new value first and revoke the old token afterwards (LINE keeps the old
long-lived token valid until you revoke it; Telegram's `/revoke` is immediate, so save the new token straight
after it). For a value still in `.env`, the same holds with `dc up -d --no-build` in place of saving.

## 11. Troubleshooting

`dc` as in section 4.

- **Is it up?** `dc ps` shows each container's health. Core: `dc exec core node -e "fetch('http://127.0.0.1:4000/ready').then(async (r) => console.log(r.status, await r.text()))"`
  prints `200 {"status":"ok","checks":{...}}`, or `503 {"status":"unavailable",...}` with the failing check (`database`, `storage` or
  `queue`). `/health` answers as long as the process runs and includes the version. Through the portal:
  `curl -s http://127.0.0.1:<PORTAL_PORT>/api/ready` on the host.
- **Logs.** `dc logs --tail 200 -f core` (also `portal`, `migrate`, `backup`, `runner`, `postgres`). Logs carry
  error codes, never credentials.
- **Deploy job failed.**
  - *SSH: host key verification failed:* `DEPLOY_KNOWN_HOSTS` does not match the host (re-check the
    fingerprint; never turn host key checking off).
  - *image … is missing* or *pulling the images … failed* (exit 3): the host is not logged in to the registry,
    or the tag pipeline's build jobs did not finish. For ghcr.io: the packages are not public yet; make them
    public ([releasing](releasing.md#one-time-setup)) or `docker login ghcr.io` with a GitHub token that may read
    packages.
  - *YODA_IMAGE_PREFIX is not set: using the public release images:* neither `release.env` nor `.env` names the
    registry path, so `deploy.sh` used and pinned `ghcr.io/tantee/yoda`. For a mirror, run `deploy.sh` once with
    `YODA_IMAGE_PREFIX=<path>` (section 5, upgrade notes).
  - *migrate failed:* `dc logs migrate`. Nothing was replaced; the previous release is still running. Fix and
    deploy again, or restore (section 6).
  - *not ready after 120s:* `/ready` names the failing dependency; then `dc logs core`.
  - *init: an existing database was found but its password is unknown:* the bootstrap volume is empty or new
    while the database volume is not: put section 3 of the recovery kit in `.env`, or reset the Postgres password
    (section 4a, "Lost bootstrap volume").
  - *init: … would replace …, but ….prev already keeps an earlier replaced value:* `.env` holds a third value for
    a key or password that was replaced before (section 4a). Check which value is right; remove the `.prev` only
    when nothing needs it (for the master key: no backup from before that change).
- **install.sh refused.** *signature check FAILED* or *checksum MISMATCH*: the download does not match what the
  release job signed (a changed or partial file, the wrong base URL, or an `install.sh` with another release
  key); download again and never bypass it. *no release public key yet*: this `install.sh` still has the
  placeholder key (section 5). *already holds an install*: upgrade with `deploy.sh` instead.
- **The wizard says "csrf_failed" (or "the request was refused") on every step.** The portal checks that each
  request comes from the address the wizard is open on. Behind a reverse proxy that does not pass the browser's
  `Host` (nginx sends the upstream address by default), the portal sees another host and refuses. Add
  `proxy_set_header Host $host;` (and the `X-Forwarded-*` headers, section 5), reload the proxy, then reload the
  wizard. Through the SSH tunnel, open exactly `http://127.0.0.1:3000/setup` (not `localhost` on one tab and
  `127.0.0.1` on another), and finish in the same tab.
- **The wizard (or System settings → General) refuses the public URL: "https_required"** (*Yoda's address must
  use https*). The URL is `http://` on a host that is not this machine (D8, section 1). Enter the `https://`
  address of the reverse proxy (it may be set up later, before the claim), or finish setup through the SSH tunnel
  (`ssh -L 3000:127.0.0.1:3000 <deploy host>`, then `http://127.0.0.1:3000/setup`). If the field is locked, the
  value comes from `PORTAL_URL` in `.env`: change it there and restart. `/setup/complete` answers the same code
  when an http URL was saved before this rule: go back to the organisation step and change it.
- **Setup token lost or expired.** `dc exec core yoda-admin setup-token` prints the current one, or a new one
  when it was used or is older than 24 hours (`--new` always makes a new one); a restart of core also makes a new
  one (in the "Yoda setup" banner of `dc logs core`). Once setup is done there is no token: the command says so.
- **Locked out of Keycloak** (a wrong issuer or client, Keycloak down, no admin left): open `/recovery` on the
  portal and sign in with the break-glass account from setup (password plus authenticator code or a recovery
  code from the kit). An install set up from `.env` (no wizard) has none until `yoda-admin create-break-glass`
  (section 5, upgrade notes). Every portal admin is notified. There you can stage new sign-in values, check them, test a
  real sign-in, apply them, or roll back to the last working ones. Lost the break-glass password or
  authenticator: `dc exec core yoda-admin reset-break-glass` (on the host) prints a temporary password once;
  the next sign-in must set a new password and authenticator first. `dc exec core yoda-admin status` shows the
  setup, master key and break-glass state without secrets. Every portal admin page shows a banner while a
  break-glass session is open. If nobody can be admin under the sign-in in effect (another identity provider
  with other usernames, or no admin left), grant admin at `/recovery` → **Portal admins**. A grant also
  pre-grants the username: the next new person with it (for example the same username under a new identity
  provider) is admin at their first sign-in, which uses the pre-grant up; it counts as admin for the test
  sign-in of a pending change. Pending pre-grants are listed there. Revoking the last admin asks for
  confirmation.
- **Maintenance lock-down.** `dc exec core yoda-admin recovery on` forces recovery mode: the portal shows only
  `/recovery` and the portal API answers 503 (`recovery_mode`); webhooks keep working. `... recovery off` ends it.
  Both are audited and the admins are told.
- **Wrong or missing master key** (recovery mode): core starts, but the secrets saved in System settings cannot
  be read; System settings → Security and `/health` say so, and those settings show **unavailable**. The
  break-glass account can still sign in at `/recovery` with its password alone, to a **status-only** session
  (the authenticator cannot be checked without the key, so nothing can be changed there; the admins are told).
  Such a session stays status-only for its whole life and ends as soon as the key works again.
  Put the right key back (from the recovery kit: `YODA_MASTER_KEY=<key>` in `.env`, then `dc up -d --no-build`
  and `dc restart core`: `init` writes the key file, but core is not recreated, since its own environment did not
  change, and reads the key only at start; section 4a). `init` keeps the wrong key as `core/master-key.prev`:
  `dc exec core yoda-admin rotate-master-key --finish` deletes it once core runs on the right key. If the key is lost for good, `dc exec core yoda-admin reset-master-key --yes` makes the key core
  has now the master key: it lists and drops the secrets the old key encrypted, removes the break-glass
  authenticator and recovery codes, ends every recovery session (including status-only ones) and core leaves
  recovery mode without a restart. Then enter the secrets again, sign in at `/recovery` (the password, which must
  be changed first, then a new authenticator; forgotten password: `yoda-admin reset-break-glass`), run
  `yoda-admin recovery-kit` and store the kit. Never delete the bootstrap volume to "fix" it.
- **A setting shows "Set by environment" and cannot be edited.** Its variable is in `.env` (the lock names it),
  or in the shell that ran compose. Remove the line from `.env` and `dc up -d --no-build`; the value
  imported from env stays in effect, now editable (section 3).
- **Everyone shows as the proxy's address, or the wizard detects the wrong URL** behind a reverse proxy: set
  `YODA_TRUSTED_PROXY_HOPS=2` and have the proxy send `X-Forwarded-For`, `X-Forwarded-Proto` and
  `X-Forwarded-Host` (section 5, upgrade notes). Core logs a warning once when it sees a proxy while the value is
  `1`. Never set it higher than the proxies really there.
- **Sign-in loops or 401s.** The issuer (System settings → Sign-in, or `OIDC_ISSUER`) must equal the token's `iss`
  exactly, `azp` must be the client id, core must reach the signing keys (the issuer's certs or the JWKS URL), and
  the client must be public with PKCE (section 2). Fix them at `/recovery` if nobody can sign in.
- **A person is a requester but should be staff.** They are not in `STAFF_GROUP` (full path) in Keycloak, or an
  admin set an override in Admin → People.
- **GitLab shows not connected.** System settings → GitLab; check `GITLAB_URL`, the token (expired?) and that core can
  reach GitLab. Missing webhook events: GitLab's webhook **Recent events** (section 7).
- **Emails, LINE or Telegram not arriving.** System settings → Notification channels shows whether each channel is
  configured and enabled; the person's settings show what they chose and whether they are linked. Core logs a
  code per failed delivery, never the message or a credential: `smtp_<reply code>` (e.g. `smtp_535`, a wrong
  password), `line_<status>` / `telegram_<status>` (`401`: a wrong or revoked token, section 10),
  `telegram_blocked`, `send_failed` (network). LINE: the webhook **Verify** button and `LINE_CHANNEL_SECRET`.
  Telegram: `getWebhookInfo`.
- **Backups.** `dc ps backup` unhealthy or `dc logs backup` (section 6). "cannot read the backup settings from the
  database" right after the first install is harmless (the migrations had not run yet); later it means the
  database is down.
- **Disk full.** `docker system df`; old images: `docker image prune -a` (keeps the running ones); the
  `backups` volume (section 6).
