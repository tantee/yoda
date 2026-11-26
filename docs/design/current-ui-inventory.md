# Current portal UI inventory

Snapshot of every Yoda portal page as of branch `feat/portal-design-refresh` (before the design refresh), with
realistic demo data. Input for the design-refresh proposal; no portal code was changed.

- Screenshots: `docs/design/screenshots/current/` (129 PNG, ~15 MB). Desktop = 1440×900 viewport, full page
  unless the name says dialog/menu. Mobile = 390×844. Light mode, Thai locale (one English sample).
- Data: `apps/core/scripts/seed-demo.ts` (DEV ONLY) on a separate `yoda_demo` database: 7 projects, 13 staff +
  3 requesters, 25 work items across every step and state, runners and runs, discussions with AI briefs,
  an agenda, knowledge, weekly summaries, AI spend, chat threads with action cards. GitLab ran against the
  in-memory fake (`pnpm --filter @yoda/core fake-gitlab`), LINE/Telegram against `fake-channels`; all URLs
  are `gitlab.example.org` placeholders.
- Logins used: `somchai` (admin + PM), `dev1` (non-admin DEV staff, a DEV ONLY Keycloak user created through
  the admin API for this), `nurse1` (requester).

Screenshot artefacts to keep in mind when reading them: full-page captures show the nav drawer only 900 px tall
(it is `position: fixed`), and timestamps were back-dated by the seed, so some events sit at night.

---

## 1. Theme and global layout (as built)

**Theme setup** (`apps/portal/app/plugins/vuetify.ts`, `nuxt.config.ts`)

- `createVuetify({ icons: { defaultSet: 'mdi' }, locale })` only: **no theme object at all**. Colors are the
  Vuetify 3 defaults (primary `#1867C0`, secondary `#48A9A6`, error `#B00020`, info `#2196F3`, success
  `#4CAF50`, warning `#FB8C00`), light theme only, no dark theme, no brand color.
- **No component defaults** (`defaults:` unset): every `v-btn`, `v-text-field`, `v-chip`, `v-card` uses
  Vuetify's stock look (filled grey text fields, `elevated` buttons, uppercase-style letter-spacing).
- **No font configured.** `vuetify/styles` asks for Roboto but nothing loads it; Thai text falls back to the OS
  font (on macOS a looped Thai face for body and a different face for bold/button text). There is no Thai web
  font (e.g. Sarabun, Noto Sans Thai, IBM Plex Sans Thai), so rendering differs per OS.
- Typography is ad hoc: page titles use `text-h5` (22 places), section titles `text-h6` (27), one `text-h4`;
  Markdown output (`MarkdownView`) renders `##` larger than the page title.
- CSS: `@mdi/font` + `vuetify/styles`; scoped `<style>` blocks in only 7 components (chat, brief, markdown,
  status board, agenda). Colors used in templates: `primary` (49), `warning` (13), `error` (12),
  `success` (4), `secondary` (3), `info` (1); status chip colors come from helpers in `app/utils/*.ts`.

**Global layout** (`app/layouts/default.vue`)

- `v-app-bar flat border`: hamburger, title "พอร์ทัลงาน AI" (no logo), TH/EN `v-btn-toggle`, notification bell
  with red count badge, user menu (display name, one item: notification settings), logout icon.
- `v-navigation-drawer` with a flat `v-list nav`: staff get Chat, To-do, Discussions, Status, Projects,
  Runners (+ 4 admin items for admins); requesters get My requests, Chat, Answers. No grouping, no section
  headers, no counts. **Agendas are not in the nav** (only reachable from the Discussions page button).
- `v-main > v-container` (fixed max widths per breakpoint). No breadcrumbs anywhere; each detail page has its
  own text "back" button with a different label.
- Route guard (`middleware/role.global.ts`) silently redirects requesters away from staff paths and non-admins
  away from `/admin` to their home — no "not allowed" message.
- No custom `error.vue`: unknown routes show the raw Nuxt 404 page.

Screens: every page; `staff-nav-drawer-mobile.png`, `menu-user.png`, `menu-notifications.png`,
`requester-menu-notifications.png`, `login-keycloak-desktop.png`.

Problems:

- App bar: product name is plain text, no logo/brand mark; TH/EN toggle takes prime space and on mobile is
  clipped (only "TH" visible, "EN" cut off at 390 px — `staff-chat-mobile.png`, `requester-*-mobile.png`).
- Badge shows "50" for somchai (unread notifications are never summarised or capped, e.g. "9+").
- Logout is a bare icon with only a `title` tooltip, next to the user menu which has room for it.
- Nav drawer items: mixed icon metaphors (robot-industrial for Runners, robot for AI budget), labels of admin
  items ("จัดการบุคลากร", "งบประมาณ AI", "GitLab", "ช่องทางแจ้งเตือน") are visually identical to daily work items.
  Active item is a grey block with no accent color.
- Drawer is the only navigation; on mobile it overlays and there is no bottom nav for the 3–4 daily pages.
- Keycloak login page is the stock Keycloak theme ("Sign in to your account", English) — visually unrelated to
  the portal.
- The display name falls back to the Keycloak username when the token has no name (`nurse1`, `dev1` in the app
  bar and everywhere their names appear).

---

## 2. Staff pages

### 2.1 Home `/` → `/todo`

Who: everyone (staff → `/todo`, requesters → `/requests`). Screens: `staff-home-redirect-desktop.png`.

- No dashboard/landing page: home is a redirect, so the first thing a PM sees is a long to-do list.

### 2.2 To-do `/todo`

Who: staff. Screens: `staff-todo-desktop.png`, `staff-todo-mobile.png`, `staff-todo-english-desktop.png`,
`dev-todo-desktop.png`, `dev-todo-mobile.png`, `state-empty-todo-desktop.png`, `state-loading-todo.png`,
`state-error-500-todo.png`.

Content: "รอการตัดสินใจของคุณ" (pending proposals as outlined cards with ยืนยัน/ปฏิเสธ), "รอการยืนยันจากคุณ"
(confirmations: proposed/unassigned tasks, AI drafting/failed), then "my tasks" for assignees.

Problems:

- **Step-advance proposal card does not say which work item or step** ("ขั้นตอนปัจจุบันเสร็จแล้ว ต้องการไปขั้นตอนถัดไปหรือไม่"
  + a link labelled only "รายการงาน"). Same for the priority card: only the summary text and a generic link.
- Proposal cards are full-width outlined boxes with lots of empty space; confirm/reject buttons are small and
  left-aligned, while list rows put their confirm button at the far right — two different action patterns on
  one page.
- Confirmation rows: the subtitle is one long "project · work item · state · AI status" string that truncates
  with "…" on mobile and hides the important part (who/what is waiting). Status icons (spinner "AI กำลังร่าง…",
  warning "AI ร่างงานนี้ไม่ได้") are inline in the grey subtitle.
- Priority chips are all the same neutral grey ("เร่งด่วน", "สูง", "ปกติ", "ต่ำ") — urgent work does not stand out;
  sorting by priority is the only cue.
- 16 rows for a PM with no grouping by project, no filters, no counts in section headings.
- The "choose a project" select inside an intake proposal card is a full-width filled field — heavy for a
  one-click decision; its ยืนยัน is disabled with no hint why.
- Empty state is a single grey line "ยังไม่มีงานที่ต้องทำ" with no illustration or next step.
- Loading = a thin indeterminate bar under the title; error = a solid red full-width `v-alert` with
  "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้" even for an HTTP 500 (misleading: the server answered) and no retry button.

### 2.3 Task detail `/todo/:id`

Who: staff (and requesters for their own REQUESTER tasks, §3.4). Screens: `staff-task-ai-draft-desktop.png`,
`staff-task-ai-draft-mobile.png`, `staff-task-approval-desktop.png`, `staff-task-approval-mobile.png`,
`staff-task-ai-runner-feedback-desktop.png`, `staff-task-ai-failed-desktop.png`,
`staff-task-proposed-desktop.png`, `dev-task-review-desktop.png`, `dev-task-review-mobile.png`,
`dev-task-in-progress-result-box-desktop.png`, `inline-request-changes-validation.png`,
`dialog-assign-task.png`, `dialog-raise-discussion-from-task.png`, `state-error-task-not-found.png`.

Content: back link, task title, state/type/priority chips, work item + project links, assignee; instructions;
feedback alert (changes requested); "จากขั้นตอนก่อนหน้า" inputs (AI draft cards with copy button); result
textarea; attachment drop zone; "ไม่ส่งไฟล์นี้ให้ AI" checkbox; action buttons.

Problems:

- **AI draft confidence is not shown on the accepted draft**: the seeded low-confidence draft (missing:
  "จำนวนผู้ใช้พร้อมกันสูงสุด", "ระยะเวลาเก็บประวัติการแก้ไข") renders as a normal result with no confidence note.
- Rendered Markdown result (`## ข้อกำหนดเบื้องต้น…`) is **larger than the page title** — hierarchy inverted; the
  result has no container, so it blends with the page's own headings ("คำแนะนำ", "ผลลัพธ์").
- Action row "เริ่มทำ / อนุมัติ / ขอให้แก้ไข": three filled buttons in blue/green/orange with white text (green
  `#4CAF50` and orange `#FB8C00` fail WCAG AA contrast for white text); "เริ่มทำ" is shown next to approve on
  review/approval tasks where starting is meaningless.
- "ขอให้แก้ไข" without a comment only shows a small red helper line under the textarea
  (`inline-request-changes-validation.png`) — easy to miss; there is no confirm step.
- Feedback alert (warning tonal) uses orange text on light orange — low contrast.
- The AI runner draft for code tasks is in English ("Merge requests in GitLab:") inside an otherwise Thai page.
- The attachment drop zone is as big as the result textarea and always visible, even on approval tasks.
- Proposed task page: confirm/assign controls are inline (a select + button) rather than a clear "assign to"
  panel; the assignee select opens a plain long list of names without roles/load (`dialog-assign-task.png`).
- Chip row mixes state ("เปิด"), type ("ตรวจทาน", "AI") and priority ("เร่งด่วน") in the same neutral style.
- Mobile: buttons wrap but keep desktop sizes; the drop zone takes a full screen height.

### 2.4 Work item `/work-items/:id`

Who: staff who can see the project. Screens: `staff-work-item-running-desktop.png`,
`staff-work-item-rework-desktop.png`, `staff-work-item-run-failed-desktop.png`,
`staff-work-item-awaiting-advance-desktop.png`, `staff-work-item-done-desktop.png`,
`staff-work-item-mobile.png`, `dialog-raise-discussion.png`, `dialog-reopen-step.png`,
`dialog-cancel-work-item.png`, `dialog-assign-inline-work-item.png`, `state-error-work-item-not-found.png`.

Content: back link, title + 3 outlined action buttons (raise discussion, reopen step, cancel), chips (state,
priority, template, owner, requester), target date field with save/clear, description, blocking-discussion
alert, `v-stepper`-like step header, Code panel (repo picker, issues, MRs with pipeline), tasks grouped by step
(cards with type chip, state chip, assignee, RunChip), full event timeline.

Problems:

- **Mobile overflow**: the page is 518 px wide at a 390 px viewport (horizontal scroll); the title wraps one
  word per line because the three action buttons sit on the same row and do not wrap
  (`staff-work-item-mobile.png`).
- **Timeline is unbounded**: 60–120 entries render as one long `v-timeline` (page height 5,700 px desktop,
  6,200 px mobile). No grouping by step/day, no filter, no "show more"; most entries are low-value
  ("สร้างงานย่อย", "เพิ่มความรู้").
- Target date: a full filled text field + "บันทึกวันที่" + "ล้าง" always visible in the header; the date input shows
  the Gregorian `09/12/2026` while every other date on the page is Buddhist-era Thai (`9 ธ.ค. 2569`).
- Destructive "ยกเลิกงาน" is the same size and position as the other header actions (only red outline).
- Step header: completed steps are blue checks with "เสร็จสิ้น" sub-labels in tiny grey; the current step is
  only marginally bolder. It does not scroll on mobile (truncated).
- Code panel: the repo multi-select is a disabled-looking filled field with grey chips; "บันทึก" sits apart
  from it; issue sync chips "ซิงก์แล้ว" are tiny pale green; the "ใส่ Closes #41 ในคำอธิบาย merge request" hint
  repeats per repo.
- Task cards: one outlined card per task with the title as a link, state chip, and "ผู้รับผิดชอบ: …" line —
  dense but repetitive; the run chip and "มอบหมาย" button are tiny at the far right.
- Blocking discussion alert (tonal warning) uses orange-on-cream text.
- Not-found: red alert only, no suggestion where to go.

### 2.5 Chat `/chat`

Who: everyone (staff personal/project/work-item threads; requesters their intake thread). Screens:
`staff-chat-desktop.png`, `staff-chat-mobile.png`, `state-empty-chat-dev-desktop.png`,
`state-loading-chat.png`, `requester-chat-*.png`.

Content: thread list (left, ~290 px) + message list + composer with attach button. Messages: person bubbles
right (primary blue), assistant bubbles left (dark grey `#424242`-ish), action cards inside bubbles
(proposal with ยืนยัน/ปฏิเสธ, knowledge saved, link, work item created).

Problems:

- **Initial scroll is not at the latest message**: the newest message is cut off at the bottom on load
  (desktop) and the composer is out of view on mobile.
- Assistant bubbles are near-black with white text and contain outlined cards with light borders — heavy and
  low-hierarchy; action card types differ only by a small icon.
- Thread titles are truncated with "…" at ~12 Thai characters; unread badges are plain blue circles.
- On mobile the thread list and the conversation stack vertically in the same card (no master/detail), so
  the thread list pushes the conversation down.
- Composer placeholder is long ("พิมพ์ข้อความ (Enter เพื่อส่ง, Shift+Enter ขึ้นบรรทัดใหม่)"); the send button is a
  pale disabled blue circle until text is entered.
- "link" action cards render as a link inside an outlined box (`ดูคำขอ`) — a button would read better.
- Empty state (no threads besides "ผู้ช่วยของฉัน"): "เลือกการสนทนา" text only.

### 2.6 Discussions `/discussions`, `/discussions/:id`

Who: staff. Screens: `staff-discussions-desktop.png`, `staff-discussions-decided-desktop.png`,
`staff-discussion-detail-desktop.png`, `staff-discussion-detail-mobile.png`,
`staff-discussion-decided-desktop.png`, `staff-discussion-brief-pending-desktop.png`,
`staff-discussion-brief-failed-desktop.png`, `dialog-record-decision.png`, `dialog-withdraw-discussion.png`,
`state-loading-discussions.png`, `state-error-network-discussions.png`, `state-error-discussion-not-found.png`.

Content: tabs (open / on agenda / decided), project + sort selects, list with question, project · work item,
priority chip, brief status chip, vote count chip. Detail: question, chips, links, details, AI brief
(context, option cards with pros/cons, recommended option highlighted, recommendation), vote tallies, opinion
buttons per option, response list, opinion textarea + send; decide / withdraw buttons.

Problems:

- List page is sparse: two filled selects take a full row for 2 results; brief-status chips are pale
  orange/blue with tiny text ("สรุปประเด็นไม่สำเร็จ: AI เตรียมสรุปไม่สำเร็จ" truncated); "0 โหวต" chip is outlined black.
- Detail: vote tallies are a plain two-column text list ("ใช้ SMS ต่อทั้งหมด … 1") far from the options; the vote
  buttons are uppercase-spaced outlined buttons repeating full option titles; no visual bar or percentage.
- Each response is its own outlined box with metadata and content on one grey line — votes and opinions look
  the same.
- Recommended option is shown only with blue text + "แนะนำ" mini-chip; the brief source chip "AI เตรียมให้" is
  tiny pale teal.
- The page has no maximum line length: context paragraphs run 1,150 px wide.
- Decision dialog / withdraw dialog are plain `v-card` dialogs with a textarea; the decide dialog's option
  radio list repeats option titles without pros/cons.

### 2.7 Agendas `/agendas`, `/agendas/:id`, `/agendas/:id/present`

Who: staff (editing for PMs/admins). Screens: `staff-agendas-desktop.png`, `staff-agenda-detail-desktop.png`,
`staff-agenda-present-desktop.png`, `dialog-new-agenda.png`, `state-empty-agendas-desktop.png`.

Problems:

- Not reachable from the nav (only via a button on Discussions).
- Agenda detail: ordered list with arrow up/down/× icon buttons (disabled arrows still shown); discussion
  links are underlined blue default links; the "add discussion" select + "เพิ่ม" button look disabled.
- Delete agenda is a red circled trash icon next to "นำเสนอ"/"พิมพ์" — destructive action given equal weight.
- Present mode: good large question, but options are outlined boxes with small text, vote counts are two
  plain lines ("นับรวม 0"), "ตัดสินใจ" is a normal button, and the prev/next controls sit at the bottom with a
  tiny keyboard hint. No timer/progress beyond "1 จาก 2" in the corner. Not designed for a projector (small body
  text, thin borders).

### 2.8 Projects `/projects`, `/projects/:id`

Who: staff (project tabs depend on role). Screens: `staff-projects-desktop.png`, `dev-projects-desktop.png`,
`staff-project-status-desktop.png`, `staff-project-status-ai-configured-desktop.png`,
`staff-project-status-mobile.png`, `staff-project-overview-desktop.png`, `staff-project-items-desktop.png`,
`staff-project-items-mobile.png`, `staff-project-repos-desktop.png`, `staff-project-knowledge-desktop.png`,
`staff-project-ai-desktop.png`, `staff-project-ai-near-budget-desktop.png`, `staff-project-archived-desktop.png`,
`dev-project-status-desktop.png`, `dev-project-not-member-desktop.png`, `dialog-create-work-item.png`,
`dialog-knowledge-entry-new.png`, `dialog-knowledge-entry-edit.png`, `dialog-weekly-regenerate-confirm.png`,
`state-empty-project-*.png`, `state-error-500-projects.png`, `state-error-500-project-knowledge.png`,
`state-loading-projects.png`.

Projects list: a bordered `v-list` of name + description, alphabetical, archived project mixed in with no
marker, no health/owner/counts. One "สร้างโครงการ" button.

Project page: title + description, tabs สถานะ / ภาพรวม / งาน / REPOSITORIES / ความรู้ / ตั้งค่า AI.

Problems:

- Tabs: "REPOSITORIES" is English and uppercase while the other tabs are Thai; tab labels are letter-spaced
  (Vuetify default tracking applied to Thai). On mobile the tab bar scrolls and "REPOSIT…" is cut.
- Status tab: health chip, reasons list with underlined links, Kanban-like board whose **last column ("ทดสอบ")
  is clipped at the right edge** (board overflows the container without a visible scrollbar); board cards are
  dense with tiny chips. Weekly summary card, member load table (plain `v-table`), events list — the events list
  repeats the work item timeline style and runs ~2,500 px.
- The weekly summary card mixes the AI-not-configured info alert, two summaries, draft chips and timestamps
  (`23/11/2569 01:00:00`, seconds shown).
- Overview tab: autonomy switch with long helper text; members as rows of filled multi-selects for roles
  (heavy, looks like a form for each person); trash icons per row without confirmation hint; "เพิ่มสมาชิก" card
  at the bottom with a disabled-looking button.
- Work items tab: plain `v-table`; titles are underlined default links; priority and state are plain text (no
  chips/colors), owner column repeats the PM; no filters/sort/search; done and active items mixed. On mobile the
  table squeezes the title column to ~60 px so titles wrap per word, and the state/owner columns are cut off.
- Knowledge tab: 30+ rows, each with title, a raw-Markdown one-line preview (`## ข้อกำหนดเบื้องต้น: …`,
  `| # | กรณี |…`), and three tiny chips (type, status, source · author) right-aligned. Generated "progress"
  drafts dominate the list; no grouping by type, no pagination. Upload area and attachments section at the
  bottom.
- Knowledge dialog: large full-height dialog; fields are stock filled inputs.
- AI tab: budget field + spend bar, fine but plain; near-budget state (89%) shows the same blue bar (no
  warning color until over budget).
- Archived project: no banner/disabled state is evident beyond a chip.
- Not a member: red "ไม่พบข้อมูลที่ต้องการ" alert (`dev-project-not-member-desktop.png`), while the projects list
  only shows member projects.
- Create work item dialog: 6 stacked full-width filled fields, "สร้าง" disabled pale blue; no template
  explanation, no requester search hint beyond "ไม่บังคับ".
- Empty project tabs: items "ยังไม่มีงาน" text; repos/knowledge similar grey lines; status shows an empty board
  with "-" placeholders.

### 2.9 Status `/status`

Who: staff. Screens: `staff-status-desktop.png`, `staff-status-mobile.png`, `state-loading-status.png`,
`state-error-500-status.png`.

Content: 4 KPI tiles (active items, overdue, open discussions, AI spend), department AI line, one card per
project (health chip, reasons, 3 counters, AI spend bar, step chips), then people load.

Problems:

- KPI tiles are flat grey boxes; only "overdue" is colored (red number). No trend or link.
- Health chip: "ติดขัด" (blocked) red filled, "ตามแผน" green filled — at-risk never appears in the demo because
  any stuck item flips a project to blocked; the reasons list repeats long work item titles as underlined links,
  making cards uneven heights (HIS Lab card is twice as tall as Portal ผู้ป่วย).
- Budget bars switch to orange only at >80%; blue otherwise. "($0.00 (ไม่จำกัดงบ))" text noise.
- Step chips ("ออกแบบระบบ · 1") are tiny grey chips at the card bottom.
- Empty project ("ระบบจองห้องประชุม") gets a full card with zeros.

### 2.10 Runners `/runners`

Who: staff (settings card for admins). Screens: `staff-runners-desktop.png`, `staff-runners-all-desktop.png`,
`staff-runners-mobile.png`, `dev-runners-desktop.png`, `dialog-runner-create.png`,
`dialog-runner-token-once.png` (token masked), `dialog-runner-view.png`, `dialog-runner-revoke-confirm.png`,
`state-loading-runners.png`, `state-error-500-runners.png`.

Problems:

- Admin settings card (two switches + a long orange warning alert) sits above the user's own runner list and
  is only 1,030 px wide while the table below is full width.
- Table: 8 columns, capability chips tiny grey; **no status column** — a revoked runner ("old-ci-runner") and
  a paused one look the same as active ones; "ติดต่อล่าสุด" shows full timestamps with seconds.
- "รันเนอร์ของฉัน / รันเนอร์ทั้งหมด" is a `v-btn-toggle` styled differently from the tabs used elsewhere.
- Create dialog: long form; the token-once dialog shows the token in a filled field with a "คัดลอก" button
  and orange warning — clear, but "เสร็จสิ้น" is a text button easy to miss.
- Mobile: the table scrolls horizontally inside the card.

### 2.11 Notification settings `/settings/notifications`

Who: everyone. Screens: `staff-notification-settings-desktop.png`, `dialog-link-telegram.png`.

Problems:

- A checkbox grid (kind × channel) with column headers that also hold link state ("เชื่อมแล้ว" green text,
  "ยกเลิกการเชื่อม" tiny text button, "เชื่อมบัญชี" tiny grey button) — actions hidden in table headers.
- Disabled Telegram checkboxes have no explanation in place (you must notice the column header).
- The grid is 760 px wide, left-aligned, the rest of the page empty.
- Link dialog: good content (deep link, code, countdown), but the code is plain text, not a copyable field.

---

## 3. Requester pages (`nurse1`)

### 3.1 My requests `/requests`

Screens: `requester-requests-desktop.png`, `requester-requests-mobile.png`, `state-empty-requester-requests.png`,
`requester-staff-path-redirect-desktop.png`.

- List of title / project · step / status chip. Status chips are tonal pastel (blue "กำลังดำเนินการ", orange
  "รอคุณตอบ", green "เสร็จแล้ว") with low contrast text.
- **Items waiting for the requester are not pinned on top**; sorting is by creation date.
- No progress indicator (which step of how many), no last-update time in the list, no "new request" button
  (requests are only made through chat — not explained here).
- Empty state: one grey line.

### 3.2 Request detail `/requests/:id`

Screens: `requester-request-detail-desktop.png`, `requester-request-detail-mobile.png`,
`requester-request-detail-waiting-*.png`, `requester-request-detail-done-*.png`.

- Very sparse: title, three chips (status, step, project), "อัปเดตล่าสุด: 25/11/2569 12:40:29" (seconds), one
  hint sentence, list of questions, "เปิดแชท" button. No timeline of what happened, no step progress, no
  owner/contact person, no target date.
- The question list shows the task title "ตรวจรับงาน" with a state chip "เปิด" — staff wording.

### 3.3 Answers `/answers`

Screens: `requester-answers-desktop.png`, `requester-answers-mobile.png`, `state-empty-requester-answers.png`.

- Plain list of open REQUESTER tasks; no grouping by request; empty state one line.

### 3.4 Answer / accept task `/todo/:id` (requester view)

Screens: `requester-answer-task-desktop.png`, `requester-answer-task-mobile.png`,
`requester-accept-delivery-task-desktop.png`, `requester-accept-delivery-task-mobile.png`.

- Same staff task layout and wording: chips "เปิด", "อนุมัติ", "สูง" (task type and priority are internal
  concepts); "เริ่มทำ" button shown to a nurse accepting delivery; result field labelled "ความเห็น / ผลลัพธ์".
- Delivery acceptance shows nothing about what was delivered (no summary, no link) — only instructions.
- Back link "กลับไปคำถามของฉัน" points to Answers even when arriving from a request.

### 3.5 Requester chat

Screens: `requester-chat-desktop.png`, `requester-chat-mobile.png`.

- The pending request card reads only "ข้อเสนอ" with an icon — no title or state; requester cannot tell it was
  sent to the team.

---

## 4. Admin pages

### 4.1 People `/admin/people`

Screens: `admin-people-desktop.png`.

- Table of name/username, skills (`v-combobox` chips with × in every row), staff status select ("ตามกลุ่มใน
  Keycloak" repeated 16 times), admin switch. Every row is an always-on form; no search, no filter
  (staff/requester/admin), unsorted (Thai and Latin names interleaved, `nurse1` first).
- Requesters and staff are mixed; no project memberships or load shown.

### 4.2 AI budget `/admin/ai`

Screens: `admin-ai-desktop.png`, `admin-ai-configured-desktop.png`.

- Single budget field + save + one progress bar; "$3.6000" shows 4 decimals. No per-project breakdown or
  history, although the data exists (`ai_calls`). Field helper text wraps under a narrow field.

### 4.3 GitLab `/admin/gitlab`

Screens: `admin-gitlab-desktop.png`.

- Key/value table ("ใช่" plain text vs "ใช่" green chip for reachability — inconsistent), webhook URL field +
  copy, long instruction line. Fine but plain; 900 px wide, rest of page empty.

### 4.4 Notification channels `/admin/notifications`

Screens: `admin-notifications-desktop.png`.

- 3-row table with "ใช่" chips and switches; switches are vertically misaligned with the row text (sit higher).

### 4.5 Runner settings card

On `/runners` for admins (see §2.10).

---

## 5. Dialogs and menus

| Dialog / menu | Screenshot | Notes |
| --- | --- | --- |
| Create work item | `dialog-create-work-item.png` | 6 stacked filled fields; primary action pale until valid; no inline template description |
| Assign task (select) | `dialog-assign-task.png` | plain name list, no role/load; inline not a dialog |
| Assign from work item | `dialog-assign-inline-work-item.png` | inline select inside the task card |
| Request changes | `inline-request-changes-validation.png` | no dialog; only helper-text validation under the result box |
| Raise discussion | `dialog-raise-discussion.png`, `dialog-raise-discussion-from-task.png` | long form incl. option editor; same dialog from task and work item |
| Record decision | `dialog-record-decision.png` | option radios + textarea |
| Withdraw discussion | `dialog-withdraw-discussion.png` | reason textarea; red button |
| Reopen step | `dialog-reopen-step.png` | step select + explanation |
| Cancel work item | `dialog-cancel-work-item.png` | confirm |
| New agenda | `dialog-new-agenda.png` | title + native datetime field (browser-styled, Gregorian) |
| Knowledge entry new / edit | `dialog-knowledge-entry-new.png`, `dialog-knowledge-entry-edit.png` | large textarea; version info |
| Weekly summary regenerate | `dialog-weekly-regenerate-confirm.png` | text-only confirm; "สร้างใหม่" as a text button |
| Runner create / token once / view / revoke | `dialog-runner-*.png` | see §2.10 |
| Link Telegram | `dialog-link-telegram.png` | see §2.11 |
| Notifications menu | `menu-notifications.png`, `requester-menu-notifications.png` | titles all "มีประเด็นหารือใหม่"; no time, no icon per kind, no unread marker |
| User menu | `menu-user.png` | one item only |

Common dialog problems: all use stock `v-card` with title + text + actions; primary actions alternate between
text buttons (regenerate, token "เสร็จสิ้น") and filled buttons; widths vary (400–800 px); none show which
object they act on in the title.

## 6. States

| State | Screenshots | Observed |
| --- | --- | --- |
| Initial app load | `state-loading-app-shell.png` | **blank white page** (no shell, no spinner) until Keycloak + `/api/me` resolve |
| Page loading (client nav) | `state-loading-{todo,status,projects,runners,discussions,chat}.png` | title + thin `v-progress-linear` (todo/status) or nothing at all (projects, chat: empty card); no skeletons |
| Empty | `state-empty-*.png` | one grey sentence each; no icon, no call to action (e.g. empty project items does have "สร้างงานใหม่" button but the empty text is far from it) |
| Server error (500) | `state-error-500-*.png` | solid red `v-alert` "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองใหม่ภายหลัง" — same text for 500 and network failure; no retry |
| Network down | `state-error-network-discussions.png` | same alert |
| Not found | `state-error-{work-item,task,discussion}-not-found.png`, `dev-project-not-member-desktop.png` | red alert "ไม่พบข้อมูลที่ต้องการ" (same style as a server error) |
| Unknown route | `state-error-404-route.png` | raw Nuxt dev 404 page, English, showing the full URL **including the OAuth `#state=…&code=…` fragment** |
| Forbidden | `dev-admin-forbidden-redirect-desktop.png`, `requester-staff-path-redirect-desktop.png` | silent redirect to home, no message |

---

## 7. Top cross-cutting problems

1. **No design system**: Vuetify defaults only — no theme colors, no brand, no component defaults, no dark
   mode; every page assembles stock components differently.
2. **No Thai web font**: Thai falls back to the OS font, bold/button Thai uses another face, and Vuetify's
   button/tab letter-spacing is applied to Thai (spaced-out "ย้อนกลับขั้นตอน", "ภาพรวม").
3. **Status/priority/state chips have no consistent color language**: priorities are all grey, states are grey,
   request statuses are pastel tonal, health is filled red/green, sync status pale green; the same word
   ("ใช่", "เปิด") appears in different styles.
4. **Hierarchy problems**: Markdown headings in AI drafts/summaries render bigger than page titles; section
   titles (`text-h6`) and page titles (`text-h5`) are close in size; underlined default blue links everywhere.
5. **Mobile is an afterthought**: work item page overflows (518 px), tables squeeze titles one word per line,
   chat composer off-screen, TH/EN toggle clipped, no bottom navigation.
6. **Unbounded lists**: work item timeline, project events and knowledge list have no paging, grouping or
   filtering (5,000–6,000 px pages).
7. **Inconsistent action patterns**: confirm/reject left-aligned in cards vs right-aligned in rows; text vs
   filled primary buttons in dialogs; destructive actions (cancel work item, delete agenda) placed beside normal
   ones with equal weight.
8. **Loading, empty and error states are minimal**: blank white initial load, no skeletons, one-line empty
   states with no next step, one generic red alert for 500/network/not-found, no retry, raw Nuxt 404.
9. **No breadcrumbs/context**: each detail page has a differently worded back button; proposal cards and
   notifications don't name the work item; Agendas are missing from the nav.
10. **Requester experience reuses staff screens and jargon**: task type/state chips, "เริ่มทำ" button, no
    delivery summary, no progress or contact on the request page, waiting items not pinned.
11. **Forms everywhere**: admin people and project members render every row as editable inputs; target date
    editor always open in the work item header.
12. **Accessibility/contrast**: white text on success green and warning orange buttons, orange-on-cream tonal
    alerts, pale tonal chips, tiny 10–11 px chip text, icon-only logout/arrows with tooltips only.
13. **Mixed language**: "REPOSITORIES" tab, English AI runner text, English Keycloak login and Nuxt 404 in a
    Thai UI; Gregorian dates in native date inputs vs Buddhist-era dates elsewhere; timestamps with seconds.
14. **AI signals are under-designed**: AI confidence not shown on drafts, AI status as small inline text in
    subtitles, AI-prepared brief marked with a tiny pale chip, budget bars only change color at >80%.
15. **Layout width is inconsistent**: some pages use the full container (todo, tables), others cap at
    760–1,030 px left-aligned (settings, GitLab, runner settings), leaving half the screen empty; the status
    board overflows its container.

## 8. Not captured

- Dark mode (the app has none).
- Weekly summary "confirm" dialog (`weekly-confirm`): the button did not render for the drafts in this state.
- Attachment upload progress/rejection (no files were uploaded), and the LINE link dialog (only Telegram).
- Real AI drafting/brief generation in progress beyond the seeded "drafting"/"pending" states (no AI key).
- Print view of an agenda (`พิมพ์`), and the runner MCP/CLI side.
- An "at risk" (amber) health state: the demo's projects are either on track or blocked.
