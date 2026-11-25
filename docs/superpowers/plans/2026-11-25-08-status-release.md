# Status & Release (Plan 8 of 8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two things ship in this plan, and together they make the first release usable. The Status screen shows department and project health, counts by step, overdue items, open discussions, people load, AI spend, and an AI-written weekly summary per project. The production side covers notifications by email, LINE and Telegram, safe migrations, readiness checks, daily backups with a tested restore, image publishing and a manual deploy job, and an operations runbook.

**Architecture:** Core gets a `status/` module with pure health rules, aggregate queries, and a weekly-summary job on the existing pg-boss schedule and AI gateway. Notifications get outside channels (email over SMTP, LINE Messaging API, Telegram Bot API) behind one channel interface, with department-level switches and per-person, per-kind channel choices. Deployment becomes four steps, run by the GitLab CI pipeline that publishes images and offers a manual deploy job:
1. A `migrate` one-shot service.
2. The core and portal services, with health and readiness checks.
3. A `backup` service.
4. Restore scripts.

**Tech Stack:** as plans 1–7, plus `nodemailer` (SMTP) in core and Mailpit for dev mail (`# DEV ONLY`). LINE and Telegram use plain `fetch` against their HTTP APIs, with fake servers in tests.

**Spec:** `docs/superpowers/specs/2026-11-24-ai-work-portal-design.md` (§13 Status, §15 Deployment and operations, §16 notification channels, §14 secrets). Follow-ups: `docs/superpowers/plans/2026-11-24-01-foundation-followups.md` ("Later / plan 8"), `2026-11-24-04-secretary-followups.md` (notification kinds), `2026-11-25-05-discussions-followups.md` (status counts from the discussions table), `2026-11-25-07-runners-followups.md` (image publishing).

**Not in this plan:** Kubernetes, multi-instance core, calendar integration, GitHub image publishing.

## Defaults chosen in this plan (owner can override)

1. **Health rules.** The first rule that matches wins:
   - **Blocked:** any active work item has had no events for 5 or more days, or an urgent discussion has been open 3 or more days, or a GitLab issue sync has failed.
   - **At risk:** any item is overdue, or a high-priority discussion has been open 7 or more days, or the project AI budget is at 80% or more.
   - **On track:** otherwise.

   Each project shows the reasons behind its health. The thresholds are constants in one file.
2. **Overdue.** A work item may have an optional target date, set by its PM or owner. "Overdue" means the item is active and its target date has passed, in Asia/Bangkok.
3. **Notifications (owner decision).**
   - **Channels.** Three channels go outside the portal: email (hospital SMTP), LINE (Messaging API through a LINE Official Account) and Telegram (Bot API).
   - **When a channel is on.** It is on only when its credentials are set in env *and* an admin has enabled it in Admin → Notifications. Each person chooses which enabled channels they want for each notification kind.
   - **Defaults when a person has no choices.**
     - Staff get email for `task_assigned`, `proposal_pending` and `discussion`.
     - Requesters get email for `request_update`.
     - LINE and Telegram stay off until the person links an account.
   - **Linking.**
     - **LINE:** the person adds the official account and sends the one-time link code shown in the portal (`LINK-XXXXXX`, valid 15 minutes). The signed webhook binds their LINE user id.
     - **Telegram:** the person opens `t.me/<bot>?start=<code>`. The webhook (secret token header) binds their chat id.
     - **Unlinking:** possible from the portal at any time. A LINE unfollow or a Telegram "blocked" error unlinks automatically.
4. **Weekly summary.** Every Monday at 08:00 Asia/Bangkok, the fast model writes a draft summary of the past 7 days for each active project. It is stored as a `draft` knowledge document titled with the ISO week, and PMs can regenerate it. No-AI projects and projects over budget are skipped.
5. **Backups.** Every day at 02:00 Asia/Bangkok:
   - a `pg_dump -Fc` of the database;
   - a mirror of the storage bucket, kept on a backup volume for 14 days.

   Copying backups off the server is the owner's infrastructure choice; the runbook covers it.
6. **Release.**
   - GitLab CI publishes `core`, `portal` and `runner` images to the GitLab project's container registry. Images are tagged with the commit SHA, and with the git tag on tags.
   - A manual `deploy` job runs on tags. It connects over SSH to a host from CI variables, then pulls, migrates and restarts.
   - GitHub Actions stays build-only, because the repo is public.
   - The version is `1.0.0`.

## Global Constraints

- Requesters never see the status screens, other people's load, AI spend or summaries. These routes are staff-only, and a project's status needs project visibility.
- Weekly summaries go through the AI gateway with project billing. They respect no-AI and the budget, and their material is fenced like context packs.
- Outside messages (email, LINE, Telegram) hold only the notification's own title, body and an absolute portal link. Nothing more goes to requesters than the portal notification already holds.
- **Credentials:** the SMTP password, the LINE channel access token and secret, and the Telegram bot token come only from env. They are never logged, never stored in the DB and never returned by an API.
- **LINE webhook:** requests are verified with `X-Line-Signature`, an HMAC-SHA256 of the raw body keyed by the channel secret, compared in constant time.
- **Telegram webhook:** requests need `X-Telegram-Bot-Api-Secret-Token` to equal `TELEGRAM_WEBHOOK_SECRET`.
- The repo is public. No secrets and no real hostnames, including the internal GitLab host: use `example.org` placeholders. Dev-only literals are marked `# DEV ONLY`.
- Production compose must not run migrations from more than one container. The `migrate` service runs first and core waits for it.
- Thai is the default UI, every string goes through i18n, and th/en stay in parity. Repo style applies.

## Review Focus

1. **A project with no work items, or only cancelled ones:** shows "on track" with zeros, not an error or a NaN load. Test in Task 1.
2. **A requester or a non-member staff calling `/status` or `/projects/:id/status`:** gets 403 or 404. Tests in Task 1.
3. **A channel down or misconfigured** (SMTP refused, LINE or Telegram 5xx or 401), or **a forged webhook** (bad LINE signature, wrong Telegram secret, a reused or expired link code): the delivery job retries and then gives up, portal notifications are unaffected, credentials never appear in logs, and forged or stale requests bind nothing. Tests in Tasks 4 and 5.
4. **The weekly summary running twice for the same week** (a restart, or a manual regenerate racing the schedule): one entry per project-week; a regenerate replaces the draft. Test in Task 2.
5. **Restoring a backup into an empty database and storage:** the app starts and the data is there. Scripted check in Task 7.

---

### Task 1: Target dates, health rules and status queries

**Files:**
- Create: `packages/shared/src/status.ts`, `apps/core/src/status/health.ts`, `apps/core/src/status/queries.ts`, `apps/core/src/routes/status.ts`
- Modify: `packages/shared/src/work.ts` (`WorkItem.targetDate`, `WorkItemPatch.targetDate`), `apps/core/src/db/schema.ts` + migration `0016_status` (`work_items.target_date date null`), the work item patch route (PM or owner sets it; event `work_item.target_date_changed`), `packages/shared` EventType
- Test: `apps/core/test/status-health.test.ts`, `apps/core/test/status-routes.test.ts`

**Interfaces:**
- Shared:
  - `Health = z.enum(['on_track','at_risk','blocked'])`.
  - `HealthReason = z.object({ code: z.enum(['stuck','urgent_discussion','sync_failed','overdue','high_discussion','ai_budget']), count: z.number().int(), sample: z.array(z.object({ id: uuid, title: z.string() })).max(3) })`.
  - `ProjectStatusSummary = z.object({ projectId, name, health: Health, reasons: z.array(HealthReason), activeItems, overdueItems, openDiscussions, countsByStep: z.record(z.string(), z.number()), aiSpendUsd: z.number(), aiBudgetUsd: z.number().nullable() })`.
  - `DepartmentStatus = z.object({ projects: z.array(ProjectStatusSummary), totals: { activeItems, overdueItems, openDiscussions, aiSpendUsd }, departmentAiSpendUsd: z.number() })`.
  - `ProjectStatus = ProjectStatusSummary.extend({ board: z.array(z.object({ stepKey, stepName, items: z.array(BoardItem) })), people: z.array(PersonLoad), recentEvents: z.array(TimelineEvent).max(30), discussions: z.array(DiscussionSummary).max(20), repos: z.array(Repo), weeklySummary: WeeklySummary.nullable() })`.
    - `BoardItem = { id, title, priority, targetDate, overdue, ownerName, stuckDays }`.
    - `PersonLoad = { personId, name, roles, openTasks, inProgressTasks, todayAssigned }`.
    - `WeeklySummary = { entryId, week: 'YYYY-Www', body, status, createdAt }`.
- `HEALTH_RULES = { stuckDays: 5, urgentDiscussionDays: 3, highDiscussionDays: 7, budgetRatio: 0.8 }` in `status/health.ts`.
- `computeHealth(input: { stuck: Item[], urgentOpen: Item[], syncFailed: Item[], overdue: Item[], highOpen: Item[], aiRatio: number | null }): { health, reasons }` is pure. Blocked reasons come before at-risk reasons, and each reason keeps up to 3 samples.
- Routes:
  - `GET /status` (staff) covers the projects the caller can see. Admins see all.
  - `GET /projects/:id/status` (staff and project visibility; non-member → 404).
  - Counts come from tables (`discussions` for open counts and the latest event per item for stuck), not from live events.
  - AI spend is `monthUsage`, the same as the budget.
  - `overdue` is evaluated against `bangkokDate()`.

- [ ] **Step 1: Write failing tests.**
  - `computeHealth`: every rule in isolation; blocked beats at-risk; an empty input → `on_track` with no reasons.
  - Routes: a project with no items → `on_track` and zeros; one overdue item → `at_risk` with reason `overdue` count 1; an item with no events for 6 days → `blocked/stuck`; an urgent discussion open 4 days → `blocked`; a requester → 403; a non-member → 404 on the project route and the project absent from `/status`; `countsByStep` matches the active items' current steps; setting `targetDate` by a non-PM non-owner → 403.
- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/status-*.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Aggregate in SQL per project and avoid N+1 per item. About 10 projects and hundreds of items are expected.
- [ ] **Step 4: Run** `pnpm vitest run apps/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): project health and status queries`.

---

### Task 2: Weekly AI summary

**Files:**
- Create: `apps/core/src/status/weekly.ts`; Modify: `apps/core/src/jobs/{queue,handlers}.ts` (schedule `weekly-summary` `0 8 * * 1` Asia/Bangkok, plus a job `weekly-summary-project { projectId, week }`), `apps/core/src/ai/prompts.ts`, `apps/core/src/routes/status.ts` (`POST /projects/:id/weekly-summary` for PM/admin → 202)
- Test: `apps/core/test/status-weekly.test.ts` (AI mock from `test/ai-mocks.ts`)

**Interfaces:**
- `isoWeek(date: Date, tz = 'Asia/Bangkok'): string` returns a string like `2026-W48`.
- `weeklyMaterial(db, projectId, since: Date): Promise<string>` builds fenced material from the last 7 days:
  - events, with types and work item titles
  - accepted task results, clipped
  - decided discussions
  - confirmed knowledge
  - progress notes, labelled as unverified drafts

  It leaves out no-AI entries and requester names, and is clipped to 40 000 characters.
- `runWeeklySummary(deps, { projectId, week, force })`:
  - It skips no-AI projects and projects with nothing in 7 days (no entry).
  - It calls `ai.generateText({ job: 'fast', projectId, … })` outside any transaction. A budget refusal → skip with event `status.weekly_summary_skipped` reason `budget_exceeded`.
  - It upserts one knowledge entry per (project, week): type `document`, sourceKind `ai`, status `draft`, title `สรุปประจำสัปดาห์ <week> / Weekly summary <week>`, and a ref key `weekly:<projectId>:<week>`.
  - Without `force`, an existing entry for the week → no-op. With `force`, the entry is replaced as a new version.
  - It records `status.weekly_summary`.
- The scheduler fans out one `weekly-summary-project` job per active project, with singleton key `<projectId>:<week>`.
- `EventType` adds `status.weekly_summary` and `status.weekly_summary_skipped`.

- [ ] **Step 1: Write failing tests.**
  - The material contains an event from 3 days ago and not one from 10 days ago, contains no requester name, and is fenced.
  - A run creates one draft entry. A second run in the same week → still one, and no second AI call.
  - `force` → a new version.
  - No-AI project → no AI call, no entry.
  - The AI mock throws `budget_exceeded` → a skipped event, no entry.
  - Fan-out enqueues one job per active project.
  - A non-PM calling POST → 403.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement.** Prompt rules: Thai if the project's work is in Thai; sections Progress / Decisions / Risks / Next; no names of requesters; under 400 words.
- [ ] **Step 4: Run** `pnpm vitest run apps/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): weekly AI project summary`.

---

### Task 3: Portal Status screens

**Files:**
- Modify: `apps/portal/app/pages/status.vue` (department overview); Create: `apps/portal/app/components/status/{HealthChip,ProjectCard,Board,PeopleLoad,WeeklySummary}.vue`, `apps/portal/app/utils/status.ts`
- Modify: `apps/portal/app/pages/projects/[id].vue` (a "Status" tab, the default for staff), `apps/portal/app/pages/work-items/[id].vue` (target date field for PM/owner, overdue chip), i18n files, `EventTimeline.vue` (labels for new events)
- Test: `apps/portal/test/status.test.ts`

**Interfaces:**
- `healthColor(h: Health): string` returns success, warning or error. `reasonText(t, r: HealthReason): string` gives a localized sentence with the count. `isOverdue(targetDate: string | null, today: string): boolean`.
- **Department page:**
  - One card per project with its health chip, its reasons (each linking to a sample item), active, overdue, open discussions and AI spend against budget (a progress bar when a budget is set), and counts by step as small chips.
  - Totals sit at the top.
  - The page reloads on live events for work items, tasks and discussions, debounced.
- **Project Status tab:**
  - A board with one column per step and item cards: priority, owner, target date, overdue and stuck markers.
  - People load, recent events (reusing `EventTimeline`), open discussions linking to their detail, and GitLab repo links.
  - The weekly summary card shows a "draft" label and, for PM/admin, a "Regenerate" button that confirms in a dialog and calls POST.
- Requesters never see the Status nav item. `/status` is already a staff prefix; verify it.

- [ ] **Step 1: Write failing tests** for `healthColor`, `reasonText` (th and en, with counts), `isOverdue` (today is not overdue, yesterday is, null is not), i18n parity, and the nav item for staff only.
- [ ] **Step 2: Run** `pnpm vitest run apps/portal`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Browser check** on the dev stack:
  1. Set a past target date on an item and see the project turn "at risk" with the overdue reason.
  2. Open the board.
  3. Regenerate a weekly summary with a dev AI key if one is set; otherwise check that the card shows the "AI not configured" state.

  Stop only processes you started.
- [ ] **Step 6: Commit** `feat(portal): status screens`.

---

### Task 4: Notification channels, email and preferences

**Files:**
- Create: `apps/core/src/notifications/channels/{index,email}.ts`, `apps/core/src/notifications/deliver.ts`, `packages/shared/src/channels.ts`, `apps/portal/app/pages/settings/notifications.vue`, `apps/portal/app/pages/admin/notifications.vue`
- Modify: `apps/core/src/notifications/service.ts` (enqueue `notify-deliver` after commit), `apps/core/src/db/schema.ts` + migration `0017_notification_channels`, `apps/core/src/config.ts` (`SMTP_HOST`, `SMTP_PORT` default 587, `SMTP_SECURE` default false, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`), `apps/core/src/jobs/*`, routes (`GET/PUT /me/notification-prefs`, `GET/PATCH /admin/notification-channels`), `docker-compose.yml` (Mailpit `# DEV ONLY` on 8025/1025), `.env.example`, `docker-compose.prod.yml`, portal user menu and admin nav, i18n
- Test: `apps/core/test/notifications-channels.test.ts` (fake email transport, no network)

**Interfaces:**
- `ChannelName = z.enum(['email','line','telegram'])`.
- `NotificationPrefs = z.object({ kinds: z.record(NotificationKind, z.array(ChannelName)) })`. A missing kind means the role default from the defaults section.
- `ChannelStatus = z.object({ name: ChannelName, configured: z.boolean(), enabled: z.boolean() })`. `ChannelSettingsPatch = z.object({ email?: boolean, line?: boolean, telegram?: boolean })`.
- `MyChannels = z.object({ available: z.array(ChannelName), linked: z.object({ email: z.boolean(), line: z.boolean(), telegram: z.boolean() }) })`. Email counts as linked when the person has an email address.
- Tables:
  - `notification_channel_settings`: single row `id=1`, booleans `email_enabled`, `line_enabled`, `telegram_enabled`, all default false, seeded.
  - `notification_prefs`: `person_id` pk, `kinds jsonb`.
  - `channel_links`: `person_id`, `channel`, `external_id` (LINE userId / Telegram chatId), `linked_at`, with pk (`person_id`, `channel`) and unique (`channel`, `external_id`).
  - `channel_link_codes`: `code` pk, `person_id`, `channel`, `expires_at`, `used_at`.
  - `notification_deliveries`: `notification_id`, `channel`, `state` (`sent`/`failed`/`skipped`), `error_code`, `at`, with pk (`notification_id`, `channel`).
- `Channel = { name: ChannelName, configured(config): boolean, send(target: { personId, email?, externalId? }, msg: { title, body, url }): Promise<void> }`. A thrown `ChannelError { code, permanent: boolean }` marks the failure, and a permanent error never retries.
- `email` uses nodemailer (pinned); tests inject the transport through `deps.mailTransport`.
- `channelsFor(db, config, personId, kind): Promise<ChannelName[]>` is the person's choice for the kind ∩ admin-enabled ∩ configured ∩ linked.
- After commit, `notify()` enqueues one `notify-deliver { notificationId }` when that list is non-empty.
- `deliver(deps, notificationId)`:
  - It sends on each channel that has no `sent` row yet, which makes it idempotent per channel.
  - Each result is recorded in its own row.
  - It retries the job (3 attempts, backoff) only when a transient failure remains.
  - Logs carry the channel and the error code only.
- `url` = `${PORTAL_URL}${link}`.
- The message text is the notification title and body plus the link, and a footer naming where to change preferences (th + en).
- **Portal settings page:** a grid of notification kinds × available channels with checkboxes. Linking buttons appear for LINE and Telegram once Task 5 lands; in this task, show them disabled when the channel is unavailable. Requesters see only `request_update` and `secretary_message`.
- **Admin page:** each channel shows configured (from env, read-only) and an enabled switch. A channel that isn't configured can't be enabled (422).

- [ ] **Step 1: Write failing tests.**
  - With no SMTP config, `channelsFor` excludes email.
  - Configured but admin-disabled → excluded.
  - Default staff prefs → a `task_assigned` email is sent through the fake transport with an absolute link.
  - A requester's `request_update` message contains only the notification text.
  - The transport throws a transient error 3 times → the delivery row is `failed` with a code and the log has no password.
  - The job runs twice → one email.
  - PUT prefs with an unknown kind or channel → 422.
  - PATCH enabling an unconfigured channel → 422.
  - A non-admin PATCH → 403.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: notification channels with email and preferences`.

---

### Task 5: LINE and Telegram

**Files:**
- Create: `apps/core/src/notifications/channels/{line,telegram}.ts`, `apps/core/src/notifications/linking.ts`, `apps/core/src/routes/channel-webhooks.ts`, `apps/core/test/fake-line.ts`, `apps/core/test/fake-telegram.ts` (node:http fakes, like `fake-gitlab.ts`)
- Modify: `apps/core/src/config.ts` (`LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `LINE_API_URL` default `https://api.line.me`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` ≥ 16 chars, `TELEGRAM_API_URL` default `https://api.telegram.org`), `.env.example`, `docker-compose.prod.yml`, routes `POST /me/channel-links/:channel/code` and `DELETE /me/channel-links/:channel`, portal settings page (link and unlink UI), README/runbook notes in Task 8
- Test: `apps/core/test/notifications-line-telegram.test.ts`

**Interfaces:**
- `createLinkCode(deps, me, channel: 'line'|'telegram'): Promise<{ code, expiresAt, instructions: { addFriendUrl?: string, deepLink?: string } }>`.
  - Codes are `LINK-` plus 6 base32 characters (no 0/O/1/I), valid 15 minutes, one active code per person and channel (a new code replaces the old).
  - Telegram's `deepLink` is `https://t.me/<TELEGRAM_BOT_USERNAME>?start=<code without LINK->`.
- `consumeLinkCode(tx, channel, code, externalId): Promise<'linked'|'invalid'>`.
  - The code must be unused, unexpired and for that channel.
  - It marks the code used and upserts `channel_links`. If that external id was linked to another person, the old link is moved.
  - The case of the code is ignored.
- `POST /webhooks/line` is public. It verifies `X-Line-Signature` over the raw body (constant time); a mismatch → 401 with nothing processed. It handles:
  - `message` text events: a text matching a code → link, and reply "linked" / "code invalid or expired" through the reply API.
  - `follow`: reply with instructions.
  - `unfollow`: delete that user's link.

  It always answers 200 quickly once verified.
- `POST /webhooks/telegram` is public. It requires `X-Telegram-Bot-Api-Secret-Token === TELEGRAM_WEBHOOK_SECRET` (constant time); otherwise 401. It handles:
  - `message.text` `/start <code>`: link chat id `message.chat.id` and reply through `sendMessage`.
  - `my_chat_member` with status `kicked`: delete the link.
- Channels:
  - **`line.send`:** push message `POST /v2/bot/message/push` with a Bearer token, `to: externalId`, one text message of at most 5 000 characters.
  - **`telegram.send`:** `POST /bot<token>/sendMessage` with `chat_id` and `text`, at most 4 096 characters, plain text with no parse mode.
  - **Errors (both):** 429/5xx → transient; 400/401/403 → permanent.
  - **Telegram 403 "blocked":** also deletes the link.
  - **Secrets:** the token is never included in error text. Telegram's token sits in the URL path, so error messages and logs must strip it.
- `MyChannels.linked.line/telegram` reflect `channel_links`.
- **Portal:** "Link LINE" shows the code, the add-friend instructions (`LINE_ADD_FRIEND_URL` optional public config) and a countdown. "Link Telegram" shows a button that opens the deep link, plus the code. The page polls `GET /me/notification-prefs` (or uses live events) until linked, and shows "Unlink" when linked.

- [ ] **Step 1: Write failing tests**, using the fakes:
  - **LINE webhook:** a valid signature with a text event carrying a fresh code → linked, and the reply was sent to the fake. A bad signature → 401 with no link. A code used twice → the second is invalid. An expired code → invalid. An unfollow → unlinked.
  - **Telegram webhook:** the right secret with `/start <code>` → linked and `sendMessage` called. A wrong or missing secret → 401. `kicked` → unlinked.
  - **Delivery:** a linked person with `task_assigned` → [`line`,`telegram`] gets a push on both fakes with the absolute link. The LINE fake 500 ×3 → failed and transient. The Telegram 403 blocked → permanent, no retry, link removed.
  - **Secrets and errors:** logs and errors never contain either token, including Telegram's token in the URL.
  - **Config:** without the env set, the channel is not configured and admins can't enable it.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement.** Capture the raw body for the LINE signature: a route-scoped content-type parser that keeps the Buffer.
- [ ] **Step 4: Run** `pnpm vitest run && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Browser check.** Point the dev core at the fakes, which need a small dev script `fake-channels` (`# DEV ONLY`):
  1. Link Telegram by posting the webhook payload with curl.
  2. Trigger a task assignment and see the message arrive in the fake's log.

  Stop only processes you started.
- [ ] **Step 6: Commit** `feat: LINE and Telegram notifications with account linking`.

---

### Task 6: Production hardening

**Files:**
- Modify: `apps/core/src/config.ts` (`OIDC_JWKS_URL` optional, used for fetching keys while `OIDC_ISSUER` stays the token issuer; `MIGRATE_ON_START` default `true` in dev, set `false` in prod compose), `apps/core/src/auth/plugin.ts`, `apps/core/Dockerfile` (CMD runs `node dist/server.js`; the server runs migrations only when `MIGRATE_ON_START=true`), `apps/core/src/app.ts` (`GET /ready`, public: checks the DB with `select 1`, storage `headBucket`, and pg-boss started; 200 with `{ status, checks }` or 503), `GET /health` adds `version` from package.json, `docker-compose.prod.yml` (a `migrate` service with the core image and `node dist/migrate.js`, `restart: 'no'`; core `depends_on: migrate: condition: service_completed_successfully`; healthchecks for core `/ready` and portal), `apps/portal/nuxt.config.ts` (tree-shaken Vuetify via `vite-plugin-vuetify` `autoImport: true`, so stop registering all components), `apps/portal` health route if missing, root and app `package.json` versions → `1.0.0`
- Test: `apps/core/test/app.test.ts` (ready ok, ready 503 when storage throws, health version, JWKS URL used when set — the issuer check still uses `OIDC_ISSUER`), and a portal build-size check in the report (before and after `.output` size)

**Interfaces:**
- `readiness(deps): Promise<{ ok: boolean, checks: Record<'db'|'storage'|'queue', 'ok'|'fail'> }>`. Each check has a 2 s timeout. Errors are not echoed.
- `MIGRATE_ON_START` is parsed strictly as `'true'`/`'false'`.

- [ ] **Step 1: Write failing tests** for `/ready` (all ok → 200; storage down → 503 with `storage: 'fail'`; no error text), `/health` (has the version), and the JWKS URL (a token signed by a test key served at a separate JWKS URL verifies, and the issuer mismatch is still rejected).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Make the Vuetify change only if the portal tests, typecheck and a browser smoke test of three pages pass. Otherwise revert that part and record it as a follow-up.
- [ ] **Step 4: Run** `pnpm vitest run && pnpm -r typecheck`, then `docker compose -f docker-compose.yml -f docker-compose.prod.yml config` with placeholder env. Expected: PASS and valid config.
- [ ] **Step 5: Commit** `feat: readiness, migrate service and production config`.

---

### Task 7: Backups and restore

**Files:**
- Create: `ops/backup/backup.sh`, `ops/backup/restore.sh`, `ops/backup/Dockerfile` (based on `postgres:17` client tools + `minio/mc` binary, or the `rustfs` CLI if it is S3-mirror capable; pin versions), `ops/backup/restore-check.sh` (dev-only end-to-end check)
- Modify: `docker-compose.prod.yml` (a `backup` service with a `backups` volume and env `BACKUP_KEEP_DAYS` default 14 and `BACKUP_AT` default `02:00`, TZ Asia/Bangkok)
- Test: `ops/backup/test/backup.bats` if bats is available, otherwise `apps/core/test/ops-backup.test.ts` running the scripts' pure parts (`retention` selection by filename date) through `bash -c`

**Interfaces:**
- `backup.sh`:
  - It loops, sleeping until the next `BACKUP_AT`. A one-shot `backup.sh --now` also exists.
  - It writes `pg-<YYYYMMDD-HHMM>.dump` (`pg_dump -Fc`) and `storage-<YYYYMMDD-HHMM>/` (an S3 mirror of the bucket) into `/backups`, writes a `latest` marker, and deletes backups older than `BACKUP_KEEP_DAYS`.
  - It exits non-zero on failure and logs one line per step, never credentials.
- `restore.sh <stamp>` restores both parts into the configured DB and bucket (`pg_restore --clean --if-exists`). It refuses to run unless `RESTORE_CONFIRM=yes`.
- `restore-check.sh` (`# DEV ONLY`):
  1. On the dev compose stack, create data.
  2. Back up.
  3. Drop the database and empty the bucket.
  4. Restore.
  5. Call `/ready` and query that a known row exists.

- [ ] **Step 1: Write failing tests** for retention: given filenames over 20 days and keep 14, exactly the files older than 14 days are selected. Also test that `restore.sh` without `RESTORE_CONFIRM` exits non-zero.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Use shellcheck-clean bash with `set -euo pipefail`.
- [ ] **Step 4: Run** the tests, then `ops/backup/restore-check.sh` against the dev stack (Docker is available on this machine). Expected: the restore check prints `restore ok`. Stop only containers and processes you started.
- [ ] **Step 5: Commit** `feat(ops): daily backups and restore`.

---

### Task 8: Release pipeline and operations runbook

**Files:**
- Modify: `.gitlab-ci.yml`:
  - Build and push `core`, `portal`, `runner` and `backup` to `$CI_REGISTRY_IMAGE/<name>`, tagged `$CI_COMMIT_SHORT_SHA`, `$CI_COMMIT_TAG` on tags, and `latest` on the default branch. Use `docker login` with `$CI_REGISTRY_USER`/`$CI_REGISTRY_PASSWORD`.
  - A manual `deploy` job on tags. It uses `$DEPLOY_HOST`, `$DEPLOY_USER`, `$DEPLOY_SSH_KEY` (file variable) and `$DEPLOY_PATH`. Over SSH it runs `docker compose pull && docker compose run --rm migrate && docker compose up -d`, then polls `/ready`.
- Modify: `docker-compose.prod.yml` (`image: ${YODA_IMAGE_PREFIX:-yoda}/core:${YODA_VERSION:-latest}` with build kept for local), `.github/workflows/ci.yml` (add the backup image build, still build-only).
- Create: `docs/operations.md`, `CHANGELOG.md` (1.0.0: features by plan); Modify: `README.md` (link to the runbook, versioning).
- Test: CI config validation, using `glab ci lint` if available offline, otherwise a YAML parse test in `apps/core/test/ops-ci.test.ts` asserting the job names, `when: manual` on deploy and `rules` on tags, and no literal secrets or hostnames.

**Interfaces:**
- `docs/operations.md` sections:
  1. Prerequisites: host, Docker, DNS/TLS in front of the portal.
  2. Keycloak: realm, the `yoda-portal` client (public, PKCE), the staff group, `BOOTSTRAP_ADMINS`.
  3. Environment variables: a table of every variable with purpose, required or optional, and example placeholder, generated from `config.ts` and kept in sync by a test that diffs the names.
  4. First install.
  5. Upgrade: tag, then the deploy job; and rollback to the previous tag.
  6. Backups and restore, including copying `/backups` off the host.
  7. GitLab integration: bot, token scopes, webhook.
  8. Runners.
  9. Email.
  10. Rotating secrets.
  11. Troubleshooting with `/ready` checks and logs.

  Only placeholders such as `gitlab.example.org`, `portal.example.org`.
- An env-table sync test asserts that every key in the core config schema appears in `docs/operations.md` and in `.env.example`.

- [ ] **Step 1: Write failing tests:** the CI YAML structure test, and the env-table sync test.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run && pnpm -r typecheck`, and run gitleaks over the branch. Expected: PASS and no leaks; the internal-hostname check finds nothing.
- [ ] **Step 5: Commit** `feat(ops): release pipeline, runbook and changelog`.
