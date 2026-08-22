/**
 * Model catalog.
 *
 * Data, not code — apps extend it rather than fork the kit. Every entry names
 * the provider that serves it, because the same underlying model can be
 * reachable through several providers with different credentials, quotas and
 * prices (DeepSeek via GitHub Models vs. via DeepSeek's own API is exactly
 * this case, and they are two distinct entries here).
 *
 * Seeded ids were verified against each vendor's own API reference or live
 * models endpoint (gemini/openrouter on 2026-08-22; xai/deepseek/zai on
 * 2026-07-18). Ids churn; treat this as a starting point and use
 * `discoverModels()` for a live list.
 */

import type { ModelPricing } from './usage'

export type ModelInfo = {
  /** Provider-scoped model id, exactly as the API expects it. */
  id: string
  /** `Provider.id` that serves this model. */
  provider: string
  label: string
  /** Accepts image content parts. Required for document scanning. */
  vision: boolean
  /**
   * Daily request allowance, for `quota`-billed providers only. Meaningless
   * for pay-per-token providers and left undefined there.
   */
  dailyLimit?: number
  /**
   * Per-token pricing. Only set when verified against the vendor's price list
   * — an absent value means "unknown" and suppresses cost estimates rather
   * than showing a fabricated $0.00.
   */
  pricing?: ModelPricing
  /** Whether the model honours `response_format: { type: 'json_object' }`. */
  supportsJsonMode?: boolean
  contextNotes?: string
}

/**
 * Google Gemini entries (OpenAI-compatible endpoint). Ids verified against
 * Google's model documentation on 2026-08-22 (`gemini-3.7-flash` GA
 * 2026-08-13). No `dailyLimit` is seeded: free-tier caps vary by model,
 * region, and account, and AI Studio shows the live number — a wrong cap
 * displayed as fact is worse than none.
 */
export const geminiCatalog: ModelInfo[] = [
  {
    id: 'gemini-3.7-flash',
    provider: 'gemini',
    label: 'Gemini 3.7 Flash',
    vision: true,
    supportsJsonMode: true,
    contextNotes: 'Default. Free-tier eligible; image + PDF input.',
  },
]

/**
 * OpenRouter entries. Ids verified against the live public
 * `GET https://openrouter.ai/api/v1/models` on 2026-08-22 — but this seed is
 * a starting point only: the whole point of OpenRouter is its live catalog,
 * so hosts should prefer `discoverModels('openrouter')` (public, keyless).
 */
export const openrouterCatalog: ModelInfo[] = [
  {
    id: 'google/gemini-3.7-flash',
    provider: 'openrouter',
    label: 'Gemini 3.7 Flash (OpenRouter)',
    vision: true,
    supportsJsonMode: true,
  },
  {
    id: 'google/gemma-4-31b-it:free',
    provider: 'openrouter',
    label: 'Gemma 4 31B (free)',
    vision: true,
    contextNotes: 'Free variant — rate-limited, availability rotates.',
  },
]

/**
 * Models reachable only through their vendor's own API — the reason the
 * provider abstraction exists.
 *
 * No `pricing` is set: the kit does not ship price data it has not verified,
 * and vendor prices change without notice. Supply pricing per model from the
 * app if you want cost estimates.
 */
export const directProviderCatalog: ModelInfo[] = [
  {
    id: 'grok-4.5',
    provider: 'xai',
    label: 'Grok 4.5',
    vision: true,
    supportsJsonMode: true,
  },
  {
    id: 'grok-3',
    provider: 'xai',
    label: 'Grok 3',
    vision: true,
    supportsJsonMode: true,
  },
  {
    id: 'deepseek-v4-pro',
    provider: 'deepseek',
    label: 'DeepSeek V4 Pro',
    vision: false,
    supportsJsonMode: true,
  },
  {
    id: 'deepseek-v4-flash',
    provider: 'deepseek',
    label: 'DeepSeek V4 Flash',
    vision: false,
    supportsJsonMode: true,
  },
  {
    id: 'glm-4.6',
    provider: 'zai',
    label: 'GLM-4.6',
    vision: false,
    supportsJsonMode: true,
  },
]

export const builtInCatalog: ModelInfo[] = [
  ...geminiCatalog,
  ...openrouterCatalog,
  ...directProviderCatalog,
]

export type ModelRequirements = {
  /** Task needs image input. */
  vision?: boolean
  /** Task needs native JSON mode (rather than prompt-and-parse). */
  jsonMode?: boolean
  /** Restrict to specific providers. */
  providers?: string[]
}

export function findModel(
  catalog: ModelInfo[],
  modelId: string,
  providerId?: string,
): ModelInfo | undefined {
  return catalog.find(
    (m) =>
      m.id === modelId && (providerId === undefined || m.provider === providerId),
  )
}

export function satisfies(
  model: ModelInfo,
  requirements: ModelRequirements,
): boolean {
  if (requirements.vision && !model.vision) return false
  if (requirements.jsonMode && model.supportsJsonMode === false) return false
  if (
    requirements.providers &&
    !requirements.providers.includes(model.provider)
  ) {
    return false
  }
  return true
}

/**
 * Pick a model for a task.
 *
 * The user's selection wins when it can do the job. When it can't — the
 * common case being a text-only model selected while document scanning needs
 * vision — fall back to the first capable model *from the same provider*, so
 * the fallback doesn't silently need credentials the user hasn't entered.
 * Only then widen to other providers in `available`.
 *
 * Returns `undefined` when nothing satisfies the requirements; callers must
 * treat that as a real failure rather than defaulting.
 */
export function resolveModel(input: {
  catalog: ModelInfo[]
  /** The user's selected model id, if any. */
  selected?: string
  selectedProvider?: string
  requirements?: ModelRequirements
  /** Providers the user actually has credentials for. */
  available?: string[]
}): ModelInfo | undefined {
  const requirements = input.requirements ?? {}
  const usable = input.catalog.filter((m) => {
    if (!satisfies(m, requirements)) return false
    if (input.available && !input.available.includes(m.provider)) return false
    return true
  })

  if (input.selected) {
    const exact = usable.find(
      (m) =>
        m.id === input.selected &&
        (input.selectedProvider === undefined ||
          m.provider === input.selectedProvider),
    )
    if (exact) return exact

    // Selection is unusable — prefer staying on its provider.
    const selectedEntry = findModel(
      input.catalog,
      input.selected,
      input.selectedProvider,
    )
    if (selectedEntry) {
      const sameProvider = usable.find(
        (m) => m.provider === selectedEntry.provider,
      )
      if (sameProvider) return sameProvider
    }
  }

  return usable[0]
}

/** Shape of an OpenAI-style `GET /models` response entry. */
type DiscoveredModel = { id?: unknown; name?: unknown }

/**
 * Parse a `GET /models` response into catalog entries.
 *
 * Handles both the OpenAI envelope (`{ data: [...] }`) and the bare array
 * GitHub Models returns. Capability flags are only set when the payload
 * actually reports them — GitHub Models exposes
 * `supported_input_modalities`, most others expose nothing, and a discovered
 * entry with unknown vision support is marked `vision: false` so it is never
 * auto-selected for a vision task on a guess.
 */
export function parseDiscoveredModels(
  providerId: string,
  payload: unknown,
): ModelInfo[] {
  const list: unknown = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null
      ? (payload as { data?: unknown }).data
      : undefined
  if (!Array.isArray(list)) return []

  const models: ModelInfo[] = []
  for (const raw of list as DiscoveredModel[]) {
    if (typeof raw?.id !== 'string') continue
    const modalities = (raw as { supported_input_modalities?: unknown })
      .supported_input_modalities
    const vision = Array.isArray(modalities)
      ? modalities.includes('image')
      : false
    models.push({
      id: raw.id,
      provider: providerId,
      label: typeof raw.name === 'string' ? raw.name : raw.id,
      vision,
    })
  }
  return models
}

/**
 * Merge discovered entries over a base catalog, preserving hand-authored
 * metadata (limits, pricing, notes) for ids already known.
 */
export function mergeCatalog(
  base: ModelInfo[],
  discovered: ModelInfo[],
): ModelInfo[] {
  const merged = [...base]
  for (const model of discovered) {
    const index = merged.findIndex(
      (m) => m.id === model.id && m.provider === model.provider,
    )
    if (index === -1) {
      merged.push(model)
    } else {
      // Keep curated fields; discovery only fills gaps.
      merged[index] = { ...model, ...merged[index]! }
    }
  }
  return merged
}
