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
