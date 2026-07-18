/**
 * Rate limiting and usage accounting.
 *
 * Two separate concerns that share a storage namespace:
 *
 * 1. **Rate limiting** — a 429 with `retry-after` parks a given
 *    provider+model until a deadline. Ported from travel-copilot's per-model
 *    keying, widened to include the provider (the same model id can be served
 *    by two providers with independent limits).
 *
 * 2. **Usage accounting** — what "usage" *means* depends on how the provider
 *    bills. A daily request quota and a pay-per-token account cannot share one
 *    counter honestly: for the first, the number that matters is how much
 *    allowance is left; for the second, there is no allowance, and the number
 *    that matters is tokens consumed. `summarize()` returns a discriminated
 *    union so the host app renders whichever is actually true, instead of
 *    showing "142/150 requests" next to an account that has no request cap.
 */

import type { BillingModel, Provider } from './providers'
import type { KVStorage } from './storage'
import { tolerant } from './storage'

/** Tokens reported by a provider's `usage` block. */
export type TokenUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Raw counters persisted for one provider+model on one day. */
export type UsageRecord = {
  requests: number
  promptTokens: number
  completionTokens: number
}

const EMPTY_RECORD: UsageRecord = {
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
}

/**
 * What to show the user, shaped by the provider's billing model.
 *
 * `quota` carries a cap and a remainder; `metered` carries tokens and an
 * optional cost estimate and deliberately has no `limit` field — there is
 * nothing to run out of.
 */
export type UsageSummary =
  | {
      kind: 'quota'
      providerId: string
      modelId: string
      requests: number
      limit: number
      remaining: number
      /** Where the allowance comes from, for display. */
      source: string
      /** Tokens, when the provider reports them — informational only here. */
      tokens: TokenUsage
    }
  | {
      kind: 'metered'
      providerId: string
      modelId: string
      requests: number
      tokens: TokenUsage
      currency: 'USD'
      /**
       * Cost in the provider's currency, present only when the model carries
       * verified per-token pricing. Absent means "we don't know", never zero —
       * the kit does not guess prices.
       */
      estimatedCost?: number
      billingUrl?: string
    }
  | {
      kind: 'unmetered'
      providerId: string
      modelId: string
      requests: number
      tokens: TokenUsage
      plan?: string
      billingUrl?: string
    }

/** Per-million-token pricing, when known. */
export type ModelPricing = {
  inputPerMillion: number
  outputPerMillion: number
  currency: 'USD'
}

/**
 * One completed request, for apps that want richer accounting than the kit's
 * own day-bucketed counters.
 *
 * The counters exist to answer "how much of today's allowance is left", and
 * `KVStorage` is the right shape for that. They are the *wrong* shape for a
 * per-request history: gym-copilot keeps an append-only `AiUsageLog` table with
 * a `context` (which feature made the call) and `durationMs`, aggregated with
 * SQL. Expressing that through get/set/delete would mean rewriting a growing
 * JSON blob on every call and discarding both of those columns.
 *
 * So a sink is an **additive** hook rather than a replacement: the kit keeps
 * its counters, and an app that wants a real log gets every event too.
 */
export type UsageEvent = {
  providerId: string
  modelId: string
  /** Absent when the provider reports no token counts. */
  tokens?: TokenUsage
  /** Wall-clock duration of the request. */
  durationMs: number
  at: Date
  /**
   * Free-form app-defined tag — gym uses it for which feature made the call
   * ('program-generation', 'workout-generation', …). The kit never interprets
   * it, which is what keeps the app's vocabulary out of the package.
   */
  label?: string
}

/**
 * Optional destination for completed-request events.
 *
 * Failures here must never fail the request that produced them — the client
 * swallows them, since accounting is bookkeeping, not the product.
 */
export interface UsageSink {
  record(event: UsageEvent): Promise<void>
}

export type UsageTracker = {
  isRateLimited(providerId: string, modelId: string): Promise<boolean>
  /** Seconds until the model is usable again; 0 when not limited. */
  rateLimitRemaining(providerId: string, modelId: string): Promise<number>
  markRateLimited(
    providerId: string,
    modelId: string,
    retryAfterSeconds?: number,
  ): Promise<void>
  clearRateLimit(providerId: string, modelId: string): Promise<void>

  /** Record one successful call. Tokens are optional — not all providers report them. */
  record(
    providerId: string,
    modelId: string,
    tokens?: TokenUsage,
  ): Promise<UsageRecord>
  read(providerId: string, modelId: string): Promise<UsageRecord>
  reset(providerId: string, modelId: string): Promise<void>

  /** Billing-aware view of the raw counters, for display. */
  summarize(
    provider: Provider,
    modelId: string,
    opts?: { dailyLimit?: number; pricing?: ModelPricing },
  ): Promise<UsageSummary>
}

/** Storage keys are sanitised — model ids contain `/`. */
function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function dayStamp(now: Date): string {
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${yyyy}_${mm}_${dd}`
}

export function usageKey(
  providerId: string,
  modelId: string,
  now: Date,
): string {
  return `rn-ai-kit.usage.${dayStamp(now)}.${slug(providerId)}.${slug(modelId)}`
}

export function rateLimitKey(providerId: string, modelId: string): string {
  return `rn-ai-kit.ratelimit.${slug(providerId)}.${slug(modelId)}`
}

export function createUsageTracker(opts: {
  data: KVStorage
  /** Injected for deterministic tests. */
  now?: () => Date
}): UsageTracker {
  const store = tolerant(opts.data)
  const now = opts.now ?? (() => new Date())

  async function read(
    providerId: string,
    modelId: string,
  ): Promise<UsageRecord> {
    const raw = await store.get(usageKey(providerId, modelId, now()))
    if (!raw) return { ...EMPTY_RECORD }
    try {
      const parsed = JSON.parse(raw) as Partial<UsageRecord>
      return {
        requests: parsed.requests ?? 0,
        promptTokens: parsed.promptTokens ?? 0,
        completionTokens: parsed.completionTokens ?? 0,
      }
    } catch {
      return { ...EMPTY_RECORD }
    }
  }

  async function rateLimitRemaining(
    providerId: string,
    modelId: string,
  ): Promise<number> {
    const key = rateLimitKey(providerId, modelId)
    const raw = await store.get(key)
    if (!raw) return 0
    const until = parseInt(raw, 10)
    if (isNaN(until)) return 0
    const remaining = Math.max(0, Math.ceil((until - now().getTime()) / 1000))
    // Self-cleaning: an expired deadline is removed on read, as the original
    // implementation did.
    if (remaining === 0) await store.delete(key)
    return remaining
  }

  return {
    rateLimitRemaining,

    async isRateLimited(providerId, modelId) {
      return (await rateLimitRemaining(providerId, modelId)) > 0
    },

    async markRateLimited(providerId, modelId, retryAfterSeconds = 60) {
      const secs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds
          : 60
      const until = now().getTime() + secs * 1000
      await store.set(rateLimitKey(providerId, modelId), String(until))
    },

    async clearRateLimit(providerId, modelId) {
      await store.delete(rateLimitKey(providerId, modelId))
    },

    read,

    async record(providerId, modelId, tokens) {
      const current = await read(providerId, modelId)
      const next: UsageRecord = {
        requests: current.requests + 1,
        promptTokens: current.promptTokens + (tokens?.promptTokens ?? 0),
        completionTokens:
          current.completionTokens + (tokens?.completionTokens ?? 0),
      }
      await store.set(
        usageKey(providerId, modelId, now()),
        JSON.stringify(next),
      )
      return next
    },

    async reset(providerId, modelId) {
      await store.delete(usageKey(providerId, modelId, now()))
    },

    async summarize(provider, modelId, summarizeOpts) {
      const record = await read(provider.id, modelId)
      const tokens: TokenUsage = {
        promptTokens: record.promptTokens,
        completionTokens: record.completionTokens,
        totalTokens: record.promptTokens + record.completionTokens,
      }
      return summarizeRecord({
        billing: provider.billing,
        providerId: provider.id,
        modelId,
        record,
        tokens,
        dailyLimit: summarizeOpts?.dailyLimit,
        pricing: summarizeOpts?.pricing,
      })
    },
  }
}

/** Pure shaping step, exported so it can be tested without storage. */
export function summarizeRecord(input: {
  billing: BillingModel
  providerId: string
  modelId: string
  record: UsageRecord
  tokens: TokenUsage
  dailyLimit?: number
  pricing?: ModelPricing
}): UsageSummary {
  const { billing, providerId, modelId, record, tokens } = input

  switch (billing.kind) {
    case 'quota': {
      // With no per-model limit supplied we cannot claim a remainder. Fall
      // back to the metered shape rather than inventing a cap.
      if (input.dailyLimit === undefined) {
        return {
          kind: 'unmetered',
          providerId,
          modelId,
          requests: record.requests,
          tokens,
        }
      }
      return {
        kind: 'quota',
        providerId,
        modelId,
        requests: record.requests,
        limit: input.dailyLimit,
        remaining: Math.max(0, input.dailyLimit - record.requests),
        source: billing.source,
        tokens,
      }
    }

    case 'per-token': {
      const pricing = input.pricing
      const estimatedCost = pricing
        ? (tokens.promptTokens / 1_000_000) * pricing.inputPerMillion +
          (tokens.completionTokens / 1_000_000) * pricing.outputPerMillion
        : undefined
      return {
        kind: 'metered',
        providerId,
        modelId,
        requests: record.requests,
        tokens,
        currency: billing.currency,
        ...(estimatedCost !== undefined ? { estimatedCost } : {}),
        ...(billing.billingUrl ? { billingUrl: billing.billingUrl } : {}),
      }
    }

    case 'subscription':
      return {
        kind: 'unmetered',
        providerId,
        modelId,
        requests: record.requests,
        tokens,
        ...(billing.plan ? { plan: billing.plan } : {}),
        ...(billing.billingUrl ? { billingUrl: billing.billingUrl } : {}),
      }
  }
}

/** Extract the `usage` block from an OpenAI-shaped response, if present. */
export function readTokenUsage(payload: unknown): TokenUsage | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const usage = (payload as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) return undefined
  const u = usage as Record<string, unknown>
  const prompt = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0
  const completion =
    typeof u.completion_tokens === 'number' ? u.completion_tokens : 0
  const total =
    typeof u.total_tokens === 'number' ? u.total_tokens : prompt + completion
  if (prompt === 0 && completion === 0 && total === 0) return undefined
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
  }
}

/** One-line usage string suitable for a settings row. */
export function formatUsage(summary: UsageSummary): string {
  switch (summary.kind) {
    case 'quota':
      return `${summary.remaining} of ${summary.limit} requests left today`
    case 'metered': {
      const tokens = `${summary.tokens.totalTokens.toLocaleString()} tokens today`
      return summary.estimatedCost === undefined
        ? tokens
        : `${tokens} (~$${summary.estimatedCost.toFixed(4)})`
    }
    case 'unmetered':
      return `${summary.requests} requests today`
  }
}
