/**
 * The Record click. `permissions.request` needs the click's user activation, so it is called first, with nothing
 * awaited before it (as in connect.ts); the worker never requests permissions. Then the worker starts the clip.
 */
export function onRecordClick<R>(start: () => Promise<R>): Promise<R | { ok: false; error: 'permission_needed' }> {
  const granted = chrome.permissions.request({ permissions: ['tabCapture'] })
  return granted.then((ok): Promise<R | { ok: false; error: 'permission_needed' }> => (ok ? start() : Promise.resolve({ ok: false, error: 'permission_needed' })))
}
