/**
 * Retry policy and request timeouts.
 *
 * Ported from gym-copilot's `ai.ts`, which had the most developed version of
 * this across the three apps: a bounded retry loop over a classified error, and
 * a per-request timeout. Both are transport concerns with nothing app-specific
 * in them, so they belong here rather than being re-solved per consumer.
 *
 * chef-copilot is the argument for the timeout in particular: lacking one in
 * the kit, it hand-rolled a timeout with `AbortSignal.timeout()`, which exists
 * in Node but **not in React Native's Hermes runtime** — so every call failed
 * on device while every Node-based test passed.
 */

import {
  ProviderApiError,
  RateLimitedError,
  NoSuitableModelError,
  AiTimeoutError,
} from './errors'
import { MissingCredentialsError } from './credentials'

export type RetryPolicy = {
  /** Additional attempts after the first. 0 disables retrying. */
  count: number
  /** Base delay between attempts, in ms. Grows linearly with attempt number. */
  delayMs: number
}

export const defaultRetryPolicy: RetryPolicy = { count: 1, delayMs: 500 }

/** Per-request timeout in ms. */
export const DEFAULT_TIMEOUT_MS = 20_000

/**
 * Whether a failure is worth another attempt.
 *
 * Credential and capability failures are **not** retryable — retrying a
 * missing key just wastes the user's time and, for metered providers, their
 * money. A 429 is retryable in principle, but the client parks the model on
 * one, so a retry will be refused locally rather than hitting the network
 * again; that is intentional.
 */
export function isRetryable(error: unknown): boolean {
  if (
    error instanceof MissingCredentialsError ||
    error instanceof NoSuitableModelError
  ) {
    return false
  }

  if (error instanceof RateLimitedError) return true
  if (error instanceof AiTimeoutError) return true

  if (error instanceof ProviderApiError) {
    // 5xx and 408 are transient; 4xx generally means the request itself is
    // wrong and will fail identically next time.
    return error.status >= 500 || error.status === 408
  }

  // Network-level rejections (DNS, connection reset) surface as plain Errors.
  return error instanceof Error
}

/** Linear backoff: attempt 1 waits `delayMs`, attempt 2 waits `2 × delayMs`. */
export function retryDelayFor(policy: RetryPolicy, attempt: number): number {
  return policy.delayMs * Math.max(1, attempt)
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run `attempt` up to `policy.count + 1` times, backing off between tries.
 *
 * `signal` short-circuits the wait so an aborted request doesn't sit out its
 * backoff before giving up.
 */
export async function withRetry<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  policy: RetryPolicy = defaultRetryPolicy,
  signal?: AbortSignal,
): Promise<T> {
  const maxAttempts = Math.max(0, policy.count) + 1
  let lastError: unknown

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
    try {
      return await attempt(attemptNumber)
    } catch (error) {
      lastError = error
      const isLast = attemptNumber === maxAttempts
      if (isLast || !isRetryable(error) || signal?.aborted) throw error
      await wait(retryDelayFor(policy, attemptNumber))
    }
  }

  throw lastError
}

/**
 * An `AbortSignal` that aborts after `ms`, optionally following a caller's
 * signal too.
 *
 * Deliberately built from `AbortController` + `setTimeout` rather than
 * `AbortSignal.timeout()`: that static does not exist in React Native's Hermes
 * runtime, and using it makes every call throw on device while passing under
 * Node. `AbortSignal.any()` is likewise unavailable, hence the manual linking.
 *
 * Returns the signal plus a `dispose` that must be called to clear the timer.
 */
export function timeoutSignal(
  ms: number,
  caller?: AbortSignal,
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController()
  let didTimeOut = false

  const timer = setTimeout(() => {
    didTimeOut = true
    controller.abort()
  }, ms)

  const onCallerAbort = () => controller.abort()
  if (caller) {
    if (caller.aborted) controller.abort()
    else caller.addEventListener('abort', onCallerAbort)
  }

  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timer)
      caller?.removeEventListener('abort', onCallerAbort)
    },
  }
}
