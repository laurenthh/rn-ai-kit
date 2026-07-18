/**
 * Model catalog.
 *
 * Data, not code — apps extend it rather than fork the kit. Every entry names
 * the provider that serves it, because the same underlying model can be
 * reachable through several providers with different credentials, quotas and
 * prices (DeepSeek via GitHub Models vs. via DeepSeek's own API is exactly
 * this case, and they are two distinct entries here).
 *
 * Seeded ids were verified on 2026-07-18 against
 * `GET https://models.github.ai/catalog/models` for the GitHub Models entries,
 * and each vendor's own API reference for the rest. Ids churn; treat this as a
 * starting point and use `discoverModels()` for a live list.
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
 * GitHub Models entries. Ids and vision capability read directly from the
 * live catalog's `supported_input_modalities` on 2026-07-18.
 *
 * `dailyLimit` values are carried over from travel-copilot's existing
 * `AI_MODELS` list (its low/high rate-limit tiers), not from the catalog
 * endpoint — the endpoint exposes a tier name, not a number.
 */
export const githubModelsCatalog: ModelInfo[] = [
  {
    id: 'openai/gpt-4.1-mini',
    provider: 'github-models',
    label: 'GPT-4.1 mini',
    vision: true,
    dailyLimit: 150,
    supportsJsonMode: true,
    contextNotes: 'Default. Fast, high daily allowance.',
  },
  {
    id: 'openai/gpt-4.1',
    provider: 'github-models',
    label: 'GPT-4.1',
    vision: true,
    dailyLimit: 50,
    supportsJsonMode: true,
    contextNotes: 'Higher quality, lower allowance.',
  },
  {
    id: 'openai/gpt-4o-mini',
    provider: 'github-models',
    label: 'GPT-4o mini',
    vision: true,
    dailyLimit: 150,
    supportsJsonMode: true,
  },
  {
    id: 'openai/gpt-4o',
    provider: 'github-models',
    label: 'GPT-4o',
    vision: true,
    dailyLimit: 50,
    supportsJsonMode: true,
  },
  {
    id: 'deepseek/deepseek-v3-0324',
    provider: 'github-models',
    label: 'DeepSeek V3',
    vision: false,
    dailyLimit: 50,
    contextNotes: 'Text only — cannot back document scanning.',
  },
  {
    id: 'deepseek/deepseek-r1',
    provider: 'github-models',
    label: 'DeepSeek R1',
    vision: false,
    contextNotes: 'Reasoning model, custom rate-limit tier. Text only.',
  },
  {
    id: 'meta/llama-4-scout-17b-16e-instruct',
    provider: 'github-models',
    label: 'Llama 4 Scout',
    vision: true,
    dailyLimit: 50,
  },
  {
    id: 'mistral-ai/mistral-medium-2505',
    provider: 'github-models',
    label: 'Mistral Medium',
    vision: true,
    dailyLimit: 150,
  },
]

/**
 * Models reachable only through their vendor's own API — these are absent
 * from the GitHub Models catalog entirely, which is the reason the provider
 * abstraction exists.
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
  ...githubModelsCatalog,
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
