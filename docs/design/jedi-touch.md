# Fun touches ("Jedi touch")

The product is named Yoda. The owner asked for a light, tasteful space-and-wisdom mood on a few surfaces of an
otherwise plain enterprise portal. The mood comes from puns and atmosphere only. This page lists what was added,
where it appears, why it is original and how to switch it off.

## What was added and where

| Surface | Fun mode on | Fun mode off | Code |
| --- | --- | --- | --- |
| Logo tile in the side menu | Blue tile with a geometric "Y". The stem is drawn as a soft light blade, with a small four-point star beside it. The star twinkles once on hover, but not when reduced motion is set. | The same tile and "Y", static, with no blade or star | `apps/portal/app/components/AppMark.vue` |
| Favicon (portal and sign-in page) | The static mark | The static mark | `apps/portal/public/favicon.svg`, `infra/keycloak/themes/yoda/login/resources/img/favicon.svg` |
| Whole-page empty states (opt-in) | One extra line in inverted word order under the text, chosen per page. For example: "Empty, this list is. Rest a moment, you may." / "ว่างเปล่า รายการนี้ พักสักครู่ ท่านทำได้" | No extra line | `EmptyState.vue` (prop `wisdom`, default `false`; only to-do, my requests, questions for me, status, agendas and chat opt in with `wisdom="empty"`) |
| Loading (skeletons) | A caption under the placeholder, hidden from screen readers. Small placeholders inside a page that has already loaded pass `quiet`. | No caption | `SkeletonList.vue`, `SkeletonDetail.vue` |
| 404, "not found" and error pages | A not-found line or an error line | No extra line | `app/error.vue` and the not-found states of the detail pages |
| Easter egg | ↑ ↑ ↓ ↓ ← → ← → B A shows a toast: "May the source be with you" / "ขอให้ซอร์สโค้ดจงสถิตอยู่กับท่าน". Keys typed in fields or with a modifier are ignored. Nothing is sent to the server. | No key listener | `composables/useKonami.ts`, `layouts/default.vue` |
| Sign-in page (Keycloak) | Faint CSS-only starfield in the navy panel. The two layers fade slowly and stay still when reduced motion is set. The page also shows the fun mark and one line: "Sign in, you shall. Then begin, the work can." / "เข้าสู่ระบบ ท่านพึงทำ แล้วงานทั้งหลาย จึงเริ่มได้" | Static mark, no starfield and no line | `infra/keycloak/themes/yoda/login` (`template.ftl`, `yoda.css`, `messages_*.properties`) |

All copy lives in i18n under `fun.*` in `apps/portal/i18n/locales/{th,en}.json`, and in `yodaWisdom` in the theme
bundles. There are 10 empty lines, 6 loading lines, 3 not-found lines and 3 error lines, plus the toast, each in Thai
and English. Only `app/utils/funMode.ts` names the `fun.*` keys, and a test checks this.

**Never in:** task data, tables, lists, tabs or filtered results, notifications, emails and core. For example, the
to-do filters, admin people, the project work-items table, knowledge, runners, the project list tabs, discussion
tabs and agenda items all keep their empty states plain. Tests (`apps/portal/test/funMode.test.ts`) check that:

- every `EmptyState` call site is listed with the line kind it asks for, so a table or filter state cannot opt in
  unnoticed;
- only the state components and the layout use the fun utilities;
- no fun line appears anywhere in `apps/core/src` or `packages/shared/src`, where notifications and emails come from.

## How to switch it off

- **Portal:** in the side menu, open ระบบ → งบประมาณ AI (System → AI budget, `/admin/ai`). On the card
  "ลูกเล่นธีม / Fun touches", turn off the switch "ลูกเล่นเล็ก ๆ ในพอร์ทัล / Playful touches in the portal". This
  stores `department_settings.fun_mode`, which defaults to on (migration `0021_fun_mode`). Only admins can change it
  (`PATCH /admin/ai-settings { funMode }`).
  Every signed-in user, requesters included, can read it at `GET /ui-config`. The setting is cosmetic. Until it
  loads, or if loading fails, the portal treats it as off.
- **Sign-in page:** the portal setting cannot reach Keycloak, so the page has its own switch. Either set
  `YODA_LOGIN_FUN_MODE=false` on the Keycloak server (the theme property `funMode` reads it), or choose the
  `yoda-plain` login theme. `docs/operations.md` §2, "Login theme", says to install both theme folders, `yoda` and
  `yoda-plain`.

## Legal guard-rail checklist

- [x] **Everything is original.**
  - The mark is our own geometric "Y" with a light stroke and a generic four-point star, in our blues `#1F5FBF` and
    `#6FA8FF`.
  - The starfield is generic CSS dots.
  - Every line was written for Yoda. Each one is an inverted-order pun about lists, loading or pages, not a line
    from a film.
- [x] **No franchise names in the UI** beyond the product name "Yoda". A test scans every portal string, the
  Keycloak messages and the SVGs for franchise and character names and for well-known film lines.
- [x] **No likeness or images:** no character, no ears, no silhouettes, no logos.
- [x] **No film quotes.** No line quotes a film. The one deliberate nod is the toast "May the source be with you"
  (th "ขอให้ซอร์สโค้ดจงสถิตอยู่กับท่าน"). The owner asked for this pun on a famous phrase; it is not a direct
  quote. It swaps in "source", as in source code, and appears only as a hidden easter egg.
- [x] **No franchise fonts or sounds.** The fonts are IBM Plex Sans Thai and IBM Plex Sans (OFL). The feature has
  no audio.
- [x] **Nothing implies endorsement.** There is no franchise name or trademark, and nothing says "official" or
  "licensed".
- [x] **Admin switch, on by default.** With it off, nothing from this page renders. Tests cover this.
