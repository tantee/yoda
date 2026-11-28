/**
 * The Yoda Reporter extension ID (plan decision 10). Chrome derives an ID from the extension's public key: SHA-256
 * of the SPKI DER, the first 16 bytes, each nibble written as a letter a–p. The official ID is the one of the
 * committed `keys/yoda-reporter.pub`; it stays null until the owner commits that key, and until then an admin
 * allowlists a local build's ID in `extension.allowedIds`.
 */
export const OFFICIAL_EXTENSION_ID: string | null = null

const ID_RE = /^[a-p]{32}$/

export function isExtensionId(s: string): boolean {
  return ID_RE.test(s)
}

/** The only redirect URI `launchWebAuthFlow` gives an extension. */
export function chromiumappRedirect(id: string): string {
  return `https://${id}.chromiumapp.org/`
}

export async function extensionIdFromPublicKey(spkiDer: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(spkiDer)))
  let id = ''
  for (const byte of digest.slice(0, 16)) id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f))
  return id
}
