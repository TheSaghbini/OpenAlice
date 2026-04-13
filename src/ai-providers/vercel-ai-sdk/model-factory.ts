/**
 * Model factory — creates Vercel AI SDK LanguageModel instances from a resolved profile.
 *
 * Uses dynamic imports so unused provider packages don't prevent startup.
 */

import type { LanguageModel } from 'ai'
import type { ResolvedProfile } from '../../core/config.js'

const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1'
const OLLAMA_DUMMY_API_KEY = 'ollama'
const URL_SCHEME_PREFIX_RE = /^[a-z][a-z\d+.-]*:\/\//i

/** Result includes the model plus a cache key for change detection. */
export interface ModelFromConfig {
  model: LanguageModel
  /** `provider:modelId:baseUrl` — use this to detect config changes. */
  key: string
}

/** @ai-context Node treats `localhost:11434` as a custom scheme, so scheme-less Ollama hosts must be normalized before URL parsing. */
function normalizeOllamaBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim()
  if (!trimmed) return OLLAMA_DEFAULT_BASE_URL

  const candidate = URL_SCHEME_PREFIX_RE.test(trimmed) ? trimmed : `http://${trimmed}`

  try {
    const url = new URL(candidate)
    const path = url.pathname.replace(/\/+$/, '')
    url.pathname = path === '' ? '/v1' : path.endsWith('/v1') ? path : `${path}/v1`
    return url.toString()
  } catch {
    const normalized = candidate.replace(/\/+$/, '')
    return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
  }
}

/**
 * Create a Vercel AI SDK model instance from a resolved profile.
 *
 * @ai-context Ollama reuses the OpenAI client path, so its base URL and fallback key are normalized here before the cache key is derived.
 */
export async function createModelFromProfile(profile: ResolvedProfile): Promise<ModelFromConfig> {
  const p = profile.provider ?? 'anthropic'
  const m = profile.model
  const url = profile.baseUrl?.trim()
  const apiKey = profile.apiKey?.trim()
  const resolvedUrl = p === 'ollama' ? normalizeOllamaBaseUrl(url) : url
  const key = `${p}:${m}:${resolvedUrl ?? ''}`

  switch (p) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic')
      const client = createAnthropic({ apiKey: apiKey || undefined, baseURL: url || undefined })
      return { model: client(m), key }
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai')
      const client = createOpenAI({ apiKey: apiKey || undefined, baseURL: url || undefined })
      return { model: client(m), key }
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
      const client = createGoogleGenerativeAI({ apiKey: apiKey || undefined, baseURL: url || undefined })
      return { model: client(m), key }
    }
    case 'ollama': {
      const { createOpenAI } = await import('@ai-sdk/openai')
      const client = createOpenAI({ apiKey: apiKey || OLLAMA_DUMMY_API_KEY, baseURL: resolvedUrl })
      return { model: client(m), key }
    }
    default:
      throw new Error(`Unsupported model provider: "${p}". Supported: anthropic, openai, google, ollama`)
  }
}
