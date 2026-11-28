// MAIN world, injected on click only (scripting.executeScript, world MAIN): console and network capture. It
// shares the page's globals, so it carries no secret: the ISOLATED bridge adds the nonce when forwarding. The
// batch goes as a JSON string on a synchronous DOM event, so it is delivered even while the page unloads.
import { BRIDGE_EVENT } from '../capture/bridge'
import { installHooks } from './hooks'

installHooks(window, (entries) => {
  document.dispatchEvent(new CustomEvent(BRIDGE_EVENT, { detail: JSON.stringify(entries) }))
})
