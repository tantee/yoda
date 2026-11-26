# Portal design refresh — follow-ups

Deferred findings from the task reviews and the whole-branch review. None of them blocks the refresh.

## Owner decisions still open (defaults shipped)

| Decision | Default shipped |
|---|---|
| Logo | the original "Y" mark (`AppMark`), with a star and blade when fun mode is on |
| Thai product name | "Yoda · พอร์ทัลงานฝ่าย IT" |
| Hospital name in the menu | none; `NUXT_PUBLIC_ORG_LINE` sets an optional footer line |
| Menu renames | as proposed: สถานะภาพรวม, ประเด็นหารือ, คำถามถึงฉัน |
| Mobile bottom bar | งานที่ต้องทำ, แชท, โครงการ, สถานะ for staff; requesters get My requests, Chat, Answers |
| Requester wording | the proposed plain-language glossary, pending a review by one or two nurses |
| Screenshots in the public repo | `docs/design/screenshots/` is about 39 MB. Keep it, move it to release assets, or prune it after approval. |

## Behaviour to revisit
- **Login page and fun mode:** the login page can't follow the portal's fun-mode setting. Keycloak is switched separately, with `YODA_LOGIN_FUN_MODE` or the `yoda-plain` theme.
- **`openTasks` counts on the project page:** they cover a member's tasks in all projects, so they are counts only.
- **Search:** it doesn't find items where a staff member is the requester in a project they can't see.
- **Badge counts:** they refresh on navigation and every 60 s, with a 20 s throttle, not live.
- **Agenda reordering:** dragging works with a mouse only. Keyboard and touch users reorder through the row menu.
- **Requester "what was delivered":** it stays empty until a template puts a team result before delivery acceptance.
- **Admin people page:** it has no project counts, and the admin AI page has no month-by-month history (both need core fields).
- **Display names:** dev1 and nurse1 show usernames because their Keycloak profiles have no display name, which is demo data.

## Small fixes
- Vue Router logs one warning on the first load after sign-in, about the `#state` hash before it is stripped.
- The demo Keycloak container needs `docker cp` of the themes after each theme edit (see `infra/keycloak/README.md`).
- The seed script and demo data (`yoda_demo`, `yoda-demo` bucket, Keycloak `dev1`) are dev-only. Remove them when no longer needed.

## Tests to strengthen
- Component tests for `AppDialog` focus return and `ConfirmDialog` mobile bottom-sheet layout.
- A Playwright smoke suite (login, to-do, work item, requester request) run in CI against the dev stack.
