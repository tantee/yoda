// DEV ONLY: runs the in-memory FakeLine and FakeTelegram (test/fake-line.ts, test/fake-telegram.ts) on fixed
// ports for trying LINE and Telegram notifications locally, and prints every message the core sends them.
// Point the dev core at them with LINE_API_URL=http://127.0.0.1:4110 and TELEGRAM_API_URL=http://127.0.0.1:4111
// (plus placeholder credentials). Never use it in production; it keeps everything in memory.
//
//   pnpm --filter @yoda/core fake-channels
//   FAKE_LINE_PORT=4110 FAKE_TELEGRAM_PORT=4111 pnpm --filter @yoda/core fake-channels
//
// Link a Telegram chat by posting what Telegram would to the core's webhook (DEV ONLY placeholder values):
//   curl -X POST http://localhost:4000/webhooks/telegram -H 'content-type: application/json' \
//     -H "x-telegram-bot-api-secret-token: $TELEGRAM_WEBHOOK_SECRET" \
//     -d '{"update_id":1,"message":{"message_id":1,"chat":{"id":1001,"type":"private"},"text":"/start XXXXXXXX"}}'
import { FakeLine } from './fake-line.js'
import { FakeTelegram } from './fake-telegram.js'

const line = new FakeLine()
const telegram = new FakeTelegram()
await line.start(Number(process.env.FAKE_LINE_PORT ?? 4110))
await telegram.start(Number(process.env.FAKE_TELEGRAM_PORT ?? 4111))

// Print each new request as it arrives (paths without the Telegram token, which sits in the URL).
const shown = { line: 0, telegram: 0 }
setInterval(() => {
  for (; shown.line < line.requests.length; shown.line++) {
    const r = line.requests[shown.line]!
    const b = r.body as { to?: string; replyToken?: string; messages?: { text: string }[] }
    console.log(`fake-line: ${r.path} ${b.to ?? b.replyToken ?? ''}\n${(b.messages ?? []).map((m) => m.text).join('\n')}\n`)
  }
  for (; shown.telegram < telegram.requests.length; shown.telegram++) {
    const r = telegram.requests[shown.telegram]!
    const b = r.body as { chat_id?: unknown; text?: string }
    console.log(`fake-telegram: ${r.path.replace(/^\/bot[^/]+/, '/bot<token>')} chat ${String(b.chat_id)}\n${b.text ?? ''}\n`)
  }
}, 200)

console.log(`fake-line: listening on ${line.url} (DEV ONLY)`)
console.log(`fake-telegram: listening on ${telegram.url} (DEV ONLY)`)

const stop = async () => {
  await line.stop()
  await telegram.stop()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
