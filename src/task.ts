/**
 * `defineAiTask` — structured output without the package knowing your domain.
 *
 * The app supplies the prompt and a schema; the kit owns the mechanics that
 * were previously hand-rolled per feature in travel-copilot's `ai.ts`: JSON
 * mode, tolerant parsing of models that wrap or truncate their JSON, schema
 * validation, one repair-retry that shows the model its own error, and
 * capability-based model selection.
 *
 * The package never imports domain types — a task is parameterised by the
 * app's own schema, so `classifyDocument(input)` comes back typed as the
 * app's `DocumentClassification` with no `any` in between.
 */

import type { AiClient, ChatMessage, ChatOptions } from './client'
import type { ModelRequirements } from './catalog'

/**
 * Minimal structural type for a validator.
 *
 * Deliberately not `import type { ZodType } from 'zod'` — zod stays an
 * optional peer dependency, and anything with this shape works, including a
 * hand-written validator.
 */
export interface Validator<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown }
}

export type AiTaskDefinition<TInput, TOutput> = {
  /** Used in errors and usage attribution. */
  name: string
  /** Capability requirements — not a model id. */
  model?: ModelRequirements & { preferred?: string; provider?: string }
  system?: string
  /** Build the request messages from the task's typed input. */
  buildMessages: (input: TInput) => ChatMessage[]
  schema: Validator<TOutput>
  temperature?: number
  maxTokens?: number
  /**
   * Request native JSON mode. Defaults to true. Set false for models that
   * reject `response_format`; parsing and repair still apply.
   */
  json?: boolean
  /** Attempt one corrective re-prompt on validation failure. Default true. */
  repair?: boolean
}

export type AiTask<TInput, TOutput> = {
  readonly name: string
  run(
    client: AiClient,
    input: TInput,
    options?: Pick<ChatOptions, 'signal' | 'model' | 'provider'>,
  ): Promise<TOutput>
}

export class AiTaskError extends Error {
  readonly task: string
  readonly raw: string | undefined

  constructor(task: string, message: string, raw?: string) {
    super(`AI task "${task}" failed: ${message}`)
    this.name = 'AiTaskError'
    this.task = task
    this.raw = raw
  }
}

export function defineAiTask<TInput, TOutput>(
  definition: AiTaskDefinition<TInput, TOutput>,
): AiTask<TInput, TOutput> {
  const useJson = definition.json ?? true
  const allowRepair = definition.repair ?? true

  return {
    name: definition.name,

    async run(client, input, options) {
      const messages: ChatMessage[] = []
      if (definition.system) {
        messages.push({ role: 'system', content: definition.system })
      }
      messages.push(...definition.buildMessages(input))

      const requirements: ModelRequirements = {}
      if (definition.model?.vision) requirements.vision = true
      if (definition.model?.jsonMode) requirements.jsonMode = true
      if (definition.model?.providers) {
        requirements.providers = definition.model.providers
      }

      const chatOptions: ChatOptions = {
        json: useJson,
        requirements,
        ...(definition.temperature !== undefined
          ? { temperature: definition.temperature }
          : {}),
        ...(definition.maxTokens !== undefined
          ? { maxTokens: definition.maxTokens }
          : {}),
        ...(options?.model ?? definition.model?.preferred
          ? { model: options?.model ?? definition.model?.preferred }
          : {}),
        ...(options?.provider ?? definition.model?.provider
          ? { provider: options?.provider ?? definition.model?.provider }
          : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      }

      const first = await client.chat(messages, chatOptions)
      const attempt = validate(definition, first.text)
      if (attempt.ok) return attempt.value

      if (!allowRepair) {
        throw new AiTaskError(definition.name, attempt.reason, first.text)
      }

      // ── Repair: show the model its own output and the validation error. ──
      const repairMessages: ChatMessage[] = [
        ...messages,
        { role: 'assistant', content: first.text },
        {
          role: 'user',
          content:
            `That response was not valid for this task: ${attempt.reason}\n\n` +
            `Reply with corrected JSON only — no explanation, no markdown fence.`,
        },
      ]

      const second = await client.chat(repairMessages, chatOptions)
      const retry = validate(definition, second.text)
      if (retry.ok) return retry.value

      throw new AiTaskError(
        definition.name,
        `validation failed after repair attempt: ${retry.reason}`,
        second.text,
      )
    },
  }
}

type ValidateResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string }

function validate<TInput, TOutput>(
  definition: AiTaskDefinition<TInput, TOutput>,
  text: string,
): ValidateResult<TOutput> {
  let parsed: unknown
  try {
    parsed = parseJson(text)
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'could not parse JSON',
    }
  }

  const result = definition.schema.safeParse(parsed)
  if (result.success) return { ok: true, value: result.data }
  return { ok: false, reason: describeValidationError(result.error) }
}

function describeValidationError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const issues = (error as { issues?: unknown }).issues
    if (Array.isArray(issues)) {
      return issues
        .map((issue: unknown) => {
          const i = issue as { path?: unknown; message?: unknown }
          const path = Array.isArray(i.path) ? i.path.join('.') : ''
          const message = typeof i.message === 'string' ? i.message : 'invalid'
          return path ? `${path}: ${message}` : message
        })
        .join('; ')
    }
    if (error instanceof Error) return error.message
  }
  return 'schema validation failed'
}

/**
 * Parse JSON from a model response.
 *
 * Ported from travel-copilot's `parseJsonResponse` / `repairTruncatedJson`,
 * which exist because real models wrap JSON in prose or markdown fences and
 * truncate it at the token limit. Tries strict parse, then extraction, then
 * bracket-closing repair.
 */
export function parseJson(content: string): unknown {
  const trimmed = stripFence(content.trim())

  try {
    return JSON.parse(trimmed)
  } catch {
    /* fall through */
  }

  // Reasoning models (DeepSeek R1) emit a <think> block before the JSON even
  // with JSON mode requested, and that block can itself contain braces. A
  // greedy first-brace-to-last-brace match spans both and parses as neither,
  // so scan for genuinely balanced candidates instead.
  for (const candidate of balancedCandidates(trimmed)) {
    try {
      return JSON.parse(candidate)
    } catch {
      /* try the next candidate */
    }
  }

  const repaired = repairTruncatedJson(trimmed)
  if (repaired !== null) return repaired

  throw new Error('response was not valid JSON')
}

/**
 * Every balanced `{…}` / `[…]` substring, longest first.
 *
 * String contents and escapes are respected so a brace inside a JSON string
 * doesn't throw the depth count off. Longest-first means the real payload wins
 * over a small object nested inside a preamble.
 */
function balancedCandidates(raw: string): string[] {
  const candidates: string[] = []

  for (let i = 0; i < raw.length; i++) {
    const open = raw[i]
    if (open !== '{' && open !== '[') continue

    let depth = 0
    let inString = false
    let escaped = false

    for (let j = i; j < raw.length; j++) {
      const ch = raw[j]!

      if (escaped) {
        escaped = false
        continue
      }
      if (inString) {
        if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') {
        depth--
        if (depth === 0) {
          candidates.push(raw.slice(i, j + 1))
          break
        }
      }
    }
  }

  return candidates.sort((a, b) => b.length - a.length)
}

/** Strip a ```json … ``` fence, which JSON mode does not prevent. */
function stripFence(raw: string): string {
  const fence = raw.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/)
  return fence?.[1] ?? raw
}

/**
 * Close the open brackets of a JSON string truncated mid-value.
 * Returns null when the result still doesn't parse.
 */
export function repairTruncatedJson(raw: string): unknown | null {
  const start = raw.search(/[[{]/)
  if (start === -1) return null
  let json = raw.slice(start)

  // Drop a trailing incomplete key/value or object.
  json = json.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"{}[\]]*$/, '')
  json = json.replace(/,\s*\{[^}]*$/, '')

  const closers: string[] = []
  for (const ch of json) {
    if (ch === '{' || ch === '[') closers.push(ch === '{' ? '}' : ']')
    else if (ch === '}' || ch === ']') closers.pop()
  }
  json += closers.reverse().join('')

  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}
