# Yoda Reporter: managed install and policy (IT guide)

Yoda Reporter is the browser extension staff use to report defects into Yoda. This guide is for the IT team that
installs it on managed Chrome and Edge and presets it with policy. Staff can also install it themselves from
Yoda's **Help** page; nothing here is required for that.

Throughout, `yoda.example.org` stands for your Yoda's address.

## What you need

- **The extension ID:** `hcnhkfonaflhcknbhcphbfgpdfmgmibm`. It is fixed by the extension's public key, so every
  release keeps it.
- **The update URL:** `https://yoda.example.org/api/extension/updates.xml`. Yoda serves it, together with the signed
  extension package (CRX), when the running release includes a CRX. Yoda's **Help** page shows both values, with a
  copy button, under "Managed install". If that section is missing, the running release has no CRX: managed
  installs keep their current version until a release with one.
- Chrome or Edge 116 or later.

## 1. Force-install the extension

Use the browser's `ExtensionSettings` policy. It installs the extension, keeps users from removing it, and points
the browser at Yoda for updates:

```json
{
  "hcnhkfonaflhcknbhcphbfgpdfmgmibm": {
    "installation_mode": "force_installed",
    "update_url": "https://yoda.example.org/api/extension/updates.xml",
    "override_update_url": true,
    "toolbar_pin": "force_pinned"
  }
}
```

`override_update_url` keeps updates coming from Yoda. `ExtensionInstallForcelist` with the entry
`hcnhkfonaflhcknbhcphbfgpdfmgmibm;https://yoda.example.org/api/extension/updates.xml` does the same for the install
alone; use one or the other, not both.

**Where to set it:**

| | Chrome | Edge |
|---|---|---|
| Group Policy (ADMX) | Google Chrome → Extensions → "Extension management settings" | Microsoft Edge → Extensions → "Configure extension management settings" |
| Registry (Windows), value `ExtensionSettings` (REG_SZ, the JSON on one line) | `HKLM\Software\Policies\Google\Chrome` | `HKLM\Software\Policies\Microsoft\Edge` |
| macOS configuration profile | domain `com.google.Chrome`, key `ExtensionSettings` | domain `com.microsoft.Edge`, key `ExtensionSettings` |
| Intune | Settings catalog, the same policy names as Group Policy | Settings catalog, the same policy names as Group Policy |

Check it on a managed machine at `chrome://policy` or `edge://policy` (the policy is listed with no error), then at
`chrome://extensions` or `edge://extensions` (Yoda Reporter is installed and marked as installed by your
organisation).

## 2. Preset the extension (optional)

The extension reads its own managed settings. The schema it accepts is `managed-schema.json` in the extension; all
keys are optional:

| Key | Type | What it does |
|---|---|---|
| `instances` | array of `{ name, url, default }` | Yodas every user starts with. They cannot be removed. Each user still approves the connection once in Yoda: policy never carries a password or token. |
| `rules` | array of `{ pattern, instance, projectId, environment, production }` | Map application addresses (Chrome match patterns such as `https://*.uat.example.org/*`) to a Yoda (`instance`: its name or address) and, optionally, a project. `production: true` marks a production site: no video, and logs off by default. Users cannot change or remove these rules, and their own rules can never remove a production mark. |
| `allowVideo` | boolean, default `true` | `false` turns video clips off for everyone. |
| `allowBuffer` | boolean, default `true` | `false` turns the rolling replay buffer off. |
| `sessionOnly` | boolean, default `false` | `true` signs users out of every Yoda when the browser closes. |

Example:

```json
{
  "instances": [{ "name": "Yoda", "url": "https://yoda.example.org", "default": true }],
  "rules": [
    { "pattern": "https://his.example.org/*", "instance": "Yoda", "production": true },
    { "pattern": "https://his-uat.example.org/*", "instance": "Yoda", "environment": "uat" }
  ],
  "allowVideo": true,
  "sessionOnly": false
}
```

**Where to set it:**

- **Windows (Group Policy or Intune with a registry setting):** under
  `HKLM\Software\Policies\Google\Chrome\3rdparty\extensions\hcnhkfonaflhcknbhcphbfgpdfmgmibm\policy` for Chrome,
  or `HKLM\Software\Policies\Microsoft\Edge\3rdparty\extensions\hcnhkfonaflhcknbhcphbfgpdfmgmibm\policy` for Edge.
  `allowVideo`, `allowBuffer` and `sessionOnly` are REG_DWORD values (0 or 1). `instances` and `rules` are
  REG_SZ values holding the JSON array on one line.
- **macOS:** a configuration profile for the domain
  `com.google.Chrome.extensions.hcnhkfonaflhcknbhcphbfgpdfmgmibm` (Chrome) or
  `com.microsoft.Edge.extensions.hcnhkfonaflhcknbhcphbfgpdfmgmibm` (Edge), with the keys above.

Check it at `chrome://policy` (or `edge://policy`) → **Reload policies**: the extension's policies are listed under
its ID. Changes apply without a restart. If the values do not match the schema, the extension ignores the whole
policy and shows "Your organisation's policy for this extension is invalid" on its settings page.

## 3. Notes

- **Developer mode is not needed** for a force-installed extension. If you block developer mode
  (`DeveloperToolsAvailability` or `ExtensionDeveloperModeSettings`), staff cannot load an unpacked copy, which is
  the point.
- **Edge:** Edge accepts the same CRX and update URL as Chrome; the sign-in window during "Connect" works the same
  way. One manual check on a managed Edge machine before the rollout is recommended (connect once, record one clip).
- **Permissions:** the extension asks for no host access at install. It asks for each Yoda's address when a user
  connects it, and for a site only when the user starts capturing logs there. Video asks for tab capture on first
  use.
- **Data:** screenshots, video and logs go only to your Yoda, and Yoda never sends them to AI.
