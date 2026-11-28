/**
 * Puts the capture scripts in a tab (activeTab, after the tester's click): a fresh nonce in the ISOLATED world
 * first, then the bridge and metadata reader there, then the console/network hooks in the MAIN world.
 */
export async function injectCapture(tabId: number): Promise<string> {
  const nonce = crypto.randomUUID()
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: (n: string) => {
      ;(window as unknown as { __yodaNonce?: string }).__yodaNonce = n
    },
    args: [nonce],
  })
  await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: ['injected/isolated.js'] })
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['injected/main.js'] })
  return nonce
}
