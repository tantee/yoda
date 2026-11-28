import { manifestVersion } from '@yoda/shared'

/** The proposal's §5 permissions: required ones carry no install warning; the rest are asked for when needed. */
export const REQUIRED_PERMISSIONS = ['activeTab', 'scripting', 'storage', 'identity', 'offscreen'] as const
export const OPTIONAL_PERMISSIONS = ['tabCapture'] as const
/** The ceiling for per-origin requests: the Yoda origin while connecting, sites under test for pre-armed rules. */
export const OPTIONAL_HOST_PERMISSIONS = ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'] as const
/** Never in a release build (check-dist enforces it on the output too). */
export const FORBIDDEN_PERMISSIONS = ['<all_urls>', 'tabs', 'alarms', 'debugger', 'webRequest', 'cookies', 'downloads', 'history', 'clipboardRead', 'notifications'] as const
export const FORBIDDEN_MANIFEST_KEYS = ['content_scripts', 'web_accessible_resources', 'externally_connectable', 'host_permissions'] as const

export type BuildTarget = 'release' | 'e2e'

/**
 * The extension's manifest.json. `publicKey` (base64 SPKI, keys/yoda-reporter.pub) fixes the extension ID; without
 * it a local build gets a path-derived ID an admin allowlists. The e2e build alone adds `<all_urls>` and a required
 * `tabCapture`, because Playwright can neither click the toolbar button that grants activeTab nor answer a prompt.
 */
export function buildManifest(opts: { yodaVersion: string; publicKey: string | null; target: BuildTarget }): chrome.runtime.ManifestV3 {
  const { version, versionName } = manifestVersion(opts.yodaVersion)
  const manifest: chrome.runtime.ManifestV3 = {
    manifest_version: 3,
    name: '__MSG_extName__',
    short_name: '__MSG_extShortName__',
    description: '__MSG_extDescription__',
    default_locale: 'th',
    version,
    version_name: versionName,
    minimum_chrome_version: '116',
    icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
    action: { default_popup: 'src/popup/index.html', default_title: '__MSG_extName__', default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' } },
    background: { service_worker: 'sw.js', type: 'module' },
    options_page: 'src/options/index.html',
    permissions: [...REQUIRED_PERMISSIONS],
    optional_permissions: [...OPTIONAL_PERMISSIONS],
    optional_host_permissions: [...OPTIONAL_HOST_PERMISSIONS],
    commands: { _execute_action: { suggested_key: { default: 'Alt+Shift+Y' } } },
    // What IT may set through Chrome or Edge policy (src/sw/policy.ts).
    storage: { managed_schema: 'managed-schema.json' },
  }
  if (opts.publicKey) manifest.key = opts.publicKey
  if (opts.target === 'e2e') {
    // Playwright can neither click the toolbar button (activeTab) nor answer a permission prompt.
    ;(manifest as Record<string, unknown>).host_permissions = ['<all_urls>']
    manifest.permissions = [...manifest.permissions!, 'tabCapture']
  }
  return manifest
}
