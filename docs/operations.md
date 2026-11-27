# Yoda operations runbook

How to install, configure, upgrade, back up and troubleshoot a production Yoda. Every hostname here is a
placeholder (`portal.example.org`, `sso.example.org`, `gitlab.example.org`, `registry.example.org`,
`smtp.example.org`); use your own. Secrets live only in the deploy host's `.env` (mode `600`) and in GitLab
CI/CD variables, never in the repository, tickets or chat.

Contents:

1. [Prerequisites](#1-prerequisites)
2. [Keycloak](#2-keycloak)
3. [Environment variables](#3-environment-variables)
4. [First install](#4-first-install)
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
  run `docker` (member of the `docker` group), and an SSH key pair for the GitLab deploy job (section 5).
- **Registry access.** The host pulls images from the GitLab project's container registry. Create a GitLab
  **deploy token** on the project with the `read_registry` scope only, and log in once on the host as the deploy
  user: `docker login registry.example.org` (the user name and token are entered interactively, so they stay
  out of shell history).
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
- [ ] **First admins:** set `BOOTSTRAP_ADMINS` to a comma-separated list of Keycloak usernames before those
      people first sign in. It applies only when a person is first created; later admins are made in
      Admin → People. Clear it once the first admin exists.
- [ ] Core's `OIDC_ISSUER` is the browser-facing issuer, e.g. `https://sso.example.org/realms/yoda` (it must
      equal the token's `iss`). The portal's `NUXT_PUBLIC_KEYCLOAK_URL` is `https://sso.example.org` and
      `NUXT_PUBLIC_KEYCLOAK_REALM` is `yoda`. If core cannot reach the public Keycloak URL, set
      `OIDC_JWKS_URL` to Keycloak's internal certs URL; tokens are still checked against `OIDC_ISSUER`.

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

## 3. Environment variables

All configuration is environment variables, set in the deploy host's `.env` next to the compose files (compose
reads it for interpolation), except `YODA_VERSION`, which `deploy.sh` writes to `release.env` beside it. Every
name below is read by core (`apps/core/src/config.ts`), by the portal
(`NUXT_*`, read at runtime) or by `docker-compose.prod.yml`; a test keeps this table in sync with them.
"Fixed" means the prod overlay sets the value itself and ignores `.env`.

Release and host:

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `YODA_IMAGE_PREFIX` | Registry path of the images; compose uses `<prefix>/<name>:<version>` | yes on a deploy host | `registry.example.org/group/yoda` |
| `YODA_VERSION` | Release tag to run; `deploy.sh` pins it in `release.env`, never in `.env` (compose refuses to start without it) | yes, in `release.env` | `1.0.0` |
| `CORE_PORT` | Host port for core | optional (`4000`) | `4000` |
| `CORE_BIND` | Host address core is published on | optional (`127.0.0.1`) | `127.0.0.1` |
| `PORTAL_PORT` | Host port for the portal | optional (`3000`) | `3000` |
| `PORTAL_BIND` | Host address the portal is published on; another address only for a proxy on another machine | optional (`127.0.0.1`) | `10.0.0.5` |
| `PORT` | Port core listens on inside its container | fixed (`4000`) | `4000` |

Database and storage:

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `POSTGRES_USER` | Database owner created on a fresh volume | optional (`yoda`) | `yoda` |
| `POSTGRES_PASSWORD` | Its password; only applied when the volume is created | yes | `<random 32 chars>` |
| `POSTGRES_DB` | Database name | optional (`yoda`) | `yoda` |
| `DATABASE_URL` | Core, `migrate` and `backup` connection; same credentials, host `postgres` | yes | `postgres://yoda:<password>@postgres:5432/yoda` |
| `MIGRATE_ON_START` | Core migrates on start; production runs the `migrate` service instead | fixed (`false`) | `false` |
| `S3_ENDPOINT` | Object storage endpoint | fixed (`http://rustfs:9000`) | `http://rustfs:9000` |
| `S3_REGION` | Storage region | optional (`us-east-1`) | `us-east-1` |
| `S3_BUCKET` | Bucket for uploaded files, created on start | optional (`yoda`) | `yoda` |
| `S3_ACCESS_KEY` | Storage access key; also RustFS's own credentials | yes | `<random 20 chars>` |
| `S3_SECRET_KEY` | Storage secret key | yes | `<random 40 chars>` |
| `BACKUP_AT` | Daily backup time, Asia/Bangkok | optional (`02:00`) | `02:00` |
| `BACKUP_KEEP_DAYS` | Days of backups kept on the `backups` volume | optional (`14`) | `14` |

Settings and secrets (installer proposal §3.5, §6):

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `YODA_MASTER_KEY` | Master key for secrets saved in the admin settings, base64 of 32 bytes; never stored in the database. Empty: no secrets stored there (env secrets still work); a wrong key starts core in recovery | optional | `<openssl rand -base64 32>` |
| `YODA_MASTER_KEY_FILE` | File holding the master key instead (the bootstrap volume); `YODA_MASTER_KEY` wins when both are set | optional | `/run/yoda/core/master-key` |
| `YODA_SETTINGS_IMPORT` | `false` = env secrets are not copied into the database on start (other values still are) | optional (`true`) | `true` |
| `YODA_OUTBOUND_ALLOW_LOOPBACK` | Dev only: the admin settings tests may connect to loopback (the dev fakes). Never set in production | optional (`false`) | `false` |

`YODA_MASTER_KEY`, `YODA_MASTER_KEY_FILE` and `YODA_SETTINGS_IMPORT` take effect once they reach core's
environment. The prod compose file does not pass them to the `core` service yet: that wiring (with the bootstrap
volume for the key file) arrives with the installer update. Until then a production core runs without a master
key: secrets set in env work, System settings shows an information note, and secrets cannot be saved there. In
development core reads the repository's `.env` (`pnpm dev` or `pnpm --filter @yoda/core dev`), so set them there.

On start core copies every env value it reads into the database (D4; secrets too, with a usable master key and
`YODA_SETTINGS_IMPORT` not `false`). In System settings such a value shows **Imported from environment**. So
**removing a variable from `.env` does not turn the feature off**: after the restart the imported value stays in
effect, now editable. To really disable something (email, LINE, Telegram, GitLab, an AI provider), remove the
variable and restart, then clear the value in System settings (for a secret, **Remove**), or switch the channel
off there. With `YODA_SETTINGS_IMPORT=false` (or no usable master key) env secrets are not copied, so removing one
disconnects that service until it is entered in System settings. Variables the prod compose file passes with a
default (such as `SMTP_PORT`, `AI_WORKERS`) stay set in env, and so locked in the UI, until the install uses the
generated settings of the installer update. The settings read by the portal and the backup container (the
`NUXT_PUBLIC_*` values, `BACKUP_AT`, `BACKUP_KEEP_DAYS`, the organisation name) are shown read-only for now:
they are set on those containers' environment on the install host.

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

Sign-in (section 2):

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `OIDC_ISSUER` | Keycloak realm issuer, as in the token's `iss` | yes | `https://sso.example.org/realms/yoda` |
| `OIDC_CLIENT_ID` | Client id; tokens' `azp` must match | optional (`yoda-portal`) | `yoda-portal` |
| `OIDC_JWKS_URL` | Internal URL for the signing keys, when core cannot reach the issuer | optional | `http://keycloak.internal.example.org/realms/yoda/protocol/openid-connect/certs` |
| `STAFF_GROUP` | Full path of the staff group | optional (`/it-dev`) | `/it-dev` |
| `BOOTSTRAP_ADMINS` | Usernames made admin on first sign-in, comma-separated | optional | `somchai.p` |

Portal:

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `NUXT_CORE_URL` | Where the portal's `/api` proxy sends requests | fixed (`http://core:4000`) | `http://core:4000` |
| `NUXT_PUBLIC_KEYCLOAK_URL` | Browser-facing Keycloak base URL | yes | `https://sso.example.org` |
| `NUXT_PUBLIC_KEYCLOAK_REALM` | Realm | optional (`yoda`) | `yoda` |
| `NUXT_PUBLIC_KEYCLOAK_CLIENT_ID` | Public client | optional (`yoda-portal`) | `yoda-portal` |
| `NUXT_PUBLIC_RUNNER_DOCS_URL` | Setup docs linked from the Runners page | optional (README "Runners") | `https://portal.example.org/docs/runners` |
| `NUXT_PUBLIC_LINE_ADD_FRIEND_URL` | The LINE Official Account's add-friend link, shown when linking LINE | optional | `https://line.me/R/ti/p/@example` |
| `NUXT_PUBLIC_ORG_LINE` | Organisation line at the foot of the side menu, e.g. the department or hospital name | optional (empty: no line) | `ฝ่ายเทคโนโลยีสารสนเทศ` |
| `PORTAL_URL` | The portal's public base URL, used in links in emails, chats and GitLab issues (compose refuses to start without it) | yes | `https://portal.example.org` |

AI:

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic API key; jobs on a provider without a key are unavailable | optional | `<from the provider console>` |
| `OPENAI_API_KEY` | OpenAI (or compatible) API key | optional | `<from the provider console>` |
| `OPENAI_BASE_URL` | Base URL of an OpenAI-compatible provider | optional | `https://llm.example.org/v1` |
| `AI_MODEL_DRAFT` | Model for drafting, briefs and the secretary, `provider:model` | optional (`anthropic:claude-opus-5-5`) | `anthropic:claude-opus-5-5` |
| `AI_MODEL_FAST` | Model for quick jobs and weekly summaries | optional (`anthropic:claude-haiku-5-5`) | `anthropic:claude-haiku-5-5` |
| `AI_EMBEDDING_MODEL` | Embedding model; empty = trigram search only | optional | `openai:text-embedding-3-small` |
| `AI_WORKERS` | AI jobs run at once | optional (`2`) | `2` |
| `DAILY_TASK_CAP` | Most automatic assignments per person per day (Asia/Bangkok) | optional (`8`) | `8` |

GitLab (section 7):

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `GITLAB_URL` | GitLab base URL; empty = GitLab features off | optional | `https://gitlab.example.org` |
| `GITLAB_TOKEN` | The bot user's access token (`api` scope) | with `GITLAB_URL` | `<bot token>` |
| `GITLAB_WEBHOOK_SECRET` | Webhook secret token, at least 16 characters | with `GITLAB_URL` | `<random 32 chars>` |

Runners (section 8):

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `RUNNER_LEASE_SECONDS` | How long a runner's claim lasts without a heartbeat (at least 180) | optional (`600`) | `600` |
| `MCP_ENABLED` | Serve the runner MCP endpoint at `/mcp` | optional (`true`) | `true` |
| `YODA_RUNNER_TOKEN` | Server runner's token from the Runners page | with the `runner` profile | `yoda_rt_<shown once>` |
| `YODA_RUNNER_CORE_URL` | Core URL for the server runner | optional (`http://core:4000`) | `http://core:4000` |
| `YODA_RUNNER_ANTHROPIC_API_KEY` | Model key for the server runner's Claude Code | with the `runner` profile | `<from the provider console>` |
| `YODA_GIT_USERNAME` | Git user for clone and push | optional (`oauth2`) | `oauth2` |
| `YODA_GIT_PASSWORD` | Git token for clone and push (`write_repository`, limited to the repos) | with the `runner` profile | `<project or group access token>` |
| `YODA_RUNNER_GIT_NAME` | Commit author name | optional (`Yoda runner`) | `Yoda runner` |
| `YODA_RUNNER_GIT_EMAIL` | Commit author email | optional | `yoda-runner@example.org` |
| `YODA_RUNNER_CONFIG_FILE` | Runner config file mounted read-only (repos, executor; no token) | optional (`./runner-config.json`) | `./runner-config.json` |

Notifications (section 9):

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `SMTP_HOST` | Mail relay; host and `MAIL_FROM` both set = email configured | optional | `smtp.example.org` |
| `SMTP_PORT` | Relay port | optional (`587`) | `587` |
| `SMTP_SECURE` | `true` = TLS from the start (port 465); `false` = STARTTLS when offered | optional (`false`) | `false` |
| `SMTP_USER` | Relay user | optional | `yoda@example.org` |
| `SMTP_PASSWORD` | Relay password | optional | `<relay password>` |
| `MAIL_FROM` | Sender address | with `SMTP_HOST` | `Yoda <yoda@example.org>` |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API channel access token (long-lived) | for LINE | `<from LINE Developers>` |
| `LINE_CHANNEL_SECRET` | LINE channel secret, the key of `X-Line-Signature` | for LINE | `<from LINE Developers>` |
| `LINE_API_URL` | LINE API base URL | optional (`https://api.line.me`) | `https://api.line.me` |
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather | for Telegram | `<from BotFather>` |
| `TELEGRAM_BOT_USERNAME` | Bot username, without `@` | for Telegram | `example_yoda_bot` |
| `TELEGRAM_WEBHOOK_SECRET` | Webhook secret token, 16-256 of `A-Z a-z 0-9 _ -` | for Telegram | `<random 48 chars>` |
| `TELEGRAM_API_URL` | Bot API base URL | optional (`https://api.telegram.org`) | `https://api.telegram.org` |

Generate random values with `openssl rand -hex 24` (hex suits every field above, including the Telegram
secret). Only the server runner variables are passed to the `runner` container; core never sees them.

## 4. First install

On the deploy host, as the deploy user:

**Commands.** In this runbook `dc` stands for this alias, run in `DEPLOY_PATH` (define it once in the deploy
user's shell):

```bash
alias dc='docker compose --env-file .env --env-file release.env -f docker-compose.yml -f docker-compose.prod.yml'
```

`release.env` holds `YODA_VERSION=<tag>`, written by `deploy.sh` once it has pulled that release, so every `dc`
command runs the deployed images; without it compose stops with "YODA_VERSION is required". Never build on the
host: `dc up` always gets `--no-build`. A `YODA_VERSION` exported in your shell overrides `release.env`, so
leave it unset.

1. Create the deploy directory (this is `DEPLOY_PATH`, e.g. `/srv/yoda`) and copy into it, from the release
   tag: `docker-compose.yml`, `docker-compose.prod.yml` and `ops/deploy/deploy.sh` (keep the paths). The
   deploy job refreshes these files on every deploy.
2. Create `.env` there (`chmod 600 .env`) with every required variable from section 3. Start from
   `.env.example` and replace each dev value; in particular `DATABASE_URL` must use host `postgres` and the
   same password as `POSTGRES_PASSWORD`. To run the server runner too, add `COMPOSE_PROFILES=runner` (and
   create `runner-config.json`, section 8).
3. Log in to the registry (section 1), then deploy the first release:
   `cd /srv/yoda && YODA_VERSION=1.0.0 sh ops/deploy/deploy.sh`. It pulls the images, writes `release.env`,
   runs the migrations, starts everything and waits until `/api/ready` answers. Later releases go through the
   deploy job (section 5).
4. Point the reverse proxy at the portal, open `https://portal.example.org` and sign in as one of
   `BOOTSTRAP_ADMINS`.
5. Finish setup in the portal and in the services around it:
   - [ ] **AI keys and budgets.** Put the provider keys in `.env` (section 3). In Admin → AI budget set the
         department's monthly budget, and on each project's AI settings tab its budget or no-AI. A model that is
         not in `apps/core/src/ai/prices.json` is logged at startup and refused for projects with a budget.
         Set a spending limit in the provider's console as well.
   - [ ] **GitLab** bot and webhook (section 7).
   - [ ] **Runners** (section 8).
   - [ ] **Email, LINE and Telegram** (section 9), then enable each channel in System settings → Notification channels.
   - [ ] **Backups** copied off the host (section 6), and a test restore.
   - [ ] **Monitoring:** alert on the `core`, `portal` and `backup` containers turning unhealthy (section 11).

## 5. Upgrade and rollback

Releases are git tags (`1.0.0`, `1.0.1`, …, see `CHANGELOG.md`). GitLab CI builds `core`, `portal`, `runner`
and `backup` for every pipeline on the default branch and on tags, and pushes them to
`$CI_REGISTRY_IMAGE/<name>` tagged with the commit SHA, plus the git tag on tags and `latest` on the default
branch. GitHub Actions only builds (the GitHub repository is public; nothing is published from it).

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

**Upgrade.**

1. Read `CHANGELOG.md` for the release, especially new required variables; add them to the host's `.env`
   yourself. **The deploy never changes `.env`**: it only replaces the compose files and
   `ops/deploy/deploy.sh`, and rewrites `release.env`.
2. **Take a backup** on the host, every time: `cd /srv/yoda && dc run --rm backup --now`
   (wait for it to finish; it is the restore point if the upgrade or a later rollback goes wrong).
3. Tag the release on the default branch (`git tag 1.1.0 && git push origin 1.1.0`) and wait for the tag
   pipeline's build jobs.
4. Run the manual **deploy** job in that tag pipeline. It copies the tag's compose files and
   `ops/deploy/deploy.sh` to `DEPLOY_PATH` and runs it there with `YODA_VERSION=<tag>`:
   `docker compose pull`, then it pins the tag in `release.env` (only once every image is on the host), then
   `docker compose run --rm migrate` (a failed migration stops the deploy before any running container is
   replaced), then `docker compose up -d --no-build`, then it polls the portal's `/api/ready`
   for up to 2 minutes and fails the job if it never answers 200. Only one deploy runs at a time.
5. Check the portal, and the job log's last line, `deploy: <tag> ready`.

**Rollback.** Run the deploy job again in the **previous tag's** pipeline (CI/CD → Pipelines, filter by tag), or
on the host: `cd /srv/yoda && YODA_VERSION=<previous tag> sh ops/deploy/deploy.sh` (it pins that tag in
`release.env` again). Migrations only move
forward: an older release usually runs on a newer schema, but if the changelog says a release changed data in a
way the older one cannot read, restore the backup taken in step 2 of the upgrade instead (section 6).

**Try a release locally.** The overlay needs `YODA_VERSION`; for a prod-like stack built from your checkout
(images `yoda/<name>:latest`), with a local `.env` holding the overlay's required variables:
`YODA_VERSION=latest docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d`.

## 6. Backups and restore

`dc` as in section 4.

The `backup` service writes, every day at `BACKUP_AT` (Asia/Bangkok), `pg-<YYYYMMDD-HHMM>.dump` (`pg_dump -Fc`)
and `storage-<YYYYMMDD-HHMM>/` (a full mirror of the bucket) to the `backups` volume, updates a `latest`
marker and deletes backups older than `BACKUP_KEEP_DAYS`. A failed run is retried 3 times, 15 minutes apart.
Back up now with `dc run --rm backup --now`.

**Watch it.** The container turns **unhealthy** when the last backup is older than 26 hours. Alert on that
(`docker inspect -f '{{.State.Health.Status}}' <backup container>`), and read `dc logs backup` after a
failure.

**Disk usage.** Each day keeps a full copy of the bucket, so the volume holds about
`BACKUP_KEEP_DAYS × (database dump + bucket size)`. Check it with
`docker system df -v | grep backups` and lower `BACKUP_KEEP_DAYS` or add disk before it fills.

**Copy backups off the host.** The `backups` volume is on the same host as the database: a lost disk or host
loses both. Copy it elsewhere every day after `BACKUP_AT`, e.g. from a cron job on the host:

```bash
# Path of the volume on the host (one time): docker volume inspect -f '{{.Mountpoint}}' <project>_backups
rsync -a --delete /var/lib/docker/volumes/<project>_backups/_data/ backup-user@backup.example.org:/srv/yoda-backups/
```

or with `rclone sync` to the organisation's object storage. Keep the copy at least as long as
`BACKUP_KEEP_DAYS`, restrict who can read it (it holds every request, chat and file), and test a restore from
it now and then.

**Restore.** Restore into an empty database: `pg_restore --clean` replaces the objects in the backup but leaves
tables created by a newer release in place.

1. Stop everything that writes: `dc stop portal core backup` (and `runner` if you run it).
2. Recreate the database empty:
   `dc exec postgres sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'`.
3. If the backup is only on the off-host copy, copy its `pg-<stamp>.dump`, `storage-<stamp>/` and (for `latest`)
   the `latest` marker back into the `backups` volume.
4. Restore the database and the bucket:
   `dc run --rm -e RESTORE_CONFIRM=yes --entrypoint restore.sh backup <YYYYMMDD-HHMM|latest>`.
5. Bring the schema up to the running release and start again: `dc run --rm migrate`, then
   `dc up -d --no-build`.
6. Check `/api/ready` (section 11) and a few recent items in the portal.

`ops/backup/restore-check.sh` (dev only) runs the whole round trip against the dev stack and prints
`restore ok`.

## 7. GitLab integration

Owner checklist (details in the README, "GitLab integration"):

- [ ] A dedicated **bot user** on `gitlab.example.org` (e.g. `yoda-bot`) with **Developer** access to every
      repository linked in the portal (Maintainer only where protected branches require it).
- [ ] A **personal access token** of the bot with the `api` scope and an expiry date you will track (section
      10). Put it in `GITLAB_TOKEN`; set `GITLAB_URL=https://gitlab.example.org` and `PORTAL_URL`.
- [ ] A **webhook** on each linked project, or once on the group: URL
      `https://portal.example.org/api/gitlab/webhook`, secret token = `GITLAB_WEBHOOK_SECRET`, triggers
      **Merge request events**, **Pipeline events** and **Comments**, SSL verification on.
- [ ] System settings → GitLab shows core configured, GitLab reachable, the bot user, and the time of the last webhook.

GitLab does not retry failed deliveries and disables a webhook that keeps failing. After an outage, open the
webhook's **Recent events**, re-enable it if needed and **Resend** the failed deliveries; resending is harmless.
Core also re-reads the merge requests of active work items every 15 minutes.

## 8. Runners

Runners work the AI tasks that need a repository; see the README, "Runners", for the full guide.

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
affected. Credentials are read only from `.env`; they are never
logged, stored or returned by the API.

### 9.1 Email (SMTP)

- [ ] Ask the mail team for a relay account for `yoda@example.org` on `smtp.example.org` (port 587 with
      STARTTLS, or 465 with `SMTP_SECURE=true`), and that the relay accepts the deploy host.
- [ ] Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` and `MAIL_FROM`; deploy.
- [ ] Enable email in System settings → Notification channels and send a test (assign yourself a task).
- [ ] SPF/DKIM for the sender domain are the mail team's; without them messages land in spam.

### 9.2 LINE Official Account (Messaging API)

- [ ] Create a **LINE Official Account** for the department and, in the LINE Developers console, a
      **Messaging API channel** for it.
- [ ] Messaging API tab: issue a **channel access token (long-lived)** → `LINE_CHANNEL_ACCESS_TOKEN`. Basic
      settings tab: **Channel secret** → `LINE_CHANNEL_SECRET`. Deploy.
- [ ] Messaging API tab → Webhook settings: **Webhook URL** `https://portal.example.org/api/webhooks/line`,
      press **Verify** (expects 200), and turn **Use webhook** on.
- [ ] LINE Official Account Manager → Response settings: turn **auto-reply messages off** (and greeting
      messages off, or reword them), so people see Yoda's own linking replies only. Chat mode off.
- [ ] Copy the account's add-friend link (`https://line.me/R/ti/p/@<id>`) into
      `NUXT_PUBLIC_LINE_ADD_FRIEND_URL`.
- [ ] Enable LINE in System settings → Notification channels. A person links from Settings: add the account, then send
      the `LINK-XXXXXXXX` code shown in the portal (valid 15 minutes). Blocking the account unlinks them.

### 9.3 Telegram

- [ ] In Telegram, talk to **@BotFather**: `/newbot`, choose a name and a username ending in `bot`. The token it
      returns → `TELEGRAM_BOT_TOKEN`; the username (without `@`) → `TELEGRAM_BOT_USERNAME`.
- [ ] Generate `TELEGRAM_WEBHOOK_SECRET` (`openssl rand -hex 24`). Deploy.
- [ ] Register the webhook once, from `DEPLOY_PATH` on the deploy host. The snippet reads the two values out of
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

Change the value in `.env`, then apply it with `dc up -d --no-build` (`dc` as in section 4; compose recreates
the containers whose environment changed). Rotate on a schedule, when a person with access leaves, and at once
after a suspected leak.

| Secret | How |
| --- | --- |
| Postgres password | `dc exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`, then `\password yoda` (prompts, so the password stays out of history); update `POSTGRES_PASSWORD` and `DATABASE_URL` together and `dc up -d --no-build`. |
| Storage keys | RustFS takes its credentials from the same variables: change both keys and `dc up -d --no-build` (restarts `rustfs`, `core`, `backup`). |
| AI provider keys | Create the new key in the provider console, update `.env`, `dc up -d --no-build`, then delete the old key. |
| GitLab bot token | Create a new token (`api`), update `GITLAB_TOKEN`, `dc up -d --no-build`, revoke the old one. System settings → GitLab should show the bot. |
| GitLab webhook secret | Update `GITLAB_WEBHOOK_SECRET`, `dc up -d --no-build`, then the secret in every webhook right away; deliveries in between are refused (resend them). |
| SMTP password | Change it with the mail team, update `SMTP_PASSWORD`, `dc up -d --no-build`. |
| LINE token / secret | Issue a new long-lived token (or reissue the channel secret) in LINE Developers, update `.env`, `dc up -d --no-build`. |
| Telegram token | BotFather `/revoke`, update `TELEGRAM_BOT_TOKEN`, `dc up -d --no-build`, run `setWebhook` again (section 9.3). |
| Telegram webhook secret | Update `TELEGRAM_WEBHOOK_SECRET`, `dc up -d --no-build`, run `setWebhook` again. |
| Runner tokens | Revoke and re-create in the Runners page; update the runner's config or `YODA_RUNNER_TOKEN`. |
| Deploy SSH key | New key pair, add the public key to `authorized_keys`, update `DEPLOY_SSH_KEY`, remove the old public key. |
| Registry deploy token | Create a new `read_registry` token, `docker login registry.example.org` on the host, revoke the old one. |

**Rotate LINE and Telegram carefully.** While core still holds a revoked token (between revoking it and
`dc up -d --no-build`), deliveries fail with 401, which counts as a **permanent** failure: those messages are
not retried for that channel, although the portal feed has them. Put the new value in `.env` and restart first,
and revoke the old token afterwards (LINE keeps the old long-lived token valid until you revoke it; Telegram's `/revoke`
is immediate, so run `dc up -d --no-build` straight after it).

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
  - *image … is missing:* the host is not logged in to the registry, or the tag pipeline's build jobs did not
    finish.
  - *migrate failed:* `dc logs migrate`. Nothing was replaced; the previous release is still running. Fix and
    deploy again, or restore (section 6).
  - *not ready after 120s:* `/ready` names the failing dependency; then `dc logs core`.
- **Sign-in loops or 401s.** `OIDC_ISSUER` must equal the token's `iss` exactly, `azp` must be
  `OIDC_CLIENT_ID`, core must reach the signing keys (`OIDC_ISSUER` certs or `OIDC_JWKS_URL`), and the client
  must be public with PKCE (section 2).
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
- **Backups.** `dc ps backup` unhealthy or `dc logs backup` (section 6).
- **Disk full.** `docker system df`; old images: `docker image prune -a` (keeps the running ones); the
  `backups` volume (section 6).
