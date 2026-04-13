/**
 * Preset serialization tests for built-in AI provider profiles.
 *
 * @ai-context The UI creates profiles from the serialized preset list, so new providers must appear here with correct defaults.
 * @ai-related src/ai-providers/preset-catalog.ts
 */

import { describe, expect, it } from 'vitest'
import { BUILTIN_PRESETS } from './presets.js'

describe('BUILTIN_PRESETS', () => {
  it('should expose the expected built-in preset ids', () => {
    expect(BUILTIN_PRESETS.map(({ id }) => id)).toEqual([
      'claude-oauth',
      'claude-api',
      'codex-oauth',
      'codex-api',
      'gemini',
      'ollama',
      'minimax',
      'custom',
    ])
  })

  it('should serialize the Ollama preset with local defaults', () => {
    const preset = BUILTIN_PRESETS.find(({ id }) => id === 'ollama')
    const properties = (preset?.schema.properties ?? {}) as Record<string, { const?: string; default?: string; writeOnly?: boolean }>

    expect(preset).toBeDefined()
    expect(preset?.category).toBe('third-party')
    expect(preset?.defaultName).toBe('Ollama')
    expect(properties.backend?.const).toBe('vercel-ai-sdk')
    expect(properties.provider?.const).toBe('ollama')
    expect(properties.baseUrl?.default).toBe('http://localhost:11434/v1')
    expect(properties.apiKey?.writeOnly).toBe(true)
  })
})