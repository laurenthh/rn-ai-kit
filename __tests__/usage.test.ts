import { describe, expect, it, vi } from 'vitest'
import {
  createAiClient,
  createMemoryStorageBundle,
  createUsageTracker,
  createMemoryStorage,
  credentialStorageKey,
  formatUsage,
  gemini,
  readTokenUsage,
  resolveModel,
  mergeCatalog,
  parseDiscoveredModels,
  summarizeRecord,
  xai,
  type ModelInfo,
} from '../src'

const catalog: ModelInfo[] = [
  {
    id: 'gemini-3.7-flash',
    provider: 'gemini',
    label: 'GPT-4.1 mini',
    vision: true,
    dailyLimit: 150,
    supportsJsonMode: true,
  },
  {
    id: 'gemini-3.5-flash-lite',
    provider: 'gemini',
    label: 'DeepSeek V3',
    vision: false,
    dailyLimit: 50,
  },
  { id: 'grok-4.5', provider: 'xai', label: 'Grok 4.5', vision: true },
]

function completion(content: string, usage?: Record<string, number>) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      choices: [{ index: 0, message: { role: 'assistant', content } }],
      ...(usage ? { usage } : {}),
    }),
    text: async () => content,
  } as unknown as Response
}

describe('usage summaries are shaped by the provider’s billing model', () => {
  it('a quota provider reports allowance remaining, not raw tokens', () => {
    const summary = summarizeRecord({
      billing: gemini.billing,
      providerId: 'gemini',
      modelId: 'gemini-3.7-flash',
      record: { requests: 8, promptTokens: 4000, completionTokens: 1000 },
      tokens: { promptTokens: 4000, completionTokens: 1000, totalTokens: 5000 },
      dailyLimit: 150,
    })

    expect(summary.kind).toBe('quota')
    if (summary.kind !== 'quota') throw new Error('unreachable')
    expect(summary.limit).toBe(150)
    expect(summary.remaining).toBe(142)
    expect(summary.source).toBe('Google AI Studio (free tier)')
    expect(formatUsage(summary)).toBe('142 of 150 requests left today')
  })

  it('a per-token provider reports tokens and has no allowance to report', () => {
    const summary = summarizeRecord({
      billing: xai.billing,
      providerId: 'xai',
      modelId: 'grok-4.5',
      record: { requests: 3, promptTokens: 12_000, completionTokens: 3_000 },
      tokens: {
        promptTokens: 12_000,
        completionTokens: 3_000,
        totalTokens: 15_000,
      },
    })

    expect(summary.kind).toBe('metered')
    if (summary.kind !== 'metered') throw new Error('unreachable')
    expect(summary.tokens.totalTokens).toBe(15_000)
    expect(summary.billingUrl).toBe('https://console.x.ai')
    // No cap exists, so the type carries none to display.
    expect('limit' in summary).toBe(false)
  })

  it('omits cost rather than showing $0.00 when pricing is unknown', () => {
    const summary = summarizeRecord({
      billing: xai.billing,
      providerId: 'xai',
      modelId: 'grok-4.5',
      record: { requests: 1, promptTokens: 1000, completionTokens: 500 },
      tokens: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
    })

    if (summary.kind !== 'metered') throw new Error('unreachable')
    expect(summary.estimatedCost).toBeUndefined()
    expect(formatUsage(summary)).toBe('1,500 tokens today')
  })

  it('estimates cost when the model carries verified pricing', () => {
    const summary = summarizeRecord({
      billing: xai.billing,
      providerId: 'xai',
      modelId: 'grok-4.5',
      record: { requests: 1, promptTokens: 1_000_000, completionTokens: 500_000 },
      tokens: {
        promptTokens: 1_000_000,
        completionTokens: 500_000,
        totalTokens: 1_500_000,
      },
      pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: 'USD' },
    })

    if (summary.kind !== 'metered') throw new Error('unreachable')
    // 1M input @ $3 + 0.5M output @ $15 = $10.50
    expect(summary.estimatedCost).toBeCloseTo(10.5, 5)
  })

  it('a subscription provider reports requests with no cap and no cost', () => {
    const summary = summarizeRecord({
      billing: { kind: 'subscription', plan: 'Pro' },
      providerId: 'somewhere',
      modelId: 'model-x',
      record: { requests: 12, promptTokens: 0, completionTokens: 0 },
      tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    })

    expect(summary.kind).toBe('unmetered')
    expect(formatUsage(summary)).toBe('12 requests today')
  })

  it('refuses to invent a cap for a quota provider with no known limit', () => {
    const summary = summarizeRecord({
      billing: gemini.billing,
      providerId: 'gemini',
      modelId: 'some/unlisted-model',
      record: { requests: 5, promptTokens: 0, completionTokens: 0 },
      tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      // No dailyLimit — the model isn't in the curated catalog.
    })

    expect(summary.kind).toBe('unmetered')
  })
})

describe('usage accounting', () => {
  it('counts requests and accumulates tokens across calls', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        completion('a', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
      )
      .mockResolvedValueOnce(
        completion('b', { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 }),
      )

    const client = createAiClient({
      storage: createMemoryStorageBundle({
        secrets: {
          [credentialStorageKey('gemini', 'apiKey')]: 'pat-token',
        },
      }),
      providers: [gemini],
      catalog,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client.chat([{ role: 'user', content: 'x' }], {
      model: 'gemini-3.7-flash',
    })
    const second = await client.chat([{ role: 'user', content: 'y' }], {
      model: 'gemini-3.7-flash',
    })

    expect(second.tokens).toEqual({
      promptTokens: 20,
      completionTokens: 7,
      totalTokens: 27,
    })

    const summary = await client.usageFor('gemini-3.7-flash')
    if (summary.kind !== 'quota') throw new Error('expected quota summary')
    expect(summary.requests).toBe(2)
    expect(summary.remaining).toBe(148)
    expect(summary.tokens.totalTokens).toBe(42)
  })

  it('does not count a failed request against the allowance', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => 'boom',
    } as unknown as Response)

    const client = createAiClient({
      storage: createMemoryStorageBundle({
        secrets: {
          [credentialStorageKey('gemini', 'apiKey')]: 'pat-token',
        },
      }),
      providers: [gemini],
      catalog,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client
      .chat([{ role: 'user', content: 'x' }], { model: 'gemini-3.7-flash' })
      .catch(() => undefined)

    const record = await client.usage.read('gemini', 'gemini-3.7-flash')
    expect(record.requests).toBe(0)
  })

  it('keeps counters per day', async () => {
    let now = new Date('2026-07-18T12:00:00Z')
    const tracker = createUsageTracker({
      data: createMemoryStorage(),
      now: () => now,
    })

    await tracker.record('gemini', 'gemini-3.7-flash')
    await tracker.record('gemini', 'gemini-3.7-flash')
    expect((await tracker.read('gemini', 'gemini-3.7-flash')).requests).toBe(2)

    now = new Date('2026-07-19T12:00:00Z')
    expect((await tracker.read('gemini', 'gemini-3.7-flash')).requests).toBe(0)
  })

  it('survives a storage backend that throws', async () => {
    const exploding = {
      get: async () => {
        throw new Error('storage unavailable')
      },
      set: async () => {
        throw new Error('storage unavailable')
      },
      delete: async () => {
        throw new Error('storage unavailable')
      },
    }
    const tracker = createUsageTracker({ data: exploding })

    // Best-effort persistence must never take down a working call.
    await expect(
      tracker.record('gemini', 'gemini-3.7-flash'),
    ).resolves.toBeDefined()
    await expect(
      tracker.isRateLimited('gemini', 'gemini-3.7-flash'),
    ).resolves.toBe(false)
  })
})

describe('readTokenUsage', () => {
  it('reads the OpenAI usage block', () => {
    expect(
      readTokenUsage({
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }),
    ).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 })
  })

  it('derives total when the provider omits it', () => {
    expect(
      readTokenUsage({ usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    ).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 })
  })

  it('returns undefined when the provider reports nothing', () => {
    expect(readTokenUsage({})).toBeUndefined()
    expect(readTokenUsage({ usage: {} })).toBeUndefined()
    expect(readTokenUsage(null)).toBeUndefined()
  })
})

describe('resolveModel', () => {
  it('honours the user’s selection when it satisfies the task', () => {
    const model = resolveModel({
      catalog,
      selected: 'gemini-3.5-flash-lite',
      available: ['gemini'],
    })
    expect(model?.id).toBe('gemini-3.5-flash-lite')
  })

  it('prefers a fallback on the same provider, to avoid needing new credentials', () => {
    const model = resolveModel({
      catalog,
      selected: 'gemini-3.5-flash-lite',
      requirements: { vision: true },
      available: ['gemini', 'xai'],
    })
    // grok-4.5 also has vision, but staying on github-models is cheaper for the user.
    expect(model?.provider).toBe('gemini')
    expect(model?.id).toBe('gemini-3.7-flash')
  })

  it('stays on the selected provider when the selected id has left the catalog', () => {
    // A stored selection of a since-retired model (e.g. grok-3) must not jump
    // to the first catalog entry on a different provider.
    const model = resolveModel({
      catalog,
      selected: 'grok-3',
      selectedProvider: 'xai',
      available: ['gemini', 'xai'],
    })
    expect(model?.id).toBe('grok-4.5')
  })

  it('widens to another provider when the selected one cannot comply', () => {
    const model = resolveModel({
      catalog: [catalog[1]!, catalog[2]!],
      selected: 'gemini-3.5-flash-lite',
      requirements: { vision: true },
      available: ['gemini', 'xai'],
    })
    expect(model?.id).toBe('grok-4.5')
  })

  it('never returns a model from a provider with no credentials', () => {
    const model = resolveModel({
      catalog,
      requirements: { vision: true },
      available: ['xai'],
    })
    expect(model?.provider).toBe('xai')
  })

  it('returns undefined rather than a wrong model when nothing complies', () => {
    expect(
      resolveModel({
        catalog: [catalog[1]!],
        requirements: { vision: true },
        available: ['gemini'],
      }),
    ).toBeUndefined()
  })
})

describe('mergeCatalog', () => {
  it('keeps curated metadata when discovery reports the same model', () => {
    const merged = mergeCatalog(catalog, [
      {
        id: 'gemini-3.7-flash',
        provider: 'gemini',
        label: 'Discovered label',
        vision: true,
      },
    ])
    const entry = merged.find((m) => m.id === 'gemini-3.7-flash')
    // Hand-authored limit and label survive; discovery only fills gaps.
    expect(entry?.dailyLimit).toBe(150)
    expect(entry?.label).toBe('GPT-4.1 mini')
    expect(merged).toHaveLength(catalog.length)
  })

  it('appends models the curated catalog does not know', () => {
    const merged = mergeCatalog(catalog, [
      { id: 'openai/gpt-5', provider: 'gemini', label: 'GPT-5', vision: true },
    ])
    expect(merged).toHaveLength(catalog.length + 1)
    expect(merged.at(-1)?.id).toBe('openai/gpt-5')
  })
})

describe('parseDiscoveredModels payload shapes', () => {
  it('reads vision from both the flat and the nested modalities shape', () => {
    const models = parseDiscoveredModels('openrouter', {
      data: [
        {
          id: 'google/gemini-3.7-flash',
          name: 'Gemini 3.7 Flash',
          architecture: { input_modalities: ['text', 'image'] },
        },
        { id: 'text-only/model', architecture: { input_modalities: ['text'] } },
        { id: 'legacy/flat', supported_input_modalities: ['text', 'image'] },
        { id: 'no-capability-info/model' },
      ],
    })
    expect(models.map((m) => m.vision)).toEqual([true, false, true, false])
    expect(models[0]?.label).toBe('Gemini 3.7 Flash')
  })
})
