/**
 * Puts the capture scripts in a tab (activeTab, after the tester's click): the nonce in the ISOLATED world
 * first, then the bridge and metadata reader there, then the console/network hooks in the MAIN world.
 */
export async function injectCapture(tabId: number, nonce: string): Promise<void> {
  const target = { tabId }
  await chrome.scripting.executeScript({
    target,
    world: 'ISOLATED',
    injectImmediately: true,
    func: (n: string) => {
      ;(window as unknown as { __yodaNonce?: string }).__yodaNonce = n
    },
    args: [nonce],
  })
  await chrome.scripting.executeScript({ target, world: 'ISOLATED', injectImmediately: true, files: ['injected/isolated.js'] })
  await chrome.scripting.executeScript({ target, world: 'MAIN', injectImmediately: true, files: ['injected/main.js'] })
}
