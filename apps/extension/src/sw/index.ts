// The service worker: stateless beyond in-flight promises (plan B3). Content scripts never read storage.local.
void chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })
export {}
