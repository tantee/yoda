import { ConsoleEntry, NetworkEntry } from '@yoda/shared'
import { z } from 'zod'

const id = z.string().min(1).max(100)

/** Every runtime message the service worker accepts. Anything else is refused before a handler runs. */
export const Msg = z.discriminatedUnion('type', [
  z.object({ type: z.literal('profile.exchange'), origin: z.string().url(), code: z.string().max(200), verifier: z.string().max(200), browserLabel: z.string().max(120) }),
  z.object({ type: z.literal('profile.remove'), profileId: id }),
  z.object({ type: z.literal('session.get'), profileId: id, fresh: z.boolean().optional() }),
  z.object({ type: z.literal('token.get'), profileId: id, after401: z.boolean().optional() }),
  z.object({ type: z.literal('capture.arm'), tabId: z.number().int() }),
  z.object({ type: z.literal('capture.screenshot'), tabId: z.number().int(), profileId: id.optional() }),
  z.object({ type: z.literal('capture.fullPage'), tabId: z.number().int(), profileId: id.optional() }),
  z.object({ type: z.literal('capture.state'), tabId: z.number().int() }),
  z.object({
    type: z.literal('capture.collected'),
    nonce: z.string().max(100),
    // Validated again, entry by entry, when stored (sanitizeEntries): page data is untrusted.
    entries: z.array(z.unknown()).max(1000),
  }),
  z.object({ type: z.literal('draft.get'), id }),
  z.object({ type: z.literal('draft.delete'), id }),
])
export type Msg = z.infer<typeof Msg>
export type MsgType = Msg['type']
export { ConsoleEntry, NetworkEntry }

export type SenderKind = 'page' | 'content' | 'foreign'

/**
 * Who sent a message. `page`: one of our extension pages (popup, editor, options, offscreen), wherever it runs,
 * even in a tab; `content`: our scripts injected in a web page; anything else is `foreign`. `sender.tab` says
 * nothing about which, since an extension page in a tab also has one.
 */
export function senderKind(sender: chrome.runtime.MessageSender, extensionId: string): SenderKind {
  if (sender.id !== extensionId) return 'foreign'
  const own = `chrome-extension://${extensionId}`
  if (sender.origin === own || sender.url?.startsWith(`${own}/`)) return 'page'
  if (sender.url && /^https?:\/\//i.test(sender.url)) return 'content'
  return 'foreign'
}

export type Reply = { ok: true; [k: string]: unknown } | { ok: false; error: string; [k: string]: unknown }
export type Handler = (m: Msg, ctx: { sender: chrome.runtime.MessageSender; kind: SenderKind }) => Promise<Reply>

/**
 * Registers the one message handler. Foreign senders are dropped; content scripts may send only
 * `capture.collected`, carrying the nonce of their tab's current injection; everything else (`token.get`
 * included) comes from extension pages only.
 */
export function onMessage(handler: Handler, opts: { nonceFor?: (tabId: number) => Promise<string | null> } = {}): void {
  chrome.runtime.onMessage.addListener((raw, sender, reply) => {
    void (async () => {
      const kind = senderKind(sender, chrome.runtime.id)
      if (kind === 'foreign') return reply({ ok: false, error: 'forbidden' })
      const parsed = Msg.safeParse(raw)
      if (!parsed.success) return reply({ ok: false, error: 'invalid' })
      const m = parsed.data
      if (kind === 'content') {
        const tabId = sender.tab?.id
        const nonce = tabId === undefined || !opts.nonceFor ? null : await opts.nonceFor(tabId)
        if (m.type !== 'capture.collected' || !nonce || m.nonce !== nonce) return reply({ ok: false, error: 'forbidden' })
      }
      try {
        reply(await handler(m, { sender, kind }))
      } catch (err) {
        reply({ ok: false, error: 'internal', message: err instanceof Error ? err.message : String(err) })
      }
    })()
    return true
  })
}
