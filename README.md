# rn-ai-kit

Provider-agnostic LLM client for the copilot apps. Multi-provider chat,
credential handling, billing-aware usage tracking, and schema-validated tasks.

No React Native imports. No runtime dependencies. `zod` is an optional peer
dependency — any validator with a `safeParse` method works.

Sibling of [`rn-backup-kit`](https://github.com/laurenthh/rn-backup-kit) and
[`rn-command-kit`](https://github.com/laurenthh/rn-command-kit); same
inversion-of-dependencies approach, same GitHub-tag distribution.

## Install

```jsonc
// package.json
"dependencies": {
  "rn-ai-kit": "github:laurenthh/rn-ai-kit#v1"
}
```

## Why providers are data

A model is not just an id — it comes with an endpoint, a credential the user
has to obtain from somewhere specific, and a billing model. Those differ enough
between vendors that hardcoding one of them (as the original travel-copilot
implementation hardcoded GitHub Models) makes every other vendor a rewrite.

Here a provider is a value:

```ts
import { defineProvider } from 'rn-ai-kit'

const openrouter = defineProvider({
  id: 'openrouter',
  label: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  billing: { kind: 'per-token', currency: 'USD' },
})
```

`defineProvider` defaults to the OpenAI wire format (`POST /chat/completions`,
`Authorization: Bearer <apiKey>`, `GET /models`), which every bundled provider
happens to speak. Override any of it for endpoints that don't.

Bundled: **GitHub Models**, **xAI (Grok)**, **DeepSeek**, **Z.ai (GLM)**.

## Setup

The package persists nothing itself. Supply two stores — `secrets` for
credentials (back it with Keychain/Keystore) and `data` for counters:

```ts
import { createAiClient } from 'rn-ai-kit'
import * as SecureStore from 'expo-secure-store'
import AsyncStorage from '@react-native-async-storage/async-storage'

export const ai = createAiClient({
  storage: {
    secrets: {
      get: (k) => SecureStore.getItemAsync(k),
      set: (k, v) => SecureStore.setItemAsync(k, v),
      delete: (k) => SecureStore.deleteItemAsync(k),
    },
    data: {
      get: (k) => AsyncStorage.getItem(k),
      set: (k, v) => AsyncStorage.setItem(k, v),
      delete: (k) => AsyncStorage.removeItem(k),
    },
  },
  env: { GITHUB_MODELS_TOKEN: process.env.GITHUB_MODELS_TOKEN },
  defaultModel: { modelId: 'openai/gpt-4.1-mini', providerId: 'github-models' },
})
```

Credentials resolve stored value → environment fallback → missing. Ask a
provider what it still needs:

```ts
await ai.credentials.missingFields(githubModels) // → CredentialField[]
await ai.configuredProviders()                   // → providers usable right now
```

Each `CredentialField` carries a `label`, `placeholder` and `helpUrl`, so a
settings screen can render the right inputs per provider without knowing which
provider it is.

## Chat

```ts
const { text, model, tokens } = await ai.chat(
  [{ role: 'user', content: 'Three things to do in Lisbon' }],
  { maxTokens: 300 },
)
```

Vision requests use OpenAI content parts:

```ts
await ai.chat([
  {
    role: 'user',
    content: [
      { type: 'text', text: 'What kind of document is this?' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
    ],
  },
], { requirements: { vision: true } })
```

`requirements` is a capability, not an id. If the user has selected a text-only
model, a vision request transparently falls back to a capable one — preferring
another model from the *same* provider, so the fallback never needs credentials
the user hasn't entered. If nothing satisfies the requirement, it throws
`NoSuitableModelError` rather than silently downgrading.

## Tasks

`defineAiTask` handles JSON mode, tolerant parsing, schema validation and one
repair retry. The app keeps its own prompts and schemas; the package never
imports domain types.

```ts
import { defineAiTask } from 'rn-ai-kit'
import { z } from 'zod'

const DocumentClassification = z.object({
  category: z.enum(['ticket', 'hotel', 'insurance']),
  confidence: z.number().min(0).max(1),
  title: z.string(),
})

export const classifyDocument = defineAiTask({
  name: 'classify-document',
  model: { vision: true },
  system: 'Classify travel documents. Reply with JSON only.',
  schema: DocumentClassification,
  buildMessages: (input: { imageBase64: string }) => [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Classify this document.' },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${input.imageBase64}` },
        },
      ],
    },
  ],
})

// Typed as z.infer<typeof DocumentClassification>:
const result = await classifyDocument.run(ai, { imageBase64 })
```

On a schema failure the kit re-prompts **once**, showing the model its own
output and the specific validation error, then gives up with an `AiTaskError`
carrying the raw text. Not all models honour `response_format` — the parser
tolerates markdown fences, prose wrappers, and JSON truncated by the token
limit.

## Usage and billing

Providers meter access differently, so one counter cannot describe all of them
honestly. `usageFor()` returns a discriminated union matching how the provider
actually bills:

```ts
const usage = await ai.usageFor('openai/gpt-4.1-mini')

switch (usage.kind) {
  case 'quota':     // included allowance — show what's left
    `${usage.remaining} of ${usage.limit} requests left today`
    break
  case 'metered':   // pay-per-token — show consumption, and cost if known
    usage.tokens.totalTokens
    usage.estimatedCost // undefined when pricing isn't known
    break
  case 'unmetered': // flat subscription — requests only
    usage.requests
    break
}
```

`formatUsage(usage)` gives a ready one-liner for a settings row.

Cost is only estimated when a catalog entry carries verified `pricing`. The kit
ships no price data — vendor prices change without notice, and a stale number
shown as fact is worse than no number. Supply pricing per model if you want
cost estimates.

## Rate limits

A 429 parks that **provider + model** pair until `retry-after` elapses;
subsequent calls throw `RateLimitedError` without touching the network. Parking
is keyed per provider *and* model, so one exhausted model doesn't block the
others, and the same model id served by two providers has two independent
limits.

## Model catalog

`builtInCatalog` seeds a curated list. It is data — extend or replace it:

```ts
createAiClient({ catalog: [...builtInCatalog, ...myModels], ... })
```

For a live list, `ai.discoverModels(providerId)` calls the provider's
`GET /models`; `mergeCatalog(curated, discovered)` folds results in while
preserving hand-authored limits, pricing and notes.

Discovered entries whose payload doesn't report modalities are marked
`vision: false` — the kit will not guess a capability and then auto-select the
model for a task that needs it.

> **Note on GitHub Models.** Its catalog carries OpenAI, DeepSeek, Meta,
> Mistral, Cohere and Microsoft models — but **no Grok and no GLM**, and its
> DeepSeek entries are text-only. Those models need their vendor's own API,
> which is what the `xai`, `deepseek` and `zai` providers are for.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```
