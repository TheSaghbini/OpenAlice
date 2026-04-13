/**
 * config.ts unit tests.
 *
 * fs/promises is mocked so no real disk I/O occurs.
 * Tests cover: hot-read helpers, writeConfigSection, writeAIBackend,
 * loadTradingConfig (both new-format and legacy-migration paths).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock fs/promises BEFORE importing config
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}))

// Mock pino to avoid file I/O from logger
vi.mock('pino', () => ({
  pino: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

import { readFile, writeFile, mkdir } from 'fs/promises'
import {
  readAIProviderConfig,
  setActiveProfile,
  readToolsConfig,
  readAgentConfig,
  readMarketDataConfig,
  loadConfig,
  writeConfigSection,
  readAccountsConfig,
  writeAccountsConfig,
  aiProviderSchema,
  profileSchema,
} from './config.js'

const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)
const mockMkdir = vi.mocked(mkdir)

/** Simulate a file read that returns JSON content. */
function fileReturns(content: unknown) {
  mockReadFile.mockResolvedValueOnce(JSON.stringify(content) as any)
}

/** Simulate ENOENT (file not found). */
function fileNotFound() {
  const err = new Error('ENOENT: no such file') as NodeJS.ErrnoException
  err.code = 'ENOENT'
  mockReadFile.mockRejectedValueOnce(err)
}

/** Simulate a non-ENOENT read error. */
function fileReadError(message = 'Permission denied') {
  mockReadFile.mockRejectedValueOnce(new Error(message))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockWriteFile.mockResolvedValue(undefined as any)
  mockMkdir.mockResolvedValue(undefined as any)
})

// ==================== readAIProviderConfig ====================

describe('readAIProviderConfig', () => {
  it('returns schema defaults when file is missing', async () => {
    fileNotFound()
    const cfg = await readAIProviderConfig()
    expect(cfg.activeProfile).toBe('default')
    expect(cfg.profiles.default).toBeDefined()
    expect(cfg.profiles.default.backend).toBe('agent-sdk')
  })

  it('parses valid profile-based content', async () => {
    fileReturns({
      apiKeys: { openai: 'sk-test' },
      profiles: { main: { backend: 'codex', label: 'GPT', model: 'gpt-5.4', loginMethod: 'codex-oauth' } },
      activeProfile: 'main',
    })
    const cfg = await readAIProviderConfig()
    expect(cfg.activeProfile).toBe('main')
    expect(cfg.profiles.main.backend).toBe('codex')
    expect(cfg.profiles.main.model).toBe('gpt-5.4')
  })

  it('returns defaults when file contains invalid JSON (parse error)', async () => {
    fileReadError('Unexpected token')
    const cfg = await readAIProviderConfig()
    expect(cfg.activeProfile).toBe('default')
  })
})

// ==================== setActiveProfile ====================

describe('setActiveProfile', () => {
  it('updates activeProfile and writes to disk', async () => {
    const config = {
      apiKeys: {},
      profiles: {
        a: { backend: 'agent-sdk', label: 'A', model: 'claude-sonnet-4-6', loginMethod: 'api-key' },
        b: { backend: 'codex', label: 'B', model: 'gpt-5.4', loginMethod: 'codex-oauth' },
      },
      activeProfile: 'a',
    }
    fileReturns(config)

    await setActiveProfile('b')

    expect(mockWriteFile).toHaveBeenCalled()
    const written = JSON.parse((mockWriteFile.mock.calls[0][1] as string))
    expect(written.activeProfile).toBe('b')
    expect(written.profiles.a).toBeDefined() // preserved
  })

  it('throws on unknown profile slug', async () => {
    fileReturns({ apiKeys: {}, profiles: { a: { backend: 'agent-sdk', label: 'A', model: 'x' } }, activeProfile: 'a' })
    await expect(setActiveProfile('nonexistent')).rejects.toThrow('Unknown profile')
  })
})

// ==================== readToolsConfig ====================

describe('readToolsConfig', () => {
  it('returns empty disabled list when file is missing', async () => {
    fileNotFound()
    const cfg = await readToolsConfig()
    expect(cfg.disabled).toEqual([])
  })

  it('returns disabled tools from file', async () => {
    fileReturns({ disabled: ['web_search', 'read_file'] })
    const cfg = await readToolsConfig()
    expect(cfg.disabled).toEqual(['web_search', 'read_file'])
  })

  it('returns defaults on read error', async () => {
    fileReadError()
    const cfg = await readToolsConfig()
    expect(cfg.disabled).toEqual([])
  })
})

// ==================== readAgentConfig ====================

describe('readAgentConfig', () => {
  it('returns defaults when file is missing', async () => {
    fileNotFound()
    const cfg = await readAgentConfig()
    expect(cfg.maxSteps).toBe(20)
    expect(cfg.evolutionMode).toBe(false)
  })

  it('parses maxSteps from file', async () => {
    fileReturns({ maxSteps: 50 })
    const cfg = await readAgentConfig()
    expect(cfg.maxSteps).toBe(50)
  })
})

// ==================== readOpenbbConfig ====================

describe('readMarketDataConfig', () => {
  it('returns defaults when file is missing', async () => {
    fileNotFound()
    const cfg = await readMarketDataConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.backend).toBe('typebb-sdk')
  })

  it('parses enabled flag from file', async () => {
    fileReturns({ enabled: false })
    const cfg = await readMarketDataConfig()
    expect(cfg.enabled).toBe(false)
  })
})

// ==================== writeConfigSection ====================

describe('writeConfigSection', () => {
  it('validates and writes a section to the correct file', async () => {
    const result = await writeConfigSection('tools', { disabled: ['foo'] })

    expect(mockWriteFile).toHaveBeenCalledOnce()
    const filePath = mockWriteFile.mock.calls[0][0] as string
    expect(filePath).toMatch(/tools\.json$/)

    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(written.disabled).toEqual(['foo'])
    expect(result).toMatchObject({ disabled: ['foo'] })
  })

  it('applies schema defaults when partial data is provided', async () => {
    const result = await writeConfigSection('tools', {}) as { disabled: string[] }
    expect(result.disabled).toEqual([])
  })

  it('throws ZodError for invalid data (does not write file)', async () => {
    await expect(
      writeConfigSection('aiProvider', { profiles: { bad: { backend: 'invalid-backend', label: 'X' } } })
    ).rejects.toThrow()
    // writeFile should not have been called
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('writes connectors section to connectors.json', async () => {
    await writeConfigSection('connectors', { web: { port: 3005 } })
    const filePath = mockWriteFile.mock.calls[0][0] as string
    expect(filePath).toMatch(/connectors\.json$/)
  })
})

// ==================== readAccountsConfig / writeAccountsConfig ====================

describe('readAccountsConfig', () => {
  it('returns empty array and seeds file when missing', async () => {
    const enoent = new Error('ENOENT') as NodeJS.ErrnoException
    enoent.code = 'ENOENT'
    mockReadFile.mockRejectedValueOnce(enoent)
    const accounts = await readAccountsConfig()
    expect(accounts).toEqual([])
    // Should seed empty accounts.json
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
  })

  it('parses ccxt account from file', async () => {
    fileReturns([{ id: 'bybit-main', type: 'ccxt', exchange: 'bybit', apiKey: 'key1', apiSecret: 'sec1' }])
    const accounts = await readAccountsConfig()
    expect(accounts).toHaveLength(1)
    expect(accounts[0].id).toBe('bybit-main')
    expect(accounts[0].type).toBe('ccxt')
  })

  it('parses alpaca account from file', async () => {
    fileReturns([{ id: 'alpaca-paper', type: 'alpaca', paper: true, apiKey: 'k', apiSecret: 's' }])
    const accounts = await readAccountsConfig()
    expect(accounts).toHaveLength(1)
    expect(accounts[0].type).toBe('alpaca')
  })
})

describe('writeAccountsConfig', () => {
  it('writes validated accounts to accounts.json', async () => {
    await writeAccountsConfig([{ id: 'acc-1', type: 'alpaca', enabled: true, guards: [], brokerConfig: { paper: true } }])
    const filePath = mockWriteFile.mock.calls[0][0] as string
    expect(filePath).toMatch(/accounts\.json$/)
  })

  it('throws ZodError for missing required fields', async () => {
    await expect(
      writeAccountsConfig([{ type: 'alpaca' } as any])
    ).rejects.toThrow()
    expect(mockWriteFile).not.toHaveBeenCalled()
  })
})

// ==================== aiProviderSchema (Zod schema validation) ====================

describe('aiProviderSchema (profile-based)', () => {
  it('uses defaults for empty object', () => {
    const result = aiProviderSchema.parse({})
    expect(result.activeProfile).toBe('default')
    expect(result.profiles.default).toBeDefined()
    expect(result.apiKeys).toEqual({})
  })

  it('accepts valid profile-based config', () => {
    expect(() => aiProviderSchema.parse({
      profiles: { test: { backend: 'codex', label: 'Test', model: 'gpt-5.4', loginMethod: 'codex-oauth' } },
      activeProfile: 'test',
    })).not.toThrow()
  })

  it('preserves ollama api keys for migration compatibility', () => {
    const result = aiProviderSchema.parse({
      apiKeys: { ollama: 'proxy-key' },
    })

    expect(result.apiKeys.ollama).toBe('proxy-key')
  })
})

describe('loadConfig', () => {
  it('preserves unrelated global api keys when migrating an ollama profile', async () => {
    mockReadFile.mockImplementation(async (filePath) => {
      const path = String(filePath)
      if (path.endsWith('ai-provider-manager.json')) {
        return JSON.stringify({
          apiKeys: { ollama: 'proxy-key', openai: 'sk-openai' },
          profiles: {
            local: {
              backend: 'vercel-ai-sdk',
              label: 'Local Ollama',
              provider: 'ollama',
              model: 'llama3.2',
            },
          },
          activeProfile: 'local',
        }) as any
      }

      const err = new Error('ENOENT: no such file') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    })

    const config = await loadConfig()
    const profile = config.aiProvider.profiles.local
    expect(config.aiProvider.apiKeys.openai).toBe('sk-openai')

    expect(profile.backend).toBe('vercel-ai-sdk')
    if (profile.backend === 'vercel-ai-sdk') {
      expect(profile.provider).toBe('ollama')
      expect(profile.apiKey).toBe('proxy-key')
    }

    const aiProviderWrite = mockWriteFile.mock.calls.find(([filePath]) => String(filePath).endsWith('ai-provider-manager.json'))
    expect(aiProviderWrite).toBeDefined()

    const written = JSON.parse(aiProviderWrite![1] as string)
    expect(written.apiKeys).toEqual({ openai: 'sk-openai' })
    expect(written.profiles.local.apiKey).toBe('proxy-key')
  })

  it('removes migrated api keys when no global credentials remain', async () => {
    mockReadFile.mockImplementation(async (filePath) => {
      const path = String(filePath)
      if (path.endsWith('ai-provider-manager.json')) {
        return JSON.stringify({
          apiKeys: { ollama: 'proxy-key' },
          profiles: {
            local: {
              backend: 'vercel-ai-sdk',
              label: 'Local Ollama',
              provider: 'ollama',
              model: 'llama3.2',
            },
          },
          activeProfile: 'local',
        }) as any
      }

      const err = new Error('ENOENT: no such file') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    })

    const config = await loadConfig()
    const profile = config.aiProvider.profiles.local

    expect(profile.backend).toBe('vercel-ai-sdk')
    if (profile.backend === 'vercel-ai-sdk') {
      expect(profile.provider).toBe('ollama')
      expect(profile.apiKey).toBe('proxy-key')
    }

    const aiProviderWrite = mockWriteFile.mock.calls.find(([filePath]) => String(filePath).endsWith('ai-provider-manager.json'))
    expect(aiProviderWrite).toBeDefined()

    const written = JSON.parse(aiProviderWrite![1] as string)
    expect(written.apiKeys).toBeUndefined()
    expect(written.profiles.local.apiKey).toBe('proxy-key')
  })
})

describe('profileSchema', () => {
  it('validates agent-sdk profile', () => {
    const result = profileSchema.parse({ backend: 'agent-sdk', label: 'Claude', model: 'claude-opus-4-6', loginMethod: 'claudeai' })
    expect(result.backend).toBe('agent-sdk')
  })

  it('validates codex profile', () => {
    const result = profileSchema.parse({ backend: 'codex', label: 'GPT', model: 'gpt-5.4' })
    expect(result.backend).toBe('codex')
    if (result.backend === 'codex') expect(result.loginMethod).toBe('codex-oauth') // default
  })

  it('validates vercel profile', () => {
    const result = profileSchema.parse({ backend: 'vercel-ai-sdk', label: 'Gemini', provider: 'google', model: 'gemini-2.5-flash' })
    expect(result.backend).toBe('vercel-ai-sdk')
  })

  it('validates vercel ollama profile', () => {
    const result = profileSchema.parse({
      backend: 'vercel-ai-sdk',
      label: 'Ollama',
      provider: 'ollama',
      model: 'llama3.2',
      baseUrl: 'http://localhost:11434',
    })

    expect(result.backend).toBe('vercel-ai-sdk')
    if (result.backend === 'vercel-ai-sdk') {
      expect(result.provider).toBe('ollama')
      expect(result.baseUrl).toBe('http://localhost:11434')
    }
  })

  it('rejects unknown backend', () => {
    expect(() => profileSchema.parse({ backend: 'unknown', label: 'X', model: 'y' })).toThrow()
  })
})

// ==================== OLLAMA_BASE_URL env override ====================

describe('OLLAMA_BASE_URL env override', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('readAIProviderConfig injects ollama profile when OLLAMA_BASE_URL is set', async () => {
    process.env.OLLAMA_BASE_URL = 'http://ollama.railway.internal:11434'
    fileReturns({
      profiles: { default: { backend: 'agent-sdk', model: 'claude-sonnet-4-6', loginMethod: 'claudeai' } },
      activeProfile: 'default',
    })
    const cfg = await readAIProviderConfig()
    expect(cfg.activeProfile).toBe('ollama')
    expect(cfg.profiles.ollama).toBeDefined()
    expect(cfg.profiles.ollama.backend).toBe('vercel-ai-sdk')
    if (cfg.profiles.ollama.backend === 'vercel-ai-sdk') {
      expect(cfg.profiles.ollama.provider).toBe('ollama')
      expect(cfg.profiles.ollama.baseUrl).toBe('http://ollama.railway.internal:11434')
      expect(cfg.profiles.ollama.model).toBe('llama3.2')
    }
  })

  it('uses OLLAMA_MODEL when provided', async () => {
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434'
    process.env.OLLAMA_MODEL = 'mistral'
    fileReturns({
      profiles: { default: { backend: 'agent-sdk', model: 'claude-sonnet-4-6', loginMethod: 'claudeai' } },
      activeProfile: 'default',
    })
    const cfg = await readAIProviderConfig()
    expect(cfg.profiles.ollama.model).toBe('mistral')
  })

  it('preserves existing profiles when injecting ollama', async () => {
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434'
    fileReturns({
      profiles: {
        default: { backend: 'agent-sdk', model: 'claude-sonnet-4-6', loginMethod: 'claudeai' },
        gpt: { backend: 'codex', model: 'gpt-5.4', loginMethod: 'codex-oauth' },
      },
      activeProfile: 'default',
    })
    const cfg = await readAIProviderConfig()
    expect(cfg.profiles.default).toBeDefined()
    expect(cfg.profiles.gpt).toBeDefined()
    expect(cfg.profiles.ollama).toBeDefined()
    expect(cfg.activeProfile).toBe('ollama')
  })

  it('does not inject ollama profile when OLLAMA_BASE_URL is not set', async () => {
    delete process.env.OLLAMA_BASE_URL
    fileReturns({
      profiles: { default: { backend: 'agent-sdk', model: 'claude-sonnet-4-6', loginMethod: 'claudeai' } },
      activeProfile: 'default',
    })
    const cfg = await readAIProviderConfig()
    expect(cfg.activeProfile).toBe('default')
    expect(cfg.profiles.ollama).toBeUndefined()
  })

  it('loadConfig() with OLLAMA_BASE_URL produces an active ollama profile', async () => {
    process.env.OLLAMA_BASE_URL = 'http://ollama.railway.internal:11434'
    // loadConfig reads 12 config files — return ENOENT for all
    mockReadFile.mockImplementation(async () => {
      const err = new Error('ENOENT: no such file') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    })
    const config = await loadConfig()
    expect(config.aiProvider.activeProfile).toBe('ollama')
    expect(config.aiProvider.profiles.ollama).toBeDefined()
    expect(config.aiProvider.profiles.ollama.backend).toBe('vercel-ai-sdk')
    if (config.aiProvider.profiles.ollama.backend === 'vercel-ai-sdk') {
      expect(config.aiProvider.profiles.ollama.provider).toBe('ollama')
      expect(config.aiProvider.profiles.ollama.baseUrl).toBe('http://ollama.railway.internal:11434')
    }
  })
})
