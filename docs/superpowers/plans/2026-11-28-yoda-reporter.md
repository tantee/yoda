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

1. **Mosaic on video is feasible. It runs in the editor tab, with the preview visible.**
   - **Path 1:** MediaRecorder re-encode.
     - A hidden `<video>` plays the recorded WebM at 1×.
     - `requestVideoFrameCallback` draws each frame onto a visible preview canvas.
     - Active regions are pixelated with the downscale-then-upscale `drawImage` trick (`imageSmoothingEnabled = false`).
     - `canvas.captureStream(0)` with `track.requestFrame()` per frame feeds a `MediaRecorder` with the clip's codec and bitrate.
     - `fix-webm-duration` writes the duration.

     A 30 s clip takes about 30 s, with a progress bar and Cancel. On `visibilitychange` to hidden, the editor pauses the source and the recorder and shows "keep this tab visible while the mosaic is applied". It resumes when the tab is visible again.
   - **Path 2, tried when path 1 is unsupported or keeps under 90% of the source frames:** WebCodecs. An in-repo WebM (EBML) SimpleBlock reader demuxes the clip. `VideoDecoder` decodes it; each `VideoFrame` is drawn on an `OffscreenCanvas`, pixelated and wrapped in a new `VideoFrame`. `VideoEncoder` encodes it with the same codec, and `webm-muxer` (MIT) writes the WebM. This path is frame-exact and does not depend on playback timing.
   - **Fallback, when neither path keeps at least 90% of the frames:** send the report without the video, or send one still frame, chosen on the timeline, through the screenshot path with the regions burned in.
   - A video with mosaic regions is **never** sent with those regions unapplied.
2. **The e2e test runs Playwright Chromium against a stub Yoda.**
   - It loads the unpacked e2e build from `apps/extension/dist-e2e/` (`launchPersistentContext` with `--load-extension`) against `apps/extension/e2e/stub-yoda.ts`.
   - The stub is a small Node server that validates every request with the `@yoda/shared` zod schemas.
   - The real core is covered by core contract tests that post the same multipart, built with the same `encodeDefectForm`.
   - Two test-only differences exist only in the e2e build. They are `host_permissions: ['<all_urls>']`, because Playwright cannot click the toolbar button to grant `activeTab`, and the popup's `?tab=<id>` target. `check-dist` asserts that both are absent from the release build output: the manifest and the bundled JavaScript.
   - Connect runs through the real `launchWebAuthFlow` if the B1 spike shows Playwright can drive the auth window. Otherwise it runs through the same `profile.exchange` runtime message the options page sends after `launchWebAuthFlow`, with a code the test obtains from the stub.
   - The e2e also records the demo video for the PR description.
3. **URL mapping is matched in the extension.** The extension reads `GET /extension/mappings` (application URLs plus GitLab environments, cached 10 minutes) and matches locally. The proposal's `/extension/resolve?url=` is **dropped**: the extension never sends every visited URL to Yoda.
4. **Refresh tokens follow the approved rule, with no grace window.**
   - Any reuse of a rotated refresh token revokes the whole grant (`reuse_detected`).
   - Authorization codes are marked used atomically (`UPDATE … SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL RETURNING …`), so a double exchange gets exactly one token.
   - The extension refreshes single-flight. When a grant is revoked, or a browser was closed mid-refresh so the next refresh is a reuse, the popup shows a calm "Reconnect" button. Through Keycloak SSO, reconnecting is usually one click. There is no error dialog.
5. **The query string is kept by default.** It helps reproduce the defect. The form has an "include query string" switch.
6. **Defect files** have a `role`.
   - Only files with a role are removable (`DELETE /attachments/:id`) and purged by retention.
   - Their `noAi` flag can never be turned off: `PATCH /attachments/:id` with `noAi: false` gives 409 `invalid_state`.
   - Other uploads keep today's behaviour.
7. **Version scheme.** The only release versions allowed are a final `x.y.z` and `x.y.z-rc.N` with N from 1 to 999.
   - `manifestVersion('x.y.z')` gives `{ version: 'x.y.z.1000', versionName: 'x.y.z' }`.
   - `manifestVersion('x.y.z-rc.N')` gives `{ version: 'x.y.z.N', versionName: 'x.y.z-rc.N' }`.
   - This keeps a final release newer than its release candidates for Chrome's update check.
   - The release `meta` job refuses any other tag form.
   - Dry runs build from `package.json`'s version with the same mapping, so its fourth part is fixed, never the run number.
8. **Files are served by core.**
   - The release zip is built into the core image at `/app/extension`.
   - The signed CRX travels in the signed release bundle under `extension/` and is mounted read-only at `/srv/yoda-extension`.
   - Core serves `/extension/download/:file` and `/extension/updates.xml` from `YODA_EXTENSION_DIRS`; the first directory holding the file wins.
   - When a real release runs without `EXTENSION_CRX_KEY`, it still publishes. It ships the zip without a CRX, with a `::warning::` and a line in the release notes. A key that is present but does not match the committed public key fails the release.
   - Without a CRX, `updates.xml` answers 404 and the Help page hides managed install. The same holds for the GitLab mirror pipeline (`.gitlab-ci.yml`, unchanged).
9. **The CRX3 packer is about 100 lines in the repo** (`apps/extension/scripts/crx3.ts`, `node:crypto` and hand-encoded protobuf), with a verifier, instead of a dependency in the signing step (threat T12).
10. **The extension ID comes from a committed public key**, `keys/yoda-reporter.pub`: the base64 SPKI DER of the CRX key's public half, which is also the manifest `key`.
    - The owner supplies it **before PR B merges**. PR B is blocked at merge until then; releases are not blocked.
    - Until it is committed, local builds have no `key` (a path-derived dev ID that an admin allowlists in `extension.allowedIds`), and `OFFICIAL_EXTENSION_ID` is `null`.
11. **Sensitive report text never reaches AI.**
    - A report is sensitive when the tester ticked "the text may contain patient data" or its project is noAi. For a sensitive report, the text fields live only in `defect_reports`.
    - `work_items.description` holds the fixed marker `DEFECT_WITHHELD_DESCRIPTION`: "[รายงานข้อบกพร่อง: ข้อความเก็บแยก ไม่ส่งให้ AI]" / "[Defect report: text kept separately, not sent to AI]".
    - `work_items.title` keeps the tester's title, for people and notifications as today. Every AI path (context packs, secretary events, secretary tools) and the GitLab issue section use `aiTitle(item)`, which gives the neutral `DEFECT_SENSITIVE_TITLE` ("รายงานข้อบกพร่อง (ข้อมูลอ่อนไหว)" / "Defect report (sensitive)") for a sensitive defect.
    - People read the real text on the portal's defect card.
    - Outside notifications (email, LINE, Telegram) keep their existing behaviour and carry the real work item title; the docs say so.
12. **The `defect` template is extension-only.** `EXTENSION_ONLY_TEMPLATES = ['defect']` is filtered out of `listTemplates` (the portal create dialog), and is refused by `POST /projects/:id/work-items` and by the secretary's create tools and proposals. Every defect item therefore has a report.
13. **Reporting rights are as approved: staff members of the project only.**
    - The session lists only the person's member projects, for admins too.
    - The item's owner and requester is the reporter, who is a member, so `createWorkItem`'s member rule holds.
    - Requesters never get a grant (authorize is staff-only).
14. **The upload runs from the editor tab**, an extension page, not from the service worker. The editor asks the service worker for the current access token (`token.get`), keeps it in memory only, and posts the multipart itself. The B1 spike confirms the service-worker fetch limits that motivate this: event lifetime and large request bodies.
15. **The refresh token lives in the extension origin's IndexedDB** (database `yoda-secrets`), or in `storage.session` when "sign out when the browser closes" is set. It moves to `storage.local` only if the B1 spike confirms that `setAccessLevel` keeps `storage.local` out of content scripts. The access token lives in `storage.session` with the default `TRUSTED_CONTEXTS` access level.
16. **One offscreen document** exists at a time. Clips (C1) and the buffer (D1) share it, with messages routed by a `target` field. The 30 s hard stop and the buffer's 15-minute disarm are timed **in the offscreen document** with `setTimeout`, because the service worker can be stopped and the `alarms` permission is not requested.

## Delivery

| PR | Branch | Tasks | Base |
|---|---|---|---|
| A: Yoda server side | `feat/extension-server` (this branch; its first commit is this plan plus the proposal update) | A1–A13 | `main` |
| B: extension MVP (phase 0 spike + phase 1) | `feat/extension-mvp` | B1–B13 | stacked on A; retarget to `main` when A merges. **Merge gate:** the owner's `keys/yoda-reporter.pub` is committed |
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
- **Tokens:** a prefix plus 32 random bytes in base64url (43 characters), as `runners/tokens.ts`. Only the SHA-256 (`hashToken`) and a 12-character display prefix are stored.
  - Extension tokens are never accepted outside `/extension/*`.
  - Keycloak tokens are accepted, among the extension routes, only on `/extension/authorize`.
- **AI:** sensitive report text and titles never reach AI (decision 11). Attachment rows written by the defect route are always `noAi = true`, can never be set back to `false`, and never call the knowledge `onStored` hook. A noAi project sends nothing to AI.
- **Untrusted page data:** everything from the MAIN world or the page is schema-validated, size-capped (500 entries, 2 KB per message, 10 back-end builds), and rendered as text (never `v-html`) in the extension and the portal.
- **No automatic masking (D2):** no regex masking, no capture stylesheet, no `data-yoda-mask` handling, in any package.
- **Repo rules:**
  - single quotes and no semicolons;
  - th/en parity, Thai default;
  - `data-testid` on new controls;
  - the portal's components (`PageHeader`, `StatusChip`, `AppDialog`, `ConfirmDialog`, `EmptyState`, `ErrorState`);
  - `pnpm typecheck` and `pnpm test` pass;
  - migrations continue from `0024`, and each new table joins the `TRUNCATE` list in `apps/core/test/helpers.ts`;
  - `runWork`, lock order and jobs-after-commit as in earlier plans;
  - never `git stash`, never push to `main`.
- **Permissions (§5):**
  - Required: `activeTab`, `scripting`, `storage`, `identity`, `offscreen`.
  - Optional: `tabCapture` and per-origin host permissions, requested only from a click handler in an extension page (the popup or the options page), before any `await`, never from the service worker.
  - Never in the release build: `<all_urls>`, `tabs`, `alarms`, `debugger`, `webRequest`, `cookies`, `externally_connectable`, `web_accessible_resources` or manifest `content_scripts`.

## Review Focus

1. **The browser closes, or the service worker dies, mid-refresh.** The next refresh is a reuse and revokes the grant, as approved. The popup shows a calm "Reconnect", with no error dialog and no lost draft. Two refreshes in one browser never race, because refresh is single-flight. Tests in A2 and B3.
2. **A 50 MB report through the built-in proxy.** Caddy caps bodies at 32 MiB, and `request_body` blocks are middleware that all apply. So the 32 MiB block must exclude `/api/extension/defects` (`@other not path …`), and the defect path gets its own 56 MiB block. A larger report gets 413 `too_large`, which the extension shows as "remove a file". Tests in A6 and A13, including a real Caddy run.
3. **A retry with the same `Idempotency-Key`**, sequential (after a timeout) or concurrent (two clicks). It is checked before any limiter. A duplicate in flight waits for the winner and gets its body, and exactly one work item results. Test in A6.
4. **A hostile or noisy page**: 10 000 console lines, 1 MB messages, HTML in messages, a forged `yoda-build`, foreign `postMessage`s with our type. Entries stay capped; text renders as text in the extension and on the portal card; the forged build is visible and editable. Tests in B6 and A12.
5. **Production sites with a stale or missing rule in the extension.** Core refuses video and buffer files when the page URL matches a production rule of **any** of the person's projects, or when `privacy.productionSite` is set: 422 `invalid_state`, reason `video_on_production`. This catches stale or honest clients only: a hostile client can report another URL. The real guard is the extension's own production rules plus the confirmation. Tests in A6 and C3.

---

## PR A: the Yoda server side (`feat/extension-server`)

### Task A1: Shared contracts and the `extension` settings

**Files:**
- Create: `packages/shared/src/extension.ts`, `packages/shared/src/extension-id.ts`, `packages/shared/src/match-pattern.ts`, `packages/shared/test/extension.test.ts`, `packages/shared/test/match-pattern.test.ts`
- Modify: `packages/shared/src/index.ts`, `packages/shared/src/settings/registry.ts` (category `extension` and the keys below), `packages/shared/src/admin.ts` (`PublicConfig.extension`), `packages/shared/src/knowledge.ts` (`Attachment.role`, `Attachment.purgedAt`), `packages/shared/src/work.ts` (`EventType` + `defect.reported`, `attachment.removed`, `attachment.purged`; `WorkItemDetail.defect`), `packages/shared/test/settings-registry.test.ts`, `apps/portal/app/utils/settings.ts` (page `{ id: 'extension', icon: 'mdi-puzzle-outline', categories: ['extension'] }`), `apps/portal/i18n/locales/{th,en}.json` (`settings.page.extension`, `settings.category.extension`, `settings.field.extension.*.label/help`)

**Interfaces (Produces):**
- `EXTENSION_API_VERSION = 1`. `EXTENSION_TOKEN = { code: 'yoda_xc_', access: 'yoda_xt_', refresh: 'yoda_xr_' } as const`, and `extensionTokenRe(kind): RegExp`, which matches the prefix plus 43 base64url characters.
- `OFFICIAL_EXTENSION_ID: string | null` (`extension-id.ts`, `null` until the owner commits `keys/yoda-reporter.pub`); `isExtensionId(s): boolean` (`/^[a-p]{32}$/`); `chromiumappRedirect(id) => 'https://<id>.chromiumapp.org/'`; `extensionIdFromPublicKey(spkiDer: Uint8Array): Promise<string>` (SHA-256 with WebCrypto, first 16 bytes, each nibble mapped to `a`–`p`).
- `isReleaseVersion(v): boolean` (only `x.y.z` or `x.y.z-rc.N`, N 1–999) and `manifestVersion(yodaVersion: string): { version: string; versionName: string }` (decision 7; throws on anything else).
- `EXTENSION_ONLY_TEMPLATES`, `DEFECT_SENSITIVE_TITLE` and `DEFECT_WITHHELD_DESCRIPTION` (decisions 11 and 12; both `{ th, en }`).
- Enums: `DefectSeverity` (`blocker | critical | major | minor | trivial`), `DefectKind` (`defect | bug_fix_request`), `AttachmentRole` (`screenshot | screenshot_full | video | buffer | console | network`), `BuildSource` (`meta | well-known | header | gitlab | manual`). `severityPriority(s): Priority` maps blocker and critical to `urgent`, major to `high`, minor to `normal`, trivial to `low`.
- `DEFECT_LIMITS = { maxFiles: 8, maxReportBytes: 50 MiB, perRole: { screenshot: 10 MiB, screenshot_full: 15 MiB, video: 25 MiB, buffer: 25 MiB, console: 1 MiB, network: 1 MiB } }`. `DEFECT_TYPES: Record<AttachmentRole, string[]>`: images take `image/png`, `image/jpeg` and `image/webp`; video and buffer take `video/webm`; logs take `application/json`. `MEDIA_ROLES` and `LOG_ROLES`.
- `ConsoleEntry` (`{ t, level: 'log'|'info'|'warn'|'error'|'debug'|'exception'|'rejection', message: string.max(2048), source?: string.max(500) }`) and `NetworkEntry` (`{ t, method, url: string.max(2048), status: number|null, durationMs, failed: boolean, kind: 'fetch'|'xhr'|'resource', yodaBuild?: string.max(500) }`); `CAPTURE_CAPS = { entries: 500, message: 2048, backendBuilds: 10 }`.
- Schemas, as §10.1 with D2 applied:
  - `ExtensionAuthorize`, `ExtensionAuthorizeResponse`, `ExtensionTokenRequest` and `ExtensionTokenResponse`.
  - `ExtensionSession` (projects: the person's member projects only): `{ apiVersion, instance, latestExtension, person, projects: { id, name, noAi, kinds, repos }[], limits: { maxFileBytes, maxReportBytes, maxFiles, maxVideoSeconds, perRole, allowedTypes }, policy: { videoOnProduction: false, logsOnProductionDefault: false, requireConfirm: true } }`.
  - `MappingRule`: `{ pattern, projectId, environment: string|null, production, source: 'app_url'|'gitlab', build: { repo, ref, sha, deployedAt }|null }`, and `ExtensionMappings = { rules: MappingRule[], ttlSeconds: 600 }`.
  - `ExtensionGrant` (the list view: `id, extensionId, browserLabel, createdAt, lastUsedAt, lastIp, revokedAt, revokeReason, person`), `AppUrl`, `AppUrlsPut` (at most 50), `ExtensionLatest` (`{ version, zipUrl, crxUrl: string|null } | null`).
  - `DefectReportCreate`: §10.1 without `attachments[].masked`; each attachment declares `{ part, role, name, type, sizeBytes }` (A6). `privacy` is `{ confirmedNoPatientData: literal(true), productionSite: boolean, textMayContainPatientData: boolean }`, and `page.url` is kept as captured.
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
  - `manifestVersion`: `'1.2.0'` gives `{ version: '1.2.0.1000', versionName: '1.2.0' }`, `'1.2.0-rc.3'` gives `{ version: '1.2.0.3', versionName: '1.2.0-rc.3' }`, and it throws on `'1.2'`, `'1.2.0-rc'`, `'1.2.0-rc.0'`, `'1.2.0-rc.1000'` and `'1.2.0-beta.1'`;
  - `extensionIdFromPublicKey` gives a known ID for a fixed test SPKI (generate a throwaway key once, inline its public DER and the ID Chrome showed for it);
  - `chromiumappRedirect` and `isExtensionId`;
  - `severityPriority` for all five severities;
  - `DefectReportCreate` accepts the §10.1 example without `masked`, and rejects `privacy.confirmedNoPatientData: false`, 31 steps, 9 attachments and a 201-character title;
  - `encodeDefectForm`, through `new Response(fd)`, has the `report` part first and the file parts named `file1`…;
  - `ConsoleEntry` rejects a 2049-character message.

  In `match-pattern.test.ts`, a table: `https://*.review.example.org/*` matches `https://a.review.example.org/x` and `https://review.example.org/` and not `http://a.review.example.org/`. `http://localhost:3000/*` matches its own port only. `http://localhost/*` matches `http://localhost:5173/x` and `http://localhost/` (a port-less host pattern matches any port, as in Chrome). `patternSpecificity` ranks `https://app.example.org/opd/*` above `https://app.example.org/*` above `https://*.example.org/*`. Invalid patterns give null.

  In `settings-registry.test.ts`: every `extension.*` key has a default, and `extension.dirs` is bootstrap-only with its env name.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the modules and registry entries; i18n labels for each key (th/en); the portal settings page entry.
- [ ] **Step 4: Run** `pnpm vitest run packages/shared apps/portal/test/settings.test.ts apps/portal/test/i18n.test.ts apps/core/test/ops-docs.test.ts && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): extension contracts, match patterns and extension settings`

### Task A2: Grants, codes and rotating refresh tokens

**Files:**
- Create: `apps/core/src/extension/tokens.ts`, `apps/core/src/extension/grants.ts`, migration `apps/core/drizzle/0024_extension_grants.sql` (via `pnpm --filter @yoda/core db:generate`), `apps/core/test/extension-grants.test.ts`
- Modify: `apps/core/src/db/schema.ts`, `apps/core/test/helpers.ts` (TRUNCATE list), `apps/core/src/settings/rate-limit.ts` (`check`), `apps/core/test/settings-rate-limit.test.ts`

**Tables:**
- `extension_grants`: `id, person_id → people, extension_id, browser_label, access_hash unique null, access_expires_at, family_id uuid, idle_expires_at, absolute_expires_at, created_at, last_used_at, last_ip, revoked_at, revoked_by → people null, revoke_reason`, where `revoke_reason` is one of:
  - `user`;
  - `admin`;
  - `admin_all`;
  - `reuse_detected`;
  - `extension_not_allowed`: set when a refresh finds the extension ID no longer in the effective allowlist;
  - `not_staff`: set when a refresh finds the person is no longer staff by `meFromPerson`. `people` has no blocked column; a person disabled in Keycloak stops at the 14-day re-check.
- `extension_auth_codes`: `code_hash PK, person_id, extension_id, redirect_uri, code_challenge, browser_label, expires_at, used_at`.
- `extension_refresh_tokens`: `hash PK, grant_id → extension_grants on delete cascade, created_at, used_at null`.

**Interfaces (Produces):**
- `newExtensionToken(kind: 'code'|'access'|'refresh'): { token; hash; prefix }` (it reuses `hashToken` from `runners/tokens.ts`); `verifyPkceS256(verifier: string, challenge: string): boolean` (the verifier has 43–128 unreserved characters; the comparison is constant-time).
- `class GrantError extends Error { reason: 'invalid_grant' | 'reauth_required' | 'revoked'; familyId: string | null }`.
- `effectiveAllowedIds(settings): string[]` is `extension.allowedIds` plus `OFFICIAL_EXTENSION_ID`.
- `issueAuthCode(db, me: Me, input: ExtensionAuthorize, opts: { allowedIds: string[]; now: Date }): Promise<{ redirectTo: string }>`. It throws `HttpError(403, { error: 'forbidden', reason: 'extension_not_allowed' | 'redirect_mismatch' | 'not_staff' })`. The code lives 60 s.
- `exchangeCode(db, req: { code; codeVerifier; extensionId }, ctx: GrantCtx): Promise<ExtensionTokenResponse>`. It claims the code with one atomic `UPDATE … WHERE used_at IS NULL AND expires_at > now RETURNING`, then checks PKCE and the extension ID.
- `refreshGrant(db, refreshToken: string, ctx: GrantCtx): Promise<ExtensionTokenResponse>`.
  - It locks the token row, then the grant, `FOR UPDATE`.
  - A token whose `used_at` is set revokes the grant with `reuse_detected`, with no grace window.
  - It checks revocation, idle and absolute expiry, the re-auth window (`people.last_seen_at` within `reauthDays`), staff status, and the effective allowlist.
  - On success it marks the token used and issues the successor and a new access token.
- `GrantCtx = { now: Date; ip: string; allowedIds: string[]; ttl: { accessMinutes; idleDays; absoluteDays; reauthDays } }`.
- `authenticateExtension(db, authorization: string | undefined, ctx: { now: Date; allowedIds: string[] }): Promise<{ grant: GrantRow; me: Me } | null>`.
  - It refuses a grant whose `extension_id` is not in the effective allowlist, so removing an ID cuts its grants at once.
  - It uses `meFromPerson` and requires staff.
  - It updates `last_used_at` and `last_ip` at most once a minute.
- `revokeGrant(db, grantId, by: { personId: string | null; reason }): Promise<boolean>` and `revokeAllGrants(db, by): Promise<number>`.
- `RateLimiter.check(key): { ok: true } | { ok: false; retryAfter: number }`: like `take`, but it never records a call.

- [ ] **Step 1: Write failing tests** (`extension-grants.test.ts`, against the test DB):
  - Codes:
    - `code is single use, expires after 60 s, and is bound to the verifier and the extension id`;
    - `two concurrent exchanges of one code: exactly one gets tokens, the other gets invalid_grant`;
    - `an unknown extension id or a redirect other than chromiumappRedirect(id) is refused, and no code is stored`;
    - `requesters get not_staff`.
  - Refresh:
    - `refresh rotates: the successor works and the access token changes`;
    - `any reuse of a rotated refresh token, even one second later, revokes the grant with reuse_detected, and the successor stops working`;
    - `idle 30 d and absolute 90 d expiry give invalid_grant`;
    - `a person whose last_seen_at is older than reauthDays gets reauth_required, and a fresh portal sign-in clears it`;
    - `a person who lost staff status is refused and the grant is revoked with not_staff`.
  - Allowlist:
    - `removing the extension id from extension.allowedIds makes authenticate refuse at once`;
    - `the next refresh revokes the grant with extension_not_allowed`.
  - Access and revocation:
    - `authenticateExtension refuses a Keycloak JWT, a revoked grant, an expired access token, and a yoda_rt_ token`;
    - `revokeGrant stops the access token at once`;
    - `only hashes and prefixes are stored` (no raw token in any row).

  In `settings-rate-limit.test.ts`:
  - `check reports the wait without consuming`;
  - `check after take sees the take`.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/extension-grants.test.ts apps/core/test/settings-rate-limit.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the schema and migration, `RateLimiter.check`, and the module.
- [ ] **Step 4: Run** `pnpm vitest run apps/core/test/extension-grants.test.ts apps/core/test/settings-rate-limit.test.ts apps/core/test/db.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): extension grants, PKCE codes and rotating refresh tokens`

### Task A3: `/extension/*` route modes, connect, token, revoke and session routes

**Files:**
- Create: `apps/core/src/routes/extension.ts`, `apps/core/src/extension/hook.ts`, `apps/core/src/extension/limits.ts`, `apps/core/test/extension-routes.test.ts`
- Modify:
  - `apps/core/src/app.ts`: register the routes; add `body.refreshToken`, `body.code`, `body.codeVerifier` and `req.headers["idempotency-key"]` to `LOGGER_OPTIONS.redact`.
  - `apps/core/src/auth/plugin.ts`: `FastifyContextConfig.extension?: 'token' | 'public' | 'keycloak'`; `FastifyRequest.extension`; the gate below runs at the start of the `onRequest` hook in `registerAuth`.
  - `apps/core/src/routes/public-config.ts`, `apps/core/test/public-config.test.ts`.

**Route modes**, set on every `/extension/*` route:

| Mode | Routes | Authentication |
|---|---|---|
| `token` | revoke, session, mappings (A8), defects (A6) | a `yoda_xt_` access token only, through `authenticateExtension`; any other bearer gets 401 |
| `public` | `/extension/token`, `/extension/latest`, `/extension/download/:file`, `/extension/updates.xml` | none |
| `keycloak` | `/extension/authorize` | the normal Keycloak path of `registerAuth`; no extension token |

The gate runs in this order for every route with `config.extension` set:
1. setup mode, as today: 503 `setup_required`;
2. forced recovery mode: **503 `recovery_mode`**, for all three modes, because `registerAuth` returns early for public routes and must not skip this;
3. `extension.enabled` is false: **404 `not_found`**, for all three modes, before any token is read;
4. `token`: `authenticateExtension`, else 401; `public`: continue; `keycloak`: fall through to Keycloak verification.

`token` and `public` routes are also marked `public: true`, so the Keycloak check skips them.

**Limiters** (`limits.ts`, `RateLimiter` with `check` and `take`):
- `token`: 120/min per IP, generous for one hospital NAT.
- `codeFailures`: 5 per 15 min per IP. It is checked with `check` before a code exchange and taken only when the exchange fails.
- `refreshFailures`: 5 per 15 min per token family (`GrantError.familyId`). An unknown refresh token (no family) counts only against `token`.
- `authorize`: 10/h per person.
- `session`: 120/h per grant.
- `defects` and `DailyBytes`, used in A6.

**Routes** (core paths; the portal proxies `/api/*`):
- `POST /extension/authorize` (`keycloak`), body `ExtensionAuthorize` → `ExtensionAuthorizeResponse`.
- `POST /extension/token` (`public`), body `ExtensionTokenRequest` → `ExtensionTokenResponse`, or 401 `{ error: 'unauthorized', reason }`.
- `POST /extension/revoke` (`token`) → 204, reason `user`.
- `GET /extension/session` (`token`) → `ExtensionSession`.
  - Its projects are the person's **member** projects only, for admins too.
  - `latestExtension` comes from A12's `latestExtension()` (null until A12 lands).
  - Its limits come from `DEFECT_LIMITS` and `extension.maxVideoSeconds`.
- `GET /public-config` gains `extension`.

- [ ] **Step 1: Write failing tests**:
  - Connect:
    - `authorize → token → session round trip for a staff member, with PKCE`;
    - `authorize is 401 without a Keycloak token and 401 with a yoda_xt_ token`.
  - Separation:
    - `session refuses a Keycloak bearer, and /me and /projects refuse a yoda_xt_ token` (401).
  - Modes:
    - `all three modes answer 404 when extension.enabled=false, and grants are kept`;
    - `all three modes answer 503 recovery_mode in forced recovery mode`.
  - Limits:
    - `5 failed code exchanges from one IP give 429 with retryAfter, and successful ones do not count`;
    - `5 failed refreshes in one family give 429 for that family only; another family from the same IP still refreshes`.
  - Contents:
    - `revoke ends the grant`;
    - `session lists only member projects (an admin sees only their member projects), with noAi and repos`;
    - `public-config reports extension.enabled`.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/extension-routes.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them. Log grant lifecycle lines (`created`, `refreshed_after_reauth`, `revoked`, `reuse_detected`) with grant id and person id only.
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

### Task A5: The `defect` template, `defect_reports`, the create service and AI withholding

**Files:**
- Create: `apps/core/src/workflow/templates/defect.json`, `apps/core/src/defects/service.ts`, `apps/core/src/defects/ai-view.ts`, migration `0025_defect_reports.sql`, `apps/core/test/defects-service.test.ts`, `apps/core/test/defects-ai.test.ts`
- Modify:
  - `apps/core/src/db/schema.ts`;
  - `apps/core/src/work/queries.ts`: `getWorkItemDetail` adds `defect`; `listTemplates` filters `EXTENSION_ONLY_TEMPLATES`;
  - `apps/core/src/work/engine.ts`: `createWorkItem` refuses an extension-only template unless called with `{ allowExtensionOnly: true }`, with 422 `invalid_state` and reason `extension_only_template`;
  - `apps/core/src/secretary/tools.ts`: the create tools refuse extension-only templates; the tool-output wrapper applies `aiTitle`;
  - `apps/core/src/secretary/events.ts`: the done summary uses `aiTitle`, and the description is already the marker;
  - `apps/core/src/knowledge/context-pack.ts`, `apps/core/src/gitlab/issue-section.ts`;
  - `apps/core/test/templates.test.ts`, `apps/core/test/context-pack.test.ts`, `apps/core/test/issue-section.test.ts`, `apps/core/test/secretary.test.ts`, `apps/core/test/secretary-events.test.ts`, `apps/core/test/helpers.ts`;
  - `packages/shared/src/extension.ts`: `EXTENSION_ONLY_TEMPLATES`, `DEFECT_SENSITIVE_TITLE`, `DEFECT_WITHHELD_DESCRIPTION`, each `{ th, en }` where text;
  - `apps/portal/i18n/locales/{th,en}.json`: `events.defect.reported`, `events.attachment.removed`, `events.attachment.purged`.

**Template** (§10.2, human-only):
- step `triage` (คัดกรอง / Triage): `triage-defect`, approval, QC;
- step `fix` (แก้ไข / Fix): `fix-defect`, human, DEV, then `review-fix`, review, DEV, depends on `fix-defect`;
- step `verify` (ทดสอบซ้ำ / Retest): `retest`, human, REQUESTER, then `close-defect`, approval, QC, depends on `retest`.

Write th/en titles and instructions in the style of `bug-fix.json`.

**Table** `defect_reports`:
- `work_item_id PK → work_items on delete cascade, kind, severity, description, steps jsonb, expected, actual`;
- `page_url, page_title, route, build jsonb null, backend_builds jsonb, client jsonb, captured_at`;
- `reported_by → people, source ('extension'), extension_version, grant_id null`;
- `production_site bool, sensitive bool, idempotency_key uuid null, created_at`;
- `unique(reported_by, idempotency_key)`.

The same migration adds `attachments.role text null`, checked against `AttachmentRole`, and `attachments.purged_at timestamptz null`.

**Interfaces (Produces):**
- `createDefect(ctx: WorkCtx, me: Me, input: DefectReportCreate, files: StoredDefectFile[], meta: { grantId; extensionVersion; idempotencyKey }): Promise<{ workItemId: string }>`, where `StoredDefectFile = { role; storageKey; fileName; contentType; sizeBytes }`. It:
  1. computes `sensitive = input.privacy.textMayContainPatientData || project.noAi`;
  2. calls `createWorkItem(…, { allowExtensionOnly: true })` with template `defect`, or `bug-fix` for `bug_fix_request`, with:
     - priority `severityPriority`;
     - owner and requester = the reporter, a staff member of the project;
     - the title as given;
     - the description: the composed text when not sensitive, else `DEFECT_WITHHELD_DESCRIPTION` in the project's language pair (th, then en);
  3. inserts `defect_reports` with the full text and `sensitive`;
  4. inserts one attachment row per file with `noAi: true`, `role` and `workItemId`;
  5. records `defect.reported` with the metadata-only payload `{ source, extensionVersion, grantId, kind, severity, files: [{ role, sizeBytes }], productionSite, aiAllowed: !sensitive }`.
- `ai-view.ts`:
  - `sensitiveDefectIds(db, workItemIds): Promise<Set<string>>`;
  - `aiTitle(item: { id; title }, sensitive: Set<string>, lang: 'th' | 'en'): string`;
  - `redactToolOutput(db, output: unknown): Promise<unknown>` walks a secretary tool result. Every object carrying `workItemId`, or the `work_item` tool's root `id`, of a sensitive defect gets `title` replaced by `DEFECT_SENSITIVE_TITLE`, and `description` by the marker. It is applied once, in the secretary tools' `guarded()` wrapper.

- [ ] **Step 1: Write failing tests**:
  - `defects-service.test.ts`:
    - `defect.json passes validateTemplate and seeds`;
    - `createDefect makes a triage-step item owned and requested by the reporter, priority from severity`;
    - `bug_fix_request uses the bug-fix template`;
    - `every attachment row is noAi and has its role; no knowledge entry is created`;
    - `the event payload holds no text from the report`;
    - `a sensitive report keeps the text in defect_reports and the marker in work_items.description`;
    - `a noAi project makes every report sensitive`.
  - Templates:
    - `listTemplates omits defect`;
    - `POST /projects/:id/work-items with templateKey defect is 422 extension_only_template`;
    - `the secretary's create tools refuse defect`.
  - `defects-ai.test.ts`, with a sensitive defect titled "นายทดสอบ HN 0000":
    - `the context pack shows DEFECT_SENSITIVE_TITLE and the marker, never the title or the text`;
    - `the GitLab issue section shows the neutral title and the marker, severity, build and browser, and no media bytes`;
    - `the secretary done-event summary prompt never contains the real title or text` (capture the prompt with the mock model);
    - `every secretary tool that returns work items (search, todo, list_work_items, work_item, my_requests and the priority change summary) never returns the real title or text` (call each tool in the registry and search its JSON output);
    - `a non-sensitive defect shows its real title to AI`;
    - `outside notifications still carry the real work item title` (unchanged behaviour, asserted).
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/defects-service.test.ts apps/core/test/defects-ai.test.ts apps/core/test/templates.test.ts apps/core/test/context-pack.test.ts apps/core/test/issue-section.test.ts apps/core/test/secretary.test.ts apps/core/test/secretary-events.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the template, the migration, the service, the template filter and refusals, `ai-view.ts`, and its use in the context pack, the issue section, the secretary events and the tools wrapper.
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): defect template and reports; sensitive text and titles kept from AI`

### Task A6: `POST /extension/defects`, multipart and idempotent

**Files:**
- Create: `apps/core/src/defects/upload.ts`, `apps/core/test/extension-defects.test.ts`
- Modify: `apps/core/src/routes/extension.ts`, `apps/core/src/extension/limits.ts`, `packages/shared/src/extension.ts` (each `DefectReportCreate.attachments[]` entry declares `{ part, role, name, type, sizeBytes }`)

**Interfaces:**
- Consumes: `createDefect` (A5), `encodeDefectForm`, `DEFECT_LIMITS`, `DEFECT_TYPES`, `matchesPattern`, and `productionRulesForPerson(db, personId): Promise<string[]>` (A7 and A8; until they land, it returns `[]`).
- Produces:
  - `validateDeclaredReport(db, me, report, opts): Promise<void>`;
  - `readDefectParts(request, onReport): Promise<{ report; files }>`;
  - `isWebm(buf): boolean` (EBML magic `1A 45 DF A3`).

**Order of work in `POST /extension/defects` (mode `token`):**
1. Require the `Idempotency-Key` header (a uuid); without one, answer 400 `validation`.
2. **Idempotency first, before any limiter:**
   - if `(person, key)` already has a report, drain the body and answer 200 with its `DefectReportCreated`;
   - if an upload with the same `(grant, key)` is in flight, await its promise and answer 200 with the winner's body (or its error).

   The in-flight map is keyed by `${grantId}:${key}`.
3. Limiters:
   - another upload from the same grant with a **different** key gives 429 with `retryAfter: 5`;
   - `defects` allows 20/h and 100/day per person.
4. Parse the multipart with `request.parts({ limits: { parts: 9, files: 8, fields: 1, fieldSize: 64 KiB, fileSize: 25 MiB, headerPairs: 50 } })`. A `partsLimit`, `filesLimit` or `fieldsLimit` error, or a truncated field (`valueTruncated`), gives 413 `too_large` with `reason` `parts`, `files`, `fields` or `report_size`.
5. **The `report` field must be the first part.** As soon as it arrives, before any file part is read, `validateDeclaredReport` checks:
   - the zod schema (400 `validation` with `issues`, the existing shape);
   - staff membership of the project (a non-member gets 404);
   - every declared attachment: an allowed type for its role, the per-role size cap, and the total of at most 50 MiB (413 `too_large`, `reason: 'role:<role>' | 'total'`, or 415 `unsupported_type`);
   - `DailyBytes` against the declared total (300 MB/day per person; 429 with `retryAfter`);
   - production: video or buffer roles are refused when `privacy.productionSite` is set or the page URL matches a production rule of **any** of the person's projects (422 `invalid_state`, `reason: 'video_on_production'`).

   On any rejection, answer with `Connection: close` and do not read the remaining parts.
6. Read each file part. It must be declared, and its type and byte length must equal the declaration (400 `validation`). WebM must pass `isWebm`.
7. Put every object under `projects/<projectId>/defects/<uuid>/<name>`.
8. Run `runWork(createDefect)`. On any failure, remove the stored objects. A unique violation on `(reported_by, idempotency_key)`, from another grant of the same person, removes ours and answers 200 with the stored body.
9. Answer 201 `DefectReportCreated`, with the portal link `${org.publicUrl}/work-items/<id>`.

Only existing `HttpError` fields are used (`error`, `reason`, `retryAfter`, and `issues` through `ZodError`). No new fields.

- [ ] **Step 1: Write failing tests**, building bodies with `encodeDefectForm` and `new Response(fd)`:
  - Happy path and idempotency:
    - `a report with a PNG, a WebM and two JSON logs creates one item and four noAi attachments`;
    - `the same Idempotency-Key afterwards returns 200 and the same body, and stores nothing new`;
    - `two concurrent posts from one grant with one key: the second waits and gets the winner's body; one item; no 429`;
    - `two concurrent posts from one grant with different keys: the second gets 429`.
  - Early rejection:
    - `a report part that is not first is 400`;
    - `an invalid report is rejected before any file part is read` (the test stream holds the file part back and asserts it was never consumed);
    - `a declared 26 MB video is 413 role:video, read before the bytes`;
    - `a ninth file is 413 files`, and so is a 65 KiB report field;
    - `a file whose length differs from its declaration is 400`;
    - `a fake .webm without EBML magic is 415`.
  - Access and rules:
    - `video whose URL matches a production rule of another of the person's projects is 422 video_on_production`;
    - `a non-member gets 404; a revoked grant 401`;
    - `the 21st report in an hour is 429 with retryAfter`;
    - `a storage failure after two puts removes both objects and creates no item`.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/extension-defects.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them. Do not touch the app-wide multipart registration.
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
- `productionRulesForPerson(db, personId): Promise<string[]>`: the production patterns of **all** the person's member projects (application URLs with `production` plus GitLab `production`-tier environments), consumed by A6.

- [ ] **Step 1: Write failing tests**:
  - `a deployment webhook upserts the environment and ignores an older event`;
  - `sync reads environments and their last deployment from the fake GitLab`;
  - `mappings returns app URL and GitLab rules only for member projects, with production from the tier`;
  - `a production GitLab environment makes A6 refuse video` (extends the A6 test).
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/gitlab-environments.test.ts apps/core/test/extension-defects.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them. Add "Deployment events" to the webhook checklist in `docs/operations.md`.
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): GitLab deploy environments and extension URL mappings`

### Task A9: Defect files: noAi lock, removal, retention, orphan sweep

**Files:**
- Create: `apps/core/src/defects/retention.ts`, `apps/core/test/defects-retention.test.ts`
- Modify:
  - `apps/core/src/routes/attachments.ts`:
    - `PATCH` refuses `noAi: false` on a row with a `role`;
    - `DELETE /attachments/:id`;
    - downloading a purged row gives 404 `not_found` with reason `purged`.
  - `apps/core/src/attachments/service.ts` (`role` and `purgedAt` in the shape);
  - `apps/core/src/storage/s3.ts` and `storage/memory.ts` (`list(prefix): AsyncIterable<{ key: string; lastModified: Date }>`), `apps/core/test/memory-storage.test.ts`;
  - `apps/core/src/jobs/queue.ts` and `jobs/handlers.ts`: `defect-retention` daily at 03:00 Asia/Bangkok, `defect-orphan-sweep` daily at 03:15; `registerJobHandlers`' deps type adds `'storage'`.

**Interfaces:**
- `PATCH /attachments/:id` with `{ noAi: false }` on a row with a `role` gives 409 `invalid_state`, reason `defect_files_never_ai`.
- `DELETE /attachments/:id` takes the body `{ reason: string.min(1).max(500) }`.
  - The uploader, the project's PM or an admin may call it.
  - An attachment without a `role` gives 409 `invalid_state`, reason `not_defect_attachment`.
  - It removes the object, sets `purged_at` and records `attachment.removed` `{ attachmentId, role, reason }`, actor = the caller.
- `purgeExpired(deps, now): Promise<{ media: number; logs: number }>`.
  - An item's close time is its latest `work_item.done` or `work_item.cancelled` event.
  - Media roles purge after `mediaRetentionDays`, log roles after `logRetentionDays`; 0 keeps the files.
  - Items that are active, including reopened ones, are skipped.
  - Each purge records `attachment.purged`, actor `system`.
- `sweepOrphans(deps, now): Promise<number>` removes objects under `projects/*/defects/` that are older than 24 h and that no `attachments.storage_key` names. These are left behind by a crash between the put and the rollback.

- [ ] **Step 1: Write failing tests**:
  - `PATCH noAi:false on a defect file is 409, by the uploader and by the PM; noAi:true is a no-op`;
  - `uploader, PM and admin may remove; another member gets 403; a chat upload gets 409`;
  - `the removed file's download is 404 purged and the row stays`;
  - `a done item purges media after 180 d and logs after 90 d, not a day earlier`;
  - `0 keeps everything`;
  - `a reopened item is not purged`;
  - `a cancelled item counts from its cancel event`;
  - `the sweep removes an unreferenced object older than 24 h, and keeps a referenced one and a fresh one`;
  - `memory storage lists by prefix`.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/defects-retention.test.ts apps/core/test/attachments.test.ts apps/core/test/memory-storage.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them.
- [ ] **Step 4: Run** `pnpm vitest run apps/core` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): defect files stay noAi, can be removed, purged and swept`

### Task A10: Portal approve page `/extension/connect`

**Files:**
- Create: `apps/portal/app/pages/extension/connect.vue`, `apps/portal/app/utils/extensionConnect.ts`, `apps/portal/test/extensionConnect.test.ts`
- Modify: `apps/portal/nuxt.config.ts` (`routeRules: { '/extension/**': { headers: { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' } } }`), `apps/portal/app/utils/nav.ts` (`/extension` is a staff prefix), `apps/portal/i18n/locales/{th,en}.json` (`extension.connect.*`)

**Interfaces:**
- `parseConnectQuery(q): { ok: true; value: { ext; redirectUri; codeChallenge; state; browser } } | { ok: false; reason: 'missing' | 'bad_id' | 'bad_redirect' }`. The redirect must equal `chromiumappRedirect(ext)`.
- `cancelUrl(redirectUri, state)` gives `<redirect>?error=access_denied&state=…`.
- The page:
  - shows the Yoda name and origin in large text, the extension ID, the browser label, and what it may do: report defects, list my projects;
  - says "Approve only right after you clicked Connect in the extension" above the buttons;
  - **Approve** calls `POST /api/extension/authorize`, then `location.replace(redirectTo)`;
  - **Cancel** goes to `cancelUrl`;
  - on 403 `extension_not_allowed`, shows "this extension is not approved by your Yoda admin" and redirects nowhere;
  - on a bad query, shows an error and redirects nowhere.

- [ ] **Step 1: Write failing tests**:
  - `parseConnectQuery` cases;
  - `cancelUrl` keeps `state`;
  - the i18n message `extension.connect.onlyAfterConnect` exists in th and en;
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
  - severity (`StatusChip`), and the description, steps, expected and actual read from `defect_reports` (the real text, also for a sensitive report);
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
- Modify:
  - `ops/proxy/Caddyfile`, `apps/core/test/ops-ci.test.ts`, `apps/core/test/ops-proxy.test.ts`;
  - `.github/workflows/release.yml`: `ops/proxy/**` joins the `pull_request.paths`, where it is missing today;
  - `docs/operations.md`, covering:
    - the extension settings and `YODA_EXTENSION_DIRS`;
    - the webhook's Deployment events;
    - the defect upload limit for a hospital's own reverse proxy (e.g. nginx `client_max_body_size 56m` for `/api/extension/defects`);
    - retention and the orphan sweep;
    - that outside notifications carry the real work item title even for a sensitive defect;
  - `docs/development.md`: the curl walkthrough. Approve with a PKCE pair made by `openssl`, exchange the code, call the session, post a defect with `dev-post-defect.ts`, revoke.
  - `docs/guides/admin.md` (Connected browsers, allowlist, application URLs), `docs/guides/staff.md` and `staff.th.md` (Help page, reporting, the notification-title note), `CHANGELOG.md` (an `unreleased` entry).

`request_body` is middleware: every matching block applies, and the innermost limit wins. So the cap is split with two matchers, inside the site block:

```
@defects path /api/extension/defects
@other not path /api/extension/defects
request_body @defects {
	max_size 56MiB
}
request_body @other {
	max_size 32MiB
}
```

- [ ] **Step 1: Write failing tests**:
  - `ops-ci.test.ts`: `the 32MiB request_body block applies to @other, which excludes /api/extension/defects, and the defects path has its own 56MiB block; no unmatched request_body block remains`.
  - `ops-proxy.test.ts`, extending the existing docker-gated suite: run the pinned Caddy image with the bundle's Caddyfile (internal certificate mode) on a throwaway docker network. A second Caddy container, aliased `portal`, answers `respond 200`. Then:
    - `a 40 MiB POST to /api/extension/defects passes the proxy (200)`;
    - `a 40 MiB POST to /api/projects/x/attachments gets 413`;
    - `a 60 MiB POST to the defects path gets 413`.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/ops-ci.test.ts apps/core/test/ops-proxy.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the Caddyfile change, the workflow path and the docs.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: PASS. The proxy suite runs where docker is present, which includes GitHub CI.
- [ ] **Step 5: Verify on the demo stack.** Run the `docs/development.md` walkthrough end to end and see the card. Revoke in Settings. Take screenshots (desktop and phone) of the connect page, Connected browsers (both), the project's Application URLs tab, the defect card and Help, plus the GIF.
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
6. Service-worker limits behind decision 14: a 40 MB multipart `fetch` from the service worker against the 5-minute event lifetime and idle shutdown, compared with the same upload from an extension page.
7. Whether `chrome.storage.local.setAccessLevel` exists and keeps `storage.local` out of content scripts (decision 15).
8. `permissions.request` for an origin, called from a popup click handler before any `await` (it must succeed), and after an `await` (expected to fail with "must be called during a user gesture").

Record each answer and the fallback chosen (decisions 2, 14 and 15). Commit `docs: Yoda Reporter phase 0 spike findings`.

### Task B2: `apps/extension` skeleton, manifest, theme and i18n

**Files:**
- Create:
  - `apps/extension/package.json` (`@yoda/extension`, version = the root version; scripts `dev`, `build`, `build:e2e`, `build:zip`, `typecheck`, `e2e`, `demo`, `check:dist`);
  - `apps/extension/vite.config.ts`, `apps/extension/vitest.config.ts` (`include: ['test/**/*.test.ts']` only, so the root run never picks up the Playwright specs in `e2e/`), `apps/extension/tsconfig.json`;
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
  - the `e2e` target adds `host_permissions: ['<all_urls>']` and is written to `dist-e2e/`, never `dist/`;
  - `version` and `version_name` come from `manifestVersion`;
  - no `content_scripts`, no `web_accessible_resources`, no `externally_connectable`.
- The `apps/extension/release/` output holds `yoda-reporter-<version>.zip`, built from `dist/` by `scripts/zip.ts` with sorted entries and every mtime = `SOURCE_DATE_EPOCH`.

- [ ] **Step 1: Write failing tests**:
  - `release manifest has exactly the required and optional permissions of §5 and none of the forbidden keys (including alarms and tabs)`;
  - `e2e manifest differs only by host_permissions`;
  - `the vitest config includes only test/**/*.test.ts`;
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
- Create: `apps/extension/src/sw/messages.ts`, `apps/extension/src/sw/store.ts`, `apps/extension/src/sw/secrets.ts`, `apps/extension/src/sw/api.ts`, `apps/extension/test/{messages,api,secrets}.test.ts`, `apps/extension/test/support/chrome.ts` (an in-memory `chrome.*` fake for unit tests)

**Interfaces (Produces):**
- `Msg`, a zod discriminated union of every runtime message: `profile.exchange`, `profile.remove`, `session.get`, `token.get`, `capture.arm`, `capture.screenshot`, `capture.fullPage`, `capture.collected`, `draft.get`, `draft.save`, and later `offscreen.*`.
- `senderKind(sender, extensionId): 'page' | 'content' | 'foreign'`:
  - `page`: `sender.id === extensionId` and `sender.url` starts with `chrome-extension://<id>/`, or `sender.origin` equals that origin;
  - `content`: `sender.id === extensionId` and the URL is a web page;
  - otherwise `foreign`.

  `sender.tab` is not used to tell them apart, because an extension page in a tab also has one.
- `onMessage(handler)` drops `foreign`. It accepts only `capture.collected` from `content`, with a matching per-injection nonce. Everything else must come from `page`, and `token.get` only from `page`.
- `store.ts`: `profiles(): Promise<Profile[]>`, where `Profile = { id, name, colour, url, isDefault, managed, sessionOnly, grantId, person, needsReconnect }`, in `storage.local`.
- `secrets.ts`:
  - `getRefresh(profileId)` and `setRefresh(profileId, token | null)`: the extension origin's IndexedDB `yoda-secrets`, or `storage.session` when `sessionOnly`;
  - `getAccess` and `setAccess`: `storage.session`.
- `api.ts`:
  - `yodaFetch(profileId, path, init): Promise<Response>` adds the bearer;
  - on 401, `refreshOnce(profileId)` runs a single flight shared by concurrent callers, through a per-profile promise and a `storage.session` lock entry, then retries once;
  - any `GrantError` reason (`invalid_grant`, `reauth_required`, `revoked`) clears the tokens and sets `needsReconnect`. The popup then shows a calm "Reconnect" button, with no error dialog, and drafts are kept;
  - `checkVersion(session)` gives `'ok' | 'update_available' | 'api_too_new'`.

- [ ] **Step 1: Write failing tests**:
  - Messages:
    - `senderKind: an extension page in a tab is page; a web page with our id is content; another id is foreign`;
    - `token.get from content is refused`;
    - `unknown message types are rejected by the schema`.
  - Tokens:
    - `three concurrent 401s cause one refresh`;
    - `a revoked refresh sets needsReconnect, clears the tokens, keeps drafts, and does not retry`;
    - `sessionOnly keeps the refresh token in storage.session; otherwise it is in IndexedDB, never in storage.local`.
  - Version:
    - `checkVersion compares manifestVersion versions`;
    - `apiVersion 2 gives api_too_new`.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension` — Expected: FAIL.
- [ ] **Step 3: Implement** them. Keep no state in service-worker globals beyond in-flight promises.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): service worker messaging, storage and API client`

### Task B4: Connect flow

**Files:**
- Create: `apps/extension/src/connect/connect.ts` (runs in the options page or the popup, never the service worker), `apps/extension/src/options/ConnectDialog.vue`, `apps/extension/test/connect.test.ts`

**Interfaces:**
- `onConnectClick(url: string)` is the click handler. It does steps 1 and 2 synchronously, before any `await`:
  1. normalise the URL: HTTPS, or `http://localhost` / `127.0.0.1` on any port;
  2. call `chrome.permissions.request({ origins: [origin + '/*'] })` as the first awaited call. Refusal ends the flow with "permission needed".

  Then:
  3. `GET <url>/api/public-config` must parse as `PublicConfig` with `extension.enabled`; otherwise "not a Yoda" (and `permissions.remove` the origin again);
  4. PKCE: 32 random bytes for the verifier, an S256 challenge, a random state;
  5. `launchWebAuthFlow({ url: <origin>/extension/connect?…, interactive: true })`;
  6. check `state`, then send `profile.exchange { origin, code, verifier }` to the service worker, which posts `/api/extension/token` and stores the profile.

  The browser label is `navigator.userAgentData` brand, version and platform, at most 120 characters.
- "Reconnect" in the popup calls `onConnectClick(profile.url)` from its own click handler. The permission is already granted, so the prompt does not appear.

- [ ] **Step 1: Write failing tests** with the chrome fake and a fetch stub:
  - `permissions.request is the first await of the click handler`: the fake records call order and asserts no awaited call before it;
  - `refuses http to a non-localhost host`;
  - `accepts http://localhost:5173`;
  - `refuses a site whose public-config is not Yoda, and removes the origin permission`;
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

### Task B6: Console and network capture (MAIN world), across navigations

**Files:**
- Create: `apps/extension/src/injected/main.ts`, `apps/extension/src/capture/bridge.ts`, `apps/extension/src/capture/logs.ts`, `apps/extension/src/sw/capture-session.ts`, `apps/extension/test/{logs,capture-session}.test.ts`

**Interfaces:**
- `main.ts` is injected on "arm" or capture with `scripting.executeScript({ world: 'MAIN' })`, and is idempotent per page. It:
  - wraps the `console.*` methods, `onerror`, `unhandledrejection`, `fetch` and XHR (method, URL, status, duration, and the `X-Yoda-Build` response header only; never other headers or bodies);
  - keeps a ring buffer of 500 entries;
  - **forwards entries as they arrive**, batched every 500 ms, as `{ type: 'yoda-reporter/v1', nonce, entries }` posted to `window`.
- `bridge.ts` (ISOLATED) accepts only `event.source === window` messages with the type and nonce, and forwards them to the service worker as `capture.collected`.
- `capture-session.ts`:
  - `appendEntries(tabId, entries)` keeps the newest 500 of each kind **per tab in `storage.session`**, so they survive a page navigation and a service-worker restart;
  - on `tabs.onUpdated` with `status: 'complete'` for an armed tab, it re-injects the isolated and MAIN scripts when the new URL has the same origin. `activeTab` still applies on a same-origin navigation; a failed injection or another origin ends the session;
  - `captureState(tabId)` gives `'armed' | 'stopped' | 'off'` with a `stoppedReason` of `'navigated_away' | 'injection_failed' | 'tab_closed'`. The popup and editor show "capture stopped at <time> (<reason>)" so the tester knows the logs end there;
  - it clears the tab's entries when the tab closes or the draft is sent.
- `resourceFailures(entries: PerformanceResourceTiming[]): NetworkEntry[]` keeps `responseStatus >= 400`, or 0 with `transferSize 0` on a same-origin entry.
- `sanitizeEntries(raw: unknown[]): { console: ConsoleEntry[]; network: NetworkEntry[]; dropped: number }` validates with the shared schemas, truncates messages to 2048 characters, and keeps the newest 500 of each.
- `backendBuilds(network)` gives at most 10, one per origin.

- [ ] **Step 1: Write failing tests**:
  - Caps and validation:
    - `10 000 entries keep the newest 500`;
    - `a 1 MB message is cut to 2048 characters`;
    - `non-schema entries are dropped and counted`;
    - `HTML in a message stays text` (assert no `v-html` in `src/`).
  - Collection:
    - `resourceFailures` picks a 500 and a blocked same-origin load;
    - `backendBuilds` dedupes per origin;
    - `main.ts wraps fetch without changing its result or rejection` (`happy-dom` environment for this file only).
  - Navigation:
    - `entries survive a same-origin navigation and the capture is re-injected`;
    - `a cross-origin navigation stops capture with navigated_away and keeps the earlier entries`;
    - `a failed re-injection stops capture with injection_failed`;
    - `entries persist in storage.session across a service-worker restart` (the chrome fake reloads the module).
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/test/logs.test.ts apps/extension/test/capture-session.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): console and network capture without debugger, across navigations`

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

### Task B10: Report form, check before sending, send from the editor tab

**Files:**
- Create: `apps/extension/src/editor/ReportForm.vue`, `apps/extension/src/editor/ReviewPanel.vue`, `apps/extension/src/report/build-report.ts`, `apps/extension/src/editor/send.ts`, `apps/extension/test/{build-report,send}.test.ts`

**Interfaces:**
- `buildReport(draft, form, ctx: { profile; project; production: boolean; includeQuery: boolean; extensionVersion }): { report: DefectReportCreate; files: { part; name; type; data: Blob }[] }`:
  - file names are `screenshot.png`, `screenshot-full.png`, `video.webm`, `buffer-1.webm`, `buffer-2.webm`, `console.json` and `network.json`;
  - each declaration carries `type` and `sizeBytes` (A6);
  - files the tester unticked are left out;
  - on production, console and network are included only when the tester turned them on for this report.
- `sendReport(draftId)` runs **in the editor tab** (decision 14):
  1. it asks the service worker with `token.get { profileId }` and keeps the access token in a local variable only;
  2. it reuses `draft.idempotencyKey`;
  3. `POST <origin>/api/extension/defects` with `encodeDefectForm`, the host permission covering the Yoda origin;
  4. on 401 it asks `token.get` again once, which triggers the service worker's single-flight refresh;
  5. it retries network failures and 5xx 3 times with backoff, keeping the same key;
  6. it maps 413 (with `reason`) to "remove a file", 415, 422 `video_on_production` and 429 (`retryAfter`) to messages;
  7. on 200 or 201 it deletes the draft and shows the work item link.

  A `needsReconnect` profile shows the calm Reconnect button and keeps the draft.
- `ReviewPanel` shows:
  - every file with its size and a checkbox;
  - the required tick "I checked the screenshot and video: there is no patient data, or it is hidden with mosaic or redact" (Send is disabled until ticked);
  - the optional tick "the text may contain patient data";
  - the AI line: "Not sent to AI" for a noAi project or when the optional tick is set, otherwise "Text may be read by AI; media and logs never";
  - on production, a red `v-alert` warning.

- [ ] **Step 1: Write failing tests**:
  - `buildReport` sets `confirmedNoPatientData` only when ticked (otherwise throws), and declares each file's type and exact size;
  - `on production, video and buffer are never included and logs only when turned on`;
  - `includeQuery=false strips the query`;
  - `unticked files are omitted`;
  - `send asks token.get and never reads storage directly`;
  - `send retries a 503 with the same Idempotency-Key and deletes the draft on 201`;
  - `413 shows the limit and keeps the draft`;
  - `429 waits retryAfter`;
  - `a reconnect-needed profile keeps the draft and shows Reconnect`.
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
  - the "update available" banner, and the calm "Reconnect" button for a `needsReconnect` profile, whose click handler calls `onConnectClick` (B4).

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
  - builds `build:e2e` into `dist-e2e/` once, with a throwaway key made in the test's temp directory (never committed), giving a fixed ID per run;
  - calls `chromium.launchPersistentContext('', { channel: 'chromium', args: ['--disable-extensions-except=<dist-e2e>', '--load-extension=<dist-e2e>'], recordVideo? })`;
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
  - `apps/extension/package.json`:
    - `build` writes `dist/`;
    - `build:e2e` writes `dist-e2e/`;
    - `build:zip` deletes `dist/`, runs a clean release build, then zips;
  - `.gitignore` (`apps/extension/dist-e2e/`);
  - `.github/workflows/ci.yml`: the `extension` job runs `build:zip`, then `check:dist`, then gitleaks over `apps/extension/dist` with `detect --no-git --source`;
  - `apps/core/Dockerfile`: a stage `extension` runs `pnpm install --frozen-lockfile --ignore-scripts --filter @yoda/extension...`, then `pnpm --filter @yoda/extension build:zip`, and `apps/extension/release/` is copied to `/app/extension/`;
  - `.github/workflows/release.yml`:
    - `meta` refuses any tag other than `v<x.y.z>` or `v<x.y.z>-rc.<N>` with N from 1 to 999;
    - `meta` checks that `apps/extension/package.json` has the same version;
    - `apps/extension/**` joins the `pull_request.paths`;
  - `packages/shared/test/extension.test.ts`: when `keys/yoda-reporter.pub` exists, `OFFICIAL_EXTENSION_ID` matches it; when it is null, the file is absent;
  - `apps/core/test/ops-ci.test.ts`;
  - `docs/releasing.md`: the version rule, the zip in the core image, and the owner's public-key step before PR B merges;
  - `docs/development.md`: building, loading unpacked, the dev ID and allowlisting it, running the e2e;
  - `CHANGELOG.md`.

**Interfaces:** `check-dist.ts <dir|zip>` exits non-zero when:
- `manifest.json` breaks the §5 rules;
- the release output contains the e2e-only code: the string `<all_urls>` anywhere, or the `?tab=` target branch, found by a marker constant `E2E_TAB_TARGET` that only the e2e build keeps;
- any `.js` file contains `eval(` or `new Function(`, or loads a remote script;
- any file matches the private-key patterns;
- the manifest `version_name` is not the package version.

- [ ] **Step 1: Write failing tests**:
  - `check-dist` refuses fixtures (under `apps/extension/test/fixtures/`) with:
    - a planted `host_permissions` entry;
    - `<all_urls>` in a bundle;
    - the `E2E_TAB_TARGET` marker;
    - a planted `-----BEGIN PRIVATE KEY-----`;
  - `check-dist` passes a clean release build;
  - in `ops-ci.test.ts`:
    - `ci.yml builds and checks the zip and scans it with gitleaks`;
    - `the core image carries the extension zip`;
    - `the release meta step accepts only x.y.z and x.y.z-rc.N, and checks the extension version`.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension apps/core/test/ops-ci.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them.
- [ ] **Step 4: Run** the checks:
  - `pnpm --filter @yoda/extension build:zip && pnpm --filter @yoda/extension check:dist release/yoda-reporter-$(node -p "require('./package.json').version").zip`. Expected: OK.
  - `docker build -f apps/core/Dockerfile -t yoda/core .`, then `docker run --rm yoda/core ls /app/extension`. Expected: the zip.
- [ ] **Step 5: Verify** on the demo stack with the zip loaded unpacked in Chrome and in Edge: connect, report, and see the card in the portal. Take screenshots of the popup, editor (mosaic visible), options and the Help page with a working download.
- [ ] **Step 6: Commit** `build(extension): zip in CI and in the core image, release checks`, push, and open PR B (stacked on A) with the test plan, screenshots and the GIF. **Merge gate:** `keys/yoda-reporter.pub` (owner) is committed and `OFFICIAL_EXTENSION_ID` is filled before PR B merges.

---

## PR C: video, URL mapping, options page (`feat/extension-video-mapping`)

### Task C1: 30 s clips (tabCapture and an offscreen MediaRecorder)

**Files:**
- Create: `apps/extension/src/offscreen/router.ts`, `apps/extension/src/offscreen/recorder.ts`, `apps/extension/src/sw/offscreen.ts`, `apps/extension/test/{recorder,offscreen}.test.ts`, `docs/design/extension-spike.md` (section "Video re-encode measurement")
- Modify: `apps/extension/src/popup/App.vue`, `apps/extension/src/sw/messages.ts`

**Interfaces:**
- The popup's Record click handler calls `chrome.permissions.request({ permissions: ['tabCapture'] })` the first time, before any `await`, then sends `video.start { tabId }`. The service worker never requests permissions.
- `sw/offscreen.ts`:
  - `ensureOffscreen()` creates the single offscreen document (`reasons: ['USER_MEDIA']`) unless `chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })` finds it;
  - `closeOffscreenIfIdle()` closes it when neither a clip nor the buffer runs;
  - messages carry `target: 'offscreen'` and `job: 'clip' | 'buffer'`, and `router.ts` dispatches them in the document.
- `startClip(tabId)`:
  1. `tabCapture.getMediaStreamId({ targetTabId })`;
  2. `ensureOffscreen()`;
  3. send `{ target: 'offscreen', job: 'clip', type: 'start', streamId, maxSeconds }`.
- The recorder:
  - `pickMimeType(isSupported): string` prefers `video/webm;codecs=vp9`, then `vp8`;
  - about 1 Mbit/s, at most 1280 px wide, no audio;
  - **the hard stop at `maxSeconds` is a `setTimeout` in the offscreen document** (decision 16);
  - `fixDuration(blob, ms)` with `fix-webm-duration`;
  - the clip goes back to the service worker, which stores it in the draft.
- Production rules (`rule.production`) hide the video action, and the service worker refuses `video.start` on such a tab.
- The measurement for decision 1 runs C2's two paths in the editor tab on a 30 s synthetic clip, and records the frame ratio and duration of each.

- [ ] **Step 1: Write failing tests**:
  - `pickMimeType` falls back to vp8;
  - `the offscreen recorder stops itself at maxSeconds without the service worker` (fake timers, a fake `MediaRecorder`);
  - `video.start is refused on a production tab`;
  - `only one offscreen document is created when the buffer already runs, and a clip message is routed to the clip job`;
  - `the document is closed when the last job ends`;
  - `the popup requests tabCapture before any await`.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/test/recorder.test.ts apps/extension/test/offscreen.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** them, and record the measurement in the spike doc.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): 30-second tab clips`

### Task C2: Mosaic on video

**Files:**
- Create: `apps/extension/src/editor/VideoEditor.vue`, `apps/extension/src/video/regions.ts`, `apps/extension/src/video/reencode-recorder.ts`, `apps/extension/src/video/reencode-webcodecs.ts`, `apps/extension/src/video/webm-reader.ts`, `apps/extension/test/{regions,webm-reader}.test.ts`

**Interfaces:**
- `VideoRegion = { id; rect; fromMs; toMs; block }` (rectangle only on video). `activeRegions(regions, tMs): VideoRegion[]` uses `fromMs` inclusive and `toMs` exclusive.
- `type Reencode = (src: Blob, regions: VideoRegion[], opts: { mimeType; bitsPerSecond; onProgress(p: number); signal: AbortSignal; preview: HTMLCanvasElement }) => Promise<{ blob: Blob; framesIn: number; framesOut: number }>`.
- `reencodeWithRecorder: Reencode` is path 1. It draws on the visible `preview` canvas. On `visibilitychange` to hidden it pauses the source video and calls `MediaRecorder.pause()`, shows "keep this tab visible while the mosaic is applied", and resumes when visible.
- `reencodeWithWebCodecs: Reencode` is path 2, using `readWebm(buf): { codec; width; height; frames: { timestampUs; key; data }[] }` and `webm-muxer`.
- `applyVideoMosaic(src, regions, opts)`:
  1. tries path 1;
  2. tries path 2 when path 1 throws, is unsupported, or `acceptReencode` says `too_lossy`;
  3. returns `{ ok: false }` when both fail.

  `acceptReencode(r): 'ok' | 'too_lossy'` (`framesOut / framesIn < 0.9` is too lossy).
- The editor shows:
  - a timeline with a scrubber;
  - a drag on the frame draws a region, and range handles set its time range;
  - for each region, a list row with a delete button;
  - "Apply mosaic" with progress and Cancel.

  The result replaces the draft's video. While regions exist and no successful apply has replaced the video, Send is disabled for the video. When `applyVideoMosaic` fails, the dialog offers only "send without video" or "use a still frame".
- The still frame: `stillFrame(src, tMs): Promise<ImageBitmap>` goes into the screenshot editor with the active regions pre-added as mosaic rect ops.

- [ ] **Step 1: Write failing tests**:
  - `activeRegions` boundaries;
  - `acceptReencode`;
  - `applyVideoMosaic tries WebCodecs after a lossy recorder result, and reports failure when both fail` (fake paths);
  - `readWebm reads codec, size and SimpleBlocks from a small fixture WebM` (generated once by a test page, committed under `test/fixtures/`, a few KB, synthetic frames only);
  - `a video with unapplied regions cannot be sent` (`buildReport` throws `mosaic_not_applied`);
  - an e2e step in C5 covers the real pipelines.
- [ ] **Step 2: Run** `pnpm vitest run apps/extension/test/regions.test.ts apps/extension/test/webm-reader.test.ts apps/extension/test/build-report.test.ts` — Expected: FAIL.
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
  - port-specific `localhost` rules, and `http://localhost/*` matching any port;
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
- `armBuffer(tabId)`:
  - is started from the popup's click handler, which requests `tabCapture` before any `await` if needed;
  - runs as job `buffer` in the **shared** offscreen document (C1's `ensureOffscreen` and router);
  - sets the red badge (`action.setBadgeText({ text: '●', tabId })` with the error colour).
- `disarmBuffer(reason: 'saved' | 'timeout' | 'left_mapped_site' | 'production' | 'tab_closed' | 'user')`:
  - the **15-minute timeout is a `setTimeout` in the offscreen document**, reset on every save (decision 16); the document reports `disarmed { reason }` to the service worker, which clears the badge;
  - leaving a mapped site (`tabs.onUpdated` URL change re-checked with `pickRule`), production and tab close disarm it from the service worker.
- `saveBuffer()` → `buffer-1.webm` and `buffer-2.webm` into a new draft. Mosaic regions (C2) apply per segment, with the time offsets of the joined timeline.
- `allowBuffer` (policy, D2) false hides it.

- [ ] **Step 1: Write failing tests**:
  - `snapshot after 75 s gives two segments covering 45–75 s` (fake timers);
  - `nothing is written to IndexedDB or storage while armed`;
  - `the offscreen document disarms itself after 15 minutes without a save, with the service worker stopped`;
  - `each disarm reason stops the recorder and clears the badge`;
  - `production never arms`;
  - `a clip while the buffer runs shares the one offscreen document`;
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
  - `.github/workflows/release.yml`: the `bundle` job gains node, pnpm and the extension build, plus the signing steps below; the `release` job adds the notes line;
  - `ops/install/bundle.sh`: an optional fifth argument, `<extension crx>`; when given, `extension/yoda-reporter-<version>.crx` joins the bundle's file list, so it is checksummed and signed with the rest;
  - `ops/install/release-notes.sh`: an optional flag `--no-crx` that appends the release-notes line;
  - `ops/install/check-release.sh`: when the bundle lists an `extension/` CRX, check that it unpacked into the install directory;
  - `apps/core/test/ops-ci.test.ts`, `apps/core/test/ops-install.test.ts`;
  - `docs/releasing.md`: one-time setup gets a new step, owner only:
    - generate the key on a trusted machine (`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out yoda-reporter.pem`);
    - back it up offline;
    - `gh secret set --env release EXTENSION_CRX_KEY < yoda-reporter.pem`;
    - the public half must equal the committed `keys/yoda-reporter.pub`;
  - also in `docs/releasing.md`: "Rotating the extension key" (a new ID: re-push the policy) and "A release without the CRX".

**Signing steps in `bundle`:**
1. **Real run, secret set:**
   - write the key to `$RUNNER_TEMP` under `umask 077`, with an `EXIT` trap removing it;
   - if `publicKeyB64(key)` differs from `keys/yoda-reporter.pub`, **fail** with `::error::EXTENSION_CRX_KEY does not match keys/yoda-reporter.pub: the extension would get another ID (docs/releasing.md).`;
   - otherwise pack and verify with `--expect-id OFFICIAL_EXTENSION_ID`.
2. **Real run, secret missing or empty:** do **not** fail.
   - Emit `::warning::EXTENSION_CRX_KEY is not set in the release environment: this release ships the extension zip (in the core image) without a signed CRX, so managed installs cannot update from it (docs/releasing.md).`
   - Run `bundle.sh` without the CRX, and set the job output `crx=false`.
   - The `release` job then calls `release-notes.sh --no-crx`, which adds "This release has no signed extension package (CRX); managed Chrome and Edge installs keep their current version." to the notes.
3. **Dry run:** generate a throwaway key in a `mkdir -m 700` temp directory, use it once, delete it, and verify with the throwaway ID. It never touches `EXTENSION_CRX_KEY`.
4. In every case, run `pnpm --filter @yoda/extension build:zip` first (the clean release build), and run `bundle.sh` before the minisign signing.

- [ ] **Step 1: Write failing tests**:
  - in `ops-ci.test.ts`:
    - `a real release without EXTENSION_CRX_KEY warns, bundles without the CRX and adds the notes line, and does not fail`;
    - `a present but mismatched key fails the release`;
    - `the dry run uses a throwaway key that is never uploaded`;
    - `packs before minisign signs SHA256SUMS`;
    - `apps/extension/** triggers the dry run`;
  - in `ops-install.test.ts`:
    - `bundle.sh with a CRX lists extension/yoda-reporter-<v>.crx in the tarball, and check-release passes`;
    - `without one, the bundle is unchanged and check-release passes`;
    - `release-notes.sh --no-crx appends the line`.
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

It answers 404 when there is no CRX for the running version (a release made without `EXTENSION_CRX_KEY`), when `OFFICIAL_EXTENSION_ID` is null, or when the extension is disabled. Values are XML-escaped.

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

1. **The extension key pair** (the decision is already approved; the action is the owner's). Generate the RSA key and back it up offline. The plan never creates, stores or prints it.
   - **Before PR B merges:** commit the public half as `keys/yoda-reporter.pub`, the manifest `key` that fixes the extension ID. PR B is blocked at merge until then; releases are not.
   - **For signed CRX releases (PR D):** store the private key as `EXTENSION_CRX_KEY` in the GitHub `release` environment. Until then, real releases still publish: the zip without a CRX, with a warning and a release-notes line. A secret that does not match the committed public key fails the release.
2. **Chrome Web Store:** recommended off and not planned. Only the owner can decide to list it later (a developer account, privacy disclosures, the first upload with the same key).

Already approved, for the owner's calendar rather than as a decision: the DPO review before the managed rollout (§15 item 13).

## SDD task list

PR A, Yoda server side (`feat/extension-server`)
1. **A1** Shared contracts and settings. Acceptance: `pnpm vitest run packages/shared` passes with the manifest-version (final and rc only), extension-ID, schema and match-pattern tables (including `http://localhost/*` on any port), and the `extension` settings page lists every key in th and en.
2. **A2** Grants and tokens. Acceptance:
   - codes are claimed atomically, and a double exchange yields one token;
   - any refresh reuse revokes the grant, with no grace;
   - removing an extension ID from the allowlist cuts its grants;
   - reauth, expiry and lost staff status give the right reasons;
   - only hashes are stored;
   - `RateLimiter.check` does not consume.
3. **A3** Route modes and the connect, token, revoke and session routes. Acceptance:
   - `token`, `public` and `keycloak` modes behave as specified, and all three give 404 when disabled and 503 `recovery_mode` in forced recovery;
   - extension tokens are refused outside `/extension/*`, and Keycloak tokens on every extension route but `/extension/authorize`;
   - code failures are limited per IP and refresh failures per family;
   - the session lists member projects only.
4. **A4** Connected browsers API. Acceptance: a person sees and revokes only their own grants, an admin sees all and can revoke all, and no secret appears in a response.
5. **A5** Defect template, `createDefect` and AI withholding. Acceptance:
   - a defect item starts at triage, owned and requested by the reporter;
   - its attachments are noAi with roles;
   - sensitive text lives only in `defect_reports`, with the marker in the description;
   - the neutral title replaces the real one in the context pack, the issue section, the secretary events and every secretary tool;
   - the template is extension-only.
6. **A6** `POST /extension/defects`. Acceptance:
   - idempotency is checked first, and an in-flight duplicate reuses the winner;
   - the report part is validated in full before any file part is read;
   - the multipart limits reject with existing error shapes;
   - the production video refusal covers all the person's projects;
   - failures clean up the stored objects.
7. **A7** Application URLs. Acceptance: a PM edits validated patterns, members read them, and the project tab shows them in th and en.
8. **A8** GitLab environments and mappings. Acceptance: deployment webhooks and sync fill `deploy_environments`, and `/extension/mappings` returns member-only rules with production from the tier.
9. **A9** Defect files. Acceptance:
   - `noAi` cannot be turned off;
   - authorised removal writes `attachment.removed`;
   - the daily purge honours 180/90/0 days from the close event;
   - the orphan sweep removes unreferenced objects older than 24 h.
10. **A10** Approve page. Acceptance:
    - Approve redirects only to the allowlisted `chromiumapp.org` URI;
    - Cancel returns `access_denied`;
    - the page says "approve only right after you clicked Connect in the extension" and cannot be framed;
    - unknown IDs see the admin message.
11. **A11** Connected browsers UI. Acceptance: settings and admin pages list and revoke, revoke-all needs typed confirmation, and the admin rail item is admin-only.
12. **A12** Defect card, Help page and downloads. Acceptance: the card renders the report text from `defect_reports`, and media and logs as text, with placeholders for purged files; Help shows a download or the build placeholder; downloads serve only release file names.
13. **A13** Proxy cap and docs. Acceptance:
    - Caddy's 32 MiB block excludes the defect path, which has its own 56 MiB block;
    - a real Caddy run passes 40 MiB to the defect path and refuses it elsewhere;
    - the development walkthrough, runbook and guides are written;
    - `ops/proxy/**` triggers the release dry run;
    - the demo-stack screenshots and GIF are in PR A.

PR B, extension MVP (`feat/extension-mvp`)
14. **B1** Phase 0 spike. Acceptance: `docs/design/extension-spike.md` answers the eight questions with evidence, including service-worker upload limits, `setAccessLevel` and the gesture rule, and names the e2e connect path.
15. **B2** Skeleton, manifest, theme and i18n. Acceptance:
    - the release manifest has exactly the §5 permissions, and the e2e manifest (in `dist-e2e/`) adds only host permissions;
    - the versions are in lockstep;
    - the Vitest config includes only `test/**/*.test.ts`;
    - the shared theme is used by the portal and the extension.
16. **B3** Service worker core. Acceptance:
    - senders are told apart by URL or origin, not `sender.tab`;
    - the refresh token lives in IndexedDB (or `storage.session`), never in `storage.local`;
    - refresh is single-flight, and a revoked grant shows a calm Reconnect.
17. **B4** Connect flow. Acceptance: `permissions.request` is the first await of a page click handler and precedes the public-config check; only HTTPS or localhost (any port) Yoda origins work; state and PKCE are checked; no code or verifier is stored.
18. **B5** Metadata and build detection. Acceptance: the meta, well-known, header and gitlab precedence holds, with the source recorded and the query switch working.
19. **B6** Console and network capture. Acceptance: entries are forwarded as they arrive, kept per tab in `storage.session`, re-injected after same-origin navigations, and the tester is told when capture stopped; entries are capped and validated, with no headers or bodies.
20. **B7** Screenshots. Acceptance: visible capture works; the full-page plan respects the 15 000 px cap and falls back cleanly.
21. **B8** Drafts and editor shell. Acceptance: drafts survive a reload, keep their idempotency key, and are purged after 24 h.
22. **B9** Annotation editor. Acceptance: all tools work, including mosaic rectangle and brush, with undo and redo; the destructive ops are burned into the exported PNG, and only the flattened image is uploadable.
23. **B10** Report form and send. Acceptance: the editor tab uploads with a token from the service worker; Send needs the confirmation; production rules are applied; retries keep the key; a reconnect keeps the draft.
24. **B11** Popup and profiles. Acceptance: profiles switch, removal revokes, and `?tab` works only in the e2e build.
25. **B12** E2E and demo. Acceptance: the Playwright spec connects, captures, applies mosaic and sends to the stub with validated payloads in CI; the demo GIF is recorded.
26. **B13** Zip, image and release checks. Acceptance:
    - a clean release build is zipped, and `check-dist` proves the absence of `<all_urls>` and of the `?tab` path in the code;
    - the zip is gitleaks-scanned;
    - the core image serves it;
    - release meta accepts only final and rc versions;
    - PR B's merge waits for the owner's public key.

PR C, video and mapping (`feat/extension-video-mapping`)
27. **C1** 30 s clips. Acceptance:
    - tabCapture is requested from the popup gesture;
    - one shared offscreen document with routed jobs;
    - the hard stop is timed in the offscreen document;
    - production tabs refuse video;
    - the re-encode measurement is recorded.
28. **C2** Mosaic on video. Acceptance:
    - the recorder path pauses while hidden;
    - WebCodecs is tried second;
    - below 90% of frames, only "without video" or "still frame" is offered;
    - unmasked regions are never sent.
29. **C3** URL mapping. Acceptance: the most specific rule wins with the policy, yoda, mine tiebreak, the repo fallback picks member projects only, and Yoda rules stay on their own profile.
30. **C4** Options page. Acceptance: profiles, locked and editable rules, the URL tester with reasons, and granted origins with remove.
31. **C5** E2E and demo. Acceptance: the video-mosaic and mapping specs pass in CI, and the GIFs and screenshots are in PR C.

PR D, buffer and managed install (`feat/extension-enterprise`)
32. **D1** Rolling buffer. Acceptance:
    - it is armed by click only and keeps two in-memory segments in the shared offscreen document;
    - the 15-minute disarm is timed there;
    - it shows a red badge, never runs on production, and the portal plays the segments back to back.
33. **D2** Managed policy and IT guide. Acceptance: the managed schema drives locked instances and rules, `sessionOnly`, and the video and buffer switches; the Chrome, Edge and Intune guide is written.
34. **D3** CRX3 packer. Acceptance: pack and verify round-trip with a throwaway key, tampering fails, and a force-install on managed Chrome and Edge succeeds by hand.
35. **D4** Release signing. Acceptance:
    - a real release without `EXTENSION_CRX_KEY` publishes the zip without a CRX, with a warning and a notes line;
    - a mismatched key fails;
    - the dry run signs with a throwaway key;
    - a signed bundle carries the CRX.
36. **D5** `updates.xml` and Help managed section. Acceptance: core serves `updates.xml` and the CRX from the mounted bundle directory (404 without a CRX), the Help page shows the policy snippet, and the managed VM screenshot is in PR D.
