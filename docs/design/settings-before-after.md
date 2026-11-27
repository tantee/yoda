# System settings (PR A, issue #17): before / after and browser verification

Before = the design-refresh shots of the pages the settings pages replace (`docs/design/screenshots/after/admin-*.png`).
After = `docs/design/screenshots/after/settings-*.png`, shot on branch `feat/settings-ui` against the demo stack
(`yoda_demo` at migration 0022, demo Keycloak, fake GitLab / LINE / Telegram, a fake SMTP server for the tests,
a throwaway master key held in the core process env only). Desktop 1440×900 full page, mobile 390×844 full page.
Fun mode ON (the default).

Capture artefacts, as in `before-after.md`: in full-page captures the fixed nav rail stops at the first viewport and
the mobile bottom bar shows mid-page. In the generated-secret dialog the value was replaced with `x` before the shot.

## Replaced pages

| Before | After |
| --- | --- |
| `/admin/gitlab` ![](screenshots/after/admin-gitlab-desktop.png) | `/admin/settings/gitlab` (old URL redirects here) ![](screenshots/after/settings-gitlab-desktop.png) |
| `/admin/notifications` ![](screenshots/after/admin-notifications-desktop.png) | `/admin/settings/channels` (old URL redirects here) ![](screenshots/after/settings-channels-desktop.png) |
| `/admin/ai` (budget, fun switch, usage) ![](screenshots/after/admin-ai-desktop.png) | `/admin/ai` keeps usage and project spend ![](screenshots/after/settings-admin-ai-after-move-desktop.png) |
| `/admin/ai` budget and fun cards | moved to `/admin/settings/ai` ![](screenshots/after/settings-ai-desktop.png) |

No mobile "before" exists for these three pages. Mobile after: `settings-gitlab-mobile.png`,
`settings-channels-mobile.png`, `settings-admin-ai-after-move-mobile.png`, `settings-ai-mobile.png`.

## Every category

| Category | Desktop | Mobile |
| --- | --- | --- |
| ทั่วไป | ![](screenshots/after/settings-general-desktop.png) | ![](screenshots/after/settings-general-mobile.png) |
| การเข้าสู่ระบบ | ![](screenshots/after/settings-signin-desktop.png) | ![](screenshots/after/settings-signin-mobile.png) |
| AI | ![](screenshots/after/settings-ai-desktop.png) | ![](screenshots/after/settings-ai-mobile.png) |
| GitLab | ![](screenshots/after/settings-gitlab-desktop.png) | ![](screenshots/after/settings-gitlab-mobile.png) |
| ช่องทางแจ้งเตือน | ![](screenshots/after/settings-channels-desktop.png) | ![](screenshots/after/settings-channels-mobile.png) |
| รันเนอร์ | ![](screenshots/after/settings-runners-desktop.png) | ![](screenshots/after/settings-runners-mobile.png) |
| การสำรองข้อมูล | ![](screenshots/after/settings-backups-desktop.png) | ![](screenshots/after/settings-backups-mobile.png) |
| ที่เก็บข้อมูล | ![](screenshots/after/settings-storage-desktop.png) | ![](screenshots/after/settings-storage-mobile.png) |
| ความปลอดภัย | ![](screenshots/after/settings-security-desktop.png) | ![](screenshots/after/settings-security-mobile.png) |
| บันทึกการเปลี่ยนแปลง (audit log) | ![](screenshots/after/settings-audit-desktop.png) | ![](screenshots/after/settings-audit-mobile.png) |

## States and dialogs

| What | Shot |
| --- | --- |
| Re-auth dialog | `settings-reauth-dialog.png` |
| Keycloak re-auth screen (`prompt=login`, `max_age=0`) | `settings-reauth-keycloak.png` |
| Back from re-auth: retype notice | `settings-reauth-retype.png` |
| Secret: set / will clear / replace / unset / env-locked | `settings-secret-set.png`, `settings-secret-clearing.png`, `settings-secret-replace.png`, `settings-secret-unset.png`, `settings-secret-env-locked.png` |
| Bound secret: clear warning / secret set by env | `settings-bound-secret-warning.png`, `settings-bound-secret-in-env.png` |
| Env lock chip tooltip (keyboard focus) | `settings-env-lock-tooltip.png` |
| Generated secret, shown once | `settings-generated-secret-dialog.png` |
| Telegram "drop pending" confirm | `settings-telegram-drop-pending-confirm.png` |
| Test results | `settings-test-smtp-ok.png`, `settings-test-smtp-fail.png`, `settings-test-smtp-5xx.png`, `settings-test-gitlab-ok.png`, `settings-test-line.png`, `settings-test-telegram.png`, `settings-test-oidc.png`, `settings-test-storage.png`, `settings-test-backup.png` |
| Version conflict | `settings-conflict.png` |
| Field error / rate limited | `settings-field-error.png`, `settings-rate-limited.png` |
| Unsaved-changes guard | `settings-unsaved-guard.png` |
| Fun switch card | `settings-ai-fun-card.png` |
| Requester on a settings URL | `settings-requester-forbidden.png` |

## Browser verification (reviewer's list, task 5)

Admin `somchai`, requester `nurse1`, Playwright (Chromium), 2026-11-27.

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Re-auth round trip | PASS | The access token carries `auth_time` (decoded in the page from `keycloak.tokenParsed`; claim names only, token never logged). Older than 600 s, a save of `smtp.host` got 401 `reauth_required` and the dialog. Confirm went to Keycloak with `prompt=login&max_age=0` and `redirect_uri=http://localhost:3100/admin/settings/channels`. Keycloak asked for the password again ("กรุณาพิสูจน์ตัวจริงอีกครั้ง"), the redirect URI was accepted, and back on the page the stash was restored and replayed: exactly one more PUT with the same body and versions, then the stash was removed. No `beforeunload` prompt fired on the redirect. A typed secret (GitLab webhook secret) was not put in the stash (`secretsToRetype` names only, checked by wrapping `sessionStorage.setItem`), and the card asked to type it again. Webhook register after re-auth asks to press again. |
| 2 | Category switching with dirty edits | PASS | Switching category asks "ออกโดยไม่บันทึก?"; อยู่ต่อ keeps the URL and the edit, ออก switches; the crumb follows (ระบบ › การตั้งค่าระบบ › การสำรองข้อมูล); the rail item stays active; the form reloads per category. Leaving to /todo shows the same dialog. A page reload with edits shows the browser's `beforeunload` prompt. |
| 3 | Redirects as admin and requester | PASS | Admin: `/admin/gitlab` → `/admin/settings/gitlab`, `/admin/notifications` → `/admin/settings/channels`, `/admin/settings` → `/admin/settings/general`. Requester: all of these and `/admin/ai` → `/forbidden?need=staff`; no settings rail item; `GET /api/admin/settings` 403. |
| 4 | Each category desktop and mobile | PASS | 20 shots above. No horizontal scroll at 390 px on any category. Mobile: chip row for categories, audit panel under the form. The lock chip is focusable and its tooltip opens on keyboard focus. |
| 5 | Bound secret | PASS (after fix) | Changing `smtp.host`, `smtp.port` or `smtp.secure` shows "saving clears the stored รหัสผ่าน"; saving (after re-auth) reports the clear; saving the port change with a typed password keeps the secret and the test passes. With `SMTP_PASSWORD` in env, moving the port is refused with the `bound_secret_in_env` message. **Bug fixed:** the form promised a clear first and only then failed; it now says before saving that the move is refused. |
| 6 | Version conflict, 422, 429 | PASS | Two tabs: the second save of `work.dailyTaskCap` shows "มีคนอื่นเปลี่ยน … ไปแล้ว" with โหลดใหม่, which loads the other tab's value. 422: client errors show on the field (save disabled, `aria-describedby` set); a server 422 (response mocked with core's body shape) puts the issue on the field. 429: twelve test runs in a row hit the real limit ("ทำบ่อยเกินไป ลองใหม่ใน 52 วินาที"); a save 429 (mocked) shows the same with `retryAfter`. |
| 7 | Test buttons against fakes | PASS (after fix) | SMTP: ok, wrong password "ปลายทางไม่รับข้อมูลยืนยันตัวตน", a 554 server "เซิร์ฟเวอร์ SMTP ตอบรหัส 554", send-to-self delivered to the fake. GitLab ok (bot, scopes). LINE ok. Telegram ok (bot, webhook registered). Storage ok (bucket). Backup ok (config). OIDC ok. The draft note "ใช้ค่าบนฟอร์มที่ยังไม่ได้บันทึก" shows when testing unsaved values. **Bug fixed:** the OIDC test failed (`connect_failed`) because `localhost` resolves to `::1` first and Keycloak listens on 127.0.0.1 only; `safeFetch` now tries the next checked address. **Wording fixed:** `secret_required` said "the address changed" also when no secret was ever saved (AI key unset). Readable failure texts for storage and backup were not reachable live (S3 and backup are bootstrap/host-managed); their codes are covered by the code-list test. |
| 8 | Generated secret, Telegram | PASS (after fix) | The one-time dialog shows the value with copy; after closing, the value is gone from DOM, inputs, `useState` and `sessionStorage`; the field shows the last 4 only. Telegram generate re-registered the webhook (result "ผ่าน"). "ทิ้งข้อความที่ค้างอยู่" asks to confirm and then sends `{"dropPending":true}`; without it, no confirm. **Bug fixed:** สร้างใหม่ was hidden until a secret existed, so a first webhook secret could only be typed. |
| 9 | No secret in URLs, storage, DOM, state | PASS | After saving the SMTP password and webhook secrets: not in any request URL, `sessionStorage`, `localStorage`, the DOM, input values, history state or `useState('adminSettings')`; not in `GET /admin/settings` or the audit API; not in the core or portal logs; not in `settings` or `settings_audit` rows as plain text. |
| 10 | axe and keyboard | PASS (after fix) | axe-core 4.10.3 (WCAG 2.0/2.1 A and AA) on every category at desktop (whole document), and on channels at mobile and with a dark colour-scheme preference (the portal stays on its light theme): 0 violations after the fix. **Bug fixed:** the lock chip tooltips kept a nameless `role="tooltip"` while closed (`aria-tooltip-name`, serious). Keyboard: skip link → rail → header → category list → lock chips → fields; focus ring 2 px on chips and nav; every switch has a name ("เปิดใช้ อีเมล (SMTP)" …). |
| 11 | /admin/ai, fun switch | PASS | `/admin/ai` shows usage and project spend with a link to the settings; budget and fun cards are on `/admin/settings/ai`. Turning the fun switch off updates the shared shell state (`useState('funMode')`) at once, without a reload. |

## Notes, not fixed

- Schema messages from the registry are English inside Thai text ("ไม่ถูกต้อง: Number must be greater than or equal to 1").
- After a re-auth round trip that did not happen (the Keycloak redirect was blocked on purpose), the retype notice
  still says "เข้าสู่ระบบแล้ว"; in the real round trip it is right.
- A test result run on the draft stays on the card after the save, with its "unsaved form" note.
