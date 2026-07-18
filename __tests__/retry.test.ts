import { describe, expect, it, vi } from 'vitest'
import {
  AiTimeoutError,
  MissingCredentialsError,
  NoSuitableModelError,
  ProviderApiError,
  RateLimitedError,
  chunkCount,
  createAiClient,
  createMemoryStorageBundle,
  credentialStorageKey,
  estimateTokenBudget,
  githubModels,
  groupsPerChunk,
  isRetryable,
  retryDelayFor,
  shouldChunk,
  withRetry,
  type ModelInfo,
} from '../src'

const catalog: ModelInfo[] = [
  {
    id: 'openai/gpt-4.1-mini',
    provider: 'github-models',
    label: 'GPT-4.1 mini',
    vision: true,
    dailyLimit: 150,
    supportsJsonMode: true,
  },
]

function completion(content: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      choices: [{ index: 0, message: { role: 'assistant', content } }],
    }),
    text: async () => content,
  } as unknown as Response
}

function failure(status: number) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => 'boom',
  } as unknown as Response
}

function makeClient(fetchImpl: ReturnType<typeof vi.fn>, extra = {}) {
  return createAiClient({
    storage: createMemoryStorageBundle({
      secrets: {
        [credentialStorageKey('github-models', 'apiKey')]: 'pat-token',
      },
    }),
    providers: [githubModels],
    catalog,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    retry: { count: 1, delayMs: 0 },
    ...extra,
  })
}

describe('isRetryable', () => {
  it('does not retry credential or capability failures', () => {
    // Retrying a missing key wastes the user's time and, on a metered
    // provider, their money. It will fail identically every time.
    expect(
      isRetryable(new MissingCredentialsError(githubModels, [])),
    ).toBe(false)
    expect(isRetryable(new NoSuitableModelError({ vision: true }))).toBe(false)
  })

  it('retries transient server failures but not client-side ones', () => {
    expect(isRetryable(new ProviderApiError(githubModels, 500, ''))).toBe(true)
    expect(isRetryable(new ProviderApiError(githubModels, 503, ''))).toBe(true)
    expect(isRetryable(new ProviderApiError(githubModels, 408, ''))).toBe(true)
    // A 400 means the request itself is wrong.
    expect(isRetryable(new ProviderApiError(githubModels, 400, ''))).toBe(false)
    expect(isRetryable(new ProviderApiError(githubModels, 404, ''))).toBe(false)
  })

  it('retries timeouts and rate limits', () => {
    expect(isRetryable(new AiTimeoutError(1000))).toBe(true)
    expect(isRetryable(new RateLimitedError('p', 'm', 60))).toBe(true)
  })
})

describe('withRetry', () => {
  it('returns the first successful attempt without retrying', async () => {
    const attempt = vi.fn().mockResolvedValue('ok')
    expect(await withRetry(attempt, { count: 2, delayMs: 0 })).toBe('ok')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('retries a transient failure up to the policy count', async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new ProviderApiError(githubModels, 500, ''))
      .mockResolvedValue('recovered')

    expect(await withRetry(attempt, { count: 2, delayMs: 0 })).toBe('recovered')
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('gives up after count + 1 attempts', async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new ProviderApiError(githubModels, 500, ''))

    await expect(
      withRetry(attempt, { count: 2, delayMs: 0 }),
    ).rejects.toBeInstanceOf(ProviderApiError)
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('does not retry a non-retryable failure', async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new MissingCredentialsError(githubModels, []))

    await expect(
      withRetry(attempt, { count: 3, delayMs: 0 }),
    ).rejects.toBeInstanceOf(MissingCredentialsError)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('stops retrying once the caller aborts', async () => {
    const controller = new AbortController()
    const attempt = vi.fn().mockImplementation(async () => {
      controller.abort()
      throw new ProviderApiError(githubModels, 500, '')
    })

    await expect(
      withRetry(attempt, { count: 3, delayMs: 0 }, controller.signal),
    ).rejects.toBeInstanceOf(ProviderApiError)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('backs off linearly', () => {
    const policy = { count: 3, delayMs: 100 }
    expect(retryDelayFor(policy, 1)).toBe(100)
    expect(retryDelayFor(policy, 2)).toBe(200)
    expect(retryDelayFor(policy, 3)).toBe(300)
  })
})

describe('chat timeout and retry', () => {
  it('retries a 500 and succeeds on the second attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(failure(500))
      .mockResolvedValueOnce(completion('second time lucky'))

    const result = await makeClient(fetchImpl).chat([
      { role: 'user', content: 'hi' },
    ])

    expect(result.text).toBe('second time lucky')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry a 400', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(failure(400))

    await expect(
      makeClient(fetchImpl).chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toBeInstanceOf(ProviderApiError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('aborts a slow request and reports it as a timeout, not a generic error', async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }),
    )

    const client = makeClient(fetchImpl, {
      timeoutMs: 20,
      retry: { count: 0, delayMs: 0 },
    })

    await expect(
      client.chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toBeInstanceOf(AiTimeoutError)
  })

  it('gives each retry a fresh timeout rather than a shrinking one', async () => {
    const seen: number[] = []
    const fetchImpl = vi.fn().mockImplementation(async () => {
      seen.push(Date.now())
      throw new Error('network down')
    })

    await expect(
      makeClient(fetchImpl, { timeoutMs: 50 }).chat([
        { role: 'user', content: 'hi' },
      ]),
    ).rejects.toBeTruthy()

    // Both attempts ran; neither was cut short by an already-expired timer.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('a caller abort is not treated as a timeout', async () => {
    const controller = new AbortController()
    // Real fetch rejects immediately when handed an already-aborted signal.
    // The caller aborts while chat() is still resolving credentials, so by the
    // time fetch is reached the signal is aborted and no 'abort' event will
    // fire — a listener-only mock would hang forever.
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const fail = () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          }
          if (init.signal?.aborted) fail()
          else init.signal?.addEventListener('abort', fail)
        }),
    )

    const promise = makeClient(fetchImpl, {
      timeoutMs: 10_000,
      retry: { count: 0, delayMs: 0 },
    }).chat([{ role: 'user', content: 'hi' }], { signal: controller.signal })

    controller.abort()

    // Surfaces as the underlying abort, not AiTimeoutError — a user
    // cancelling is not a transient failure.
    await expect(promise).rejects.not.toBeInstanceOf(AiTimeoutError)
  })

  it('honours a per-request override of the client default', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(failure(500))

    await expect(
      makeClient(fetchImpl).chat([{ role: 'user', content: 'hi' }], {
        retry: { count: 0, delayMs: 0 },
      }),
    ).rejects.toBeInstanceOf(ProviderApiError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('token budgeting', () => {
  const spec = { base: 300, perUnit: 120, min: 1_200, max: 4_000 }

  it('scales with the amount of work', () => {
    expect(estimateTokenBudget(20, spec)).toBe(2_700)
  })

  it('clamps to the floor for a tiny job', () => {
    // 300 + 1×120 = 420, below the floor.
    expect(estimateTokenBudget(1, spec)).toBe(1_200)
  })

  it('clamps to the ceiling for a huge job', () => {
    expect(estimateTokenBudget(1_000, spec)).toBe(4_000)
  })

  it('treats nonsense unit counts as zero work', () => {
    expect(estimateTokenBudget(-5, spec)).toBe(1_200)
    expect(estimateTokenBudget(NaN, spec)).toBe(1_200)
  })
})

describe('chunking', () => {
  it('chunks only past the limit', () => {
    expect(shouldChunk(8, 8)).toBe(false)
    expect(shouldChunk(9, 8)).toBe(true)
  })

  it('fits whole groups into a chunk', () => {
    // 8 sessions per chunk at 3 per week → 3 weeks.
    expect(groupsPerChunk(8, 3)).toBe(3)
  })

  it('never returns an empty chunk, even when a group exceeds the limit', () => {
    // Otherwise a caller loops forever making no progress.
    expect(groupsPerChunk(2, 5)).toBe(1)
    expect(groupsPerChunk(8, 0)).toBe(1)
  })

  it('counts the chunks needed to cover the work', () => {
    expect(chunkCount(20, 8)).toBe(3)
    expect(chunkCount(0, 8)).toBe(1)
    expect(chunkCount(20, 0)).toBe(1)
  })
})
