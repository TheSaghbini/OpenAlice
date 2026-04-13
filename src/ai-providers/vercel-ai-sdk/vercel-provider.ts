/**
 * VercelAIProvider — GenerateProvider backed by Vercel AI SDK's generateText.
 *
 * The model is lazily created from the resolved profile on each call.
 * Instructions (persona + brain state) are also re-read per request.
 */

import type { ModelMessage, Tool } from 'ai'
import type { ProviderResult, ProviderEvent, AIProvider, GenerateOpts } from '../types.js'
import type { SessionEntry } from '../../core/session.js'
import type { MediaAttachment } from '../../core/types.js'
import type { ResolvedProfile } from '../../core/config.js'
import { resolveProfile } from '../../core/config.js'
import { toModelMessages } from '../../core/session.js'
import { extractMediaFromToolOutput } from '../../core/media.js'
import { createModelFromProfile } from './model-factory.js'
import { generateText, stepCountIs } from './agent.js'
import { createChannel } from '../../core/async-channel.js'

/**
 * Wrap every tool's execute so its return value is JSON-round-tripped.
 * This converts class instances (Decimal, etc.) to plain JSON-safe objects,
 * preventing DataCloneError from structuredClone in Vercel AI SDK v6.
 */
function sanitizeToolResults(tools: Record<string, Tool>): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {}
  for (const [name, t] of Object.entries(tools)) {
    if (!t.execute) {
      wrapped[name] = t
      continue
    }
    const originalExecute = t.execute
    wrapped[name] = {
      ...t,
      execute: async (...args: Parameters<NonNullable<Tool['execute']>>) => {
        const result = await originalExecute(...args)
        return JSON.parse(JSON.stringify(result))
      },
    }
  }
  return wrapped
}

export class VercelAIProvider implements AIProvider {
  readonly providerTag = 'vercel-ai' as const

  constructor(
    private getTools: () => Promise<Record<string, Tool>>,
    private getInstructions: () => Promise<string>,
    private maxSteps: number,
  ) {}

  /** Resolve model, tools, and instructions for a single request. */
  private async resolve(disabledTools?: string[], profile?: ResolvedProfile) {
    // If no profile provided (e.g. ask()), resolve the active one
    const effectiveProfile = profile ?? await resolveProfile()
    const [{ model }, allTools, instructions] = await Promise.all([
      createModelFromProfile(effectiveProfile),
      this.getTools(),
      this.getInstructions(),
    ])

    const filtered = disabledTools?.length
      ? Object.fromEntries(Object.entries(allTools).filter(([name]) => !new Set(disabledTools).has(name)))
      : allTools

    // @ai-warning Vercel AI SDK v6 calls structuredClone() on tool results.
    // Class instances (e.g. Decimal from decimal.js) cause DataCloneError.
    // JSON-round-trip strips methods/prototypes so results are plain objects.
    const tools = sanitizeToolResults(filtered)

    return { model, tools, instructions }
  }

  async ask(prompt: string, profile?: ResolvedProfile): Promise<ProviderResult> {
    const { model, tools, instructions } = await this.resolve(undefined, profile)
    const media: MediaAttachment[] = []

    const result = await generateText({
      model,
      tools,
      system: instructions,
      prompt,
      stopWhen: stepCountIs(this.maxSteps),
      onStepFinish: (step) => {
        for (const tr of step.toolResults) {
          media.push(...extractMediaFromToolOutput(tr.output))
        }
      },
    })

    return { text: result.text ?? '', media }
  }

  async *generate(entries: SessionEntry[], _prompt: string, opts?: GenerateOpts): AsyncGenerator<ProviderEvent> {
    const { model, tools, instructions } = await this.resolve(opts?.disabledTools, opts?.profile)
    const messages = toModelMessages(entries)

    const channel = createChannel<ProviderEvent>()
    const media: MediaAttachment[] = []

    const resultPromise = generateText({
      model,
      tools,
      system: opts?.systemPrompt ?? instructions,
      messages: messages as ModelMessage[],
      stopWhen: stepCountIs(this.maxSteps),
      onStepFinish: (step) => {
        for (const tc of step.toolCalls) {
          channel.push({ type: 'tool_use', id: tc.toolCallId, name: tc.toolName, input: tc.input })
        }
        for (const tr of step.toolResults) {
          media.push(...extractMediaFromToolOutput(tr.output))
          const content = typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output ?? '')
          channel.push({ type: 'tool_result', tool_use_id: tr.toolCallId, content })
        }
        if (step.text) {
          channel.push({ type: 'text', text: step.text })
        }
      },
    })

    resultPromise.then(() => channel.close()).catch((err) => channel.error(err instanceof Error ? err : new Error(String(err))))
    yield* channel

    const result = await resultPromise
    yield { type: 'done', result: { text: result.text ?? '', media } }
  }

}
