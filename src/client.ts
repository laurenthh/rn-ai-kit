/**
 * The chat client.
 *
 * Ported from travel-copilot's `callOpenAI`, generalised from one hardcoded
 * endpoint to a provider registry. Behaviour preserved from the original:
 * refuse to call while rate-limited, translate 429 + `retry-after` into a
 * parked deadline, count successful requests, and surface a readable error
 * when credentials are absent.
 *
 * Added: provider dispatch, per-provider credential resolution, and token
 * accounting for providers that bill per token.
 */

import {
  buildAuthHeaders,
  createCredentialStore,
  MissingCredentialsError,
  type CredentialStore,
  type EnvSource,
} from './credentials'
import {
  builtInCatalog,
  findModel,
  resolveModel,
  parseDiscoveredModels,
  type ModelInfo,
  type ModelRequirements,
} from './catalog'
import {
  builtInProviders,
  findProvider,
  type Provider,
} from './providers'
import {
  createUsageTracker,
  readTokenUsage,
  type UsageSummary,
  type UsageTracker,
} from './usage'
import type { StorageBundle } from './storage'
import {
  AiTimeoutError,
  NoSuitableModelError,
  ProviderApiError,
  RateLimitedError,
} from './errors'
import {
  defaultRetryPolicy,
  timeoutSignal,
  withRetry,
  DEFAULT_TIMEOUT_MS,
  type RetryPolicy,
} from './retry'

export {
  AiTimeoutError,
  NoSuitableModelError,
  ProviderApiError,
  RateLimitedError,
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }

export type ChatOptions = {
  /** Model id. Defaults to the stored selection, then the catalog default. */
  model?: string
  /** Disambiguates when two providers serve the same model id. */
  provider?: string
  temperature?: number
  maxTokens?: number
  /** Ask for native JSON mode. */
  json?: boolean
  /** Capability requirements; may override `model` when it can't comply. */
  requirements?: ModelRequirements
  signal?: AbortSignal
  /** Per-request timeout. Overrides the client default. */
  timeoutMs?: number
  /** Retry policy for this request. Overrides the client default. */
  retry?: RetryPolicy
}

export type ChatResult = {
  text: string
  model: ModelInfo
  provider: Provider
  /** Undefined when the provider doesn't report token counts. */
  tokens?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

export type AiClient = {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>
  /** Which model would run with these options, without calling anything. */
  selectModel(options?: ChatOptions): Promise<ModelInfo>
  /** Providers the user has complete credentials for. */
  configuredProviders(): Promise<Provider[]>
  /** Catalog filtered to providers that are actually usable. */
  availableModels(requirements?: ModelRequirements): Promise<ModelInfo[]>
  /** Persist the user's model choice. */
  setSelectedModel(modelId: string, providerId?: string): Promise<void>
  getSelectedModel(): Promise<{ modelId: string; providerId?: string } | null>
  /** Billing-aware usage for a model. */
  usageFor(modelId: string, providerId?: string): Promise<UsageSummary>
  /** Live `GET /models` for a provider, merged shape not applied. */
  discoverModels(providerId: string): Promise<ModelInfo[]>
  readonly providers: Provider[]
  readonly catalog: ModelInfo[]
  readonly credentials: CredentialStore
  readonly usage: UsageTracker
}

const SELECTED_MODEL_KEY = 'rn-ai-kit.selected-model'

export type CreateAiClientOptions = {
  storage: StorageBundle
  /** Defaults to the four bundled providers. */
  providers?: Provider[]
  /** Defaults to the bundled catalog. */
  catalog?: ModelInfo[]
  /** Environment fallbacks for credentials (Expo `extra`, `.env`, …). */
  env?: EnvSource
  /** Model used when nothing is stored. Defaults to the first catalog entry. */
  defaultModel?: { modelId: string; providerId?: string }
  /** Default per-request timeout. Defaults to 20s. */
  timeoutMs?: number
  /** Default retry policy. Defaults to one retry with a 500ms base delay. */
  retry?: RetryPolicy
  /** Injected for tests. */
  fetchImpl?: typeof fetch
  now?: () => Date
}

export function createAiClient(opts: CreateAiClientOptions): AiClient {
  const providers = opts.providers ?? builtInProviders
  const catalog = opts.catalog ?? builtInCatalog
  const credentials = createCredentialStore({
    secrets: opts.storage.secrets,
    env: opts.env,
  })
  const usage = createUsageTracker({ data: opts.storage.data, now: opts.now })
  /**
   * Resolve `fetch` per call, not once at construction.
   *
   * Capturing `globalThis.fetch` up front breaks two real cases: a host whose
   * fetch polyfill installs after this module is first imported, and any test
   * that stubs `global.fetch` after building a client. An explicit `fetchImpl`
   * still wins and is still captured, since that one is the caller's choice.
   */
  const doFetch: typeof fetch = (...args) =>
    (opts.fetchImpl ?? globalThis.fetch)(...args)

  function requireProvider(id: string): Provider {
    const provider = findProvider(providers, id)
    if (!provider) throw new Error(`Unknown provider: ${id}`)
    return provider
  }

  async function configuredProviderIds(): Promise<string[]> {
    const ids: string[] = []
    for (const provider of providers) {
      if (await credentials.isConfigured(provider)) ids.push(provider.id)
    }
    return ids
  }

  async function getSelectedModel(): Promise<{
    modelId: string
    providerId?: string
  } | null> {
    const raw = await opts.storage.data.get(SELECTED_MODEL_KEY).catch(() => null)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as {
        modelId?: unknown
        providerId?: unknown
      }
      if (typeof parsed.modelId !== 'string') return null
      return {
        modelId: parsed.modelId,
        ...(typeof parsed.providerId === 'string'
          ? { providerId: parsed.providerId }
          : {}),
      }
    } catch {
      return null
    }
  }

  async function selectModel(options?: ChatOptions): Promise<ModelInfo> {
    const stored = await getSelectedModel()
    const fallback = opts.defaultModel
    const selected =
      options?.model ?? stored?.modelId ?? fallback?.modelId ?? catalog[0]?.id
    const selectedProvider =
      options?.provider ?? stored?.providerId ?? fallback?.providerId

    const requirements: ModelRequirements = {
      ...(options?.requirements ?? {}),
      ...(options?.json ? { jsonMode: true } : {}),
    }

    const available = await configuredProviderIds()
    const model = resolveModel({
      catalog,
      ...(selected ? { selected } : {}),
      ...(selectedProvider ? { selectedProvider } : {}),
      requirements,
      available,
    })

    if (!model) {
      // Distinguish "nothing is configured" from "nothing can do this".
      if (available.length === 0) {
        const first = providers[0]
        if (first) {
          throw new MissingCredentialsError(
            first,
            await credentials.missingFields(first),
          )
        }
      }
      throw new NoSuitableModelError(requirements)
    }
    return model
  }

  async function chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ChatResult> {
    const model = await selectModel(options)
    const provider = requireProvider(model.provider)

    // ── Guard: parked by an earlier 429? ──
    const parked = await usage.rateLimitRemaining(provider.id, model.id)
    if (parked > 0) {
      throw new RateLimitedError(provider.id, model.id, parked)
    }

    const resolved = await credentials.resolve(provider)
    if (resolved.missing.length > 0) {
      throw new MissingCredentialsError(provider, resolved.missing)
    }

    const payload: Record<string, unknown> = {
      model: model.id,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 500,
    }
    if (options?.json) {
      payload.response_format = { type: 'json_object' }
    }

    const timeoutMs = options?.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const retry = options?.retry ?? opts.retry ?? defaultRetryPolicy

    // One attempt. `withRetry` re-runs this whole body, including a fresh
    // timeout — a retry that inherited the first attempt's remaining time
    // would get progressively less of a chance to succeed.
    const attempt = async (): Promise<ChatResult> => {
      const timer = timeoutSignal(timeoutMs, options?.signal)
      try {
        const response = await doFetch(
          `${provider.baseUrl}${provider.chatPath}`,
          {
            method: 'POST',
            headers: buildAuthHeaders(provider, resolved.values),
            body: JSON.stringify(payload),
            signal: timer.signal,
          },
        )

        if (response.status === 429) {
          const header = response.headers?.get?.('retry-after')
          const parsed = header ? parseInt(header, 10) : NaN
          const seconds = Number.isNaN(parsed) ? 60 : parsed
          await usage.markRateLimited(provider.id, model.id, seconds)
          throw new RateLimitedError(provider.id, model.id, seconds)
        }

        if (!response.ok) {
          const body = await response.text().catch(() => '')
          throw new ProviderApiError(provider, response.status, body)
        }

        const data: unknown = await response.json()
        const tokens = readTokenUsage(data)
        await usage.record(provider.id, model.id, tokens)

        const text = extractText(data)
        if (text === null) {
          throw new ProviderApiError(
            provider,
            response.status,
            'Response contained no assistant message',
          )
        }

        return {
          text,
          model,
          provider,
          ...(tokens ? { tokens } : {}),
        }
      } catch (error) {
        // Distinguish our own timeout from the caller cancelling: a timeout is
        // transient and retryable, a user cancellation is neither.
        if (timer.timedOut()) throw new AiTimeoutError(timeoutMs)
        throw error
      } finally {
        timer.dispose()
      }
    }

    return withRetry(attempt, retry, options?.signal)
  }

  return {
    chat,
    selectModel,
    providers,
    catalog,
    credentials,
    usage,
    getSelectedModel,

    async configuredProviders() {
      const ids = await configuredProviderIds()
      return providers.filter((p) => ids.includes(p.id))
    },

    async availableModels(requirements) {
      const available = await configuredProviderIds()
      return catalog.filter((m) => {
        if (!available.includes(m.provider)) return false
        if (requirements?.vision && !m.vision) return false
        if (requirements?.jsonMode && m.supportsJsonMode === false) return false
        return true
      })
    },

    async setSelectedModel(modelId, providerId) {
      await opts.storage.data.set(
        SELECTED_MODEL_KEY,
        JSON.stringify({
          modelId,
          ...(providerId ? { providerId } : {}),
        }),
      )
    },

    async usageFor(modelId, providerId) {
      const model = findModel(catalog, modelId, providerId)
      const provider = requireProvider(providerId ?? model?.provider ?? '')
      return usage.summarize(provider, modelId, {
        ...(model?.dailyLimit !== undefined
          ? { dailyLimit: model.dailyLimit }
          : {}),
        ...(model?.pricing ? { pricing: model.pricing } : {}),
      })
    },

    async discoverModels(providerId) {
      const provider = requireProvider(providerId)
      if (!provider.modelsPath) return []
      const resolved = await credentials.resolve(provider)
      const response = await doFetch(
        `${provider.baseUrl}${provider.modelsPath}`,
        { headers: buildAuthHeaders(provider, resolved.values) },
      )
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new ProviderApiError(provider, response.status, body)
      }
      return parseDiscoveredModels(provider.id, await response.json())
    },
  }
}

/** Pull the assistant text out of an OpenAI-shaped completion response. */
function extractText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const message = (choices[0] as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return null
  const content = (message as { content?: unknown }).content
  // Responses are plain text; the array form of `content` exists only for
  // outgoing vision requests.
  return typeof content === 'string' ? content : null
}
