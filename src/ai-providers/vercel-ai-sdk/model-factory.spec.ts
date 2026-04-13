/**
 * Model factory tests for provider-specific client wiring.
 *
 * @ai-context Ollama reuses the OpenAI SDK path but needs a normalized `/v1` base URL and a dummy key fallback.
 * @ai-related src/ai-providers/vercel-ai-sdk/model-factory.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockCreateOpenAI, mockOpenAIModel } = vi.hoisted(() => ({
  mockCreateOpenAI: vi.fn(),
  mockOpenAIModel: vi.fn(),
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mockCreateOpenAI,
}))

import { createModelFromProfile } from './model-factory.js'

describe('createModelFromProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateOpenAI.mockReturnValue(mockOpenAIModel)
  })

  it('should create an Ollama model with the local OpenAI-compatible defaults', async () => {
    const model = { provider: 'ollama-model' }
    mockOpenAIModel.mockReturnValue(model)

    const result = await createModelFromProfile({
      backend: 'vercel-ai-sdk',
      provider: 'ollama',
      model: 'llama3.2',
    })

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'ollama',
      baseURL: 'http://localhost:11434/v1',
    })
    expect(mockOpenAIModel).toHaveBeenCalledWith('llama3.2')
    expect(result).toEqual({
      model,
      key: 'ollama:llama3.2:http://localhost:11434/v1',
    })
  })

  it('should normalize a scheme-less Ollama host to an HTTP `/v1` endpoint', async () => {
    const model = { provider: 'ollama-model' }
    mockOpenAIModel.mockReturnValue(model)

    const result = await createModelFromProfile({
      backend: 'vercel-ai-sdk',
      provider: 'ollama',
      model: 'qwen3:8b',
      baseUrl: 'localhost:11434',
    })

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'ollama',
      baseURL: 'http://localhost:11434/v1',
    })
    expect(result.key).toBe('ollama:qwen3:8b:http://localhost:11434/v1')
  })

  it('should append `/v1` when an Ollama base URL omits it', async () => {
    mockOpenAIModel.mockReturnValue({ provider: 'ollama-model' })

    await createModelFromProfile({
      backend: 'vercel-ai-sdk',
      provider: 'ollama',
      model: 'qwen3:8b',
      baseUrl: 'http://127.0.0.1:11434',
    })

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'ollama',
      baseURL: 'http://127.0.0.1:11434/v1',
    })
  })

  it('should preserve an explicit Ollama key and an already-correct `/v1` path', async () => {
    const model = { provider: 'ollama-model' }
    mockOpenAIModel.mockReturnValue(model)

    const result = await createModelFromProfile({
      backend: 'vercel-ai-sdk',
      provider: 'ollama',
      model: 'deepseek-r1:8b',
      apiKey: 'secret-key',
      baseUrl: 'https://ollama.example.com/proxy/v1/',
    })

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'secret-key',
      baseURL: 'https://ollama.example.com/proxy/v1',
    })
    expect(result).toEqual({
      model,
      key: 'ollama:deepseek-r1:8b:https://ollama.example.com/proxy/v1',
    })
  })
})