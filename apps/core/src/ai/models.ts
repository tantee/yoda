import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { EmbeddingModel, LanguageModel } from 'ai'
import type { Config } from '../config.js'

export type AiJob = 'draft' | 'fast' | 'embed'
export const EMBEDDING_DIMENSIONS = 1024

export type ModelSet = {
  draft: LanguageModel | null
  fast: LanguageModel | null
  embed: EmbeddingModel | null
  /** `provider:model` per job; null when the job has no usable model. */
  ids: Record<AiJob, string | null>
}

type Warn = (msg: string) => void

export function parseModelId(id: string): { provider: string; model: string } {
  const i = id.indexOf(':')
  return { provider: id.slice(0, i), model: id.slice(i + 1) }
}

export function buildModels(config: Config, warn: Warn = (m) => console.warn(m)): ModelSet {
  const warned = new Set<string>()
  const warnOnce = (envVar: string) => {
    if (warned.has(envVar)) return
    warned.add(envVar)
    warn(`${envVar} is not set: AI jobs configured for that provider are unavailable`)
  }
  const anthropic = config.anthropicApiKey ? createAnthropic({ apiKey: config.anthropicApiKey }) : null
  const openai = config.openaiApiKey
    ? createOpenAI({ apiKey: config.openaiApiKey, baseURL: config.openaiBaseUrl })
    : null

  function resolve<T>(
    spec: string | undefined,
    pick: (p: { anthropic: typeof anthropic; openai: typeof openai }, model: string, provider: string) => T | null,
  ): { model: T | null; id: string | null } {
    if (!spec) return { model: null, id: null }
    const { provider, model } = parseModelId(spec)
    if (provider === 'anthropic' && !anthropic) return (warnOnce('ANTHROPIC_API_KEY'), { model: null, id: null })
    if (provider === 'openai' && !openai) return (warnOnce('OPENAI_API_KEY'), { model: null, id: null })
    const m = pick({ anthropic, openai }, model, provider)
    return m ? { model: m, id: spec } : { model: null, id: null }
  }

  const chat = (p: { anthropic: typeof anthropic; openai: typeof openai }, model: string, provider: string) =>
    provider === 'anthropic' ? (p.anthropic?.(model) ?? null) : (p.openai?.chat(model) ?? null)

  const draft = resolve<LanguageModel>(config.aiModelDraft, chat)
  const fast = resolve<LanguageModel>(config.aiModelFast, chat)
  const embed = resolve<EmbeddingModel>(config.aiEmbeddingModel, (p, model, provider) =>
    provider === 'openai' ? (p.openai?.embedding(model) ?? null) : null,
  )
  return {
    draft: draft.model,
    fast: fast.model,
    embed: embed.model,
    ids: { draft: draft.id, fast: fast.id, embed: embed.id },
  }
}
