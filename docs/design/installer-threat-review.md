# Installer and settings: threat model review

Review of the threat table in `docs/design/installer-proposal.md` §12 against the implementation on
`feat/setup-wizard` (Tasks 1–10, issue #17). Each threat gets a status:

- **mitigated:** the listed mitigations are in the code and covered by tests;
- **partial:** most of it is there and the gap is named;
- **open:** not addressed.

Evidence is given as `file:line` at the time of the review (Task 10). Paths are relative to the repository root.

## Summary

| # | Threat | Status |
| --- | --- | --- |
| T1 | Someone takes over `/setup` first | mitigated |
| T2 | Setup token leaks | mitigated |
| T3 | Brute force of the break-glass password | mitigated (residual as designed) |
| T4 | Break-glass used to read people's data | mitigated (admin grants added in Task 10) |
| T5 | DB dump or backup copy stolen | mitigated |
| T6 | Host compromise | out of scope (as designed) |
| T7 | Master key lost | mitigated (the reset path was missing; added in Task 10) |
| T8 | Stolen admin session exfiltrates a token | mitigated |
| T9 | SSRF through test buttons | mitigated (one note) |
| T10 | Lockout by a wrong OIDC change | mitigated (two fixes in Task 10) |
| T11 | CSRF on setup/recovery cookies | mitigated |
| T12 | Audit log tampering | partial |
| T13 | `install.sh` or bundle swapped | mitigated |
| T14 | Env and DB disagree | mitigated (boot log added in Task 10) |
| T15 | Secrets leak in logs or errors | mitigated |

## Per threat

### T1: someone on the network reaches `/setup` first — mitigated

- **Setup token required.** It is 100 bits, stored as a SHA-256 hash only and written to a `0600` file
  (`apps/core/src/local/setup-token.ts:74`). It is single use (`burnSetupToken`, `:112`) and expires after 24 h
  (`:15`).
- **Rate limits.** 5 tries per IP per 15 min, plus a global cap (`apps/core/src/routes/setup.ts:49`).
- **Ports.** Core and the portal publish on 127.0.0.1 by default (`docker-compose.prod.yml:74`, `:205`).
- **Setup mode.** Every non-setup route answers 503 until setup is done (`apps/core/src/auth/plugin.ts`, the
  `setupMode` gate).
- **Tests:** `apps/core/test/setup-recovery.test.ts` ("setup token" and "setup mode" blocks).

### T2: setup token leaks via a pasted log or CI output — mitigated

- **One copy, never in deploy output.** The token appears in the log banner and the `0600` file only.
  `deploy.sh` prints the command, never the token (pinned by `apps/core/test/ops-install.test.ts`).
- **Short-lived.** It is single use, expires, and is replaced on every start while setup is open
  (`apps/core/src/server.ts`, `issueSetupToken`).
- **Gone after setup.** The token and the file are deleted when setup completes
  (`apps/core/src/routes/setup-wizard.ts`, `/setup/complete`).

### T3: brute force of the break-glass password — mitigated

- **Hashing.** argon2id at m=64 MiB, t=3, p=1 (`apps/core/src/local/password.ts:8`).
- **Password rules.** The minimum length and rules are in `packages/shared/src/settings/local.ts:34`, and the
  wizard adds a zxcvbn meter.
- **Limits and lockout.**
  - 5 sign-ins per IP per 15 min (`apps/core/src/routes/recovery.ts:108`).
  - Per-account lockout with exponential backoff (`apps/core/src/local/break-glass.ts:27`); unknown usernames get
    the same answer and timing.
  - Step-up checks are limited, and 5 wrong codes end the session (`apps/core/src/routes/recovery.ts:91`).
- **TOTP.** It is required unless the public URL and the request host are both localhost, failing closed
  (`break-glass.ts:54`).
- **Notification.** Every use notifies every portal admin (`break-glass.ts:346`).
- **New in Task 10.** With a wrong or missing master key, TOTP cannot be checked, so the password alone opens a
  **status-only** session:
  - factor `password_keyless` (`break-glass.ts:274`);
  - restricted (`recovery.ts:103`);
  - only `GET /recovery/status`, the session calls and a temporary-password change answer; everything else is 403
    `secrets_unavailable`;
  - the session row carries `statusOnly` from its creation, so it stays status-only for its whole life: it never
    widens when the key starts working (restored key, restart, or a live `reset-master-key`); instead it is
    ended on its next use (401), and a full sign-in with the second factor is needed (`recovery.ts`, `signed`;
    tests: `e2e-install.test.ts` "wrong master key", `recovery-hardening.test.ts`).

  This is a deliberate weakening: without it, a wrong key locked the break-glass account out completely. It
  exposes no secret and no change, and the admins are told, with a distinct Thai notification text.
- **Residual (unchanged).** A localhost install without TOTP rests on the password alone.

### T4: break-glass account used to read people's data — mitigated

- **No portal session.** A break-glass session never opens a portal API (`apps/core/test/setup-recovery.test.ts:361`,
  and the e2e lockout test checks `/me` with the cookie).
- **Admin grants, new in Task 10.** `/recovery` can now grant and revoke portal admin (CARRY c):
  - routes at `apps/core/src/routes/recovery.ts:403`;
  - each one needs the current second factor;
  - each is audited (`recovery.admin_grant`, `recovery.admin_revoke`);
  - every admin is told, including the new one, and a revoke is announced before it takes effect.
- **Pre-grants.** Every grant also pre-grants the username through `oidc.bootstrapAdmins`, written with source
  `recovery` (`apps/core/src/settings/store.ts`, `setFromRecovery`), so the same username under a new identity
  provider (a new subject) becomes admin. A pre-grant is used up in the transaction that creates the admin
  person, audited as `system` (`recovery.pregrant_used`; `store.ts`, `consumePreGrant`;
  `apps/core/src/auth/plugin.ts`, `personOf`). It counts for the test sign-in of a pending change
  (`apps/core/src/local/oidc-change.ts:266`). Pending pre-grants are listed at `/recovery`; revoking the last
  admin needs a confirmation.
- **Banner.** Admin pages show a banner while a break-glass session is open:
  - `GET /admin/recovery-activity` (`recovery.ts:438`);
  - `apps/portal/app/components/settings/RecoveryBanner.vue`.
- **Residual (as designed).** Granting admin to an attacker's account. The notifications and the banner are the
  detection.

### T5: DB dump or off-host backup copy stolen — mitigated

- **Envelope encryption.** AES-256-GCM per secret, with the setting key as AAD (`apps/core/src/settings/crypto.ts:60`).
  The master key lives in the bootstrap volume, never in the database or `backups` (`docs/operations.md` §4a, §6).
- **Keyed hashes.**
  - Audit fingerprints are HMACs under a key derived from the master key (`crypto.ts:124`).
  - Recovery codes are HMACs as well (`apps/core/src/local/codes.ts:43`).
  - The setup token is stored as SHA-256 only.
- **Rotation.** A key copied together with a dump can now be retired: `yoda-admin rotate-master-key`
  (`apps/core/src/local/master-key.ts:65`).
- **Accepted.** The row version is not in the AAD, so a DB writer could put back an older ciphertext of the same
  key (`crypto.ts`, header comment).

### T6: host compromise — out of scope

The master key and the database are both on the host, as with today's `.env`. A KMS or HSM for the wrapping step
stays a later option. Rotation re-wraps the data keys only (`crypto.ts:216`), so that swap stays small.

### T7: master key lost — mitigated

- **The kit before completion.** Setup cannot complete without the recovery kit (`REQUIRED_FOR_COMPLETION`,
  `packages/shared/src/settings/local.ts:233`; `setup-wizard.ts:483`).
- **Recovery state.** A wrong key shows unavailable secrets and never garbage (`store.ts`, `decode` and `checkKey`).
- **Gap found and fixed in Task 10.** In the mismatch state the store refuses every secret write, so the admin
  could not "re-enter the secrets" as §3.5 promises: there was no way out without the old key.
  - `yoda-admin reset-master-key --yes` (`master-key.ts:193`) accepts the loaded key.
  - It drops, and lists, what the old key sealed: secrets, TOTP seeds and recovery codes.
  - It rewrites the canary and is audited.
  - Running cores leave recovery on the next reload, without a restart (`store.ts`, `load`).
  - A status-only `/recovery` session shows the state meanwhile (T3).
- **Restore after a backup.** `restore.sh` now names the key id the restored database needs
  (`ops/backup/restore.sh`, step 4).

### T8: a stolen admin session exfiltrates a token by moving its endpoint — mitigated

- **Credential-bound endpoints.** Moving an endpoint clears its bound secrets in the same transaction
  (`store.ts:457`).
- **Fake-API URLs.** They are bootstrap-only (`packages/shared/src/settings/registry.ts:175`, `:190`).
- **Write-only secrets.** No secret is ever returned.
- **Re-auth.** Secret and sign-in changes need a sign-in within the last 10 minutes
  (`apps/core/src/routes/admin-settings.ts:60`).
- **Sign-in values.** They are recovery-only in the UI (`admin-settings.ts:65`).
- **Residual (as designed).** A credential can still be replaced; that is audited and notified.

### T9: SSRF through test buttons — mitigated

- **safeOutbound.** `safeFetch` (`apps/core/src/settings/outbound.ts:241`):
  - blocks metadata, link-local, loopback and the compose names;
  - pins DNS (`:13`);
  - follows no redirects;
  - returns codes, not content.
- **Limits.** Tests are admin only and rate limited (`admin-settings.ts:276`; the wizard and /recovery have their
  own limits).
- **Note (not fixed).** The runtime JWKS fetch (`apps/core/src/auth/jwks.ts:22`, `createRemoteJWKSet`) does not
  go through `safeOutbound`. The issuer and JWKS URL reach it only through the wizard or a tested /recovery
  change, whose checks do use `safeFetch`, or through env or direct DB writes, which are trusted. Low risk;
  listed under follow-ups.

### T10: lockout by a wrong OIDC change — mitigated

- **The flow.**
  - Changes are staged, checked through `safeFetch`, and need a passing test sign-in as an admin.
  - A rollback window of 7 days follows.
  - `/recovery` works without OIDC.
  - Covered end to end by `apps/core/test/e2e-install.test.ts` ("OIDC lockout, then recovery").
- **Fixed in Task 10:**
  - **A failed apply lost the rollback snapshot** (CARRY e). The claim set `oidc_rollback` before the settings
    write, and a failure put back only the pending change. Now the previous rollback is read under the row lock
    and restored with it (`oidc-change.ts:313`). Test: `apps/core/test/recovery-hardening.test.ts`.
  - **Moving to another identity provider with other usernames** could not pass the `admin` check of the test
    sign-in. Pre-grants close it (T4); covered by the e2e test.
- **Residual (as designed).** A Keycloak outage still blocks normal users.

### T11: CSRF on the setup and recovery cookies — mitigated

- **Cookies.** `HttpOnly; SameSite=Strict`, scoped to the API path (`apps/core/src/local/session.ts:67`).
- **CSRF token.** A double-submit header (`session.ts:163`) and an Origin check (`session.ts:119`).
- **Portal API.** It uses bearer tokens.
- **Tests:** "needs the CSRF header on every non-GET call" in `setup-recovery.test.ts`.

### T12: tampering with the audit log — partial

- **Append-only.** A trigger refuses UPDATE and DELETE (`apps/core/drizzle/0022_settings.sql:71`), and the app
  never updates or deletes audit rows.
- **Gaps:**
  - **No export.** The audit log can be read in the UI and through `GET /admin/settings/audit`, page by page;
    the proposal's "export" (a download for off-host keeping) is not built.
  - **TRUNCATE.** The row trigger does not fire on `TRUNCATE`, and the app's database role owns the table, so it
    could also drop the trigger. This is the documented residual (a DB superuser or owner bypasses it), but it
    covers the app role too, not only a superuser. A `BEFORE TRUNCATE` statement trigger would close the first
    half. The test suite truncates the table between tests, so this needs a test-only bypass; listed under
    follow-ups.
  - **Fingerprints.** After a master key rotation, fingerprints from before and after cannot be compared (the
    HMAC key changed). This is documented in `docs/operations.md` §10 and printed by the command.

### T13: `install.sh` or the bundle swapped on the download server — mitigated

- **Pinned version.** `latest` is refused (`ops/install/install.sh:65`).
- **Signature and checksum.**
  - The minisign signature must carry a trusted comment that names the release (`install.sh:162`–`:166`).
  - The SHA-256 is then checked.
  - The tar is checked for unsafe entries.
  - Tests: `apps/core/test/ops-install.test.ts`, run in CI with minisign.
- **Residual.** Users who skip the documented download-and-verify steps.

### T14: env and DB disagree and nobody knows which applies — mitigated

- **In the UI.** A lock chip names the variable (`apps/portal/app/components/settings/EnvLockChip.vue`), each
  field shows its source, and the API refuses env-locked writes.
- **At boot, new in Task 10.** The log used to list only the keys imported in that boot. Now core logs every
  variable that sets a setting, names only (`store.ts:322`, `envLockedNames`; `apps/core/src/server.ts`).
- **Tests:** `apps/core/test/settings-store.test.ts`.

### T15: secrets leak in logs or errors — mitigated

- **Logs.** Pino redaction covers authorization, cookies, the CSRF header and the bodies (`apps/core/src/app.ts:87`).
- **Errors and tests.** Errors name key ids only (`crypto.ts`), and test results carry codes without details
  (`recovery.ts:288`).
- **The new commands.**
  - `yoda-admin` writes the master key only into the recovery kit on stdout (`rotate-master-key`,
    `recovery-kit`).
  - Their audit rows carry key ids and counts (asserted in `apps/core/test/master-key.test.ts`).
  - A refused rotation names setting keys, never values.

## Other findings (not in the table)

| # | Finding | Status |
| --- | --- | --- |
| F1 | `docs/operations.md` said "System settings → Security makes a new recovery kit"; no such screen exists. | Fixed: `yoda-admin recovery-kit`, docs corrected. A UI version is a follow-up. |
| F2 | `setup_state.recovery_mode` existed but nothing set or honoured it (§7.4 "forced"). | Fixed: `yoda-admin recovery on\|off`, the portal API answers 503 `recovery_mode` (`auth/plugin.ts:151`), the portal redirects to `/recovery` (`apps/portal/app/utils/publicConfig.ts`). |
| F3 | A wrong master key left a break-glass admin with TOTP unable to sign in at all (`unavailable`). | Fixed: status-only session (T3). |
| F4 | The recovery-kit re-issue in the wizard was not rate limited. | Fixed: the test limit (`setup-wizard.ts`). |
| F5 | §7.4 says recovery mode shows only `/recovery`. For a key mismatch the portal keeps working (non-secret features, unavailable secrets shown as such); only *forced* recovery redirects. | Decision recorded: hiding the whole portal on a key problem would stop the department's work for a settings issue. The owner may revisit it. |
| F6 | Pre-grants stayed in `oidc.bootstrapAdmins` after use. | Fixed in the review round: used up at the first sign-in, audited as `system`. |
| F8 | `rotate-master-key --finish` (or a new rotation) on a core running on `.prev` would delete the only working key. | Fixed: both refuse (`stale_key_file`); `.next` is created exclusively and never overwritten. |
| F7 | A rotation ends every setup and recovery session (their pending TOTP seeds are sealed with the old key). | By design, documented. |

## Follow-ups (open)

1. **An audit log export** (T12), and a `BEFORE TRUNCATE` guard with a test-only bypass.
2. **Recovery kit and rotation in the UI.** Admin → Security "new recovery kit" (break-glass re-auth) and a "new
   recovery kit needed" notice after a rotation (§3.5 step 4). Today both are CLI only.
3. **Settings editing from `/recovery`** beyond sign-in and admin grants (CARRY d): for example, SMTP to make
   notifications work during a lockout. Not built; owner to decide which keys.
4. **Runtime JWKS fetch through the outbound policy** (T9 note).
5. **Docker-based checks** of install, upgrade and rotation on a real stack (see the Task 10 report).
6. **An external review** of setup and recovery (§13.1 phase 6), not done in this task.
