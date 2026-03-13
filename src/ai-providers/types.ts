import type { SessionStore, SDKModelMessage } from '../core/session.js'
import type { CompactionConfig, CompactionResult } from '../core/compaction.js'
import type { MediaAttachment } from '../core/types.js'

// ==================== Provider Events ====================

/** Streaming event emitted by AI providers during generation. */
export type ProviderEvent =
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'text'; text: string }
  | { type: 'done'; result: ProviderResult }

// ==================== Types ====================

export interface ProviderResult {
  text: string
  media: MediaAttachment[]
  mediaUrls?: string[]
}

// ==================== GenerateProvider ====================

/**
 * Input prepared by AgentCenter, dispatched by provider.inputKind.
 *
 * - 'text': Claude Code / Agent SDK — single string prompt with <chat_history> baked in.
 * - 'messages': Vercel AI SDK — structured ModelMessage[] (history carried natively).
 */
export type GenerateInput =
  | { kind: 'text'; prompt: string; systemPrompt?: string }
  | { kind: 'messages'; messages: SDKModelMessage[]; systemPrompt?: string }

/** Per-request options passed through to the underlying provider. */
export interface GenerateOpts {
  disabledTools?: string[]
  vercelAiSdk?: { provider: string; model: string; baseUrl?: string; apiKey?: string }
  agentSdk?: { model?: string; apiKey?: string; baseUrl?: string }
}

/**
 * Slim provider interface — pure data-source adapter.
 *
 * Does NOT touch session management. AgentCenter prepares the input,
 * the provider calls the backend and yields ProviderEvents.
 */
export interface GenerateProvider {
  /** Which input format this provider expects. */
  readonly inputKind: 'text' | 'messages'
  /** Session log provenance tag. */
  readonly providerTag: 'vercel-ai' | 'claude-code' | 'agent-sdk'
  /** Stateless one-shot prompt (used for compaction summarization, etc.). */
  ask(prompt: string): Promise<ProviderResult>
  /** Stream events from the backend. Yields tool_use/tool_result/text, then done. */
  generate(input: GenerateInput, opts?: GenerateOpts): AsyncIterable<ProviderEvent>
  /**
   * Optional: custom compaction strategy. If implemented, AgentCenter delegates
   * compaction to the provider instead of using the default compactIfNeeded.
   *
   * Use case: providers with native server-side compaction (e.g. Anthropic API
   * compact-2026-01-12) can bypass the local JSONL-based summarization.
   */
  compact?(session: SessionStore, config: CompactionConfig): Promise<CompactionResult>
}
