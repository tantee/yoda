// MAIN world, injected on click only (scripting.executeScript, world MAIN): console and network capture. It
// shares the page's globals, so it carries no secret: the ISOLATED bridge adds the nonce when forwarding.
import { installHooks } from './hooks'

installHooks(window, (entries) => {
  window.postMessage({ type: 'yoda-reporter/v1', entries }, window.location.origin)
})
