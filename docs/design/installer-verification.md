# Installer: container and browser verification

The checks that PR #19 (installer PR B: bootstrap `init`, setup wizard, break-glass `/recovery`, installer,
rotation) deferred while Docker was down, run on 2026-11-27 against locally built images. Branch
`feat/setup-wizard`. Every value below (passwords, keys, tokens, TOTP seeds, kits) belonged to throwaway test
stacks that were deleted afterwards; screenshots mask the TOTP secret, the QR code and the recovery codes.

## Setup

- **Images.** `core`, `portal` and `backup` built from the branch and pushed to a throwaway local registry
  (`registry:2.8.3` on 127.0.0.1:15000) as `localhost:15000/yodatest/<name>:0.9.0-test`. For the upgrade test,
  the same three images built from `origin/main` (today's release) as `:0.8.0-old`.
- **Release bundle.** `ops/install/bundle.sh 0.9.0-test localhost:15000/yodatest`, signed with a minisign key
  generated in a temp dir (`minisign -G -W`, trusted comment `yoda release 0.9.0-test`), served by a local
  `python -m http.server`. `install.sh` was downloaded from that server, checked by hand as in the runbook
  (`minisign -Vm`, `shasum --check`), and run with `YODA_RELEASE_PUBKEY` (the script's own override; no patched
  copy needed) and `--base-url http://127.0.0.1:18765/`. Nothing from this was committed.
- **Stacks** (compose projects; host ports moved off the dev ones):
  - `yodatest`: fresh install through `install.sh`, empty `.env`; portal `127.0.0.1:13100`, core `:14100`.
  - `yodaproxy`: fresh install through `deploy.sh`, behind an nginx 1.27.5 TLS proxy (self-signed) on
    127.0.0.1:443 and :18443.
  - `yodaup`: an env-based install of `origin/main` (full `.env`), then upgraded with the new `deploy.sh`.
- **Sign-in.** The demo Keycloak `amberjack-keycloak-1` (realm `yoda`), reached by browser and containers as
  `http://keycloak.amberjack.orb.local:8080` (OrbStack DNS). The `yoda-portal` client got the test portal URLs
  as redirect URIs and web origins for the run (DEV ONLY), and was put back to its two original entries at the
  end.
- **Browser.** Headless Chrome for Testing 158 driven by Playwright (`playwright-core`, scratch install).
  `portal.yodatest.orb.local:3000` is the "LAN" address (plain http, not localhost: TOTP required, D8 warning).
  Screenshots: 1440×900 and 390×844, full page, Thai (the default locale).
- **Host.** The Mac went to sleep at 07:26 and OrbStack's VM with it, which stalled every Docker call for about
  40 minutes; it recovered on wake (`caffeinate` kept the host awake for the rest of the run). OrbStack was not
  restarted.

## Results

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| A1 | `compose config` with an empty `.env` | PASS | Without `YODA_IMAGE_PREFIX` / `YODA_VERSION`: refuses with "YODA_IMAGE_PREFIX is required". With both: resolves; postgres has only `POSTGRES_PASSWORD_FILE`, rustfs only `RUSTFS_*_KEY_FILE` (the `!reset null` entries are gone), no published Postgres/RustFS ports, keycloak/mailpit not in the config, `BACKUP_*` empty for core and backup. |
| A2 | `install.sh` from the signed bundle | PASS after fix 2 | Signature and checksum verified, bundle unpacked, empty `.env` 0600, `release.env` pins the prefix, the `docker login` warning (no tty), `deploy.sh` run. The first run failed: core crash-looped (fix 2). |
| A3 | Bootstrap volume owners and modes | PASS | `/var/lib/yoda` `0750 0:10500`; `postgres-password`, `s3-*`, `bootstrap.env` `0640 0:10500`, no trailing newline; `core/` `0700 1000:1000`; `core/master-key` and `core/setup-token` `0600 1000:1000`. `bootstrap.env` holds `DATABASE_URL` and the S3 keys, not the master key. |
| A4 | Postgres initdb via `_FILE`, RustFS `*_FILE`, readers of `bootstrap.env` | PASS | `migrate` applied the migrations with the derived `DATABASE_URL`; core `/ready` `{"db":"ok","storage":"ok","queue":"ok"}`; backup logged its schedule after reading the database ("next backup at … 02:00, keeping 14 days") and `backup --now` dumped the database and mirrored the bucket. No group-readable warning for the key. |
| A5 | argon2 native module in `node:22-alpine` | PASS | `@node-rs/argon2` hashes in the core image (`$argon2id$v=19$m=65536,t=3,p=1`). |
| A6 | `yoda-admin` in the image | PASS | `/usr/local/bin/yoda-admin` runs as `node` (groups 1000, 10500); `status` and `setup-token` work. |
| A7 | Setup mode | PASS | `/api/me` 503 `setup_required`; `/api/public-config` `setup: "required"`, `oidc: null`, `no-cache` + ETag; the "Yoda setup" banner once per start in `logs core`; `deploy.sh` ends with the wizard address and the token command (never the token). |
| A8 | Portal redirects to `/setup` | PASS | `/` → `/setup` in the browser. |
| B1 | Token step | PASS | A wrong token gives the "invalid, expired or used" wording; a lowercase paste into the first box fills all five; the setup cookie is `HttpOnly`, `SameSite=Strict`, path `/api/setup` (not `Secure` on http, `Secure` behind TLS, F2). |
| B2 | Organisation (D8) | PASS | Detected URL `http://portal.yodatest.orb.local:3000` with the match chip, the plain-http warning and the session warning. |
| B3 | Break-glass admin with TOTP | PASS | TOTP required (not localhost); zxcvbn meter "very good"; code from `otpauth` accepted; account created with TOTP on. |
| B4 | System check | PASS | Database, pgvector, bucket and queue pass. |
| B5 | Sign-in step | PASS | A non-Keycloak issuer is refused on save; a missing realm saves and the test fails (discovery HTTP 404); the real realm passes (discovery, JWKS, client and redirect). |
| B6 | Optional steps | PASS | Email against a throwaway Mailpit (`yodatest-mailpit`): the test connects (`auth: false`); LINE, Telegram and "more" skipped. |
| B7 | Recovery kit | PASS | One download, `yoda-recovery-kit-<install id>.txt`; its master key equals `core/master-key`, it carries the Postgres password; after a reload the step offers a re-issue, which downloads a new kit and replaces the codes. A code from the re-issued kit signed in at `/recovery` (C2). |
| B8 | Claim | PASS after fix 3 | `nurse1` (no group) failed with "add the groups mapper" (fix 3); now "not staff: no groups" and no person created. `dev1` claims and becomes admin. Progress survived a core restart (redeploy) mid-wizard. |
| B9 | Complete | PASS after fix 4 | Setup done (`/api/public-config` `setup: "done"`), the token file is gone, `/api/setup/*` answers 404, `/setup` sends you to the portal, `dev1` is admin. On the plain-http LAN address the portal stayed blank (no Web Crypto for keycloak-js PKCE), fix 4; on `http://localhost:13100` and behind TLS the portal opens signed in as admin. |
| C1 | `/recovery` sign-in | PASS | Wrong password gives the generic wording; password + TOTP opens the full session; a recovery code works (9 left). |
| C2 | Admin banner and alerts | PASS | Every admin page shows the break-glass banner while a session is open; each use, change, grant and the CLI on/off is a `security_alert` notification and a `settings_audit` row. |
| C3 | OIDC lockout and fix | PASS | Wrong issuer set in the database plus `pg_notify('settings_changed')`: the portal goes to a Keycloak "realm not found". At `/recovery`: stage the right issuer (Apply disabled), check (pass), test sign-in as `dev1` (pass), Apply; the portal signs in again. |
| C4 | Rollback | PASS | Rollback restores the broken issuer (shown with its 7-day window); staged, tested and applied the right one again. |
| C5 | Grant admin | PASS | `somchai` granted (pre-grant, "admin at first sign-in"), step-up TOTP. |
| C6 | `recovery on` / `off` | PASS | `on`: `/api/public-config` `recoveryForced: true`, `/api/me` 503 `recovery_mode`, the portal sends every page to `/recovery`; `off` restores it. |
| C7 | Wrong master key | PASS (see note) | A different `YODA_MASTER_KEY` in `.env` alone does not reach mismatch: `init` keeps the right key as `.prev` and core uses it with a warning (the designed stale-`.env` rescue). With `.prev` moved aside: `/health` `secrets: mismatch`, `/recovery` gives the status-only card (no OIDC or admin cards). With the kit's key back in `.env`, `dc up -d` **and `dc restart core`**, the status-only session ends. `yoda-admin rotate-master-key --finish` crashed with a TypeError in the stale state (fix 5). |
| C8 | `reset-break-glass` restricted flow | PASS after fix 6 | `/recovery` showed no QR code or secret, so TOTP could not be enrolled (fix 6). Now: temporary password, new password, TOTP enrolment, 10 codes shown once. |
| D1 | Upgrade of an env-based install | PASS | `origin/main` installed from a full `.env` (note: it needs `OPENAI_BASE_URL` set, fix 2 applies to it too), `somchai` signed in. New `deploy.sh`: `init` copies the Postgres password and S3 keys from `.env` and generates the master key; core logs "imported from env" (issuer, client, staff group, bootstrap admins, OpenAI base URL, public URL, SMTP, org line, backup time) and "existing install: setup marked done"; no Keycloak mismatch warning; the person survived; `deploy.sh` prints no setup hint. |
| D2 | Env locks in System settings | PASS | Sign-in, General and Backups show "Set by environment · <VAR>" with the how-to-unlock hint; the backup container reads `BACKUP_AT=03:30`. |
| D3 | `create-break-glass`, `/recovery`, `recovery-kit` | PASS | `recovery-kit` before an account refuses with the hint; `create-break-glass` prints a temporary password once; `/recovery` forces a new password; TOTP enrolled from the account card (optional on a localhost URL, D3); new codes; `recovery-kit` writes the kit (mode 0600 with the documented `umask`). |
| E1 | `rotate-master-key` | PASS | `--dry-run` (0 secrets, 1 TOTP seed, nothing changed); rotate: kit on stdout matches the new key file, `.prev` kept, both `0600 1000`, core logs "switched to the new key" without a restart, `dc restart core` still opens the secrets, TOTP sign-in still works, `--finish` deletes `.prev`. |
| E2 | Lost bootstrap volume | PASS | Volume deleted, `pgdata` kept: `dc run --rm init` exits 1 with the kit/section 4a message. The §4a `postgres --single` procedure, run verbatim, resets the password; `dc up -d` comes up with database and storage OK and secrets in mismatch (new key), as documented; the kit's key in `.env` plus `dc restart core` brings the secrets back. |
| F1 | Hops 1: spoofed `X-Forwarded-Host` | PASS | A browser fetch with `X-Forwarded-Host: evil.example` and a session passes the Origin check (the portal used its own Host); the spoof would otherwise be `csrf_failed`. |
| F2 | nginx TLS + hops 2 | PASS | Detected URL `https://localhost`, https, no insecure warnings, setup cookie `Secure`; the whole wizard and the claim worked; audit `ip` is the client's address, not nginx's. |
| F3 | nginx TLS + hops 1 | PASS | Recovery cookie `yoda_bg` is `Secure`; core logs the one-time "proxy in front of the portal while YODA_TRUSTED_PROXY_HOPS=1" warning. |
| F4 | nginx `$host` on a non-443 port | Doc fix | Through `https://localhost:18443` the detected URL loses the port and session calls fail `csrf_failed`. The runbook now says to use `$http_host` on a non-default port. |

## Bugs fixed

1. `a2f1e56` **Portal image build failed.** unplugin-vue-i18n refuses `https://<host>/realms/<realm>` in
   `recovery.error.notKeycloak` as HTML. Example URL instead; a test rejects HTML-like messages.
2. `a164b13` **Core crash-looped on a fresh install.** The prod compose passes `OPENAI_BASE_URL` empty and
   `@ai-sdk/openai` throws on import for an empty base URL. `env-preload.ts` drops empty AI base URLs and is the
   first import of every bundled entry (esbuild banner). The same crash happens with today's `main` images when
   `.env` lacks `OPENAI_BASE_URL`.
3. `46e3fab` **Claim by a person in no group** reported "add the groups mapper". Keycloak omits the claim for
   such a person; with a staff check it is now `not_staff_no_groups`, naming both causes.
4. `e990fad` **Blank portal on a plain-http LAN address** after setup (keycloak-js needs Web Crypto). The portal
   shows an "HTTPS needed" boot screen; the organisation step's http warning says sign-in will not work there.
5. `fb3fae7` **Every `yoda-admin` refusal crashed** (the entry block's top-level await ran before the refusal
   texts existed). The entry is last in the file (test). On a stale key file, `status` and the boot log no longer
   advise `--finish`.
6. `a8203d5` **`/recovery` showed no TOTP QR code, secret or new codes** (`TotpEnrol` / `CodesOnce` not
   imported; Nuxt registers them with a `Recovery` prefix). A test checks every PascalCase tag in the app
   resolves. Runbook: restart core (and backup) after a key or Postgres password change in `.env`, `--finish`
   after a wrong-key fix, nginx `$host` and ports.

## Tests after the fixes

- Full `vitest run` (core with the local Postgres, portal, shared, runner): 126 files, 1772 passed, 7 skipped.
- `pnpm -r typecheck`: exit 0 (the known vue-tsc `ERR_PACKAGE_PATH_NOT_EXPORTED` warning).

## Cleanup

The `yodatest`, `yodaproxy` and `yodaup` projects (containers, networks, volumes), the throwaway registry,
Mailpit and nginx containers, and every image built or pulled for the run were removed. The `yoda-portal`
client of the demo realm is back to its two redirect URIs and web origins, and `amberjack-keycloak-1` is stopped
again, as it was before the run. `yoda_demo`, the `yoda-demo` bucket and `dev1` were not touched.

## Remaining gaps and notes

- **D8 decision.** A plain-http LAN install could finish the wizard but nobody could sign in to the portal there
  afterwards (browser rule). Resolved by the owner (2026-11-27): setup now refuses an http public URL unless the
  host is localhost, `*.localhost`, 127.0.0.0/8 or `::1` (`https_required`; installer proposal §8.2, D8). Rows B2
  and the `portal.yodatest.orb.local:3000` run above predate that rule.
- **Small things seen, not changed:** the wizard shows core's English validation text for a non-Keycloak issuer
  inside the Thai UI; the check step lists "database password: not set" although it is in the bootstrap volume
  (it is part of `DATABASE_URL`); `deploy.sh`'s setup hint reads `PORTAL_PORT` from `.env` only; CLI security
  alerts read "break-glass cli: …"; the key file written by a rotation ends with a newline (init's does not;
  both are read fine).
- **Not run:** the §4a "with the kit" path (section 3 values in `.env`; the `postgres --single` path was run); a
  second kit download refused through the API (the UI only offers the re-issue); the token change on a core
  restart (one banner per start was seen); LINE/Telegram webhook registration against the fake channels; th/en
  screenshot pairs (Thai only); a backup restore and its key id line; the Postgres password rotation (the new
  restart step is from how core reads `bootstrap.env`, not from a run); a real registry `docker login` prompt and
  the GitLab tag pipeline (`release-bundle`); a real authenticator app scanning the QR code.
- `setup-organisation` was taken before fix 4, so it shows the earlier http warning text.

## Screenshots

All in `docs/design/screenshots/after/`, `<name>-desktop.png` (1440) and `<name>-mobile.png` (390) unless noted.

| Area | Names |
| --- | --- |
| Wizard | `setup-token`, `setup-token-wrong`, `setup-organisation`, `setup-organisation-https`, `setup-admin`, `setup-admin-done`, `setup-check`, `setup-signin-fail`, `setup-signin`, `setup-email`, `setup-line`, `setup-telegram`, `setup-more`, `setup-kit`, `setup-kit-downloaded`, `setup-kit-gone`, `setup-kit-reissued`, `setup-claim`, `setup-claim-not-staff`, `setup-claimed`, `setup-finished-portal`, `setup-after-admin-settings` |
| Portal | `portal-http-lan-insecure`, `proxy-https-portal-after-setup` (desktop) |
| Recovery | `recovery-signin`, `recovery-signin-wrong`, `recovery-signin-code` (desktop), `recovery-status`, `recovery-lockout-portal` (desktop), `recovery-oidc-broken`, `recovery-oidc-staged`, `recovery-oidc-tested`, `recovery-oidc-applied`, `recovery-oidc-rolled-back`, `recovery-admins`, `recovery-banner-admin`, `recovery-forced-mode`, `recovery-status-only`, `recovery-restricted-new-password`, `recovery-restricted-totp`, `recovery-restricted-codes`, `recovery-totp-enrol`, `recovery-codes-once` |
| Upgrade | `upgrade-before-old-release` (desktop), `upgrade-settings-signin`, `upgrade-settings-general` (desktop), `upgrade-settings-backups` (desktop) |

## Built-in HTTPS proxy run (2026-11-27)

Branch `feat/builtin-https-proxy`, compose project `yodaproxy`, images `core`, `portal` and `backup` built from the
branch into a throwaway local registry (127.0.0.1:15001), a bundle signed with a throwaway minisign key and served
locally. Everything was removed afterwards.

- **Install.** `install.sh --version 0.9.1-proxy --with-proxy --domain portal.example.org --http-port 18080
  --https-port 18443` (with `PORTAL_PORT` / `CORE_PORT` moved off the dev ports in a pre-existing `.env`, and
  `YODA_PROXY_BIND=127.0.0.1` in the shell). `.env` got the profile, domain and mode; `release.env`
  `YODA_PROXY_ENABLED=true`; core and portal ran with `YODA_TRUSTED_PROXY_HOPS=2`; `caddy validate` ran before
  init; `proxy/root.crt` (Caddy Local Authority - 2026 ECC Root, valid 10 years) was exported and the deploy
  printed `https://portal.example.org:18443/setup`.
- **Proxy.** `http://…:18080/setup?x=1` → 308 `https://portal.example.org:18443/setup?x=1`; curl with
  `--cacert proxy/root.crt` verified (HTTP/2); `/api/ready` and `/api/ready/x` 404 from outside, `/health` 200; a
  client `X-Forwarded-For` is replaced; `X-Forwarded-Host` keeps the port.
- **Browser.** Headless Chrome 158 over CDP, driven through the Playwright MCP, with
  `--host-resolver-rules` (portal.example.org and sso.example.org → 127.0.0.1) and
  `--ignore-certificate-errors-spki-list` holding only the exported root's and the intermediate's SPKI hashes (the
  stand-in for installing the root; no blanket `--ignore-certificate-errors`). The wizard detected
  `https://portal.example.org:18443` (match chip), the admin got TOTP, the system check showed the proxy card (on,
  internal CA, hops 2, issuer, expiry, fingerprint), the sign-in test and the claim against a throwaway Keycloak
  passed, setup completed and the portal opened signed in as admin over https. The throwaway Keycloak ran on plain
  http (`http://sso.example.org:18180`, reachable by core under a network alias), so for the final portal sign-in
  only, Chrome also had `--allow-running-insecure-content` (keycloak-js token call from the https page); a real
  install has Keycloak on https. Audit rows carry the client address (the docker gateway), not the proxy's.
- **Operations.** Redeploy kept the same root (fingerprint unchanged); `caddy reload --force`, `caddy validate`
  and the runbook's `proxy-data` tar backup worked (the tar holds `root.key`: hence "off the host"); a bad
  `YODA_PROXY_CERT_MODE` stopped the deploy with exit 2 and Caddy's error before anything was replaced;
  `PORTAL_BIND=0.0.0.0` was refused; switching to files mode with an organisation-style certificate served that
  certificate.
- **Bug found and fixed in the run:** Caddy's automatic redirect dropped a non-443 port (the port inside the
  container is the host's, so Caddy took it as the default); an explicit `http://` site now redirects to
  `https://{host}:<https port>{uri}`.
- **Screenshots** (`docs/design/screenshots/after/`): `proxy-setup-organisation-desktop`,
  `proxy-setup-check-desktop`, `proxy-setup-check-mobile`, `proxy-setup-check-en-desktop`,
  `proxy-setup-card-en-desktop`, `proxy-setup-claimed-desktop`, `proxy-https-portal-desktop`,
  `proxy-https-portal-mobile`; `docs/images/setup-proxy.webp` for the guide and runbook.
