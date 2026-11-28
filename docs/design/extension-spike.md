# Yoda Reporter: phase 0 spike findings

Plan task B1 (`docs/superpowers/plans/2026-11-28-yoda-reporter.md`). A throwaway MV3 extension
(`docs/design/spike/ext/`) and two Playwright scripts (`docs/design/spike/run.mjs`, `sso.mjs`), run on 2026-11-28 on
macOS (arm64) with Playwright 1.57 driving **Chrome for Testing 158** in the new headless mode, against the dev
demo stack (portal on `http://localhost:3100`, Keycloak `start-dev` with the `yoda` realm). Nothing here is
production code.

```bash
npm i playwright@1.57.0   # in a scratch directory
CHROME=<path to Chrome for Testing> node run.mjs "$PWD" "http://localhost:3100/extension/connect?ext=x"
CHROME=<path to Chrome for Testing> node sso.mjs "$PWD"
```

| # | Question | Answer | Decision |
|---|---|---|---|
| 1 | `launchWebAuthFlow` with the portal and Keycloak: does SSO reach the auth window? | **Yes.** After signing in to the portal in a tab of the same profile, the auth window opened straight on `/extension/connect` (no login form). Approve then answered the extension-not-allowed message for the unlisted spike ID, as designed; closing the window rejects with "The user did not approve access." | The extension uses the real flow. A first-time user signs in inside the auth window (the Keycloak return URL keeps the connect query: checked on the demo stack). |
| 1b | The same in **Edge**, and the `chromiumapp.org` redirect there | **Not run**: no Edge on this Mac. Edge documents `launchWebAuthFlow` and the same `https://<id>.chromiumapp.org/` redirect. | **Owner/IT check before rollout** (one manual connect in Edge). |
| 2 | `captureVisibleTab` in Playwright's new headless Chromium with the e2e host permission | **Works**: an 89 KB PNG data URL of `https://example.org/`. | The e2e captures real screenshots. |
| 3 | Playwright: load unpacked, ID from `serviceWorkers()`, popup as a page, the auth window | **All work.** The ID is the service worker URL's host; `chrome-extension://<id>/popup.html?tab=1` opens as a page and can `sendMessage`; the `launchWebAuthFlow` window **is a page Playwright sees** (`context.waitForEvent('page')`) and can drive. | Decision 2's preferred path: the e2e runs the **real connect flow** (sign in, Approve) against the stub; no `profile.exchange` shortcut is needed. |
| 4 | `tabCapture.getMediaStreamId` in automation | **Works only with `--allowlisted-extension-id=<id>`** plus `--auto-accept-this-tab-capture`. Without the allowlist it fails: "Extension has not been invoked for the current page (see activeTab permission)", because Playwright cannot click the toolbar button. | The C1 e2e launches with both flags (the unpacked e2e build's ID is stable for a fixed path, or fixed by the manifest `key`). |
| 5 | Force-install with `ExtensionSettings` and `override_update_url` on managed Chrome and Edge (Windows VM), CRX from `chrome --pack-extension` with a throwaway key | **Not run**: no Windows VM or managed browser here. | **Deferred to PR D (D5)** with the owner's IT: one managed Chrome and one managed Edge. The CRX3 packer and `updates.xml` are tested in CI meanwhile. |
| 6 | Service-worker limits behind decision 14: a 40 MB multipart `fetch` from the service worker vs an extension page | Locally both finish (86 ms from the worker, 46 ms from a page, to a local server). The worker's limits (an event ends after 5 minutes; idle shutdown at 30 s without events) bite only on slow hospital links, which a local run cannot show. | **Decision 14 stands**: the upload runs from the editor tab, which can show progress and cannot be stopped mid-upload. |
| 7 | `chrome.storage.local.setAccessLevel` exists and keeps `storage.local` out of content scripts | **Yes.** It exists (Chrome 158), and after `setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })` a content script's `chrome.storage.local.get` throws "Access to storage is not allowed from this context." | Decision 15's alternative applies: the refresh token lives in **`storage.local`** with `TRUSTED_CONTEXTS` (set at service-worker start, before any write), or in `storage.session` when "sign out when the browser closes" is set. IndexedDB is not needed. `minimum_chrome_version` 116 covers `setAccessLevel` on `storage.local` (Chrome 102+). |
| 8 | `permissions.request` from a popup click handler before any `await`, and after one | **Both succeed**: after a 50 ms `await` the click's transient user activation (about 5 s) is still live. | The rule stays as written (request before any `await`), because a long `await` (a network call) outlives the activation; a test covers the synchronous path. |

## What changes in the plan

- Decision 2: the e2e uses the real `launchWebAuthFlow` (finding 3); `profile.exchange` remains only as a unit-test seam.
- Decision 15: `storage.local` + `TRUSTED_CONTEXTS` (finding 7).
- C1's e2e launch flags: `--allowlisted-extension-id` and `--auto-accept-this-tab-capture` (finding 4).
- Open items for the owner: one manual Edge connect (1b), and the managed install on Windows with IT (5, in D5).
