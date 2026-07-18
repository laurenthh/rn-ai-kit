import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  AiTaskError,
  createAiClient,
  createMemoryStorageBundle,
  credentialStorageKey,
  defineAiTask,
  githubModels,
  parseJson,
  repairTruncatedJson,
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

function makeClient(fetchImpl: ReturnType<typeof vi.fn>) {
  return createAiClient({
    storage: createMemoryStorageBundle({
      secrets: {
        [credentialStorageKey('github-models', 'apiKey')]: 'pat-token',
      },
    }),
    providers: [githubModels],
    catalog,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
}

// A stand-in for an app's own domain schema — the package never sees this type.
const DocumentClassification = z.object({
  category: z.enum(['ticket', 'hotel', 'insurance']),
  confidence: z.number().min(0).max(1),
  title: z.string(),
})

const classifyDocument = defineAiTask({
  name: 'classify-document',
  model: { vision: true },
  system: 'Classify the document.',
  schema: DocumentClassification,
  buildMessages: (input: { imageBase64: string }) => [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Classify this.' },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${input.imageBase64}` },
        },
      ],
    },
  ],
})

describe('defineAiTask', () => {
  it('returns parsed, schema-validated output typed as the app’s own type', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        completion(
          '{"category":"ticket","confidence":0.9,"title":"Flight to Paris"}',
        ),
      )
    const client = makeClient(fetchImpl)

    const result = await classifyDocument.run(client, { imageBase64: 'AAA' })

    // Typed as z.infer<typeof DocumentClassification>, not `unknown`.
    expect(result.category).toBe('ticket')
    expect(result.title).toBe('Flight to Paris')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('requests JSON mode and prepends the system prompt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        completion('{"category":"hotel","confidence":1,"title":"Hotel"}'),
      )
    const client = makeClient(fetchImpl)

    await classifyDocument.run(client, { imageBase64: 'AAA' })

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body)
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.messages[0]).toEqual({
      role: 'system',
      content: 'Classify the document.',
    })
  })

  it('selects a vision-capable model even when a text-only one is selected', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        completion('{"category":"hotel","confidence":1,"title":"Hotel"}'),
      )
    const client = makeClient(fetchImpl)
    await client.setSelectedModel('deepseek/deepseek-v3-0324', 'github-models')

    await classifyDocument.run(client, { imageBase64: 'AAA' })

    // The text-only selection would have broken document scanning outright.
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).model).toBe(
      'openai/gpt-4.1-mini',
    )
  })

  it('repairs a schema-invalid first response by re-prompting once', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        // `confidence` out of range — parses as JSON, fails the schema.
        completion('{"category":"ticket","confidence":7,"title":"Flight"}'),
      )
      .mockResolvedValueOnce(
        completion('{"category":"ticket","confidence":0.7,"title":"Flight"}'),
      )
    const client = makeClient(fetchImpl)

    const result = await classifyDocument.run(client, { imageBase64: 'AAA' })

    expect(result.confidence).toBe(0.7)
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    // The repair turn must show the model its own output and the failure.
    const repairBody = JSON.parse(fetchImpl.mock.calls[1]![1].body)
    const [assistantTurn, correctionTurn] = repairBody.messages.slice(-2)
    expect(assistantTurn.role).toBe('assistant')
    expect(assistantTurn.content).toContain('"confidence":7')
    expect(correctionTurn.role).toBe('user')
    expect(correctionTurn.content).toContain('confidence')
  })

  it('repairs an unparseable first response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(completion('I think this is a hotel booking!'))
      .mockResolvedValueOnce(
        completion('{"category":"hotel","confidence":0.8,"title":"Ibis"}'),
      )
    const client = makeClient(fetchImpl)

    const result = await classifyDocument.run(client, { imageBase64: 'AAA' })
    expect(result.category).toBe('hotel')
  })

  it('throws AiTaskError carrying the raw text when repair also fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion('still not json'))
    const client = makeClient(fetchImpl)

    const error = await classifyDocument
      .run(client, { imageBase64: 'AAA' })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AiTaskError)
    expect((error as AiTaskError).task).toBe('classify-document')
    expect((error as AiTaskError).raw).toBe('still not json')
    // Exactly one retry — not an unbounded repair loop.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry when repair is disabled', async () => {
    const strict = defineAiTask({
      name: 'strict',
      schema: z.object({ ok: z.boolean() }),
      repair: false,
      buildMessages: () => [{ role: 'user', content: 'x' }],
    })
    const fetchImpl = vi.fn().mockResolvedValue(completion('nope'))

    await expect(strict.run(makeClient(fetchImpl), {})).rejects.toBeInstanceOf(
      AiTaskError,
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('passes temperature and maxTokens through to the request', async () => {
    const task = defineAiTask({
      name: 'tuned',
      schema: z.object({ ok: z.boolean() }),
      temperature: 0.1,
      maxTokens: 2000,
      buildMessages: () => [{ role: 'user', content: 'x' }],
    })
    const fetchImpl = vi.fn().mockResolvedValue(completion('{"ok":true}'))

    await task.run(makeClient(fetchImpl), {})

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body)
    expect(body.temperature).toBe(0.1)
    expect(body.max_tokens).toBe(2000)
  })
})

describe('parseJson', () => {
  it('parses clean JSON', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('strips a markdown fence, which JSON mode does not prevent', () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseJson('```\n[1,2]\n```')).toEqual([1, 2])
  })

  it('extracts an object embedded in prose', () => {
    expect(parseJson('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({
      a: 1,
    })
  })

  it('extracts an array embedded in prose', () => {
    expect(parseJson('Results: [{"a":1},{"a":2}]')).toEqual([
      { a: 1 },
      { a: 2 },
    ])
  })

  it('throws on text with no JSON in it', () => {
    expect(() => parseJson('no json here')).toThrow(/not valid JSON/)
  })

  // DeepSeek R1 does this even with response_format: json_object requested —
  // confirmed against the live GitHub Models endpoint on 2026-07-18.
  it('skips a reasoning model’s <think> preamble', () => {
    const raw =
      '<think>\nOkay, the user wants JSON. Maybe {"city": something}? Let me decide.\n</think>\n{"city":"Lisbon","country":"Portugal"}'
    expect(parseJson(raw)).toEqual({ city: 'Lisbon', country: 'Portugal' })
  })

  it('is not fooled by braces inside string values', () => {
    expect(parseJson('Here: {"note":"use {braces} freely","n":1}')).toEqual({
      note: 'use {braces} freely',
      n: 1,
    })
  })

  it('is not fooled by an escaped quote inside a string value', () => {
    expect(parseJson('{"note":"a \\" quote","n":2}')).toEqual({
      note: 'a " quote',
      n: 2,
    })
  })

  it('prefers the full payload over a smaller object nested in the preamble', () => {
    const raw =
      'Example format was {"a":1}. Actual answer:\n{"city":"Porto","tags":["x","y"]}'
    expect(parseJson(raw)).toEqual({ city: 'Porto', tags: ['x', 'y'] })
  })
})

describe('repairTruncatedJson', () => {
  it('closes brackets left open by a token-limit cutoff', () => {
    expect(repairTruncatedJson('{"items":[{"name":"a"},{"name":"b"}')).toEqual({
      items: [{ name: 'a' }, { name: 'b' }],
    })
  })

  it('drops a trailing incomplete object', () => {
    expect(
      repairTruncatedJson('{"items":[{"name":"a"},{"name":"unterminat'),
    ).toEqual({ items: [{ name: 'a' }] })
  })

  it('returns null when the fragment cannot be salvaged', () => {
    expect(repairTruncatedJson('not json at all')).toBeNull()
  })
})
