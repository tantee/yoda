# Portal design refresh: before / after

Before = `docs/design/screenshots/current/` (branch state before the refresh, see `current-ui-inventory.md`).
After = `docs/design/screenshots/after/`, re-shot at the end of the refresh (branch `feat/portal-design-refresh`,
fun mode ON, which is the default) with the same file names, the same `yoda_demo` data set and the same
viewports: desktop 1440×900 (full page unless the name says dialog/menu/state), mobile 390×844 (full page).
All 129 `current/` shots have an `after/` file with the same name. `after/` also keeps the extra per-phase shots
(`phase1-*`, `phase2-*`, `task4-*`, `jedi-*`, new dialogs and menus).

Capture artefacts: in full-page captures, fixed elements (the desktop nav rail, the mobile bottom navigation) are
drawn at their first-viewport position, so the rail stops at 900 px and the mobile bottom bar shows mid-page.

## Key pages

| Page | Before (desktop) | After (desktop) | Before (mobile) | After (mobile) |
| --- | --- | --- | --- | --- |
| To-do | <img src="screenshots/current/staff-todo-desktop.png" width="260"> | <img src="screenshots/after/staff-todo-desktop.png" width="260"> | <img src="screenshots/current/staff-todo-mobile.png" width="120"> | <img src="screenshots/after/staff-todo-mobile.png" width="120"> |
| Task detail (approval) | <img src="screenshots/current/staff-task-approval-desktop.png" width="260"> | <img src="screenshots/after/staff-task-approval-desktop.png" width="260"> | <img src="screenshots/current/staff-task-approval-mobile.png" width="120"> | <img src="screenshots/after/staff-task-approval-mobile.png" width="120"> |
| Task detail (AI draft) | <img src="screenshots/current/staff-task-ai-draft-desktop.png" width="260"> | <img src="screenshots/after/staff-task-ai-draft-desktop.png" width="260"> | <img src="screenshots/current/staff-task-ai-draft-mobile.png" width="120"> | <img src="screenshots/after/staff-task-ai-draft-mobile.png" width="120"> |
| Work item | <img src="screenshots/current/staff-work-item-running-desktop.png" width="260"> | <img src="screenshots/after/staff-work-item-running-desktop.png" width="260"> | <img src="screenshots/current/staff-work-item-mobile.png" width="120"> | <img src="screenshots/after/staff-work-item-mobile.png" width="120"> |
| Chat | <img src="screenshots/current/staff-chat-desktop.png" width="260"> | <img src="screenshots/after/staff-chat-desktop.png" width="260"> | <img src="screenshots/current/staff-chat-mobile.png" width="120"> | <img src="screenshots/after/staff-chat-mobile.png" width="120"> |
| Project status | <img src="screenshots/current/staff-project-status-desktop.png" width="260"> | <img src="screenshots/after/staff-project-status-desktop.png" width="260"> | <img src="screenshots/current/staff-project-status-mobile.png" width="120"> | <img src="screenshots/after/staff-project-status-mobile.png" width="120"> |
| Department status | <img src="screenshots/current/staff-status-desktop.png" width="260"> | <img src="screenshots/after/staff-status-desktop.png" width="260"> | <img src="screenshots/current/staff-status-mobile.png" width="120"> | <img src="screenshots/after/staff-status-mobile.png" width="120"> |
| My requests | <img src="screenshots/current/requester-requests-desktop.png" width="260"> | <img src="screenshots/after/requester-requests-desktop.png" width="260"> | <img src="screenshots/current/requester-requests-mobile.png" width="120"> | <img src="screenshots/after/requester-requests-mobile.png" width="120"> |
| Request detail | <img src="screenshots/current/requester-request-detail-desktop.png" width="260"> | <img src="screenshots/after/requester-request-detail-desktop.png" width="260"> | <img src="screenshots/current/requester-request-detail-mobile.png" width="120"> | <img src="screenshots/after/requester-request-detail-mobile.png" width="120"> |
| Admin people | <img src="screenshots/current/admin-people-desktop.png" width="260"> | <img src="screenshots/after/admin-people-desktop.png" width="260"> | not shot | <img src="screenshots/after/admin-people-mobile.png" width="120"> |
| Login | <img src="screenshots/current/login-keycloak-desktop.png" width="260"> | <img src="screenshots/after/login-keycloak-desktop.png" width="260"> | not shot | <img src="screenshots/after/login-keycloak-mobile.png" width="120"> |

Mobile "after" shots with no "before" (admin people, login) come from the earlier phase captures in `after/`.

## Same name, different capture

Every `current/` shot has an `after/` file with the same name. These were captured differently because the page,
the route or the demo data changed:

| Shot | What `after/` shows |
| --- | --- |
| `dialog-runner-view.png` | Before: the "all runners" toggle (not a dialog). There is no runner view dialog now, so after shows the runners page with the "all runners" tab selected (viewport). |
| `dialog-assign-inline-work-item.png` | Before: an inline select in the task card (full page). Now it is the shared assign dialog opened from the work item task list (viewport). |
| `inline-request-changes-validation.png` | Before: helper text under the result box. Now "request changes" opens a dialog; after shows that dialog submitted empty (validation). Approval/review action buttons now show only to the assignee, so it is shot as `dev1` on their code review task, not as `somchai`. |
| `dev-task-review-*.png` | The demo data changed since the before shots (the OPD queue bug review is now assigned to someone else); after uses dev1's open code review on "Dashboard ระยะเวลารอคอย OPD". |
| `dev-admin-forbidden-redirect-desktop.png`, `requester-staff-path-redirect-desktop.png` | Before: a silent redirect home. Now these routes go to the new `/forbidden` page. |
| `state-error-404-route.png` | Before: raw Nuxt 404. Now the in-app 404 page. |
| `staff-project-status-ai-configured-desktop.png`, `dialog-weekly-regenerate-confirm.png` | The demo runs without an AI key. The `aiConfigured` flag in the project status response was set to true in the browser so the AI-configured weekly summary and its regenerate dialog show. |
| `admin-ai-desktop.png`, `admin-ai-configured-desktop.png` | The demo department budget is set, so both show the same configured state. The "no budget" state was not re-created (that would change demo data). |
| `state-empty-todo-desktop.png`, `state-empty-agendas-desktop.png`, `state-empty-requester-requests.png`, `state-empty-requester-answers.png` | Empty lists faked in the browser (the API response arrays emptied), not by deleting data. Empty project tabs use the real empty project "ระบบจองห้องประชุม". |
| `state-loading-*.png` | The page's main API call was held for 15 s in the browser; `state-loading-app-shell.png` holds `/api/me`. |
| `state-error-500-*.png`, `state-error-network-discussions.png` | 500 responses and a dropped connection faked in the browser for the page's main API call. |
| `dialog-runner-token-once.png` | The create call was answered in the browser with a placeholder token. No runner was created. |
| `state-error-*-not-found.png` | Full page instead of viewport (they fit one screen). |

## Before shots with no after equivalent

None. All 129 `current/` names were re-shot.
