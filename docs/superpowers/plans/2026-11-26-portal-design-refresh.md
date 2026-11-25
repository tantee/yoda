# Portal Design Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle and restructure the Yoda portal to match the owner-approved design. The design is in `docs/design/portal-design-refresh.md`, the mockups are in `docs/design/mockups/`, and `docs/design/screenshots/proposed/` holds screenshots of them. Add a light, original "Jedi" touch that an admin can switch off.

**Architecture:** The work is mostly in `apps/portal`, a Nuxt 4 + Vuetify 3.13 app. It covers:
- a Vuetify theme with defaults and SASS settings;
- self-hosted IBM Plex fonts;
- shared presentation components: `PageHeader`, `StatusChip`, `StepTrack`, `EmptyState`, `ErrorState`, skeletons, `AiDraft`;
- a new app shell: rail, top bar, breadcrumbs, bottom navigation and error pages;
- page-by-page rework.

Core changes are small and tested: menu counts, paged timeline and knowledge, a requester delivery summary, and the fun-mode setting. Behaviour and API contracts stay the same unless a task says otherwise.

**Tech Stack:** as before, plus `@fontsource/ibm-plex-sans-thai` and `@fontsource/ibm-plex-sans` (pinned, OFL 1.1).

**Spec:** `docs/design/portal-design-refresh.md` (sections cited per task), `docs/design/current-ui-inventory.md` (problems to fix), mockups and screenshots under `docs/design/`.

## Owner decisions (approved 2026-11-26)
- All 7 phases are in scope.
- Fonts are self-hosted: IBM Plex Sans Thai and IBM Plex Sans.
- The AI-draft label is muted indigo, as proposed.
- Global search ships now as a simple jump box: projects, work items and people by title or name, plus a route to open.
- **The Jedi touch (Task 9).** It is original, tasteful and kept to its own surfaces:
  - **Surfaces:** a small original mark in our blue; wise-master inverted word-order microcopy on empty states, loading, the 404 page and the login page; an optional subtle starfield on the login page; and an easter egg (the Konami code shows "May the source be with you").
  - **Never in:** task data, tables or notifications.
  - **Switch:** admin-switchable, on by default.
  - **Legal:** no Star Wars logos, no Yoda likeness or images, no Lucasfilm fonts or sounds, no quoted film lines, and nothing implying endorsement. Puns and mood only.
- **Left open, with defaults to list in the PR:**

  | Open item | Default |
  |---|---|
  | Logo | the original mark from Task 9 |
  | Thai product name | "Yoda · พอร์ทัลงานฝ่าย IT" |
  | Hospital name in the menu | none; a configurable footer line, empty by default |
  | Menu renames | as proposed: สถานะภาพรวม, ประเด็นหารือ, คำถามถึงฉัน |
  | Mobile bottom bar | งานที่ต้องทำ, แชท, โครงการ, สถานะ |
  | Requester wording | the proposed glossary, pending a nurse review |

## Global Constraints
- The proposal is the spec. Follow its tokens (§2), type scale (§3), density and widths (§4), navigation (§5), components and status mapping (§6), states and accessibility (§7), and per-page fixes (§8).
- Every status, priority or health display goes through the single mapping in `app/utils/statusStyle.ts` and `StatusChip`.
- **Dates** in UI text use Buddhist-era format without seconds, through `useDateFormat`.
- **Thai text** uses zero letter-spacing and is never uppercased.
- **Contrast:** every text pair meets WCAG AA.
- **Existing tests:** keep the `data-testid` attributes, because existing tests and selectors rely on them. Add new ones for new controls.
- **No behaviour regressions:**
  - Server-side authorisation is unchanged.
  - Requesters never see staff data.
  - Every existing test still passes.
- **i18n:** th is the default, with th/en parity (the existing parity test). Every new string goes through i18n, gimmick strings included.
- **Repo rules:** single quotes, no semicolons, no reformatting of untouched code, and no secrets. Never write the internal GitLab hostname or any part of its domain; use example.org placeholders.
- **Tests and checks for each task:**
  - unit tests for new utilities and components where logic exists (vitest);
  - `pnpm vitest run` and `pnpm -r typecheck` pass;
  - a browser check on the demo stack (`yoda_demo` DB; restart commands in `docs/design/current-ui-inventory.md` header notes and the seed script), taking after-screenshots of the pages touched at desktop 1440 and mobile 390, saved to `docs/design/screenshots/after/`.
- **Lock order and core patterns** are as in earlier plans. Core endpoints are staff-only unless stated.

## Review Focus
1. **Requester isolation:** new shell pieces (counts, search, breadcrumbs, delivery summary) must never expose staff data to a requester. Tests are in Tasks 2, 5 and 9.
2. **Mobile at 390px:** no horizontal page scroll on any page, the chat composer is visible, and dialogs fit. Each task checks its pages; Task 8 does the full pass.
3. **Long Thai titles and names:** they wrap or ellipsize correctly in tables, chips, breadcrumbs and cards. Covered by Task 1 component tests and the browser checks.
4. **Fun mode off:** with the switch off, no gimmick copy, mark animation, starfield or easter egg appears anywhere. A test is in Task 9.
5. **Slow or failing API:** skeletons show, errors show a retry, and 404/forbidden pages are useful. Covered in Tasks 1 and 2.

---

### Task 1: Foundation (proposal phase 1; §2, §3, §6, §7)
- Vuetify theme and defaults (§2.2 snippet), the SASS settings file for typography and tracking, and self-hosted fonts through `@fontsource` imports (weights 400/500/600/700, Thai and Latin subsets).
- `app/utils/statusStyle.ts` holds the single state → {color, icon, label key} mapping for every domain in §6.5, plus priority arrows. `StatusChip.vue` uses it, and every existing chip helper is migrated (`healthColor`, `runStateColor`, request status and so on).
- `useDateFormat()` covers Buddhist-era date, date-time and relative forms, in th and en, with tests.
- Shared components:
  - `PageHeader` (title, meta slot, actions slot, tabs slot);
  - `EmptyState` and `ErrorState` (retry);
  - `SkeletonList` and `SkeletonDetail`;
  - `AiDraft`: the indigo "ร่างโดย AI" container with a confidence badge and a missing-info list;
  - `StepTrack`: the 6-segment track.
- `MarkdownView` caps headings below the page title.
- Tests:
  - mapping coverage: every enum value of each status domain has an entry;
  - date formatting, including year 2569 and the en Gregorian form;
  - `StepTrack` segments;
  - `StatusChip` renders its label.
- Browser check: take a screenshot of 4 representative pages to see the global effect, and fix any obvious breakage.
- Commit `feat(portal): design foundation — theme, fonts, status chips, shared components`.

### Task 2: App shell (phase 2; §5, §7)
- **Rail:** groups and counts, with a core endpoint `GET /me/counts` returning `{ todo, chat, discussions }`. It is computed with existing queries, staff-only, and requesters get only their own counts.
- **Top bar:** breadcrumbs from route meta plus titles for dynamic routes, the jump search box, a notifications menu capped at 9+, and a user menu with language and logout.
- **Requester variant:** the requester rail.
- **Mobile:** a bottom navigation bar with the 4 default pages.
- **Error and loading pages:**
  - `error.vue` for 404 and errors; the OAuth fragment must not be shown;
  - a forbidden page that replaces the silent redirect with a message;
  - an app-shell loading state.
- **Search endpoint:** `GET /search?q=` scoped like the existing visibility rules: staff see visible projects, work items and staff people; requesters see only their own requests. It returns at most 10, with tests.
- Tests: core counts and search authorisation, including requester isolation; nav and breadcrumb utilities.
- Commit `feat: app shell — rail, top bar, breadcrumbs, search, error pages`.

### Task 3: Daily pages A — To-do and task detail (phase 3, first half; §8.2)
- To-do page as in the mockup (`docs/design/mockups/todo.html`): sections, decision cards, tables with `StepTrack`, filters and tabs.
- Task detail: the AI draft container, the result box, review and approval layouts, a request-changes dialog, and an assign picker.
- The existing behaviour tests stay green; add any tests that are needed.
- Commit `feat(portal): to-do and task detail redesign`.

### Task 4: Daily pages B — Work item and chat (phase 3, second half; §8.2)
- Work item as in the mockup: a header with `StepTrack`, tasks grouped by step, a side panel (people, dates, code, run) and a paged timeline grouped by day.
  - Core change: `GET /work-items/:id/events?before=&limit=`, staff-only, keeping the requester rules. Tests.
  - Destructive actions are separated and need confirmation.
- Chat: layout and composer always visible on mobile, restyled action cards, and scroll behaviour.
- Commit `feat: work item and chat redesign with paged timeline`.

### Task 5: Project and status (phase 4; §8.2)
- Projects list.
- Project page tabs:
  - status board, as in the mockup;
  - work items as a data table with filters;
  - members read-only, with edits in dialogs;
  - knowledge grouped and paginated, with a core `limit`/`offset` on the knowledge list if one is missing; tests;
  - repos;
  - AI.
- Department status page.
- Commit `feat: project and status redesign`.

### Task 6: Requester (phase 5; §8.3)
- My requests, as in the mockup.
- Request detail with a plain-language timeline and a delivery summary (core: the latest accepted QC/close result text, already visible to the requester, or null; tests for isolation).
- Answers.
- The requester task view.
- The glossary strings from the proposal.
- Commit `feat: requester pages redesign`.

### Task 7: Meetings and admin (phase 6; §8.2, §8.4, §8.5)
- Discussions with vote bars and the brief layout.
- Agendas, including present mode.
- Runners.
- Notification settings.
- Admin pages: people with read-only rows and dialogs, AI, GitLab, notifications.
- A dialogs sweep: consistent widths, a destructive confirm pattern, and mobile fit.
- Commit `feat(portal): meetings, runners, settings and admin redesign`.

### Task 8: Polish (phase 7; §7)
- Keycloak login theme: an original theme under `infra/keycloak/themes/yoda`. It uses the same palette and font and is mounted in dev compose. The prod docs say how to install it on the hospital Keycloak.
- Accessibility pass: axe through Playwright on 8 key pages, with no serious or critical violations; a keyboard pass covering focus rings and skip-to-content.
- Mobile pass at 390px on every page.
- Re-shoot the full inventory into `docs/design/screenshots/after/` with the same names as `current/`.
- Commit `feat: login theme, accessibility and mobile polish`.

### Task 9: The Jedi touch (owner gimmick)
- **Setting:** `department_settings.fun_mode boolean default true` (migration), exposed in `GET /me` or the public config for the shell, and switched in Admin → AI or a "Look and feel" card. Admins only.
- **Original mark:** an SVG (minimal saber or star motif in `#1F5FBF`/`#6FA8FF`) used as the logo tile and the favicon. A static, neutral mark is used when fun mode is off.
- **Microcopy:** th and en sets of wise-master inverted word-order lines, original wording only. They appear on:
  - `EmptyState` (an optional secondary line);
  - loading (skeleton caption);
  - the 404 and error pages;
  - the login page, through the Keycloak theme with its message bundle and a fun flag via a theme property, or a static default.

  They never appear in task data, tables, notifications or emails. Example: "งานว่างเปล่า ที่นี่ เห็นข้า" / "Empty, this list is."
- **Starfield:** subtle, CSS-only, on the login page only, and it respects `prefers-reduced-motion`.
- **Easter egg:** the Konami code shows a toast reading "May the source be with you" (th: "ขอให้ซอร์สโค้ดจงสถิตอยู่กับท่าน"). It works only in fun mode and has no network effect.
- **Guard rails, as a checklist in the PR:**
  - everything is original;
  - no franchise names in the UI beyond the product name "Yoda";
  - no likeness or images;
  - no film quotes;
  - no franchise fonts or sounds;
  - nothing implying endorsement.
- **Tests:**
  - with fun mode off, nothing from the gimmick renders (EmptyState, error page, Konami listener inactive);
  - the admin toggle is admin-only;
  - an i18n parity check.
- Commit `feat: optional Jedi touch — mark, microcopy, starfield, easter egg`.

### Finish
- A whole-branch review and one fix wave.
- Before/after screenshots of the key pages in the PR body (To-do, work item, project status, department status, chat, my requests, admin people; desktop and mobile), linked from `docs/design/screenshots/{current,after}/`.
- A PR closing the issue, with a checkbox test plan and the open-items list.
- Get CI green, then report.
