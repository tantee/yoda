# Installer & Settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure Yoda from the UI instead of env files:
- a settings store in the database, with secrets encrypted under a master key, an audit log and live apply;
- admin settings pages;
- a bootstrap `init` service;
- a token-protected first-run wizard at `/setup`, with a break-glass local admin for setup and recovery;
- a verified one-line installer and release bundle;
- hardening.

Existing env-based installs keep working unchanged.

**Spec:** `docs/design/installer-proposal.md`, approved with D1–D11 = option (a) each. Mockups are in `docs/design/mockups/installer-*.html` and `docs/design/screenshots/proposed/installer-*`. Phases 0–4 and 6 are in scope. Phase 5 (bundled Keycloak) is out of scope.

**Delivery:**

| PR | Branch | Contents |
|---|---|---|
| A | `feat/settings-ui`, off `feat/installer-proposal` (so it carries the proposal doc) | Tasks 1–5: phases 0–2 |
| B | `feat/setup-wizard`, stacked on A | Tasks 6–10: phases 3, 4, 6. Retarget to `main` once A merges. |

Each PR has before/after screenshots of new screens and a checkbox test plan.

## Owner decisions applied

| # | Decision |
|---|---|
| D1 | Internal registry and file server only for `install.sh`, the bundle and the images. Nothing is published publicly. |
| D2 | Bundled Keycloak is a later phase (not now). |
| D3 | Break-glass TOTP is required whenever the public URL is not localhost. |
| D4 | Env secrets are mirrored into the DB on boot by default, with `YODA_SETTINGS_IMPORT=false` to opt out. |
| D5 | One rail item "การตั้งค่าระบบ" absorbs the GitLab and channels pages. |
| D6 | Every portal admin may change settings, with re-authentication for secrets. |
| D7 | The recovery kit is one file (master key + break-glass codes). |
| D8 | Setup over plain HTTP on the LAN is allowed with a warning. |
| D9 | S3 is env/bootstrap only; the UI is read-only with a test. |
| D10 | The audit log is kept forever. |
| D11 | The wizard opens in Thai and can be switched. |

## Global Constraints
- The proposal is the spec. Section references below point to `docs/design/installer-proposal.md`.
- **Precedence** is env > DB > default. Env-set values show as locked ("set by environment" plus the variable name). Bootstrap-only settings are never editable in the UI (§8): DB connection, master key, ports and binds, `MIGRATE_ON_START`, image versions, S3 (D9), and the LINE/Telegram API base URLs.
- **Secrets** use AES-256-GCM envelope encryption with a key id and a key canary.
  - They are never returned by any API after saving: only `set`, the last 4 characters where safe, and the updated time.
  - They are never logged and never written to the audit log in plain text; the audit log stores hashes only.
- **Outbound tests** all go through `safeOutbound()`, per §8:
  - private hospital IPs are allowed;
  - cloud metadata, link-local, loopback and compose service names are blocked;
  - there is a timeout, no redirects, and a short result code.
- **Backward compatibility:** an existing deploy directory with a full `.env` and `release.env` upgrades with the same `deploy.sh`. Setup is marked done, values are imported, and nothing breaks. Tests prove it.
- **Requesters** never reach any settings or setup surface.
- **Repo rules** are as before:
  - single quotes and no semicolons;
  - th/en i18n parity, using the approved design tokens and components (`PageHeader`, `StatusChip`, `AppDialog` and so on);
  - `data-testid` on new controls;
  - no secrets, placeholders only (example.org);
  - never write the internal GitLab hostname or any part of its domain;
  - `pnpm vitest run` and `pnpm -r typecheck` must pass;
  - browser checks on the demo stack (see the ledger), stopping only the processes you started.
- **Lock order, runWork and jobs after commit** follow earlier plans. Migrations continue from 0021.

## Review Focus
1. **Lockout:** an OIDC misconfiguration must never lock everyone out. The break-glass `/recovery` route always works when the master key is present (Tasks 7 and 10).
2. **Secret exposure:** no secret appears in API responses, logs, the audit log, error messages, the portal bundle or `/public-config` (Tasks 2, 4, 7).
3. **Env-locked values:** the UI and API refuse to change a value that is set in env (Tasks 2, 4).
4. **Live apply mid-operation:** an email send or GitLab call in flight when its settings change completes or fails cleanly, and nothing uses half-updated config (Task 3).
5. **Wrong or missing master key:** core starts in a clear recovery state and does not serve secrets as garbage (Tasks 2, 10).

---

### Task 1: Spike (phase 0; §13.1)
Answer each spike question and write the findings to `docs/design/installer-spike.md`, with commands and evidence:
- RustFS credential files, or the shim needed;
- keycloak-js init after an async config fetch in Nuxt;
- `@node-rs/argon2` (or a pure alternative) building in the core image for arm64 and amd64;
- `LISTEN`/`NOTIFY` with the existing postgres.js client;
- an inventory of `deps.config` call sites.

Prototype only in scratch files; no production code. Commit `docs: installer spike findings`.

### Task 2: Settings store, crypto, import, audit (phase 1, part 1; §5.1, §6, §10)
- **Registry:** `packages/shared/src/settings/registry.ts` holds every row of the §9 inventory: key, zod schema, category, secret, `envName`, scope, `apply` (live/reconnect/restart), `uiEditable`, `test`.
- **Migration 0022:** tables `settings`, `settings_audit` and `setup_state`. Follow §10, minus the tables Task 7 owns.
- **Crypto:** `apps/core/src/settings/crypto.ts` does the envelope encryption with a key canary.
- **Store:** `SettingsStore` resolves env > DB > default, with typed getters. It imports env on boot (D4, opt-out `YODA_SETTINGS_IMPORT=false`) and writes audit rows.
- **Master key:** `YODA_MASTER_KEY` comes from env or a bootstrap file path. A missing or wrong key puts core into recovery state.
- **Upgrade:** an existing env-based install is marked `setup done`.
- **Sync test:** the registry must match the `config.ts` envSchema and the `docs/operations.md` table.
- **Tests:** encryption round trip, wrong key, canary, precedence, import, audit hashing, never decrypting into logs.
- Commit `feat(core): settings store with encrypted secrets and audit`.

### Task 3: Live apply (phase 1, part 2; §5.3)
- Swappable holders for the SMTP transport, the GitLab client, the LINE/Telegram channel clients, AI gateway models, keys and budgets, and JWKS/OIDC. Change `deps.config` consumers to read through the store and holders.
- `NOTIFY settings_changed` with a debounced reload. Handlers swap references, and in-flight operations keep the old instance.
- Restart-mode settings set a `restartRequired` flag.
- **Tests:**
  - changing SMTP host or GitLab token takes effect without restart;
  - an in-flight call completes with the old client;
  - the reconnect path works.
- Commit `feat(core): live apply of settings`.

### Task 4: Admin settings API (phase 1, part 3; §5.2, §11)
- **Endpoints:**
  - `GET /admin/settings` (categories with values, secrets masked, lock reasons);
  - `PUT /admin/settings/:category` (validate, refuse env-locked or non-UI values, audit);
  - `POST /admin/settings/:category/test` (through `safeOutbound`);
  - `GET /admin/settings/audit` (paged).
- **Recent auth for secret writes (D6):** the OIDC `auth_time` claim must be within 10 minutes. Otherwise return 401 `reauth_required`, and the portal re-logs in with `max_age`.
- **Address change:** changing a server address clears its stored secret (§8).
- **`safeOutbound()`:** in a shared module, with tests for metadata IPs, link-local, loopback and service names blocked, and private ranges allowed.
- Commit `feat(core): admin settings API with tests and audit`.

### Task 5: Admin settings UI (phase 2; §5.2, mockup `installer-admin-settings.html`)
- A `/admin/settings/<category>` page per category, under one rail item "การตั้งค่าระบบ" (D5). The existing GitLab and notification-channel pages fold in, with content kept.
- **Components:** `SecretField` (write-only), an env-lock chip, apply hints, test buttons with result states, an audit panel and change log, and a restart banner.
- Thai and English text.
- Browser check: before/after screenshots of each category page, desktop and mobile.
- Commit `feat(portal): admin system settings pages`.
- **Finish PR A:** whole-branch review, then a fix wave, then the PR (base `main`, with the proposal commit included), CI green, then report.

### Task 6: Bootstrap and public config (phase 3, part 1; §3, §5.6)
- **`init` service:** one-shot, in the core image or a tiny image. It generates the master key, Postgres password and RustFS keys into the `yoda-bootstrap` volume (0600), never overwrites, and lets env win. It refuses if a database exists with an unknown password.
- **Compose:** prod/dev compose changes per §13.3. `YODA_DEV_SKIP_SETUP=true` stays the default for dev.
- **`GET /public-config`** (public) returns the OIDC URL, realm, client, org name, fun mode and setup state.
- **Portal boot:** the portal fetches config before keycloak-js init, removing the `NUXT_PUBLIC_KEYCLOAK_*` requirement while still honouring it if set.
- **Tests:** init idempotency (bash or vitest), public-config contents (no secrets), portal boot with the async config.
- Commit `feat: bootstrap init service and public config`.

### Task 7: Setup mode, token, break-glass admin, recovery (phase 3, part 2; §4.1, §7, §8)
- **Setup mode** when setup is not done: only `/setup` APIs, `/public-config` and health are served.
- **Setup token:** single-use, 24 h, regenerated on restart until setup is done, printed in the log and written to a 0600 file. `yoda-admin setup-token` prints it.
- **Break-glass admin:**
  - argon2id password;
  - TOTP required unless the URL is localhost (D3);
  - recovery codes;
  - its own session cookie, SameSite=strict, short TTL;
  - a double-submit CSRF token;
  - IP rate limits;
  - every use audited and admins notified;
  - allowed only on `/setup` and `/recovery`.
- **`/recovery`** can fix OIDC settings and reset fun mode etc. OIDC issuer changes need a passing test sign-in and stay pending until then, with a 7-day rollback.
- **Tests:** token lifecycle, lockouts, CSRF, rate limits, recovery flow, and that the break-glass session cannot reach portal APIs.
- Commit `feat(core): setup mode, setup token, break-glass admin and recovery`.

### Task 8: Setup wizard UI (phase 3, part 3; §4.2–4.3, mockups)
- **Steps 0–10, as in §4.2:**
  - token;
  - language (Thai first, D11);
  - organisation and public URL (detected and confirmed);
  - the break-glass admin with TOTP enrolment;
  - OIDC with a test, which signs in through OIDC;
  - storage check (read-only, D9);
  - optional SMTP, LINE, Telegram (register webhook), GitLab, AI keys and budgets, backups;
  - the recovery kit download, one file (D7), required before finishing;
  - claim (the first OIDC admin);
  - lock.
- A plain-HTTP warning (D8).
- Browser check on a fresh demo install: screenshots of every step, desktop and mobile.
- Commit `feat(portal): first-run setup wizard`.

### Task 9: Installer and release bundle (phase 4; §3.4, §13.2–13.3)
- **`install.sh`:** pinned version; downloads the bundle from the internal file server (D1, placeholder URL `https://files.example.org/yoda/`); verifies `SHA256SUMS` and the signature (minisign or cosign; choose and document); runs `docker compose up -d`; prints the setup URL and token.
- **CI:** builds the release bundle with checksums and a signature step (key from CI variables).
- **Deploy:** `deploy.sh` changes. `.env.example` is split.
- **Runbook:** `docs/operations.md` rewritten per §13.2, with the env-sync test updated.
- **Tests:** shellcheck, `install.sh` verify and failure paths with a local fixture bundle, `deploy.sh` with no `.env`.
- Commit `feat(ops): installer and release bundle`.

### Task 10: Hardening (phase 6; §12, §13.1)
- `yoda-admin rotate-master-key`, with docs.
- **E2E tests** (vitest plus docker where feasible, otherwise scripted on the dev stack, documented):
  - fresh install to wizard to sign-in;
  - upgrade from an env install;
  - OIDC lockout then recovery;
  - wrong master key.
- A threat-model review pass, with findings fixed or recorded.
- Commit `feat: master key rotation and setup hardening`.
- **Finish PR B:** whole-branch review, then a fix wave, then the PR (base `feat/settings-ui`, retargeted to `main` after A merges), CI green, then report.
