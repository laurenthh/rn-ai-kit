/**
 * Transport error types.
 *
 * Extracted from `client.ts` so `retry.ts` can classify failures without
 * importing the client (which imports retry — that would be a cycle).
 */

import type { ModelRequirements } from './catalog'
import type { Provider } from './providers'

export class RateLimitedError extends Error {
  readonly providerId: string
  readonly modelId: string
  readonly retryAfterSeconds: number

  constructor(providerId: string, modelId: string, retryAfterSeconds: number) {
    super(`Rate limit reached for ${modelId}. Retry in ${retryAfterSeconds}s.`)
    this.name = 'RateLimitedError'
    this.providerId = providerId
    this.modelId = modelId
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export class ProviderApiError extends Error {
  readonly status: number
  readonly providerId: string
  readonly body: string

  constructor(provider: Provider, status: number, body: string) {
    super(`${provider.label} API error: ${status} — ${body}`)
    this.name = 'ProviderApiError'
    this.status = status
    this.providerId = provider.id
    this.body = body
  }
}

export class NoSuitableModelError extends Error {
  constructor(requirements: ModelRequirements) {
    const needs = [
      requirements.vision ? 'image input' : null,
      requirements.jsonMode ? 'JSON mode' : null,
    ]
      .filter(Boolean)
      .join(' and ')
    super(
      `No configured model supports ${needs || 'this task'}. ` +
        `Add credentials for a provider that offers one, or pick a different model in Settings.`,
    )
    this.name = 'NoSuitableModelError'
  }
}

/**
 * The request exceeded its own timeout.
 *
 * Distinct from a caller-initiated abort: a user cancelling is not a failure
 * and should not be retried, whereas a timeout is transient and is.
 */
export class AiTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`The AI request timed out after ${timeoutMs}ms.`)
    this.name = 'AiTimeoutError'
    this.timeoutMs = timeoutMs
  }
}
