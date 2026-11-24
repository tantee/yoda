import { MockEmbeddingModelV4, MockLanguageModelV4 } from 'ai/test'

type Chunk = Record<string, unknown>
const usage = (i: number, o: number) => ({
  inputTokens: { total: i, noCache: i, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: o, text: o, reasoning: undefined },
})

/** A finished text stream with fixed usage (1000 in / 500 out by default). */
export function textStream(text: string, i = 1000, o = 500): ReadableStream<never> {
  const chunks: Chunk[] = [{ type: 'stream-start', warnings: [] }]
  if (text) {
    chunks.push(
      { type: 'text-start', id: '1' },
      { type: 'text-delta', id: '1', delta: text },
      { type: 'text-end', id: '1' },
    )
  }
  chunks.push({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(i, o) })
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch as never)
      c.close()
    },
  })
}

export function textModel(modelId: string, text: string) {
  return new MockLanguageModelV4({ modelId, doStream: async () => ({ stream: textStream(text) }) })
}

export function failingModel(modelId: string, message: string) {
  return new MockLanguageModelV4({
    modelId,
    doStream: async () => {
      throw new Error(message)
    },
  })
}

export function embeddingModel(modelId: string, dims = 1024) {
  return new MockEmbeddingModelV4({
    modelId,
    doEmbed: async ({ values }) => ({
      embeddings: values.map(() => Array.from({ length: dims }, () => 0.1)),
      usage: { tokens: 10 },
      warnings: [],
    }),
  })
}

type Turn = { text?: string; toolCalls?: { name: string; input: unknown }[] }

/** A finished stream for one model turn: optional text, then tool calls (finish reason `tool-calls` if any). */
export function turnStream(turn: Turn, i = 1000, o = 500): ReadableStream<never> {
  const chunks: Chunk[] = [{ type: 'stream-start', warnings: [] }]
  if (turn.text) {
    chunks.push(
      { type: 'text-start', id: '1' },
      { type: 'text-delta', id: '1', delta: turn.text },
      { type: 'text-end', id: '1' },
    )
  }
  const calls = turn.toolCalls ?? []
  calls.forEach((c, k) =>
    chunks.push({ type: 'tool-call', toolCallId: `call-${Math.random().toString(36).slice(2)}-${k}`, toolName: c.name, input: JSON.stringify(c.input) }),
  )
  const reason = calls.length ? 'tool-calls' : 'stop'
  chunks.push({ type: 'finish', finishReason: { unified: reason, raw: reason }, usage: usage(i, o) })
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch as never)
      c.close()
    },
  })
}

/** A model that plays `turns` in order (the last one repeats). */
export function scriptedModel(modelId: string, turns: Turn[]) {
  let n = 0
  return new MockLanguageModelV4({
    modelId,
    doStream: async () => ({ stream: turnStream(turns[Math.min(n++, turns.length - 1)]!) }),
  })
}
