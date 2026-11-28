# Yoda Reporter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Yoda Reporter, a Chrome and Edge (MV3) extension that captures a UI defect (metadata, build, screenshot or short video, console and failed requests, annotations, a structured form) and files it as a `defect` work item in the right Yoda project, together with everything Yoda needs to accept it: extension grants and tokens, the approve page, Connected browsers, the `/extension/*` API, project application URLs and GitLab environments for URL mapping, retention, and managed distribution.

**Architecture:** Core gets an `extension/` module: its own token family (`yoda_xc_` codes, `yoda_xt_` access, `yoda_xr_` rotating refresh) on grant rows, accepted only by `/extension/*` routes through their own hook. One multipart, idempotent `POST /extension/defects` stores the files and creates the work item, its `defect_reports` row and the attachment rows in one transaction. The extension (`apps/extension`, Vite + Vue 3 + Vuetify with the portal's tokens and th/en strings) has a stateless service worker, an ISOLATED metadata script and a MAIN-world capture script injected on click, an offscreen recorder, and an editor tab (Konva) whose blur, mosaic and redact are burned into the exported image. Contracts are zod schemas in `@yoda/shared`, so core, the portal, the extension and the e2e stub validate the same shapes.

**Tech Stack:** As the repo (Fastify 5, drizzle, Postgres, Nuxt 4, Vuetify 3, Vitest 3), plus in `apps/extension`: Vite, Vue 3, Vuetify 3, vue-i18n, Konva, fflate (zip), fix-webm-duration (clip duration), and `@playwright/test` with Chromium for the e2e. No `debugger`, no remote code.

**Spec:** `docs/design/extension-proposal.md`, approved 2026-11-28 with every §15 recommendation and one change (below). Mockups: `docs/design/mockups/extension-{popup,editor,setup}.html`. Product spec: `docs/superpowers/specs/2026-11-24-ai-work-portal-design.md` (§3 roles, §4 privacy, §9 AI, §12 GitLab, §14 secrets).

## Owner decisions applied

| # | Decision |
|---|---|
| D1 | All §15 recommendations as written (name "Yoda Reporter" / "Yoda แจ้งปัญหา", staff members only in v1, `defect` template by default with "bug-fix request" optional, no automatic AI triage, zip then managed CRX, production rules, retention 180/90 days, build meta off on production, token lifetimes 1 h / 30 d idle / 90 d absolute / 14 d Keycloak, 30 s clips and buffer at 720p without audio, CRX key in the `release` environment, DPO review before the managed rollout). |
| D2 | **No automatic masking.** Test data is usually mock, and auto-masking hinders debugging. The extension and core do **not** mask HN, Thai ID, phone, e-mail or token patterns, and nothing hides form fields or `[data-yoda-mask]` elements before capture. §15 question 6 (HN format) is void. `extension.piiPatterns`, `defect_reports.masked_counts`, the attachments' `masked` field and `maskInputsLocked` do not exist. |
| D3 | Instead the editor gets a manual **mosaic** (pixelate) tool, rectangle and brush, burned into the image, beside blur and redact. Mosaic also works on **video**: a rectangle over a time range, applied by re-encoding the clip (PR C, Task C2; feasibility below). |
| D4 | Kept unchanged: the confirmation step before sending; media and logs always stored `noAi`; the project's noAi wins over everything; production sites get no video and no buffer, logs off by default and a red warning; retention. |

## Decisions made in this plan

1. **Mosaic on video is feasible; it runs in the editor tab.** A hidden `<video>` plays the recorded WebM at 1×; `requestVideoFrameCallback` draws each frame onto a canvas; active regions are pixelated with the downscale-then-upscale `drawImage` trick (`imageSmoothingEnabled = false`); `canvas.captureStream(0)` with `track.requestFrame()` per drawn frame feeds a `MediaRecorder` with the clip's codec and bitrate; `fix-webm-duration` writes the duration. A 30 s clip takes about 30 s, with a progress bar and Cancel. It runs in the visible editor tab rather than the offscreen document because hidden documents may throttle video frame callbacks. Task C1 measures the offscreen document, and the work moves there only if it delivers at least 95% of the frames; nothing else changes. **Fallback:** when re-encoding is unsupported, fails or delivers under 90% of the source frames, the editor says so and offers (a) send without the video or (b) send one still frame, chosen on the timeline, through the screenshot path, with the same regions burned in. A video with mosaic regions is never sent with those regions unapplied.
2. **The e2e test runs Playwright Chromium against a stub Yoda.** It loads the unpacked e2e build (`launchPersistentContext` with `--load-extension`) against `apps/extension/e2e/stub-yoda.ts`, a small Node server that validates every request with the `@yoda/shared` zod schemas. The real core is covered by core contract tests that post the same multipart, built with the same `encodeDefectForm`. Two test-only differences are confined to the e2e build target and asserted absent from the release zip:
   - `host_permissions: ['<all_urls>']`, because Playwright cannot click the toolbar button to grant `activeTab`;
   - the popup reads `?tab=<id>` to choose its target tab.

   Connect runs through the real `launchWebAuthFlow` if the B1 spike shows Playwright can drive the auth window. Otherwise the e2e connects through the same `profile.exchange` runtime message the options page sends after `launchWebAuthFlow`, with a code the test obtains from the stub. The e2e also records the demo video for the PR description.
3. **URL mapping is matched in the extension**, from `GET /extension/mappings` (application URLs plus GitLab environments, cached 10 minutes). The proposal's `/extension/resolve?url=` is not built: the extension never sends every visited URL to Yoda.
4. **Refresh-token reuse has a 30 s grace.** A used refresh token presented again within 30 s of its use, while its successor is still unused, rotates once more and voids that successor. This covers an MV3 service worker that died before storing the response. Any other reuse revokes the whole grant (`reuse_detected`).
5. **The query string is kept by default.** It helps reproduce the defect. The form has an "include query string" switch.
6. **Defect media and logs** are only removable (`DELETE /attachments/:id`) and only purged by retention when the attachment has a `role`. Other uploads keep today's behaviour.
7. **Extension version.** `manifestVersion('x.y.z') = { version: 'x.y.z.1000', versionName: 'x.y.z' }`, and `manifestVersion('x.y.z-<tag>.N') = { version: 'x.y.z.N', versionName: 'x.y.z-<tag>.N' }` with 1 ≤ N ≤ 999. This keeps a final release newer than its release candidates for Chrome's update check, which the proposal's mapping did not.
8. **Files are served by core.** The release zip is built into the core image at `/app/extension`. The signed CRX travels in the signed release bundle under `extension/` and is mounted read-only at `/srv/yoda-extension`. Core serves `/extension/download/:file` and `/extension/updates.xml` from `YODA_EXTENSION_DIRS`, the first directory holding the file winning. The GitLab mirror pipeline (`.gitlab-ci.yml`) is unchanged: its bundles carry no CRX, so `updates.xml` answers 404 there and the Help page hides managed install.
9. **The CRX3 packer is about 100 lines in the repo** (`apps/extension/scripts/crx3.ts`, `node:crypto` and hand-encoded protobuf), with a verifier, instead of a dependency in the signing step (threat T12).
10. **The extension ID comes from `keys/yoda-reporter.pub`**, the base64 SPKI DER of the CRX key's public half, which is also the manifest `key`. Until the owner commits it, builds have no `key` (a path-derived dev ID that an admin allowlists in `extension.allowedIds`), `OFFICIAL_EXTENSION_ID` is `null`, and a real release fails with instructions (Tasks B13, D4).

## Delivery

| PR | Branch | Tasks | Base |
|---|---|---|---|
| A: Yoda server side | `feat/extension-server` (this branch; its first commit is this plan plus the proposal update) | A1–A13 | `main` |
| B: extension MVP (phase 0 spike + phase 1) | `feat/extension-mvp` | B1–B13 | stacked on A; retarget to `main` when A merges |
| C: video and mapping (phase 2) | `feat/extension-video-mapping` | C1–C5 | stacked on B |
| D: buffer and managed install (phase 3) | `feat/extension-enterprise` | D1–D5 | stacked on C |

Open one GitHub issue per PR before its first code commit and link it from the PR. Every PR description has:
- a checkbox test plan;
- screenshots, desktop and phone width, of every new or changed portal screen, from the demo stack (`docs/development.md`) via Playwright;
- for B, C and D, a short demo GIF recorded by the e2e (`pnpm --filter @yoda/extension demo`, converted with `ffmpeg -vf fps=8,scale=960:-1`) and committed under `docs/design/screenshots/extension/`, at most 2 MB each;
- for A, a GIF of approve → Connected browsers → revoke on the demo stack.

Verification per PR: CI green (`secrets`, `test` with `pnpm typecheck` and `pnpm test`, and from B the `extension` job; for D also the Release dry run), plus the media above. If a PR goes past a merged base, rebase, never stash.

## Global Constraints

- The proposal is the spec, as amended by D2 and D3. Section numbers below are the proposal's.
- **No secrets anywhere.** No private keys, tokens or passwords in the repo, the zip, the CRX, logs, API responses (tokens only in the token response) or the extension's MAIN world. The private CRX key exists only as the `release`-environment secret `EXTENSION_CRX_KEY` (owner) or as a throwaway key made and deleted inside a dry-run job or test.
- **Hostnames:** `example.org` placeholders only. Never write the internal GitLab hostname or any part of its domain.
- **Versions:** `apps/extension/package.json` `version` equals the root and `apps/core` `package.json` version. The manifest uses `manifestVersion()` (decision 7).
- **Tokens:** a prefix plus 32 random bytes in base64url (43 characters), as `runners/tokens.ts`. Only the SHA-256 (`hashToken`) and a 12-character display prefix are stored. Keycloak tokens are refused on `/extension/*`, and extension tokens are refused everywhere else.
- **AI:** `defect_reports.no_ai` withholds the report text from context packs and the GitLab issue section. Attachment rows written by the defect route are always `noAi = true` and never call the knowledge `onStored` hook. A noAi project sends nothing to AI.
- **Untrusted page data:** everything from the MAIN world or the page is schema-validated, size-capped (500 entries, 2 KB per message, 10 back-end builds), and rendered as text (never `v-html`) in the extension and the portal.
- **No automatic masking (D2):** no regex masking, no capture stylesheet, no `data-yoda-mask` handling, in any package.
- **Repo rules:** single quotes and no semicolons; th/en parity, Thai default; `data-testid` on new controls; the portal's components (`PageHeader`, `StatusChip`, `AppDialog`, `ConfirmDialog`, `EmptyState`, `ErrorState`); `pnpm typecheck` and `pnpm test` pass; migrations continue from `0024`, and each new table joins the `TRUNCATE` list in `apps/core/test/helpers.ts`; `runWork`, lock order and jobs-after-commit as in earlier plans; never `git stash`, never push to `main`.
- **Permissions (§5):** required `activeTab`, `scripting`, `storage`, `identity`, `offscreen`; optional `tabCapture` and per-origin host permissions. Never `<all_urls>`, `tabs`, `debugger`, `webRequest`, `cookies`, `externally_connectable`, `web_accessible_resources` or manifest `content_scripts` in the release build.

## Review Focus

1. **The service worker dies mid-refresh, or two refreshes race.** The extension is single-flight. Core's 30 s grace (decision 4) rotates once instead of revoking; a later or second reuse revokes the grant. Tests in A2 and B3.
2. **A 50 MB report through the built-in proxy.** Caddy caps bodies at 32 MiB today. `/api/extension/defects` gets its own 56 MiB cap, and a larger report gets 413 `too_large` with the limit, which the extension shows as "remove a file". Tests in A6 and A13.
3. **A retry with the same `Idempotency-Key`**, sequential (after a timeout) or concurrent (two tabs). One work item results; the loser's objects are removed; both callers get the same body. Test in A6.
4. **A hostile or noisy page**: 10 000 console lines, 1 MB messages, HTML in messages, a forged `yoda-build`, foreign `postMessage`s with our type. Entries stay capped; text renders as text in the editor and on the portal card; the forged build is visible and editable. Tests in B6 and A12.
5. **Production sites with a stale or missing rule.** A page that matches a production application URL or GitLab production environment must not carry video or buffer files, even from an older or patched extension. Core refuses them: 422 `invalid_state`, reason `video_on_production`. Tests in A6 and C3.

---

## PR A: the Yoda server side (`feat/extension-server`)

### Task A1: Shared contracts and the `extension` settings

**Files:**
- Create: `packages/shared/src/extension.ts`, `packages/shared/src/extension-id.ts`, `packages/shared/src/match-pattern.ts`, `packages/shared/test/extension.test.ts`, `packages/shared/test/match-pattern.test.ts`
- Modify: `packages/shared/src/index.ts`, `packages/shared/src/settings/registry.ts` (category `extension` and the keys below), `packages/shared/src/admin.ts` (`PublicConfig.extension`), `packages/shared/src/knowledge.ts` (`Attachment.role`, `Attachment.purgedAt`), `packages/shared/src/work.ts` (`EventType` + `defect.reported`, `attachment.removed`, `attachment.purged`; `WorkItemDetail.defect`), `packages/shared/test/settings-registry.test.ts`, `apps/portal/app/utils/settings.ts` (page `{ id: 'extension', icon: 'mdi-puzzle-outline', categories: ['extension'] }`), `apps/portal/i18n/locales/{th,en}.json` (`settings.page.extension`, `settings.category.extension`, `settings.field.extension.*.label/help`)

**Interfaces (Produces):**
- `EXTENSION_API_VERSION = 1`. `EXTENSION_TOKEN = { code: 'yoda_xc_', access: 'yoda_xt_', refresh: 'yoda_xr_' } as const`, and `extensionTokenRe(kind): RegExp`, which matches the prefix plus 43 base64url characters.
- `OFFICIAL_EXTENSION_ID: string | null` (`extension-id.ts`, `null` until the owner commits `keys/yoda-reporter.pub`); `isExtensionId(s): boolean` (`/^[a-p]{32}$/`); `chromiumappRedirect(id) => 'https://<id>.chromiumapp.org/'`; `extensionIdFromPublicKey(spkiDer: Uint8Array): Promise<string>` (SHA-256 with WebCrypto, first 16 bytes, each nibble mapped to `a`–`p`).
- `manifestVersion(yodaVersion: string): { version: string; versionName: string }` (decision 7; throws on anything else).
- Enums: `DefectSeverity` (`blocker | critical | major | minor | trivial`), `DefectKind` (`defect | bug_fix_request`), `AttachmentRole` (`screenshot | screenshot_full | video | buffer | console | network`), `BuildSource` (`meta | well-known | header | gitlab | manual`). `severityPriority(s): Priority` maps blocker and critical to `urgent`, major to `high`, minor to `normal`, trivial to `low`.
- `DEFECT_LIMITS = { maxFiles: 8, maxReportBytes: 50 MiB, perRole: { screenshot: 10 MiB, screenshot_full: 15 MiB, video: 25 MiB, buffer: 25 MiB, console: 1 MiB, network: 1 MiB } }`. `DEFECT_TYPES: Record<AttachmentRole, string[]>`: images take `image/png`, `image/jpeg` and `image/webp`; video and buffer take `video/webm`; logs take `application/json`. `MEDIA_ROLES` and `LOG_ROLES`.
- `ConsoleEntry` (`{ t, level: 'log'|'info'|'warn'|'error'|'debug'|'exception'|'rejection', message: string.max(2048), source?: string.max(500) }`) and `NetworkEntry` (`{ t, method, url: string.max(2048), status: number|null, durationMs, failed: boolean, kind: 'fetch'|'xhr'|'resource', yodaBuild?: string.max(500) }`); `CAPTURE_CAPS = { entries: 500, message: 2048, backendBuilds: 10 }`.
- Schemas, as §10.1 with D2 applied:
  - `ExtensionAuthorize`, `ExtensionAuthorizeResponse`, `ExtensionTokenRequest` and `ExtensionTokenResponse`.
  - `ExtensionSession`: `{ apiVersion, instance, latestExtension, person, projects: { id, name, noAi, kinds, repos }[], limits: { maxFileBytes, maxReportBytes, maxFiles, maxVideoSeconds, perRole, allowedTypes }, policy: { videoOnProduction: false, logsOnProductionDefault: false, requireConfirm: true } }`.
  - `MappingRule`: `{ pattern, projectId, environment: string|null, production, source: 'app_url'|'gitlab', build: { repo, ref, sha, deployedAt }|null }`, and `ExtensionMappings = { rules: MappingRule[], ttlSeconds: 600 }`.
  - `ExtensionGrant` (the list view: `id, extensionId, browserLabel, createdAt, lastUsedAt, lastIp, revokedAt, revokeReason, person`), `AppUrl`, `AppUrlsPut` (at most 50), `ExtensionLatest` (`{ version, zipUrl, crxUrl: string|null } | null`).
  - `DefectReportCreate`: §10.1 without `attachments[].masked`. `privacy` is `{ confirmedNoPatientData: literal(true), productionSite: boolean, textMayContainPatientData: boolean }`, and `page.url` is kept as captured.
  - `DefectReportCreated` and `DefectReportView` (what the portal card reads).
- `encodeDefectForm(report, files: { part: string; name: string; type: string; data: Blob }[]): FormData` (part `report` first, then the files in order).
- `match-pattern.ts`: `parseMatchPattern(p): { scheme: 'http'|'https'|'*'; host: string; path: string } | null` (Chrome match-pattern grammar, with `*.` host prefix, no `<all_urls>`); `matchesPattern(p, url): boolean`; `patternSpecificity(p): [hostScore: number, pathLength: number]`, where a literal host scores higher than a wildcard host and longer hosts score higher.
- Settings (all `scope: 'core'`, `apply: 'live'`, UI-editable, no `envName`, like `org.name`):
  - `extension.enabled` (bool, default `true`);
  - `extension.allowedIds` (list of `isExtensionId`, default `[]`; the effective allowlist adds `OFFICIAL_EXTENSION_ID`);
  - `extension.accessTtlMinutes` (5–240, default 60);
  - `extension.refreshIdleDays` (default 30), `extension.refreshAbsoluteDays` (default 90) and `extension.reauthDays` (default 14), each 1–365;
  - `extension.maxVideoSeconds` (5–60, default 30);
  - `extension.mediaRetentionDays` (default 180) and `extension.logRetentionDays` (default 90), each 0–3650, where 0 keeps the files.

  One bootstrap setting: `extension.dirs` (list, `envName: 'YODA_EXTENSION_DIRS'`, `boot`, default `['/srv/yoda-extension', '/app/extension']`). Add it to core's `envSchema` and to the runbook's variable table, which the sync test checks.
- `PublicConfig.extension = { enabled: boolean, apiVersion: number }`.

- [ ] **Step 1: Write failing tests** in `extension.test.ts`:
  - `manifestVersion`: `'1.2.0'` gives `{ version: '1.2.0.1000', versionName: '1.2.0' }`, `'1.2.0-rc.3'` gives `{ version: '1.2.0.3', versionName: '1.2.0-rc.3' }`, and it throws on `'1.2'` and `'1.2.0-rc'`;
  - `extensionIdFromPublicKey` gives a known ID for a fixed test SPKI (generate a throwaway key once, inline its public DER and the ID Chrome showed for it);
  - `chromiumappRedirect` and `isExtensionId`;
  - `severityPriority` for all five severities;
  - `DefectReportCreate` accepts the §10.1 example without `masked`, and rejects `privacy.confirmedNoPatientData: false`, 31 steps, 9 attachments and a 201-character title;
  - `encodeDefectForm`, through `new Response(fd)`, has the `report` part first and the file parts named `file1`…;
  - `ConsoleEntry` rejects a 2049-character message.

  In `match-pattern.test.ts`, a table: `https://*.review.example.org/*` matches `https://a.review.example.org/x` and `https://review.example.org/` and not `http://a.review.example.org/`. `http://localhost:3000/*` matches its own port. `patternSpecificity` ranks `https://app.example.org/opd/*` above `https://app.example.org/*` above `https://*.example.org/*`. Invalid patterns give null.

  In `settings-registry.test.ts`: every `extension.*` key has a default, and `extension.dirs` is bootstrap-only with its env name.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the modules and registry entries; i18n labels for each key (th/en); the portal settings page entry.
- [ ] **Step 4: Run** `pnpm vitest run packages/shared apps/portal/test/settings.test.ts apps/portal/test/i18n.test.ts apps/core/test/ops-docs.test.ts && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): extension contracts, match patterns and extension settings`

### Task A2: Grants, codes and rotating refresh tokens

**Files:**
- Create: `apps/core/src/extension/tokens.ts`, `apps/core/src/extension/grants.ts`, migration `apps/core/drizzle/0024_extension_grants.sql` (via `pnpm --filter @yoda/core db:generate`), `apps/core/test/extension-grants.test.ts`
- Modify: `apps/core/src/db/schema.ts`, `apps/core/test/helpers.ts` (TRUNCATE list)

**Tables:**
- `extension_grants`: `id, person_id → people, extension_id, browser_label, access_hash unique null, access_expires_at, family_id uuid, idle_expires_at, absolute_expires_at, created_at, last_used_at, last_ip, revoked_at, revoked_by → people null, revoke_reason`, where `revoke_reason` is one of `user`, `admin`, `admin_all`, `reuse_detected`, `person_blocked` or `extension_disabled`.
- `extension_auth_codes`: `code_hash PK, person_id, extension_id, redirect_uri, code_challenge, browser_label, expires_at, used_at`.
- `extension_refresh_tokens`: `hash PK, grant_id → extension_grants on delete cascade, created_at, used_at null, successor_hash null`.

**Interfaces (Produces):**
- `newExtensionToken(kind: 'code'|'access'|'refresh'): { token; hash; prefix }` (it reuses `hashToken` from `runners/tokens.ts`); `verifyPkceS256(verifier: string, challenge: string): boolean` (the verifier has 43–128 unreserved characters; the comparison is constant-time).
- `class GrantError extends Error { reason: 'invalid_grant' | 'reauth_required' | 'revoked' }`.
- `issueAuthCode(db, me: Me, input: ExtensionAuthorize, opts: { allowedIds: string[]; now: Date }): Promise<{ redirectTo: string }>`. It throws `HttpError(403, { error: 'forbidden', reason: 'extension_not_allowed' | 'redirect_mismatch' | 'not_staff' })`. The code lives 60 s.
- `exchangeCode(db, req: { code; codeVerifier; extensionId }, ctx: GrantCtx): Promise<ExtensionTokenResponse>` and `refreshGrant(db, refreshToken: string, ctx: GrantCtx): Promise<ExtensionTokenResponse>`. `GrantCtx = { now: Date; ip: string; ttl: { accessMinutes; idleDays; absoluteDays; reauthDays } }`.
- `authenticateExtension(db, authorization: string | undefined, now: Date): Promise<{ grant: GrantRow; me: Me } | null>`. It uses `meFromPerson`, requires staff, and updates `last_used_at` and `last_ip` at most once a minute.
- `revokeGrant(db, grantId, by: { personId: string | null; reason }): Promise<boolean>` and `revokeAllGrants(db, by): Promise<number>`.

- [ ] **Step 1: Write failing tests** (`extension-grants.test.ts`, against the test DB):
  - Codes:
    - `code is single use, expires after 60 s, and is bound to the verifier and the extension id`;
    - `an unknown extension id or a redirect other than chromiumappRedirect(id) is refused, and no code is stored`;
    - `requesters get not_staff`.
  - Refresh:
    - `refresh rotates: the old token's successor is issued and the access token changes`;
    - `reuse within 30 s while the successor is unused rotates again and voids that successor`;
    - `reuse after 30 s, or after the successor was used, revokes the grant with reuse_detected`;
    - `idle 30 d and absolute 90 d expiry give invalid_grant`;
    - `a person whose last_seen_at is older than reauthDays gets reauth_required, and a fresh portal sign-in clears it`.
  - Access and revocation:
    - `authenticateExtension refuses a Keycloak JWT, a revoked grant, an expired access token, a non-staff owner, and a yoda_rt_ token`;
    - `revokeGrant stops the access token at once`;
    - `only hashes and prefixes are stored` (no raw token in any row).
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/extension-grants.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the schema and migration, then the module. Lock order: the refresh token row, then the grant row, both `FOR UPDATE`, in one transaction.
- [ ] **Step 4: Run** `pnpm vitest run apps/core/test/extension-grants.test.ts apps/core/test/db.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): extension grants, PKCE codes and rotating refresh tokens`

### Task A3: `/extension/*` auth hook, connect, token, revoke and session routes

**Files:**
- Create: `apps/core/src/routes/extension.ts`, `apps/core/src/extension/hook.ts`, `apps/core/src/extension/limits.ts`, `apps/core/test/extension-routes.test.ts`
- Modify: `apps/core/src/app.ts` (register the routes, add `yoda_xt_`/`yoda_xr_` bodies and the `idempotency-key` header to `LOGGER_OPTIONS.redact`), `apps/core/src/auth/plugin.ts` (`FastifyContextConfig.extension?: boolean`; `FastifyRequest.extension`), `apps/core/src/routes/public-config.ts`, `apps/core/test/public-config.test.ts`

**Interfaces:**
- Consumes: A1 and A2.
- Produces: routes marked `{ public: true, extension: true }` run `extensionHook`. It answers 404 when `extension.enabled` is false; otherwise it requires `authenticateExtension` and sets `request.extension = { grant, me }`, or answers 401 `unauthorized`. `limits.ts` exports `extensionLimiters(now)`: `token` (20/min per IP), `tokenFailures` (5 per 15 min per IP, counted only on `GrantError`), `authorize` (10/h per person), `session` (120/h per grant), plus `defects` and `DailyBytes`, used in A6.
- Routes (core paths; the portal proxies `/api/*`):
  - `POST /extension/authorize` (Keycloak), body `ExtensionAuthorize` → `ExtensionAuthorizeResponse`.
  - `POST /extension/token` (public, body `ExtensionTokenRequest`) → `ExtensionTokenResponse`, or 401 `{ error: 'unauthorized', reason }`.
  - `POST /extension/revoke` (extension token) → 204, reason `user`.
  - `GET /extension/session` → `ExtensionSession`. Its projects are the person's member projects (admins: every active project); `latestExtension` comes from A12's `latestExtension()` (null until A12 lands); its limits come from `DEFECT_LIMITS` and `extension.maxVideoSeconds`.
  - `GET /public-config` gains `extension`.

- [ ] **Step 1: Write failing tests**:
  - Connect:
    - `authorize → token → session round trip for a staff member, with PKCE`;
    - `authorize is 401 without a Keycloak token`;
    - `token answers 429 rate_limited with retryAfter after 20 calls a minute, and after 5 failed exchanges in 15 minutes`.
  - Separation:
    - `session refuses a Keycloak bearer, and /me and /projects refuse a yoda_xt_ token` (401);
    - `revoke ends the grant`.
  - Switch and contents:
    - `extension.enabled=false gives 404 on every /extension/* route, and grants are kept`;
    - `session lists only member projects, with noAi and repos`;
    - `public-config reports extension.enabled`.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/extension-routes.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the hook as an app-level `onRequest` after `registerAuth`, keyed on `routeOptions.config.extension`. Log grant lifecycle lines (`created`, `refreshed_after_reauth`, `revoked`, `reuse_detected`) with grant id and person id only.
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): extension connect, token, revoke and session routes`

### Task A4: Connected browsers API (person and admin)

**Files:**
- Create: `apps/core/test/extension-grants-api.test.ts`
- Modify: `apps/core/src/routes/extension.ts` (or `routes/extension-grants.ts` if it passes 300 lines)

**Interfaces:**
- `GET /me/extension-grants` → `ExtensionGrant[]` for the signed-in person, newest first, revoked ones for 30 days.
- `DELETE /me/extension-grants/:id` → 204 (reason `user`; another person's grant gives 404).
- `GET /admin/extension-grants?active=1` → `ExtensionGrant[]` with `person`.
- `DELETE /admin/extension-grants/:id` → 204 (reason `admin`).
- `POST /admin/extension-grants/revoke-all` → `{ revoked: number }` (reason `admin_all`).

- [ ] **Step 1: Write failing tests**:
  - `a person lists and revokes only their own grants`;
  - `staff non-admins get 403 on /admin/extension-grants`;
  - `revoke-all revokes every active grant and the old tokens stop working`;
  - `no hash or token appears in any response`.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/extension-grants-api.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the routes.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): connected browsers API`

### Task A5: The `defect` template, `defect_reports` and the create service

**Files:**
- Create: `apps/core/src/workflow/templates/defect.json`, `apps/core/src/defects/service.ts`, migration `0025_defect_reports.sql`, `apps/core/test/defects-service.test.ts`
- Modify: `apps/core/src/db/schema.ts`, `apps/core/src/work/queries.ts` (`getWorkItemDetail` adds `defect`), `apps/core/src/knowledge/context-pack.ts`, `apps/core/src/gitlab/issue-section.ts`, `apps/core/test/templates.test.ts`, `apps/core/test/context-pack.test.ts`, `apps/core/test/issue-section.test.ts`, `apps/core/test/helpers.ts`, `apps/portal/i18n/locales/{th,en}.json` (`events.defect.reported`, `events.attachment.removed`, `events.attachment.purged`)

**Template** (§10.2, human-only):
- step `triage` (คัดกรอง / Triage): `triage-defect`, approval, QC;
- step `fix` (แก้ไข / Fix): `fix-defect`, human, DEV, then `review-fix`, review, DEV, depends on `fix-defect`;
- step `verify` (ทดสอบซ้ำ / Retest): `retest`, human, REQUESTER, then `close-defect`, approval, QC, depends on `retest`.

Write th/en titles and instructions in the style of `bug-fix.json`.

**Table** `defect_reports`:
- `work_item_id PK → work_items on delete cascade, kind, severity, steps jsonb, expected, actual`;
- `page_url, page_title, route, build jsonb null, backend_builds jsonb, client jsonb, captured_at`;
- `reported_by → people, source ('extension'|'portal'), extension_version, grant_id null`;
- `production_site bool, no_ai bool, idempotency_key uuid null, created_at`;
- `unique(reported_by, idempotency_key)`.

The same migration adds `attachments.role text null`, checked against `AttachmentRole`, and `attachments.purged_at timestamptz null`.

**Interfaces (Produces):** `createDefect(ctx: WorkCtx, me: Me, input: DefectReportCreate, files: StoredDefectFile[], meta: { grantId; extensionVersion; idempotencyKey }): Promise<{ workItemId: string }>`, where `StoredDefectFile = { role; storageKey; fileName; contentType; sizeBytes }`.

The service:
1. calls `createWorkItem` with template `defect`, or `bug-fix` for `bug_fix_request`, with priority `severityPriority`, requester = the reporter, and a description built from the text fields;
2. inserts `defect_reports` with `no_ai = input.privacy.textMayContainPatientData`, unless the project is noAi, which makes it true;
3. inserts one attachment row per file with `noAi: true`, `role` and `workItemId`;
4. records `defect.reported` with the metadata-only payload `{ source, extensionVersion, grantId, kind, severity, files: [{ role, sizeBytes }], productionSite, aiAllowed }`.

- [ ] **Step 1: Write failing tests**:
  - `defect.json passes validateTemplate and seeds`;
  - `createDefect makes a triage-step item with requester = reporter and priority from severity`;
  - `bug_fix_request uses the bug-fix template`;
  - `every attachment row is noAi and has its role; no knowledge entry is created`;
  - `the event payload holds no text from the report`;
  - `context pack shows "[withheld: report marked do not send to AI]" for a no_ai defect`, and `the GitLab issue section withholds the text the same way, never links media bytes, and shows severity, build and browser`;
  - `a noAi project forces defect_reports.no_ai`.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/defects-service.test.ts apps/core/test/templates.test.ts apps/core/test/context-pack.test.ts apps/core/test/issue-section.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the template, the migration, the service, the detail field and the two withholding changes.
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): defect template, defect_reports and createDefect`

### Task A6: `POST /extension/defects`, multipart and idempotent

**Files:**
- Create: `apps/core/src/defects/upload.ts`, `apps/core/test/extension-defects.test.ts`
- Modify: `apps/core/src/routes/extension.ts`, `apps/core/src/extension/limits.ts`

**Interfaces:**
- Consumes: `createDefect` (A5), `encodeDefectForm`, `DEFECT_LIMITS`, `DEFECT_TYPES`, `matchesPattern`, and the project's production rules (A7 and A8; until they land, `productionRulesFor()` returns `[]`).
- Produces: `readDefectParts(request, limits): Promise<{ report: DefectReportCreate; files: { part; name; type; buf }[] }>` and `isWebm(buf): boolean` (EBML magic `1A 45 DF A3`).
- `POST /extension/defects` behaviour, in order:
  1. Read the `Idempotency-Key` header (a uuid); without one, answer 400 `validation`.
  2. If `(person, key)` already has a report, drain the body and answer 200 with the stored `DefectReportCreated`.
  3. Run the limiters: `defects` (20/h and 100/day per person), one in-flight upload per grant (otherwise 429, `retryAfter: 5`), and `DailyBytes` (300 MB/day per person).
  4. Parse with `request.parts({ limits: { files: 8, fileSize: 25 MiB } })`: the part `report` (JSON) first; each file must be named in `report.attachments` with an allowed type for its role and its role's size cap; WebM must pass `isWebm`; the running total must stay ≤ 50 MiB. On failure answer 413 `too_large` (with `reason` naming the limit), 415 `unsupported_type` or 400.
  5. Check the project: membership is checked as in `POST /projects/:id/work-items` (a non-member gets 404, a requester 403).
  6. Refuse video or buffer files when `privacy.productionSite` is set, or when the page URL matches a production rule of the project: 422 `invalid_state`, reason `video_on_production`.
  7. Put every object under `projects/<projectId>/defects/<uuid>/<name>`.
  8. Run `runWork(createDefect)`. On any failure, remove the stored objects. On a unique violation of the idempotency key, remove ours and answer 200 with the winner's body.
  9. Answer 201 `DefectReportCreated`, with the portal link `${org.publicUrl}/work-items/<id>`.
- The production refusal is `new HttpError(422, { error: 'invalid_state', reason: 'video_on_production' })` (422 is already in the status union; `invalidState()` stays 409 elsewhere).

- [ ] **Step 1: Write failing tests**, building bodies with `encodeDefectForm` and `new Response(fd)`:
  - Happy path and retries:
    - `a report with a PNG, a WebM and two JSON logs creates one item and four noAi attachments`;
    - `the same Idempotency-Key returns 200 and the same body, and stores nothing new`;
    - `two concurrent posts with one key make one item, and the loser's objects are removed`.
  - Limits and types:
    - `a fake .webm without EBML magic is 415`;
    - `a 26 MB video is 413`, and so are a 51 MB total and a ninth file;
    - `a file whose part is not listed in report.attachments is 400`.
  - Access and rules:
    - `video on a production site is 422 video_on_production`;
    - `a non-member gets 404, a requester's grant 403, a revoked grant 401`;
    - `the 21st report in an hour is 429 with retryAfter`;
    - `a storage failure after two puts removes both objects and creates no item`.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/extension-defects.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the route and helpers. Do not touch the app-wide multipart registration.
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): POST /extension/defects, multipart and idempotent`

### Task A7: Project application URLs

**Files:**
- Create: migration `0026_project_app_urls.sql`, `apps/core/src/projects/app-urls.ts`, `apps/core/test/app-urls.test.ts`, `apps/portal/app/components/project/AppUrlsTab.vue`, `apps/portal/app/utils/appUrls.ts`, `apps/portal/test/appUrls.test.ts`
- Modify: `apps/core/src/db/schema.ts`, `apps/core/src/routes/projects.ts`, `apps/core/test/helpers.ts`, `apps/portal/app/pages/projects/[id].vue` (new tab), `apps/portal/i18n/locales/{th,en}.json`

**Interfaces:**
- Table `project_app_urls`: `id, project_id → projects on delete cascade, pattern, environment null, production bool, created_by, created_at`, with `unique(project_id, pattern)`.
- `GET /projects/:id/app-urls` (members) → `AppUrl[]`; `PUT /projects/:id/app-urls` (PM or admin, body `AppUrlsPut`) replaces the list. Every pattern must pass `parseMatchPattern`; otherwise 400 with the index.
- `appUrlRules(db, projectIds): Promise<MappingRule[]>` (source `app_url`), used by A8.
- Portal: `validatePatternInput(s): 'ok' | 'invalid' | 'too_broad'` (`too_broad` for `*://*/*` or a bare `https://*/*`), tested.

- [ ] **Step 1: Write failing tests**:
  - `PM replaces the list; members read; non-members 404; non-PM 403`;
  - `invalid pattern is 400 with the index`;
  - in the portal, `validatePatternInput` and the tab's i18n keys exist in both locales.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/app-urls.test.ts apps/portal/test/appUrls.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the table, routes and tab. The tab lists pattern, environment and a production chip (`StatusChip`); PMs add and remove rows in an `AppDialog`.
- [ ] **Step 4: Run** the same command and `pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: project application URLs`

### Task A8: GitLab environments and `GET /extension/mappings`

**Files:**
- Create: migration `0027_deploy_environments.sql`, `apps/core/src/gitlab/environments.ts`, `apps/core/test/gitlab-environments.test.ts`
- Modify: `apps/core/src/db/schema.ts`, `apps/core/src/gitlab/webhook.ts` (`object_kind: 'deployment'`), `apps/core/src/gitlab/client.ts` (`listEnvironments(projectId)`, `lastDeployment(projectId, envId)`), `apps/core/src/jobs/queue.ts` and `jobs/handlers.ts` (`gitlab-env-sync`: nightly at 03:30 Asia/Bangkok, and on repo link), `apps/core/src/routes/gitlab.ts` (enqueue on link), `apps/core/test/fake-gitlab.ts`, `apps/core/src/routes/extension.ts`, `apps/core/test/helpers.ts`

**Interfaces:**
- Table `deploy_environments`: `repo_id → project_repos on delete cascade, name, external_url null, tier null, ref, sha, status, deployed_at`, with `unique(repo_id, name)`.
- `upsertDeployment(db, repoId, d: { name; externalUrl; tier; ref; sha; status; deployedAt })`, which ignores an event older than the stored `deployed_at`; `syncEnvironments(deps, repoId)`.
- `externalUrlPattern(url): string | null` turns `https://review-12.example.org/app` into `https://review-12.example.org/*`.
- `GET /extension/mappings` (extension token, `session` limiter) → `ExtensionMappings`. It holds the app URL rules and the GitLab rules of the person's projects; a GitLab rule has `production` when the tier is `production` and `build` from the deployment.
- `productionRulesFor(db, projectId): Promise<string[]>`, consumed by A6.

- [ ] **Step 1: Write failing tests**:
  - `a deployment webhook upserts the environment and ignores an older event`;
  - `sync reads environments and their last deployment from the fake GitLab`;
  - `mappings returns app URL and GitLab rules only for member projects, with production from the tier`;
  - `a production GitLab environment makes A6 refuse video` (extends the A6 test).
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/gitlab-environments.test.ts apps/core/test/extension-defects.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them. Add "Deployment events" to the webhook checklist in `docs/operations.md`.
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): GitLab deploy environments and extension URL mappings`

### Task A9: Removing defect files and retention

**Files:**
- Create: `apps/core/src/defects/retention.ts`, `apps/core/test/defects-retention.test.ts`
- Modify: `apps/core/src/routes/attachments.ts` (`DELETE /attachments/:id`; download of a purged row → 404 `not_found`, reason `purged`), `apps/core/src/attachments/service.ts` (`role` and `purgedAt` in the shape), `apps/core/src/jobs/queue.ts` and `jobs/handlers.ts` (`defect-retention`, daily at 03:00 Asia/Bangkok)

**Interfaces:**
- `DELETE /attachments/:id` takes the body `{ reason: string.min(1).max(500) }`. The uploader, the project's PM or an admin may call it. An attachment without a `role` gives 409 `invalid_state`, reason `not_defect_attachment`. It removes the object, sets `purged_at` and records `attachment.removed` `{ attachmentId, role, reason }`, actor = the caller.
- `purgeExpired(deps, now): Promise<{ media: number; logs: number }>`. An item's close time is its latest `work_item.done` or `work_item.cancelled` event. Media roles purge after `mediaRetentionDays`, log roles after `logRetentionDays`; 0 keeps the files. Items that are active (including reopened ones) are skipped. Each purge records `attachment.purged`, actor `system`.

- [ ] **Step 1: Write failing tests**:
  - `uploader, PM and admin may remove; another member gets 403; a chat upload gets 409`;
  - `the removed file's download is 404 purged and the row stays`;
  - `a done item purges media after 180 d and logs after 90 d, not a day earlier`;
  - `0 keeps everything`;
  - `a reopened item is not purged`;
  - `a cancelled item counts from its cancel event`.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/defects-retention.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them.
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): remove defect files and purge them after retention`

### Task A10: Portal approve page `/extension/connect`

**Files:**
- Create: `apps/portal/app/pages/extension/connect.vue`, `apps/portal/app/utils/extensionConnect.ts`, `apps/portal/test/extensionConnect.test.ts`
- Modify: `apps/portal/nuxt.config.ts` (`routeRules: { '/extension/**': { headers: { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' } } }`), `apps/portal/app/utils/nav.ts` (`/extension` is a staff prefix), `apps/portal/i18n/locales/{th,en}.json` (`extension.connect.*`)

**Interfaces:**
- `parseConnectQuery(q): { ok: true; value: { ext; redirectUri; codeChallenge; state; browser } } | { ok: false; reason: 'missing' | 'bad_id' | 'bad_redirect' }`. The redirect must equal `chromiumappRedirect(ext)`.
- `cancelUrl(redirectUri, state)` gives `<redirect>?error=access_denied&state=…`.
- The page:
  - shows the Yoda name and origin in large text, the extension ID, the browser label, and what it may do: report defects, list my projects;
  - **Approve** calls `POST /api/extension/authorize`, then `location.replace(redirectTo)`;
  - **Cancel** goes to `cancelUrl`;
  - on 403 `extension_not_allowed`, shows "this extension is not approved by your Yoda admin" and redirects nowhere;
  - on a bad query, shows an error and redirects nowhere.

- [ ] **Step 1: Write failing tests**:
  - `parseConnectQuery` cases;
  - `cancelUrl` keeps `state`;
  - `nuxt.config.ts has the frame-ancestors rule for /extension/**` (read the file as text, as the ops tests do);
  - the i18n keys exist in both locales.
- [ ] **Step 2: Run** `pnpm vitest run apps/portal/test/extensionConnect.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the page with `PageHeader` and `DialogCard` styling, and the `data-testid`s `connect-approve`, `connect-cancel` and `connect-error`.
- [ ] **Step 4: Run** `pnpm vitest run apps/portal && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): extension approve page`

### Task A11: Portal Connected browsers (Settings and Admin)

**Files:**
- Create: `apps/portal/app/pages/settings/browsers.vue`, `apps/portal/app/pages/admin/browsers.vue`, `apps/portal/app/components/settings/GrantList.vue`, `apps/portal/app/utils/grants.ts`, `apps/portal/test/grants.test.ts`
- Modify: `apps/portal/app/components/UserMenu.vue` (`menu-connected-browsers`), `apps/portal/app/utils/nav.ts` (admin item `admin.browsers` → `/admin/browsers`, `mdi-monitor-cellphone`), `apps/portal/i18n/locales/{th,en}.json`

**Interfaces:**
- `grantStatus(g, now): 'active' | 'idle' | 'revoked'`, where idle means not used for 7 days.
- `sortGrants(list)`: active first, then by last use.
- The pages:
  - Settings → Connected browsers: browser label, created, last used and IP, with Revoke through `ConfirmDialog`.
  - Admin → Connected browsers: everyone's grants, filterable by person, with "Revoke all" behind a typed confirmation.

- [ ] **Step 1: Write failing tests**:
  - `grantStatus` and `sortGrants`;
  - `navItemsFor(admin)` includes `/admin/browsers` and `navItemsFor(staff)` does not;
  - the i18n keys exist.
- [ ] **Step 2: Run** `pnpm vitest run apps/portal/test/grants.test.ts apps/portal/test/nav.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them.
- [ ] **Step 4: Run** `pnpm vitest run apps/portal && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): connected browsers in settings and admin`

### Task A12: Defect report card, Help page, downloads

**Files:**
- Create: `apps/portal/app/components/workItem/DefectCard.vue`, `apps/portal/app/utils/defectView.ts`, `apps/portal/app/pages/help.vue`, `apps/portal/test/defectView.test.ts`, `apps/core/src/extension/files.ts`, `apps/core/test/extension-files.test.ts`
- Modify: `apps/portal/app/pages/work-items/[id].vue`, `apps/portal/app/utils/nav.ts` (`help` → `/help`, `mdi-help-circle-outline`, in the projects group), `apps/portal/i18n/locales/{th,en}.json`, `apps/core/src/routes/extension.ts`

**Interfaces:**
- Core:
  - `latestExtension(dirs: string[], version: string, publicUrl: string): Promise<ExtensionLatest>` looks for `yoda-reporter-<version>.zip` and `.crx`.
  - `GET /extension/latest` (public, 404 when disabled) → `ExtensionLatest`.
  - `GET /extension/download/:file` (public) serves only names matching `/^yoda-reporter-\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?\.(zip|crx)$/` from the first directory holding them, as `application/zip` or `application/x-chrome-extension`, with `X-Content-Type-Options: nosniff`.
- Portal `defectView.ts`:
  - `parseLog(text, kind): { entries: ConsoleEntry[] | NetworkEntry[]; dropped: number }` validates with the schemas and caps at `CAPTURE_CAPS`;
  - `buildLine(build): string`;
  - `orderAttachments(list)`: screenshots, then video and buffer, then logs.
- The card shows:
  - severity (`StatusChip`), steps, expected and actual;
  - page URL (as text, opened with `rel=noopener`), build (with the commit linked to the GitLab repo for staff), browser and viewport;
  - images (blob URLs), video (`<video controls>` from a blob), and log tables, all as text;
  - "removed" placeholders for purged files, and a remove button for those allowed (A9).
- The Help page shows:
  - what the extension does;
  - a download button when `/api/extension/latest` gives a zip, otherwise the placeholder "Not available in this install; build it with `pnpm --filter @yoda/extension build:zip`";
  - the install steps (load unpacked);
  - "Connect: open the extension and paste `<org.publicUrl>`" with `CopyField`;
  - the privacy notice: nothing is masked automatically, so use mosaic or redact; media and logs never go to AI; the retention periods come from settings.

- [ ] **Step 1: Write failing tests**:
  - core:
    - `download refuses ../, other names and unknown files with 404`;
    - `latest finds the zip for VERSION`;
    - `latest is null when there is none`;
  - portal:
    - `parseLog drops invalid entries and counts them, and caps at 500`;
    - `a message with <script> stays a plain string` (no HTML rendering helpers are used: assert the card source has no `v-html`);
    - `orderAttachments`;
    - `buildLine`.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/extension-files.test.ts apps/portal/test/defectView.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them.
- [ ] **Step 4: Run** `pnpm vitest run apps/core apps/portal && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: defect report card, Help page and extension downloads`

### Task A13: Proxy body cap, docs and PR A verification

**Files:**
- Create: `apps/core/scripts/dev-post-defect.ts` (`// DEV ONLY`)
- Modify: `ops/proxy/Caddyfile`, `apps/core/test/ops-ci.test.ts`, `docs/operations.md` (the extension settings; `YODA_EXTENSION_DIRS`; the webhook's Deployment events; the defect upload limit for a hospital's own reverse proxy, e.g. nginx `client_max_body_size 56m` for `/api/extension/defects`; retention), `docs/guides/admin.md` (Connected browsers, allowlist, application URLs), `docs/guides/staff.md` and `staff.th.md` (Help page, reporting), `CHANGELOG.md` (an `unreleased` entry)

The Caddyfile change, inside the site block:

```
@defects path /api/extension/defects
request_body @defects {
	max_size 56MiB
}
```

Keep the existing 32 MiB `request_body` for everything else. Check that Caddy applies the matcher-specific block to that path; the release dry run's `caddy validate` covers the syntax.

- [ ] **Step 1: Write a failing test** in `ops-ci.test.ts`: `caps /api/extension/defects at 56MiB and everything else at 32MiB`.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/ops-ci.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the Caddyfile change and the docs.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: PASS.
- [ ] **Step 5: Verify on the demo stack.** Approve a connect request as a staff user, with the curl walkthrough from `docs/development.md`: authorize with a PKCE pair, then the token exchange. Then post a defect with `apps/core/scripts/dev-post-defect.ts`, a helper marked `// DEV ONLY` that uses `encodeDefectForm`. See the card. Revoke in Settings. Take screenshots (desktop and phone) of the connect page, Connected browsers (both), the project's Application URLs tab, the defect card and Help, plus the GIF.
- [ ] **Step 6: Commit** `docs: Yoda Reporter server side, runbook and guides`, push, and open PR A with the test plan.

---

## PR B: the extension MVP (`feat/extension-mvp`)

### Task B1: Phase 0 spike

Prototype only in a scratch directory, with no production code. Write the findings to `docs/design/extension-spike.md`, with commands and evidence:
1. `launchWebAuthFlow` against the demo portal and its Keycloak, in Chrome and Edge. Does the SSO cookie reach the auth window? Does the `chromiumapp.org` redirect resolve in Edge?
2. `captureVisibleTab` in Playwright's new headless Chromium with the e2e host permission.
3. Playwright:
   - loading the unpacked extension;
   - reading the ID from `context.serviceWorkers()`;
   - opening `popup.html?tab=` as a page;
   - driving the `launchWebAuthFlow` window: is it a page Playwright sees?
4. `tabCapture.getMediaStreamId` in automation with `--allowlisted-extension-id` and `--auto-accept-this-tab-capture`.
5. A force-install with `ExtensionSettings` and `override_update_url` on one managed Chrome and one managed Edge (Windows VM), using a CRX from `chrome --pack-extension` and a throwaway key.

Record each answer and the fallback chosen (decision 2). Commit `docs: Yoda Reporter phase 0 spike findings`.

### Task B2: `apps/extension` skeleton, manifest, theme and i18n

**Files:**
- Create:
  - `apps/extension/package.json` (`@yoda/extension`, version = the root version; scripts `dev`, `build`, `build:e2e`, `build:zip`, `typecheck`, `e2e`, `demo`, `check:dist`);
  - `apps/extension/vite.config.ts`, `apps/extension/vitest.config.ts`, `apps/extension/tsconfig.json`;
  - `apps/extension/src/manifest.ts`, `apps/extension/scripts/build-manifest.ts`;
  - `apps/extension/src/{popup,editor,options,offscreen}/index.html` and `main.ts`;
  - `apps/extension/src/sw/index.ts`, `apps/extension/src/injected/{isolated,main}.ts` (built as self-contained IIFEs in a second Vite build);
  - `apps/extension/src/ui/vuetify.ts`, `apps/extension/src/i18n/{th,en}.json`, `apps/extension/src/i18n/index.ts`;
  - `apps/extension/test/manifest.test.ts`, `apps/extension/test/i18n.test.ts`.
- Create `packages/shared/src/ui/vuetify-theme.ts` (the plain objects `vuetifyTheme` and `vuetifyDefaults`, moved from the portal) and modify `apps/portal/app/plugins/vuetify.ts` to import them.
- Modify: `pnpm-lock.yaml`, `.gitignore` (`apps/extension/release/`), `.dockerignore` if it excludes `keys/`.

**Interfaces (Produces):**
- `buildManifest(opts: { yodaVersion: string; publicKey: string | null; target: 'release' | 'e2e' }): chrome.runtime.ManifestV3`:
  - permissions exactly as §5, with `minimum_chrome_version: '116'` and the `_execute_action` command `Alt+Shift+Y`;
  - `storage.managed_schema` is added in D2, not here;
  - `key` only when `publicKey` is given (read from `keys/yoda-reporter.pub` when present, or `YODA_EXTENSION_PUBLIC_KEY_FILE` for tests);
  - the `e2e` target adds `host_permissions: ['<all_urls>']`;
  - `version` and `version_name` come from `manifestVersion`;
  - no `content_scripts`, no `web_accessible_resources`, no `externally_connectable`.
- The `apps/extension/release/` output holds `yoda-reporter-<version>.zip`, built from `dist/` by `scripts/zip.ts` with sorted entries and every mtime = `SOURCE_DATE_EPOCH`.

- [ ] **Step 1: Write failing tests**:
  - `release manifest has exactly the required and optional permissions of §5 and none of the forbidden keys`;
  - `e2e manifest differs only by host_permissions`;
  - `version follows manifestVersion and package.json equals the root version`;
  - `key is present only with a public key`;
  - `th and en have identical keys and no HTML-like messages`;
  - `the portal still builds its theme from the shared object` (portal `components.test.ts` keeps passing).
- [ ] **Step 2: Run** `pnpm vitest run apps/extension` — Expected: FAIL.
- [ ] **Step 3: Implement** the skeleton: Vuetify with the shared theme, IBM Plex fonts bundled through `@fontsource` (the portal's versions), and `vue-i18n` with Thai default and a ไทย/EN switch remembered in `storage.local`.
- [ ] **Step 4: Run** `pnpm install && pnpm vitest run apps/extension apps/portal && pnpm typecheck && pnpm --filter @yoda/extension build` — Expected: PASS, and `dist/manifest.json` exists.
- [ ] **Step 5: Commit** `feat(extension): skeleton, manifest, theme and i18n`

### Task B3: Service worker core: messages, storage, API client

**Files:**
- Create: `apps/extension/src/sw/messages.ts`, `apps/extension/src/sw/store.ts`, `apps/extension/src/sw/api.ts`, `apps/extension/test/{messages,api}.test.ts`, `apps/extension/test/support/chrome.ts` (an in-memory `chrome.*` fake for unit tests)

**Interfaces (Produces):**
- `Msg`, a zod discriminated union of every runtime message: `profile.connect`, `profile.exchange`, `profile.remove`, `session.get`, `capture.arm`, `capture.screenshot`, `capture.fullPage`, `draft.get`, `draft.save`, `report.send`, and later `video.*` and `buffer.*`.
- `onMessage(handler)` accepts only `sender.id === chrome.runtime.id`. It accepts `sender.tab` only for `capture.collected` from our injected scripts, with a matching per-injection nonce.
- `store.ts`:
  - `profiles(): Promise<Profile[]>`, where `Profile = { id, name, colour, url, isDefault, managed, sessionOnly, grantId, person }`, in `storage.local`;
  - `accessToken(profileId)` and `setTokens(profileId, t)`: the access token in `storage.session`; the refresh token in `storage.local`, or in `storage.session` when `sessionOnly`.
- `api.ts`:
  - `yodaFetch(profileId, path, init): Promise<Response>` adds the bearer;
  - on 401, `refreshOnce(profileId)` runs a single flight shared by concurrent callers through a promise kept per profile and a `storage.session` lock entry, then retries once;
  - `reauth_required` or `revoked` marks the profile "reconnect needed";
  - `checkVersion(session)` gives `'ok' | 'update_available' | 'api_too_new'`.

- [ ] **Step 1: Write failing tests**:
  - Messages:
    - `messages from another extension id or a web page are ignored`;
    - `unknown message types are rejected by the schema`.
  - Tokens:
    - `three concurrent 401s cause one refresh`;
    - `a refresh answering reauth_required marks the profile and does not retry`;
    - `sessionOnly keeps the refresh token in storage.session`.
  - Version:
    - `checkVersion compares manifestVersion versions`;
    - `apiVersion 2 gives api_too_new`.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension` — Expected: FAIL.
- [ ] **Step 3: Implement** them. Keep no state in service-worker globals beyond in-flight promises.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): service worker messaging, storage and API client`

### Task B4: Connect flow

**Files:**
- Create: `apps/extension/src/sw/connect.ts`, `apps/extension/src/options/ConnectDialog.vue`, `apps/extension/test/connect.test.ts`

**Interfaces:**
- `startConnect(url: string): Promise<Profile>`:
  1. normalise the URL: HTTPS, or `http://localhost` / `127.0.0.1`;
  2. `GET <url>/api/public-config` must parse as `PublicConfig` with `extension.enabled`;
  3. `permissions.request({ origins: [origin + '/*'] })`;
  4. PKCE: 32 random bytes for the verifier, an S256 challenge, a random state;
  5. `launchWebAuthFlow({ url: <origin>/extension/connect?…, interactive: true })`;
  6. check `state`, then send `profile.exchange`.
- `exchange(origin, code, verifier)` → `POST /api/extension/token` → stores the profile.
- The browser label is `navigator.userAgentData` brand, version and platform, at most 120 characters.

- [ ] **Step 1: Write failing tests** with the chrome fake and a fetch stub:
  - `refuses http to a non-localhost host`;
  - `refuses a site whose public-config is not Yoda`;
  - `a state mismatch aborts without exchanging`;
  - `error=access_denied gives a cancelled result`;
  - `the PKCE challenge is S256 of the verifier`;
  - `the stored profile has no code or verifier`.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/test/connect.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them, with the origin shown in large text in the dialog (T9).
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): connect to Yoda with launchWebAuthFlow and PKCE`

### Task B5: Metadata and build detection

**Files:**
- Create: `apps/extension/src/capture/metadata.ts`, `apps/extension/src/capture/build.ts`, `apps/extension/src/injected/isolated.ts`, `apps/extension/test/build.test.ts`, `apps/extension/test/metadata.test.ts`

**Interfaces:**
- `parseYodaBuild(content: string): Partial<Build>`, for the meta and header format: `;`-separated `key=value` pairs, percent-decoded, unknown keys dropped, each value at most 200 characters.
- `detectBuild(sources: { meta: string | null; wellKnown: unknown | null; headers: string[]; gitlab: MappingRule['build'] }): Build | null`, chosen in the order meta, then well-known, then header, then gitlab, with its `source` set. Manual entry is the form's.
- `collectMetadata()` runs in the ISOLATED world. It reads the URL, title, route (`location.pathname + hash`, plus `<meta name=yoda-route>`), the viewport, `devicePixelRatio`, the locale and time zone, and `userAgentData.getHighEntropyValues`. It fetches `/.well-known/yoda-build.json` same-origin with a 1 s timeout and reads `X-Yoda-Build` from it.
- `stripQuery(url)` serves the form's "include query string" switch (on by default).

- [ ] **Step 1: Write failing tests**:
  - `parseYodaBuild` handles `repo=group/appt-web;branch=feature%3Bx;commit=3f9c2e1;env=uat`, empty values, junk and an overlong value;
  - `detectBuild` precedence and `source`;
  - `stripQuery` keeps the hash.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/test/build.test.ts apps/extension/test/metadata.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): page metadata and build detection`

### Task B6: Console and network capture (MAIN world)

**Files:**
- Create: `apps/extension/src/injected/main.ts`, `apps/extension/src/capture/bridge.ts`, `apps/extension/src/capture/logs.ts`, `apps/extension/test/logs.test.ts`

**Interfaces:**
- `main.ts`, injected on "arm" or capture with `scripting.executeScript({ world: 'MAIN' })`, idempotent per page:
  - wraps the `console.*` methods, `onerror`, `unhandledrejection`, `fetch` and XHR (method, URL, status, duration, and the `X-Yoda-Build` response header only; never other headers or bodies);
  - keeps a ring buffer of 500 entries;
  - posts `{ type: 'yoda-reporter/v1', nonce, entries }` to `window`.
- `bridge.ts` (ISOLATED) accepts only `event.source === window` messages with the type and nonce, and forwards them to the service worker.
- `resourceFailures(entries: PerformanceResourceTiming[]): NetworkEntry[]` keeps `responseStatus >= 400`, or 0 with `transferSize 0` on a same-origin entry.
- `sanitizeEntries(raw: unknown[]): { console: ConsoleEntry[]; network: NetworkEntry[]; dropped: number }` validates with the shared schemas, truncates messages to 2048 characters, and keeps the newest 500 of each.
- `backendBuilds(network): { origin; repo?; branch?; commit? }[]` gives at most 10, one per origin.

- [ ] **Step 1: Write failing tests**:
  - `10 000 entries keep the newest 500`;
  - `a 1 MB message is cut to 2048 characters`;
  - `non-schema entries are dropped and counted`;
  - `HTML in a message stays text` (the editor renders with `{{ }}`; assert no `v-html` in `src/`);
  - `resourceFailures` picks a 500 and a blocked same-origin load;
  - `backendBuilds` dedupes per origin;
  - `main.ts wraps fetch without changing its result or rejection` (run `main.ts` in a vitest `happy-dom` environment for this file only).
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/test/logs.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): console and network capture without debugger`

### Task B7: Screenshots: visible area and full page (beta)

**Files:**
- Create: `apps/extension/src/capture/screenshot.ts`, `apps/extension/src/capture/stitch.ts`, `apps/extension/test/stitch.test.ts`

**Interfaces:**
- `captureVisible(tabId): Promise<Blob>` uses `captureVisibleTab` and gives a PNG.
- `planStitch(page: { scrollHeight; viewportHeight; dpr }, cap = 15000): { offsets: number[]; truncated: boolean }`.
- `captureFullPage(tabId, onProgress)`:
  - detects the scroller: the document, or the tallest `overflow-y: auto|scroll` element filling the viewport;
  - hides `position: fixed|sticky` elements after the first frame;
  - captures at most 2 per second;
  - restores scroll and styles in a `finally`;
  - falls back to `captureVisible` with a notice.

- [ ] **Step 1: Write failing tests**:
  - `planStitch` for 1, 2.5 and 40 screens;
  - `the 15000 px cap gives truncated: true`;
  - `dpr 2` halves the CSS cap.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/test/stitch.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them. The real capture is covered by the B12 e2e.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): visible and full-page screenshots`

### Task B8: Drafts and the editor shell

**Files:**
- Create: `apps/extension/src/drafts/db.ts`, `apps/extension/src/editor/App.vue`, `apps/extension/test/drafts.test.ts`

**Interfaces:**
- `Draft = { id; createdAt; profileId; tabUrl; metadata; build; console; network; images: { role; blob }[]; video?: Blob; buffer?: Blob[]; editorDoc?: EditorDoc; form?: DraftForm; idempotencyKey: string }`, stored in the IndexedDB database `yoda-drafts`.
- `putDraft`, `getDraft`, `deleteDraft`, and `purgeOldDrafts(now)`, which removes drafts older than 24 h. The service worker calls it on startup and every time it opens the editor.
- The editor opens at `editor.html?draft=<id>`. It restores `editorDoc` and `form` from the draft, and saves both, debounced, on every change.

- [ ] **Step 1: Write failing tests** (`fake-indexeddb`):
  - `a draft survives a reload and keeps its idempotency key`;
  - `drafts older than 24 h are purged`;
  - `deleteDraft removes the images`.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/test/drafts.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): drafts in IndexedDB and the editor shell`

### Task B9: Annotation editor: tools, mosaic, flatten

**Files:**
- Create: `apps/extension/src/editor/doc.ts`, `apps/extension/src/editor/pixels.ts`, `apps/extension/src/editor/flatten.ts`, `apps/extension/src/editor/Canvas.vue` (Konva), `apps/extension/src/editor/Toolbar.vue`, `apps/extension/test/{doc,pixels,flatten}.test.ts`
- Modify: `docs/design/mockups/extension-editor.html` only if the toolbar order differs from it (the mosaic button is added with this plan).

**Interfaces (Produces):**
- `Op` is one of:
  - `{ kind: 'arrow'; points: [x1, y1, x2, y2]; colour; width }`;
  - `{ kind: 'box' | 'highlight'; rect; colour }`;
  - `{ kind: 'text'; at; text: string.max(500); colour; size }`;
  - `{ kind: 'step'; at; n: number }`;
  - `{ kind: 'blur'; rect; radius }`;
  - `{ kind: 'redact'; rect }`;
  - `{ kind: 'mosaic'; mode: 'rect'; rect; block }`;
  - `{ kind: 'mosaic'; mode: 'brush'; points: number[]; width; block }`;
  - `{ kind: 'crop'; rect }`.

  `EditorDoc = { width; height; ops: Op[] }`.
- Pure history functions in `doc.ts`: `apply(doc, cmd)`, `undo(state)` and `redo(state)` with `State = { doc; past: EditorDoc[]; future: EditorDoc[] }` (at most 100 steps); `nextStepNumber(doc)`.
- `pixels.ts`:
  - `pixelate(img: { data: Uint8ClampedArray; width; height }, rect, block): void` (each block is filled with its mean colour, edges clamped);
  - `cellsInStroke(points, width, block, w, h): number[]` (cell indices whose square intersects the stroke capsule);
  - `pixelateCells(img, cells, block)`;
  - `redactRect(img, rect, rgb = [26, 36, 51])`.
- `flatten(base: ImageBitmap, doc: EditorDoc): Promise<Blob>`:
  1. on an OffscreenCanvas, apply the destructive ops (blur with `ctx.filter = 'blur(Npx)'` on the clipped rect, redact, mosaic rect, mosaic brush) in document order to the base pixels;
  2. draw the vector ops (arrow, box, highlight, text, step) from a Konva stage `toCanvas({ pixelRatio: 1 })`;
  3. apply the last `crop`;
  4. export a PNG.

  Only this output is uploaded; the original bitmap is dropped with the draft.
- Defaults:
  - the mosaic block is `max(12, round(min(w, h) / 60))` image pixels, with a slider from 8 to 48;
  - the brush is 32 px wide;
  - the blur radius is 12 px.
- Shortcuts: A arrow, B box, H highlight, T text, N step, U blur, M mosaic (Shift+M switches rectangle or brush), R redact, C crop, Ctrl+Z, and Ctrl+Shift+Z / Ctrl+Y.
- Toolbar order, as the mockup: select, arrow, box, highlight, text, step | blur, **mosaic**, redact, crop | undo, redo | colours.

- [ ] **Step 1: Write failing tests**:
  - `pixels.test.ts`:
    - `pixelate makes every block inside the rect uniform and leaves pixels outside unchanged`;
    - `block edges at the image border are clamped`;
    - `cellsInStroke covers a diagonal stroke and nothing farther than width/2 + block`;
    - `redact fills exactly the rect`.
  - `doc.test.ts`:
    - `undo and redo restore the exact doc`;
    - `a new op clears the redo stack`;
    - `history is capped at 100`;
    - `step numbers continue after undo`.
  - `flatten.test.ts` (node-canvas-free: run `flatten`'s pixel stage through `applyDestructive(imgData, ops)`):
    - `mosaic then arrow: the arrow pixels are not pixelated`;
    - `crop applies last`;
    - `the exported pixels inside a mosaic rect differ from the original` (for a gradient source).
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/test/pixels.test.ts apps/extension/test/doc.test.ts apps/extension/test/flatten.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the pure modules, then `Canvas.vue` and `Toolbar.vue`. Konva shapes render the preview: mosaic previews as a pixelated `Konva.Image` clipped to the rect or brush path. Every tool has a `data-testid` (`tool-mosaic`, `tool-mosaic-brush`…).
- [ ] **Step 4: Run** the same command and `pnpm --filter @yoda/extension typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): annotation editor with blur, mosaic and redact burned in`

### Task B10: Report form, check before sending, send

**Files:**
- Create: `apps/extension/src/editor/ReportForm.vue`, `apps/extension/src/editor/ReviewPanel.vue`, `apps/extension/src/report/build-report.ts`, `apps/extension/src/sw/send.ts`, `apps/extension/test/{build-report,send}.test.ts`

**Interfaces:**
- `buildReport(draft, form, ctx: { profile; project; production: boolean; includeQuery: boolean; extensionVersion }): { report: DefectReportCreate; files: { part; name; type; data: Blob }[] }`:
  - file names are `screenshot.png`, `screenshot-full.png`, `video.webm`, `buffer-1.webm`, `buffer-2.webm`, `console.json` and `network.json`;
  - files the tester unticked are left out;
  - on production, console and network are included only when the tester turned them on for this report.
- `sendReport(draftId)`:
  1. reuses `draft.idempotencyKey`;
  2. `POST /api/extension/defects` with `encodeDefectForm`;
  3. retries network failures and 5xx 3 times with backoff, keeping the same key;
  4. maps 413 to "remove a file (limit X)", 415, 422 `video_on_production` and 429 (`retryAfter`) to messages;
  5. on 200 or 201, deletes the draft and shows the work item link.
- `ReviewPanel` shows:
  - every file with its size and a checkbox;
  - the required tick "I checked the screenshot and video: there is no patient data, or it is hidden with mosaic or redact" (Send is disabled until ticked);
  - the optional tick "the text may contain patient data";
  - the AI line: "Not sent to AI" for a noAi project or when the optional tick is set, otherwise "Text may be read by AI; media and logs never";
  - on production, a red `v-alert` warning.

- [ ] **Step 1: Write failing tests**:
  - `buildReport` sets `confirmedNoPatientData` only when ticked (otherwise throws);
  - `on production, video and buffer are never included and logs only when turned on`;
  - `includeQuery=false strips the query`;
  - `unticked files are omitted`;
  - `send retries a 503 with the same Idempotency-Key and deletes the draft on 201`;
  - `413 shows the limit and keeps the draft`;
  - `429 waits retryAfter`.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/test/build-report.test.ts apps/extension/test/send.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them. The form fields are kind (defect or bug-fix request), title, severity, steps (a list), expected, actual and description, with metadata and build shown with their source and editable.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): report form, check before sending and send`

### Task B11: Popup and profiles

**Files:**
- Create: `apps/extension/src/popup/App.vue`, `apps/extension/src/popup/target.ts`, `apps/extension/src/sw/profiles.ts`, `apps/extension/test/{target,profiles}.test.ts`

**Interfaces:**
- `resolveTargetTab(search: string, queryActive: () => Promise<chrome.tabs.Tab>): Promise<number>`: `?tab=<id>` is honoured only in the e2e build (`import.meta.env.VITE_TARGET === 'e2e'`); otherwise it uses the active tab.
- `profiles.ts`: `addProfile`, `removeProfile` (calls `/extension/revoke`, then forgets the tokens), `setDefault`, and `pickProfileFor(url, profiles, rules)`, which until C3 gives the default profile.
- The popup, as `extension-popup.html`, shows:
  - the profile chip (switcher), the project picker (session projects, or the rule's project), and the build line with its source;
  - console and network counts after arming;
  - the actions Screenshot, Full page (beta), Arm capture and Text only;
  - toggles to attach the console log and the failed requests;
  - the "update available" and "reconnect" banners.

- [ ] **Step 1: Write failing tests**:
  - `?tab is ignored in the release build`;
  - `removing a profile revokes and forgets tokens`;
  - `exactly one default profile remains`.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/test/target.test.ts apps/extension/test/profiles.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): popup and Yoda profiles`

### Task B12: Playwright e2e with a stub Yoda, and the demo recording

**Files:**
- Create: `apps/extension/playwright.config.ts`, `apps/extension/e2e/fixtures.ts`, `apps/extension/e2e/stub-yoda.ts`, `apps/extension/e2e/app-under-test/index.html`, `apps/extension/e2e/report.spec.ts`, `apps/extension/e2e/demo.spec.ts`
- Modify: `.github/workflows/ci.yml` (job `extension`), `apps/core/test/ops-ci.test.ts`

**Interfaces:**
- The fixture `withExtension`:
  - builds `build:e2e` once, with a throwaway key made in the test's temp directory (never committed), giving a fixed ID per run;
  - calls `chromium.launchPersistentContext('', { channel: 'chromium', args: ['--disable-extensions-except=<dist>', '--load-extension=<dist>'], recordVideo? })`;
  - exposes `extensionId`, `sw` (from `context.serviceWorkers()`) and `openPopup(tabId)`.
- `stub-yoda.ts` serves the endpoints below and records every report it receives, for the test to assert on:
  - `/api/public-config`;
  - `/extension/connect`: a page with an Approve button that redirects to `chromiumappRedirect(ext)?code&state`;
  - `/api/extension/{token,session,mappings,defects,revoke}`, validating with the shared schemas and answering 400 with zod issues otherwise.
- The app under test carries:
  - `<meta name="yoda-build" content="repo=demo/app;branch=feature/x;commit=abc1234;env=uat">`;
  - a button that logs `console.error('boom')` and fetches a 500 endpoint;
  - mock patient fields with synthetic values only.

- [ ] **Step 1: Write the failing spec** `report.spec.ts`, `connect, arm, reproduce, screenshot, mosaic, send`:
  1. connect, through the auth window if the B1 spike allows, else the `profile.exchange` fallback;
  2. open the app, arm capture, click the failing button;
  3. take a screenshot; the editor opens;
  4. draw a mosaic rectangle with `tool-mosaic` and one brush stroke;
  5. add an arrow and a step number;
  6. fill the form, tick the confirmation, send.

  Assert:
  - the stub received one report with `build.commit === 'abc1234'`, `source === 'meta'`;
  - `console.json` has the `boom` error and `network.json` has the 500;
  - the uploaded PNG's pixels inside the mosaic rect are block-uniform (decoded in a test page with `createImageBitmap` and `getImageData`);
  - the success link is shown;
  - a second spec, `production rule hides video and turns logs off`, uses a stub mapping with `production: true`.
- [ ] **Step 2: Run** `pnpm --filter @yoda/extension e2e` — Expected: FAIL (the specs fail, or the build is missing).
- [ ] **Step 3: Implement** the fixtures, the stub and the CI job. The `extension` job (ubuntu-24.04):
  1. `pnpm install --frozen-lockfile --ignore-scripts`;
  2. `pnpm --filter @yoda/extension exec playwright install --with-deps chromium`;
  3. `pnpm --filter @yoda/extension build:e2e && pnpm --filter @yoda/extension e2e`;
  4. upload the Playwright report and traces on failure only.

  Add an ops-ci test that `ci.yml has the extension job running the e2e`.
- [ ] **Step 4: Run** `pnpm --filter @yoda/extension e2e && pnpm vitest run apps/core/test/ops-ci.test.ts` — Expected: PASS.
- [ ] **Step 5: Record the demo.** `pnpm --filter @yoda/extension demo` runs `demo.spec.ts` with `recordVideo` at 1280×800, with the same steps at human pace. Convert it with `ffmpeg -i <video> -vf fps=8,scale=960:-1 docs/design/screenshots/extension/demo-mvp.gif`. Expected: a GIF of 2 MB or less.
- [ ] **Step 6: Commit** `test(extension): Playwright e2e against a stub Yoda, and the demo`

### Task B13: The zip in CI and in the core image; release version checks

**Files:**
- Create: `apps/extension/scripts/check-dist.ts`
- Modify:
  - `.github/workflows/ci.yml` (`extension` job: `build:zip`, then `check:dist`, then gitleaks over `apps/extension/dist` with `detect --no-git --source`);
  - `apps/core/Dockerfile` (stage `extension`: `pnpm install --frozen-lockfile --ignore-scripts --filter @yoda/extension...`, then `pnpm --filter @yoda/extension build:zip`; copy `apps/extension/release/` to `/app/extension/`);
  - `.github/workflows/release.yml` (`meta` also checks `apps/extension/package.json`; on a real release, `keys/yoda-reporter.pub` must exist and `OFFICIAL_EXTENSION_ID` must equal its derived ID, otherwise `::error::` with the owner step from `docs/releasing.md`; `apps/extension/**` joins the `pull_request.paths`);
  - `packages/shared/test/extension.test.ts` (when `keys/yoda-reporter.pub` exists, `OFFICIAL_EXTENSION_ID` matches it; when it is null, the file is absent);
  - `apps/core/test/ops-ci.test.ts`;
  - `docs/releasing.md` (the version rule, the zip in the core image, and the owner's key step, written for D but needed from the first tag after B);
  - `docs/development.md` (building, loading unpacked, the dev ID and allowlisting it, running the e2e);
  - `CHANGELOG.md`.

**Interfaces:** `check-dist.ts <dir|zip>` exits non-zero when:
- `manifest.json` breaks the §5 rules;
- any `.js` file contains `eval(`, `new Function(` or a remote `http(s)://` script URL other than the profile's runtime fetches;
- any file matches the gitleaks-style patterns for private keys;
- the zip's manifest `version_name` is not the package version.

- [ ] **Step 1: Write failing tests**:
  - `check-dist` refuses a planted `host_permissions` entry and a planted `-----BEGIN PRIVATE KEY-----` (fixtures under `apps/extension/test/fixtures/`);
  - `ops-ci`: `ci.yml builds and checks the zip and scans it with gitleaks`, `the core image carries the extension zip`, and `the release meta step checks the extension version and the public key`.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension apps/core/test/ops-ci.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them.
- [ ] **Step 4: Run**:
  - `pnpm --filter @yoda/extension build:zip && pnpm --filter @yoda/extension check:dist release/yoda-reporter-$(node -p "require('./package.json').version").zip` — Expected: OK;
  - `docker build -f apps/core/Dockerfile -t yoda/core .`, then `docker run --rm yoda/core ls /app/extension` — Expected: the zip.
- [ ] **Step 5: Verify** on the demo stack with the zip loaded unpacked in Chrome and in Edge: connect, report, and see the card in the portal. Take screenshots of the popup, editor (mosaic visible), options and the Help page with a working download.
- [ ] **Step 6: Commit** `build(extension): zip in CI and in the core image, release checks`, push, and open PR B (stacked on A) with the test plan, screenshots and the GIF.

---

## PR C: video, URL mapping, options page (`feat/extension-video-mapping`)

### Task C1: 30 s clips (tabCapture and an offscreen MediaRecorder)

**Files:**
- Create: `apps/extension/src/offscreen/recorder.ts`, `apps/extension/src/sw/video.ts`, `apps/extension/test/recorder.test.ts`, `docs/design/extension-spike.md` (section "Video re-encode measurement")
- Modify: `apps/extension/src/popup/App.vue`, `apps/extension/src/sw/messages.ts`

**Interfaces:**
- `startClip(tabId)`:
  1. `permissions.request({ permissions: ['tabCapture'] })` the first time;
  2. `tabCapture.getMediaStreamId({ targetTabId })`;
  3. `offscreen.createDocument({ reasons: ['USER_MEDIA'] })`;
  4. send `video.start { streamId, maxSeconds }`.
- `stopClip()` → a `Blob`.
- `pickMimeType(isSupported): string` prefers `video/webm;codecs=vp9`, then `vp8`.
- The recorder: about 1 Mbit/s, at most 1280 px wide, no audio, a hard stop at `session.limits.maxVideoSeconds`; `fixDuration(blob, ms)` with `fix-webm-duration`.
- Production rules (`rule.production`) hide the video action, and the service worker refuses `video.start` on such a tab.
- The measurement for decision 1 runs the C2 pipeline in the offscreen document and in the editor tab on a 30 s synthetic clip and records the frame ratio of each.

- [ ] **Step 1: Write failing tests**:
  - `pickMimeType` falls back to vp8;
  - `the recorder stops at maxSeconds` (fake timers, a fake `MediaRecorder`);
  - `video.start is refused on a production tab`;
  - `the offscreen document is closed after stop`.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/test/recorder.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them, and record the measurement in the spike doc.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): 30-second tab clips`

### Task C2: Mosaic on video

**Files:**
- Create: `apps/extension/src/editor/VideoEditor.vue`, `apps/extension/src/video/regions.ts`, `apps/extension/src/video/reencode.ts`, `apps/extension/test/regions.test.ts`

**Interfaces:**
- `VideoRegion = { id; rect; fromMs; toMs; block }` (rectangle only on video). `activeRegions(regions, tMs): VideoRegion[]` uses `fromMs` inclusive and `toMs` exclusive.
- `reencodeWithMosaic(src: Blob, regions: VideoRegion[], opts: { mimeType; bitsPerSecond; onProgress(p: number); signal: AbortSignal }): Promise<{ blob: Blob; framesIn: number; framesOut: number }>`, implemented as decision 1 describes.
- `acceptReencode(r): 'ok' | 'too_lossy'` (`framesOut / framesIn < 0.9` is too lossy).
- The editor shows:
  - a timeline with a scrubber;
  - a drag on the frame draws a region, and range handles set its time range;
  - for each region, a list row with a delete button;
  - an "Apply mosaic" action with a progress bar and Cancel.

  The result replaces the draft's video. With regions and no successful apply, Send is disabled for the video: the fallback dialog offers "send without video" or "use a still frame".
- The fallback: `stillFrame(src, tMs): Promise<ImageBitmap>` goes into the screenshot editor with the active regions pre-added as mosaic rect ops.

- [ ] **Step 1: Write failing tests**:
  - `activeRegions` boundaries;
  - `acceptReencode`;
  - `a video with unapplied regions cannot be sent` (`buildReport` throws `mosaic_not_applied`);
  - an e2e step in C5 covers the real pipeline.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/test/regions.test.ts apps/extension/test/build-report.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): mosaic regions on video, applied by re-encoding`

### Task C3: URL mapping engine

**Files:**
- Create: `apps/extension/src/rules/match.ts`, `apps/extension/src/sw/rules.ts`, `apps/extension/test/match.test.ts`

**Interfaces:**
- `Rule = { id; pattern; profileId; projectId: string | null; environment: string | null; production: boolean; source: 'policy' | 'yoda' | 'mine'; order: number }`.
- `pickRule(url, rules): { rule: Rule; why: string[] } | null`:
  1. only rules whose pattern matches the URL (`matchesPattern`) count;
  2. the most specific wins (`patternSpecificity`: literal host over wildcard, longer host, longer path);
  3. ties go to `policy`, then `yoda`, then `mine`;
  4. then to the lower `order`.

  `why` lists the comparisons, for the URL tester.
- `projectFor(url, build, rules, sessions)` returns the rule's project. Without a rule, it maps `build.repo` to a member project of the default profile. Otherwise it returns null, and the popup's picker shows only reportable projects.
- `rules.ts` caches `/extension/mappings` per profile for `ttlSeconds` and refreshes it when the popup opens. Yoda rules may target only their own profile (T11).

- [ ] **Step 1: Write failing tests**, a table covering:
  - each precedence step;
  - port-specific `localhost` rules;
  - a Yoda rule never mapping to another profile;
  - the `repo` fallback choosing only a member project;
  - `why` naming the winning reason;
  - `a production rule makes the popup state production`.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/test/match.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them, and wire `pickProfileFor` (B11) to `pickRule`.
- [ ] **Step 4: Run** `pnpm vitest run apps/extension` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): URL mapping, most specific rule wins`

### Task C4: Options page

**Files:**
- Create: `apps/extension/src/options/App.vue`, `apps/extension/src/options/{Profiles,Rules,UrlTester,Permissions}.vue`, `apps/extension/test/options.test.ts`

**Interfaces:**
- The page follows `extension-setup.html`:
  - profiles: add (connect), make default, colour, "sign out when the browser closes", remove;
  - rules, grouped by source, where only `mine` rules are editable and the others show a lock with their source;
  - the URL tester: paste a URL, see `pickRule`'s winner and `why`;
  - granted origins, from `permissions.getAll()`, each with Remove (`permissions.remove`);
  - the language switch.
- `validateRuleInput(r): string[]` (pattern valid, profile exists, `too_broad` refused).

- [ ] **Step 1: Write failing tests**:
  - `validateRuleInput`;
  - `locked rules cannot be edited or deleted through the store API`;
  - `removing an origin also removes rules that need it for capture from load` (none in C; assert a no-op).
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/test/options.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): options page with profiles, rules and URL tester`

### Task C5: E2E, demo and PR C verification

**Files:**
- Modify: `apps/extension/e2e/report.spec.ts` (new specs), `apps/extension/e2e/fixtures.ts` (launch flags `--allowlisted-extension-id=<id>` and `--auto-accept-this-tab-capture`, if B1 confirmed them), `apps/extension/e2e/stub-yoda.ts` (mappings), `docs/guides/staff.md` and `staff.th.md`, `CHANGELOG.md`

- [ ] **Step 1: Write failing specs**:
  - `record 5 s, add a mosaic region 1–3 s, apply, send`: the stub receives `video.webm`; in the page, sample frames at 2 s and 4 s and assert the region is block-uniform at 2 s and not at 4 s, within a codec tolerance of a per-block standard deviation under 6.
  - `a mapping from Yoda picks the project; a mine rule for localhost loses to a more specific Yoda rule; the URL tester explains it`.
  - When tabCapture cannot be driven in CI (B1 result), the video spec records a `canvas.captureStream()` source through the same recorder and editor path, and the tabCapture step stays a manual check in the PR test plan.
- [ ] **Step 2: Run** `pnpm --filter @yoda/extension e2e` — Expected: FAIL.
- [ ] **Step 3: Fix** what fails.
- [ ] **Step 4: Run** `pnpm --filter @yoda/extension e2e && pnpm test` — Expected: PASS.
- [ ] **Step 5: Demo:** `demo-video-mosaic.gif` and `demo-mapping.gif`, plus screenshots of the options page and the video editor. Commit `test(extension): video mosaic and mapping e2e, demo`, push, and open PR C.

---

## PR D: rolling buffer, managed install (`feat/extension-enterprise`)

### Task D1: Rolling buffer

**Files:**
- Create: `apps/extension/src/offscreen/buffer.ts`, `apps/extension/src/sw/buffer.ts`, `apps/extension/test/buffer.test.ts`

**Interfaces:**
- `class SegmentRing { constructor(segmentMs = 30000); push(chunk); rotate(); snapshot(): Blob[] }` holds the previous complete segment and the current one, in memory only. The recorder restarts at every rotation.
- `armBuffer(tabId)` is user-initiated (popup), needs tabCapture, and sets the red badge (`action.setBadgeText({ text: '●', tabId })` with the error colour).
- `disarmBuffer(reason: 'saved' | 'timeout' | 'left_mapped_site' | 'production' | 'tab_closed' | 'user')`: 15 minutes without a save, leaving a mapped site (`tabs.onUpdated` URL change re-checked with `pickRule`), production or a tab close disarms it.
- `saveBuffer()` → `buffer-1.webm` and `buffer-2.webm` into a new draft. Mosaic regions (C2) apply per segment, with the time offsets of the joined timeline.
- `allowBuffer` (policy, D2) false hides it.

- [ ] **Step 1: Write failing tests**:
  - `snapshot after 75 s gives two segments covering 45–75 s` (fake timers);
  - `nothing is written to IndexedDB or storage while armed`;
  - `each disarm reason stops the recorder and clears the badge`;
  - `production never arms`;
  - `regions spanning the segment boundary are split per segment`.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/test/buffer.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them. The portal card plays buffer segments back to back (extend `DefectCard.vue` and `defectView.ts` with `bufferPlaylist(list)`, tested in `apps/portal/test/defectView.test.ts`).
- [ ] **Step 4: Run** `pnpm vitest run apps/extension apps/portal` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): rolling 30-second buffer`

### Task D2: Managed configuration (`storage.managed`) and policy docs

**Files:**
- Create: `apps/extension/public/managed-schema.json`, `apps/extension/src/sw/policy.ts`, `apps/extension/test/policy.test.ts`, `docs/guides/extension-admin.md` (Chrome and Edge GPO paths, Intune JSON, `ExtensionSettings` with `override_update_url`, `ExtensionInstallForcelist`, developer-mode notes, the Edge notes from B1, every hostname `example.org`)
- Modify: `apps/extension/src/manifest.ts` (`storage.managed_schema`), `apps/extension/test/manifest.test.ts`

**Interfaces:**
- The schema: `instances: [{ name, url, default }]`, `rules: [{ pattern, instance, projectId?, environment?, production }]`, `allowVideo` (default true), `allowBuffer` (default true) and `sessionOnly` (default false).
- `readPolicy(): Promise<Policy>` (`storage.managed.get`, validated by zod, errors logged and ignored). Policy instances become `managed: true` profiles that cannot be removed. Policy rules become `source: 'policy'` rules. `sessionOnly` forces the token storage of B3. `onChanged` re-applies.

- [ ] **Step 1: Write failing tests**:
  - `the schema file parses and matches the zod Policy`;
  - `policy instances are locked and pre-seeded but still need Approve (no token from policy)`;
  - `sessionOnly moves the refresh token to storage.session`;
  - `allowVideo false hides video and buffer`;
  - `invalid policy is ignored with a notice`.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/test/policy.test.ts apps/extension/test/manifest.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them and write the guide.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): managed policy and the IT guide`

### Task D3: The CRX3 packer and verifier

**Files:**
- Create: `apps/extension/scripts/crx3.ts` (CLI: `pack <zip> <key.pem> <out.crx>` and `verify <crx> [--expect-id <id>]`), `apps/extension/test/crx3.test.ts`
- Modify: `apps/extension/package.json` (scripts `crx:pack` and `crx:verify`)

**Interfaces:**
- `packCrx3(zip: Uint8Array, privateKeyPem: string): Uint8Array`:
  - the output is `Cr24`, version 3 (u32 LE), the header length, then `CrxFileHeader { sha256_with_rsa: [{ public_key, signature }], signed_header_data: SignedData { crx_id } }`, then the zip;
  - the signature is RSA PKCS#1 v1.5 SHA-256 over `"CRX3 SignedData\x00" + u32le(len(signed_header_data)) + signed_header_data + zip`;
  - `crx_id` is the first 16 bytes of SHA-256 of the SPKI DER.
- `verifyCrx3(crx: Uint8Array): { id: string; publicKey: Uint8Array; zip: Uint8Array }` throws on a bad magic, version, signature or ID.
- `publicKeyB64(privateKeyPem)` gives the manifest `key` value, the same format as `keys/yoda-reporter.pub`.

- [ ] **Step 1: Write failing tests**, with a throwaway 2048-bit key generated in the test and never written to the repo:
  - `pack then verify round-trips the zip and gives extensionIdFromPublicKey(spki)`;
  - `a flipped byte in the zip fails verification`;
  - `--expect-id mismatch exits 1`;
  - `the packer refuses an encrypted or non-RSA key with a clear message`.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/test/crx3.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them (`node:crypto` only; hand-encoded protobuf for the two messages).
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Verify once by hand** (recorded in the spike doc). Force-install the packed CRX through `ExtensionSettings` on the B1 managed Chrome and Edge VMs, serving `updates.xml` from the demo core of D5. Expected: it installs and updates to a bumped test version.
- [ ] **Step 6: Commit** `build(extension): CRX3 packer and verifier`

### Task D4: CRX signing in the release workflow

**Files:**
- Modify:
  - `.github/workflows/release.yml`: the `bundle` job gains node, pnpm and the extension build, plus the signing steps below;
  - `ops/install/bundle.sh`: an optional fifth argument, `<extension crx>`; when given, `extension/yoda-reporter-<version>.crx` joins the bundle's file list, so it is checksummed and signed with the rest;
  - `ops/install/check-release.sh`: when the bundle lists an `extension/` CRX, check that it unpacked into the install directory;
  - `apps/core/test/ops-ci.test.ts`, `apps/core/test/ops-install.test.ts`;
  - `docs/releasing.md`: one-time setup gets a new step, owner only: generate the key on a trusted machine (`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out yoda-reporter.pem`), back it up offline, `gh secret set --env release EXTENSION_CRX_KEY < yoda-reporter.pem`, and commit the public half as `keys/yoda-reporter.pub` together with `OFFICIAL_EXTENSION_ID`; also "Rotating the extension key" (a new ID: re-push the policy).

**Signing steps in `bundle`:**
1. **Real run:** read `secrets.EXTENSION_CRX_KEY`. If it is empty: `::error::The secret EXTENSION_CRX_KEY is not set in the release environment, and a release is never published without its signed extension. Set it with: gh secret set --env release EXTENSION_CRX_KEY < yoda-reporter.pem (docs/releasing.md).`, exit 1. Write the key to `$RUNNER_TEMP` under `umask 077` with an `EXIT` trap removing it. If `publicKeyB64(key)` differs from `keys/yoda-reporter.pub`, fail: `::error::EXTENSION_CRX_KEY does not match keys/yoda-reporter.pub: the extension would get another ID.`
2. **Dry run:** generate a throwaway key in a `mkdir -m 700` temp directory, use it once and delete it. The dry run's ID differs, as with the minisign throwaway key.
3. `pnpm --filter @yoda/extension build:zip`, then `crx:pack`, then `crx:verify --expect-id <id>`, where the ID comes from `keys/yoda-reporter.pub` on a real run and from the throwaway key on a dry run.
4. Run `bundle.sh` with the CRX path, before the minisign signing.

- [ ] **Step 1: Write failing tests** in `ops-ci.test.ts`:
  - `bundle fails with a clear error when EXTENSION_CRX_KEY is missing on a real release`;
  - `checks the key against keys/yoda-reporter.pub`;
  - `uses a throwaway key on a dry run that is never uploaded`;
  - `packs before minisign signs SHA256SUMS`;
  - `apps/extension/** triggers the dry run`.

  In `ops-install.test.ts`, `bundle.sh with a CRX lists extension/yoda-reporter-<v>.crx in the tarball, and check-release passes`.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/ops-ci.test.ts apps/core/test/ops-install.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then push the branch. Expected: the Release dry run is green, and its log shows the throwaway CRX ID and `check-release` passing.
- [ ] **Step 5: Commit** `release: build and sign the extension CRX in the bundle`

### Task D5: Core serves `updates.xml` and the CRX; Help page managed section

**Files:**
- Modify:
  - `apps/core/src/extension/files.ts` (`updatesXml(opts: { id: string; version: string; codebase: string }): string`);
  - `apps/core/src/routes/extension.ts` (`GET /extension/updates.xml`);
  - `docker-compose.prod.yml` (core: `./extension:/srv/yoda-extension:ro`);
  - `apps/core/test/extension-files.test.ts`, `apps/core/test/ops-ci.test.ts`;
  - `apps/portal/app/pages/help.vue` (the managed install section: ID, update URL, the `ExtensionSettings` JSON with copy buttons, and a link to the IT guide; hidden when `crxUrl` is null);
  - `apps/portal/i18n/locales/{th,en}.json`, `docs/operations.md`, `CHANGELOG.md`.

**Interfaces:** `GET /extension/updates.xml` (public) gives `application/xml`:

```xml
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='{OFFICIAL_EXTENSION_ID}'>
    <updatecheck codebase='{org.publicUrl}/api/extension/download/yoda-reporter-{VERSION}.crx' version='{manifestVersion(VERSION).version}' />
  </app>
</gupdate>
```

It answers 404 when there is no CRX for the running version, when `OFFICIAL_EXTENSION_ID` is null, or when the extension is disabled. Values are XML-escaped.

- [ ] **Step 1: Write failing tests**:
  - `updates.xml names the official id, the manifest version and the CRX URL under PORTAL_URL`;
  - `404 without a CRX, without an official id, and when disabled`;
  - `escapes a publicUrl with &`;
  - `ops-ci: prod compose mounts ./extension read-only into core`.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/extension-files.test.ts apps/core/test/ops-ci.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: PASS.
- [ ] **Step 5: Verify and demo:**
  - buffer demo GIF (`demo-buffer.gif`);
  - screenshots of the Help page's managed section and of `chrome://policy` on the managed VM showing the extension force-installed from Yoda.
- [ ] **Step 6: Commit** `feat: serve the signed extension and updates.xml from Yoda`, push, and open PR D.

---

## Owner-only items

1. **The CRX signing key** (the decision is already approved; the action is the owner's). Generate the RSA key, back it up offline, store it as `EXTENSION_CRX_KEY` in the GitHub `release` environment, and commit its public half as `keys/yoda-reporter.pub`, which fixes the extension ID. Do it before the first release tag that includes PR B: that tag's release fails with instructions until the public key is committed (Task B13), and from PR D also until the secret is set (Task D4). The plan never creates, stores or prints this key.
2. **Chrome Web Store:** recommended off and not planned. Only the owner can decide to list it later (a developer account, privacy disclosures, the first upload with the same key).

Already approved, for the owner's calendar rather than as a decision: the DPO review before the managed rollout (§15 item 13).

## SDD task list

PR A, Yoda server side (`feat/extension-server`)
1. **A1** Shared contracts and settings. Acceptance: `pnpm vitest run packages/shared` passes with the manifest-version, extension-ID, schema and match-pattern tables, and the `extension` settings page lists every key in th and en.
2. **A2** Grants and tokens. Acceptance: codes are single use with PKCE; refresh rotates with a 30 s grace; any other reuse revokes the grant; reauth and expiry give the right reasons; only hashes are stored.
3. **A3** Hook and connect, token, revoke and session routes. Acceptance: the round trip works, Keycloak and extension tokens are each refused on the other's routes, the rate limits answer 429, and the disabled switch gives 404.
4. **A4** Connected browsers API. Acceptance: a person sees and revokes only their own grants, an admin sees all and can revoke all, and no secret appears in a response.
5. **A5** Defect template and `createDefect`. Acceptance: a defect item starts at triage with requester = reporter; attachments are noAi with roles and no knowledge entry; no_ai text is withheld from context packs and GitLab.
6. **A6** `POST /extension/defects`. Acceptance: limits, types, WebM magic, idempotency (sequential and concurrent), cleanup on failure, and the production video refusal all pass.
7. **A7** Application URLs. Acceptance: a PM edits validated patterns, members read them, and the project tab shows them in th and en.
8. **A8** GitLab environments and mappings. Acceptance: deployment webhooks and sync fill `deploy_environments`, and `/extension/mappings` returns member-only rules with production from the tier.
9. **A9** Removal and retention. Acceptance: authorised removal writes `attachment.removed`; the daily purge honours 180/90/0 days from the close event and skips active items.
10. **A10** Approve page. Acceptance: Approve redirects only to the allowlisted `chromiumapp.org` URI, Cancel returns `access_denied`, unknown IDs see the admin message, and the page cannot be framed.
11. **A11** Connected browsers UI. Acceptance: settings and admin pages list and revoke, revoke-all needs typed confirmation, and the admin rail item is admin-only.
12. **A12** Defect card, Help page and downloads. Acceptance: the card renders media and logs as text, with placeholders for purged files; Help shows a download or the build placeholder; downloads serve only release file names.
13. **A13** Proxy cap and docs. Acceptance: Caddy allows 56 MiB on the defect route only, the runbook and guides are updated, and the demo-stack screenshots and GIF are in PR A.

PR B, extension MVP (`feat/extension-mvp`)
14. **B1** Phase 0 spike. Acceptance: `docs/design/extension-spike.md` answers the five questions with evidence and names the e2e connect path.
15. **B2** Skeleton, manifest, theme and i18n. Acceptance: the release manifest has exactly the §5 permissions, the e2e manifest adds only host permissions, the versions are in lockstep, and the shared theme is used by the portal and the extension.
16. **B3** Service worker core. Acceptance: foreign messages are ignored, refresh is single-flight, reauth marks the profile, and version skew is detected.
17. **B4** Connect flow. Acceptance: only HTTPS or localhost Yoda origins work, state and PKCE are checked, and no code or verifier is stored.
18. **B5** Metadata and build detection. Acceptance: the meta, well-known, header and gitlab precedence holds, with the source recorded and the query switch working.
19. **B6** Console and network capture. Acceptance: entries are capped and validated, rendered as text, with Resource Timing failures and back-end builds collected; no headers or bodies.
20. **B7** Screenshots. Acceptance: visible capture works; the full-page plan respects the 15 000 px cap and falls back cleanly.
21. **B8** Drafts and editor shell. Acceptance: drafts survive a reload, keep their idempotency key, and are purged after 24 h.
22. **B9** Annotation editor. Acceptance: all tools work, including mosaic rectangle and brush, with undo and redo; the destructive ops are burned into the exported PNG, and only the flattened image is uploadable.
23. **B10** Report form and send. Acceptance: Send needs the confirmation, production rules are applied, retries keep the key, and errors map to clear messages.
24. **B11** Popup and profiles. Acceptance: profiles switch, removal revokes, and `?tab` works only in the e2e build.
25. **B12** E2E and demo. Acceptance: the Playwright spec connects, captures, applies mosaic and sends to the stub with validated payloads in CI; the demo GIF is recorded.
26. **B13** Zip, image and release checks. Acceptance: CI builds, checks and gitleaks-scans the zip; the core image serves it on the Help page; release meta enforces the extension version and the public key.

PR C, video and mapping (`feat/extension-video-mapping`)
27. **C1** 30 s clips. Acceptance: tabCapture is requested on first use, recording stops hard at the limit, production tabs refuse video, and the offscreen-versus-tab measurement is recorded.
28. **C2** Mosaic on video. Acceptance: regions over time ranges are burned in by re-encoding; a lossy or failed re-encode offers only "without video" or "still frame", never the unmasked clip.
29. **C3** URL mapping. Acceptance: the most specific rule wins with the policy, yoda, mine tiebreak, the repo fallback picks member projects only, and Yoda rules stay on their own profile.
30. **C4** Options page. Acceptance: profiles, locked and editable rules, the URL tester with reasons, and granted origins with remove.
31. **C5** E2E and demo. Acceptance: the video-mosaic and mapping specs pass in CI, and the GIFs and screenshots are in PR C.

PR D, buffer and managed install (`feat/extension-enterprise`)
32. **D1** Rolling buffer. Acceptance: it is armed by click only, keeps two in-memory segments, shows a red badge, disarms on every listed reason, never runs on production, and the portal plays the segments back to back.
33. **D2** Managed policy and IT guide. Acceptance: the managed schema drives locked instances and rules, `sessionOnly`, and the video and buffer switches; the Chrome, Edge and Intune guide is written.
34. **D3** CRX3 packer. Acceptance: pack and verify round-trip with a throwaway key, tampering fails, and a force-install on managed Chrome and Edge succeeds by hand.
35. **D4** Release signing. Acceptance: a real release fails clearly without `EXTENSION_CRX_KEY` or with a mismatched key, the dry run signs with a throwaway key, and the signed bundle carries the CRX.
36. **D5** `updates.xml` and Help managed section. Acceptance: core serves `updates.xml` and the CRX from the mounted bundle directory, the Help page shows the policy snippet, and the managed VM screenshot is in PR D.
