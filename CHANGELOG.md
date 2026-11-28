# Changelog

Releases follow [semantic versioning](https://semver.org); each is a git tag `v<version>` (`v1.1.0`), published
as a GitHub Release, and the version without the `v` is the image tag a host runs. Upgrade steps:
[docs/operations.md](docs/operations.md#5-upgrade-and-rollback).

## Unreleased

- **Yoda Reporter, server side** (the extension itself follows): staff connect the browser extension through
  an approve page (PKCE, rotating refresh tokens; a reused one ends the connection) and see or revoke their
  connected browsers; admins see everyone's and can revoke all. `POST /extension/defects` files a defect report
  (screenshot, video, logs; idempotent, up to 50 MiB) as a work item on the new human-only `defect` template,
  or on `bug-fix`. Defect media and logs are always "do not send to AI", and a report marked as possibly
  holding patient data keeps its text and title from every AI path. Projects get **App URLs**; GitLab
  environments (deployment webhook events and a nightly sync) map pages to projects and mark production sites,
  where video is refused. Defect files can be removed with a reason and are purged 180 days (media) or 90 days
  (logs) after the item closes. The work item page shows a defect card; a new **Help** page offers the
  extension. The built-in proxy allows 56 MiB on `/api/extension/defects` only (section 7a of the runbook has
  the setting for your own proxy).
- **Yoda Reporter extension** (Chrome and Edge): connect once from its options page, arm capture on the page
  under test, then take a screenshot (visible area or full page) or report without one. The editor draws arrows,
  boxes, highlights, text and step numbers, and hides data with blur, a mosaic (rectangle or brush) or a black
  box, all burned into the uploaded image. Reports carry the page, browser and build details, the console and
  failed requests, and pass a check-before-sending step. The zip ships in the core image and the Help page
  offers it; a release tag is now `v<x.y.z>` or `v<x.y.z>-rc.<N>` only.

## 1.2.0 — 2026-11-28

A one-line installer, which checks and installs its own dependencies and handles sudo and the docker group.

### One-line install

- `curl -fsSL https://github.com/tantee/yoda/releases/latest/download/install.sh | sh` installs the latest
  release into `/srv/yoda`; `… | sh -s -- --version 1.2.0 --dir /srv/yoda --with-proxy --domain …` takes the usual
  options. Piping trusts GitHub's TLS for `install.sh` itself; everything it downloads is signature-checked. The
  long form (download `install.sh`, `SHA256SUMS` and the signature, check them, then run it) still works, and
  `install.sh` then uses the `SHA256SUMS` next to it and checks its own checksum against it.
- Without `--version`, the published `install.sh` installs its own release (`RELEASE_VERSION`, set when the bundle
  is built), so the one-liner of release N never installs N+1. Only the repository's copy, or `--version latest`,
  looks up the latest release, from the `releases/latest` redirect (then the GitHub API; no `jq`); a mirror
  (`--base-url`) has no "latest", so that lookup needs `--version`. An existing Docker apt source or
  `docker-ce.repo` is used as it is, and a failed Docker setup removes only the files the run added.
- When piped, it downloads `SHA256SUMS` and `SHA256SUMS.minisig` for the release, checks the signature with the
  key built into the script, checks that the trusted comment is exactly `yoda release <version>`, then the
  bundle's checksum, and only then unpacks anything. Any verification error stops it.
- The whole script is functions, called from its last line: a download cut short runs nothing at all.

### Dependencies, sudo and the docker group

- `install.sh` checks its dependencies first (curl, tar, sha256sum or shasum, minisign, Docker Engine 24+,
  Docker Compose v2.24+, and openssl for `--cert-mode files`) and names each one that is missing or too old, with
  the version found and the version needed.
- On Debian and Ubuntu it offers to install them: minisign with apt (enabling universe on Ubuntu when needed), and
  Docker from Docker's own apt repository (its key in `/etc/apt/keyrings`; `docker-ce`, `docker-ce-cli`,
  `containerd.io`, `docker-buildx-plugin`, `docker-compose-plugin`). The RHEL family gets the same with dnf
  (minisign from EPEL). Ubuntu's or Debian's own `docker.io` / `docker-compose-v2` that is too old is explained,
  never replaced. Any other system gets the manual steps, and `install.sh` exits non-zero.
- Questions are read from the terminal (`/dev/tty`), so they work when piped. `--yes` answers yes; with no
  terminal and no `--yes`, `install.sh` stops and names the flag instead of assuming yes. Package installs use
  sudo when not root, and it stops clearly when sudo is missing.
- A user who may not run docker is added to the docker group (when asked). The rest of the same run uses the group
  through `sg docker`; new logins get it after logging out and back in.
- When `--dir` (default `/srv/yoda`) cannot be created, it offers to create it with sudo and give it to the user.
- The low-disk warning names the free space and the path it checked.
- The release workflow's dry run (`ops/install/check-release.sh`) also runs the piped install against its local
  server, resolving the latest release from a `releases/latest` redirect.

## 1.1.0 — 2026-11-28

The first public release: an AI work portal for the IT department, in Thai (default) and English. Version 1.0.0
was tagged but never published (its release runs failed before any image was tagged or any release created); its notes
are part of this release.

### Releases on GitHub

- Releases are published on GitHub (owner decision D1, 2026-11-27): a `v<version>` tag on `main` runs
  `.github/workflows/release.yml`, which pushes the images to `ghcr.io/tantee/yoda/<name>` by digest (linux/amd64
  and linux/arm64), writes those digests into the release bundle, signs it with minisign in the `release`
  environment, and only then tags the images `<version>` and `sha-<short>` and attaches the bundle to the GitHub
  Release with the changelog section as notes. Each architecture is built on its own native runner (no emulation)
  and the two are merged into one multi-platform index per image, pushed by digest. Pull requests and manual runs
  are always dry runs (both architectures, nothing pushed, no packages permission, a throwaway key, an end-to-end
  `install.sh` check). Actions, BuildKit and the Dockerfiles' base images are pinned by digest. See `docs/releasing.md`.
- Hosts run exactly the signed images: `deploy.sh` pins the bundle's image digests in `release.env`
  (`YODA_<NAME>_DIGEST`), and the prod compose runs `<prefix>/<name>:<version>@<digest>`.
- `deploy.sh` uses the public `ghcr.io/tantee/yoda` images when no image prefix is set anywhere (never Docker
  Hub), and exits 3 when it cannot pull; `install.sh` then offers `docker login ghcr.io` on a terminal.
- The verification snippets in the docs fail closed: each step runs only when the one before it passed, and they
  check that the signature's trusted comment names the release.
- `install.sh` downloads from `https://github.com/tantee/yoda/releases/download/v<version>/` and uses the public
  `ghcr.io/tantee/yoda` images by default, without `docker login`. `--base-url` now names the release's own
  directory (`{version}` in it becomes the version), for an internal mirror together with `--image-prefix`.
- Release tags carry a `v` (`v1.0.0`); the version a host runs stays `1.0.0`. The GitLab pipeline remains as an
  internal mirror and maps a `v` tag to the version.

### Built-in HTTPS proxy (optional)

- An optional `proxy` service (Caddy 2.11.4, pinned by version and digest) under the compose profile `proxy`,
  for hosts without a reverse proxy of their own. Off by default: the external reverse proxy stays the default.
  It publishes 80 and 443, redirects http to https, forwards to the portal with the browser's `Host` and the
  `X-Forwarded-*` headers, and keeps `/api/ready` inside the host ([runbook 4b](docs/operations.md#4b-built-in-https-proxy-optional)).
- Three certificate modes: `internal` (Caddy's own CA; `deploy.sh` copies its public root to `proxy/root.crt`
  for the staff PCs, with instructions for Windows, macOS, Linux and Firefox), `files` (the organisation's
  certificate and key; preferred where the organisation has a CA) and `acme` (Let's Encrypt only, for a host
  reachable from the internet on 80 and 443). The internal CA is named `Yoda <domain> internal CA`; its root has no
  name constraints, so `proxy-data` is kept as one encrypted offline copy with the recovery kit (runbook 4b).
- `install.sh --with-proxy --domain <name> [--cert-mode internal|files|acme] [--cert F --key F]
  [--acme-email A [--acme-staging]] [--http-port N --https-port N]` writes the choice into the new `.env`. It
  refuses a release before this one, acme on other ports than 80 and 443, and (with `openssl`) a certificate that
  does not name the domain, does not match the key or has expired.
- `deploy.sh` pins `YODA_PROXY_ENABLED` in `release.env` on every deploy (`true` with the profile on, empty
  otherwise; compose gives core and the portal `YODA_TRUSTED_PROXY_HOPS=2` only for `true`, unless `.env` sets
  it) and refuses another value in `.env`. With the profile on it refuses a portal or core published beyond
  loopback and settings the proxy cannot run with, runs `caddy validate` before `release.env` or any container is
  replaced, reloads the proxy after the start (it reads the Caddyfile from the mounted `ops/proxy` directory, so a
  new bundle's Caddyfile, a changed `proxy/sites` file or certificate applies), and
  warns about an organisation certificate that expires within 30 days. `COMPOSE_PROFILES=proxy` with compose files
  that have no proxy service stops the deploy.
- The proxy container runs without capabilities but binding 80/443 and reading the key (`NET_BIND_SERVICE`,
  `DAC_OVERRIDE`; not `DAC_READ_SEARCH`), with `no-new-privileges` and a read-only root; request bodies are capped
  at 32 MiB and slow request headers time out after 30 s (no body or write timeout: server-sent events stay open).
  ACME uses Let's Encrypt's directory from compose unless `YODA_PROXY_ACME_CA` names another. No HSTS header.
- The setup wizard's system check shows a read-only card: proxy on or off, address, certificate mode, trusted hops
  and the presented certificate's issuer, names, expiry and fingerprint (core reads it with a TLS handshake, never
  the proxy's files).
- The release bundle carries `ops/proxy/Caddyfile`; `check-release.sh` checks the Caddy image is digest-pinned and
  that the Caddyfile validates in it for every mode, with the environment compose gives the proxy. The GitLab deploy job copies the Caddyfile too.
- **Upgrade notes:** nothing changes unless you turn the profile on (`release.env` gains an empty
  `YODA_PROXY_ENABLED=`; delete any `YODA_PROXY_ENABLED` line from `.env`). The new `proxy-data` volume holds the
  certificates and the internal CA's keys: keep one encrypted copy off the host (runbook 4b). Rolling back below
  this release with the proxy on takes the portal off HTTPS (runbook 5, rollback).

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

- **Setup refuses a plain-HTTP public URL (D8, owner decision 2026-11-27).** The organisation step, its save
  (`PUT /setup/settings/general`) and System settings → General refuse `org.publicUrl` on `http://` unless the
  host is localhost, `*.localhost`, 127.0.0.0/8 or `::1` (422 `invalid_settings`, message `https_required`);
  `/setup/complete` checks the URL in effect again, so an http LAN URL saved earlier or set in `PORTAL_URL`
  cannot finish setup. The wizard shows the SSH-tunnel command and how to put HTTPS in front
  (`YODA_TRUSTED_PROXY_HOPS=2`, runbook section 1). Replaces "allowed with a warning": nobody could sign in there.
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

- **`YODA_IMAGE_PREFIX`** is pinned in `release.env` by `install.sh` and `deploy.sh` (an older install keeps it
  in `.env`); with none anywhere `deploy.sh` uses `ghcr.io/tantee/yoda`, never Docker Hub.
- **`YODA_TRUSTED_PROXY_HOPS`**: set `2` when a reverse proxy is in front of the portal (and pass `Host` and the
  `X-Forwarded-*` headers), so client addresses and the detected public URL are right.
- **An env-based install upgrades unchanged**: values are imported, setup is marked done, the env values stay
  locked until removed from `.env`. Then create the break-glass account and the recovery kit
  (`yoda-admin create-break-glass`, then `yoda-admin recovery-kit`).
- The prod compose passes every UI-editable setting with an empty default, so only a variable in `.env` locks a
  setting; it no longer sets `BACKUP_AT` / `BACKUP_KEEP_DAYS` defaults.

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
