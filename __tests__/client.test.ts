import { describe, expect, it, vi } from 'vitest'
import {
  createAiClient,
  createMemoryStorageBundle,
  MissingCredentialsError,
  NoSuitableModelError,
  ProviderApiError,
  RateLimitedError,
  credentialStorageKey,
  githubModels,
  xai,
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
  {
    id: 'deepseek/deepseek-v3-0324',
    provider: 'github-models',
    label: 'DeepSeek V3',
    vision: false,
    dailyLimit: 50,
  },
  { id: 'grok-4.5', provider: 'xai', label: 'Grok 4.5', vision: true },
]

/** A storage bundle with the GitHub Models PAT already stored. */
function configuredStorage() {
  return createMemoryStorageBundle({
    secrets: {
      [credentialStorageKey('github-models', 'apiKey')]: 'pat-token',
    },
  })
}

function jsonResponse(body: unknown, init?: { status?: number }) {
  return {
    ok: (init?.status ?? 200) < 400,
    status: init?.status ?? 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function completion(content: string, usage?: Record<string, number>) {
  return jsonResponse({
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    ...(usage ? { usage } : {}),
  })
}

function makeClient(overrides?: {
  fetchImpl?: typeof fetch
  storage?: ReturnType<typeof createMemoryStorageBundle>
  now?: () => Date
}) {
  return createAiClient({
    storage: overrides?.storage ?? configuredStorage(),
    providers: [githubModels, xai],
    catalog,
    fetchImpl: overrides?.fetchImpl ?? (vi.fn() as unknown as typeof fetch),
    ...(overrides?.now ? { now: overrides.now } : {}),
  })
}

describe('chat', () => {
  it('sends an OpenAI-shaped payload to the provider endpoint with bearer auth', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion('hello'))
    const client = makeClient({ fetchImpl: fetchImpl as unknown as typeof fetch })

    const result = await client.chat([{ role: 'user', content: 'hi' }], {
      model: 'openai/gpt-4.1-mini',
    })

    expect(result.text).toBe('hello')
    expect(result.provider.id).toBe('github-models')

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://models.github.ai/inference/chat/completions')
    expect(init.headers.Authorization).toBe('Bearer pat-token')
    // GitHub Models needs its own Accept header; other providers must not get it.
    expect(init.headers.Accept).toBe('application/vnd.github+json')
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'openai/gpt-4.1-mini',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      max_tokens: 500,
    })
  })

  it('routes to a different provider with that provider’s own credentials', async () => {
    const storage = createMemoryStorageBundle({
      secrets: { [credentialStorageKey('xai', 'apiKey')]: 'xai-key' },
    })
    const fetchImpl = vi.fn().mockResolvedValue(completion('from grok'))
    const client = makeClient({
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await client.chat([{ role: 'user', content: 'hi' }], {
      model: 'grok-4.5',
    })

    expect(result.provider.id).toBe('xai')
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.x.ai/v1/chat/completions')
    expect(init.headers.Authorization).toBe('Bearer xai-key')
    expect(init.headers.Accept).toBeUndefined()
  })

  it('sends image content parts through unchanged for vision requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion('a receipt'))
    const client = makeClient({ fetchImpl: fetchImpl as unknown as typeof fetch })

    await client.chat(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,AAA', detail: 'low' },
            },
          ],
        },
      ],
      { model: 'openai/gpt-4.1-mini' },
    )

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body)
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'what is this?' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,AAA', detail: 'low' },
      },
    ])
  })

  it('requests JSON mode only when asked', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion('{}'))
    const client = makeClient({ fetchImpl: fetchImpl as unknown as typeof fetch })

    await client.chat([{ role: 'user', content: 'x' }], {
      model: 'openai/gpt-4.1-mini',
    })
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).response_format).toBeUndefined()

    await client.chat([{ role: 'user', content: 'x' }], {
      model: 'openai/gpt-4.1-mini',
      json: true,
    })
    expect(JSON.parse(fetchImpl.mock.calls[1]![1].body).response_format).toEqual({
      type: 'json_object',
    })
  })
})

describe('credentials', () => {
  it('throws MissingCredentialsError naming the provider when nothing is stored', async () => {
    const client = makeClient({ storage: createMemoryStorageBundle() })

    await expect(
      client.chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toBeInstanceOf(MissingCredentialsError)
  })

  it('falls back to the environment when no value is stored', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion('ok'))
    const client = createAiClient({
      storage: createMemoryStorageBundle(),
      providers: [githubModels],
      catalog,
      env: { GITHUB_MODELS_TOKEN: 'env-token' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client.chat([{ role: 'user', content: 'hi' }])

    expect(fetchImpl.mock.calls[0]![1].headers.Authorization).toBe(
      'Bearer env-token',
    )
  })

  it('prefers a stored value over the environment fallback', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion('ok'))
    const client = createAiClient({
      storage: configuredStorage(),
      providers: [githubModels],
      catalog,
      env: { GITHUB_MODELS_TOKEN: 'env-token' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client.chat([{ role: 'user', content: 'hi' }])

    expect(fetchImpl.mock.calls[0]![1].headers.Authorization).toBe(
      'Bearer pat-token',
    )
  })

  it('reports only providers whose required fields resolve', async () => {
    const client = makeClient()
    const configured = await client.configuredProviders()
    expect(configured.map((p) => p.id)).toEqual(['github-models'])
  })
})

describe('rate limiting', () => {
  it('parks the model on a 429 and honours retry-after', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (h: string) => (h === 'retry-after' ? '120' : null) },
      json: async () => ({}),
      text: async () => 'rate limited',
    } as unknown as Response)

    const client = makeClient({ fetchImpl: fetchImpl as unknown as typeof fetch })

    await expect(
      client.chat([{ role: 'user', content: 'hi' }], {
        model: 'openai/gpt-4.1-mini',
      }),
    ).rejects.toBeInstanceOf(RateLimitedError)

    const remaining = await client.usage.rateLimitRemaining(
      'github-models',
      'openai/gpt-4.1-mini',
    )
    expect(remaining).toBeGreaterThan(115)
    expect(remaining).toBeLessThanOrEqual(120)
  })

  it('defaults to 60s when retry-after is absent or unparseable', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: () => 'soon' },
      json: async () => ({}),
      text: async () => '',
    } as unknown as Response)
    const client = makeClient({ fetchImpl: fetchImpl as unknown as typeof fetch })

    await expect(
      client.chat([{ role: 'user', content: 'hi' }], {
        model: 'openai/gpt-4.1-mini',
      }),
    ).rejects.toBeInstanceOf(RateLimitedError)

    const remaining = await client.usage.rateLimitRemaining(
      'github-models',
      'openai/gpt-4.1-mini',
    )
    expect(remaining).toBeGreaterThan(55)
    expect(remaining).toBeLessThanOrEqual(60)
  })

  it('refuses to call while parked, without hitting the network', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion('ok'))
    const client = makeClient({ fetchImpl: fetchImpl as unknown as typeof fetch })

    await client.usage.markRateLimited(
      'github-models',
      'openai/gpt-4.1-mini',
      90,
    )

    await expect(
      client.chat([{ role: 'user', content: 'hi' }], {
        model: 'openai/gpt-4.1-mini',
      }),
    ).rejects.toBeInstanceOf(RateLimitedError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('keys the park per provider+model, so one limit does not block others', async () => {
    const client = makeClient()
    await client.usage.markRateLimited('github-models', 'openai/gpt-4.1-mini', 60)

    expect(
      await client.usage.isRateLimited('github-models', 'openai/gpt-4.1-mini'),
    ).toBe(true)
    expect(
      await client.usage.isRateLimited('github-models', 'deepseek/deepseek-v3-0324'),
    ).toBe(false)
    expect(await client.usage.isRateLimited('xai', 'openai/gpt-4.1-mini')).toBe(
      false,
    )
  })

  it('expires the park once the deadline passes', async () => {
    let now = new Date('2026-07-18T10:00:00Z')
    const client = makeClient({ now: () => now })

    await client.usage.markRateLimited('github-models', 'openai/gpt-4.1-mini', 60)
    expect(
      await client.usage.isRateLimited('github-models', 'openai/gpt-4.1-mini'),
    ).toBe(true)

    now = new Date('2026-07-18T10:02:00Z')
    expect(
      await client.usage.isRateLimited('github-models', 'openai/gpt-4.1-mini'),
    ).toBe(false)
  })
})

describe('errors', () => {
  it('wraps non-429 failures with the provider name and body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => 'upstream exploded',
    } as unknown as Response)
    const client = makeClient({ fetchImpl: fetchImpl as unknown as typeof fetch })

    await expect(
      client.chat([{ role: 'user', content: 'hi' }], {
        model: 'openai/gpt-4.1-mini',
      }),
    ).rejects.toThrow(/GitHub Models API error: 500 — upstream exploded/)
  })

  it('rejects a response with no assistant message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [] }))
    const client = makeClient({ fetchImpl: fetchImpl as unknown as typeof fetch })

    await expect(
      client.chat([{ role: 'user', content: 'hi' }], {
        model: 'openai/gpt-4.1-mini',
      }),
    ).rejects.toBeInstanceOf(ProviderApiError)
  })

  it('reports no suitable model when the task needs a capability nothing has', async () => {
    const storage = createMemoryStorageBundle({
      secrets: {
        [credentialStorageKey('github-models', 'apiKey')]: 'pat-token',
      },
    })
    const client = createAiClient({
      storage,
      providers: [githubModels],
      // Only a text-only model is reachable.
      catalog: [catalog[1]!],
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })

    await expect(
      client.chat([{ role: 'user', content: 'hi' }], {
        requirements: { vision: true },
      }),
    ).rejects.toBeInstanceOf(NoSuitableModelError)
  })
})

describe('model selection', () => {
  it('persists and reuses the user’s selected model', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion('ok'))
    const client = makeClient({ fetchImpl: fetchImpl as unknown as typeof fetch })

    await client.setSelectedModel('deepseek/deepseek-v3-0324', 'github-models')
    expect(await client.getSelectedModel()).toEqual({
      modelId: 'deepseek/deepseek-v3-0324',
      providerId: 'github-models',
    })

    const result = await client.chat([{ role: 'user', content: 'hi' }])
    expect(result.model.id).toBe('deepseek/deepseek-v3-0324')
  })

  it('overrides a text-only selection when the task needs vision', async () => {
    const client = makeClient()
    await client.setSelectedModel('deepseek/deepseek-v3-0324', 'github-models')

    const model = await client.selectModel({ requirements: { vision: true } })

    // Falls back within the same provider — xai has no credentials stored.
    expect(model.id).toBe('openai/gpt-4.1-mini')
    expect(model.provider).toBe('github-models')
  })

  it('lists only models from providers that are configured', async () => {
    const client = makeClient()
    const models = await client.availableModels()
    expect(models.map((m) => m.id)).toEqual([
      'openai/gpt-4.1-mini',
      'deepseek/deepseek-v3-0324',
    ])
  })
})

describe('discoverModels', () => {
  it('parses the bare-array catalog shape and reads vision from modalities', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          id: 'openai/gpt-4.1',
          name: 'OpenAI GPT-4.1',
          supported_input_modalities: ['text', 'image'],
        },
        {
          id: 'deepseek/deepseek-r1',
          name: 'DeepSeek R1',
          supported_input_modalities: ['text'],
        },
      ]),
    )
    const client = makeClient({ fetchImpl: fetchImpl as unknown as typeof fetch })

    const models = await client.discoverModels('github-models')

    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://models.github.ai/catalog/models',
    )
    expect(models).toEqual([
      {
        id: 'openai/gpt-4.1',
        provider: 'github-models',
        label: 'OpenAI GPT-4.1',
        vision: true,
      },
      {
        id: 'deepseek/deepseek-r1',
        provider: 'github-models',
        label: 'DeepSeek R1',
        vision: false,
      },
    ])
  })

  it('parses the OpenAI `{ data: [...] }` envelope', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [{ id: 'grok-4.5' }] }))
    const storage = createMemoryStorageBundle({
      secrets: { [credentialStorageKey('xai', 'apiKey')]: 'xai-key' },
    })
    const client = makeClient({
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const models = await client.discoverModels('xai')
    expect(models).toEqual([
      { id: 'grok-4.5', provider: 'xai', label: 'grok-4.5', vision: false },
    ])
  })
})
