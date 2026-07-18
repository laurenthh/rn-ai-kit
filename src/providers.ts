/**
 * Providers — where a model actually lives, how you authenticate to it, and
 * how it bills you.
 *
 * The kit does not assume GitHub Models. A provider is data: a base URL, an
 * auth scheme, the credential fields the user must supply, and a billing
 * model. Every provider bundled here speaks the OpenAI chat-completions
 * wire format, which is why one transport serves all of them — but that is a
 * property of these particular providers, not a requirement baked into the
 * type.
 *
 * Models that are not in any bundled provider's catalog (Grok, GLM, a
 * self-hosted endpoint) are added by defining a provider, not by patching the
 * kit. See `defineProvider`.
 */

/**
 * How a provider charges for use. This drives what the host app should show
 * the user in a "usage" screen — a request-quota provider and a pay-per-token
 * provider need genuinely different displays, not the same counter with a
 * different label.
 */
export type BillingModel =
  /**
   * Access is included with something the user already pays for (or a free
   * tier), and is metered as a capped number of requests per period. There is
   * no marginal cost per call; what matters is how much of the allowance is
   * left. GitHub Models works this way.
   */
  | {
      kind: 'quota'
      unit: 'requests'
      period: 'daily'
      /** Where the allowance comes from, for display. */
      source: string
    }
  /**
   * Billed per token consumed. There is no cap to display; what matters is
   * tokens used and, when pricing is known, the money that represents.
   */
  | {
      kind: 'per-token'
      currency: 'USD'
      /** Where the user tops up / sees the real bill. */
      billingUrl?: string
    }
  /**
   * Flat recurring fee with no per-call metering exposed to the client.
   * Tracked as request counts only, with no cap and no cost attribution.
   */
  | {
      kind: 'subscription'
      /** Plan name or tier, for display. */
      plan?: string
      billingUrl?: string
    }

/**
 * A credential the user must supply before a provider can be used.
 *
 * Providers differ here — most want a single API key, but a self-hosted or
 * enterprise endpoint may also need an org/project id or a custom base URL.
 * The host app renders one input per field; the kit resolves them by key.
 */
export type CredentialField = {
  /** Stable key, unique within the provider. Used as the storage key. */
  key: string
  label: string
  /** Secrets go to the secure store and are never echoed back to the UI. */
  secret: boolean
  /** Optional environment-variable fallback, checked when nothing is stored. */
  envVar?: string
  /** Field is optional — resolution succeeds without it. */
  optional?: boolean
  placeholder?: string
  /** Where the user goes to obtain this value. */
  helpUrl?: string
}

export type AuthScheme =
  /** `Authorization: Bearer <value>` */
  | { kind: 'bearer'; credentialKey: string }
  /** Arbitrary header, e.g. `x-api-key: <value>` */
  | { kind: 'header'; header: string; credentialKey: string }
  /** No credential required (local/self-hosted endpoints). */
  | { kind: 'none' }

export type Provider = {
  /** Stable id, used in storage keys and model references. */
  id: string
  label: string
  /** Origin + path prefix, no trailing slash. */
  baseUrl: string
  /** Chat-completions path, appended to `baseUrl`. */
  chatPath: string
  /**
   * OpenAI-style `GET /models` path, when the provider exposes one. Enables
   * `client.discoverModels(providerId)`.
   */
  modelsPath?: string
  auth: AuthScheme
  /** Sent on every request, merged before auth. */
  extraHeaders?: Record<string, string>
  billing: BillingModel
  credentials: CredentialField[]
  docsUrl?: string
}

/**
 * Define a provider, filling in the defaults that hold for any
 * OpenAI-compatible endpoint.
 *
 * This is the extension point for models the bundled providers don't carry.
 * Adding Grok, for example, is a provider definition plus catalog entries —
 * no change to the kit:
 *
 * ```ts
 * const xai = defineProvider({
 *   id: 'xai',
 *   label: 'xAI',
 *   baseUrl: 'https://api.x.ai/v1',
 *   billing: { kind: 'per-token', currency: 'USD' },
 * })
 * ```
 */
export function defineProvider(
  spec: Omit<Provider, 'chatPath' | 'auth' | 'credentials'> &
    Partial<Pick<Provider, 'chatPath' | 'auth' | 'credentials'>>,
): Provider {
  return {
    chatPath: '/chat/completions',
    modelsPath: '/models',
    auth: { kind: 'bearer', credentialKey: 'apiKey' },
    credentials: [
      {
        key: 'apiKey',
        label: 'API key',
        secret: true,
        placeholder: 'sk-…',
      },
    ],
    ...spec,
  }
}

// ── Bundled providers ──────────────────────────────────────────────────────
//
// Base URLs and auth schemes verified against each provider's own API
// reference on 2026-07-18. Model ids live in `catalog.ts`, deliberately
// separate: ids churn far faster than endpoints do.

/**
 * GitHub Models. Included with a GitHub account; metered as a per-model daily
 * request quota rather than per token, which is why its billing kind is
 * `quota` and its usage display is "N of M requests left today".
 */
export const githubModels: Provider = {
  id: 'github-models',
  label: 'GitHub Models',
  baseUrl: 'https://models.github.ai',
  chatPath: '/inference/chat/completions',
  // Public — unauthenticated GET returns the full catalog.
  modelsPath: '/catalog/models',
  auth: { kind: 'bearer', credentialKey: 'apiKey' },
  extraHeaders: { Accept: 'application/vnd.github+json' },
  billing: {
    kind: 'quota',
    unit: 'requests',
    period: 'daily',
    source: 'GitHub account (free tier)',
  },
  credentials: [
    {
      key: 'apiKey',
      label: 'GitHub personal access token',
      secret: true,
      envVar: 'GITHUB_MODELS_TOKEN',
      placeholder: 'github_pat_…',
      helpUrl: 'https://github.com/settings/personal-access-tokens',
    },
  ],
  docsUrl: 'https://docs.github.com/github-models',
}

/** xAI (Grok). Pay-per-token; not available through GitHub Models. */
export const xai: Provider = defineProvider({
  id: 'xai',
  label: 'xAI (Grok)',
  baseUrl: 'https://api.x.ai/v1',
  billing: {
    kind: 'per-token',
    currency: 'USD',
    billingUrl: 'https://console.x.ai',
  },
  credentials: [
    {
      key: 'apiKey',
      label: 'xAI API key',
      secret: true,
      envVar: 'XAI_API_KEY',
      placeholder: 'xai-…',
      helpUrl: 'https://console.x.ai',
    },
  ],
  docsUrl: 'https://docs.x.ai/docs/api-reference',
})

/**
 * DeepSeek's own API. Distinct from the DeepSeek models carried by GitHub
 * Models — different credentials, different billing, different model ids.
 */
export const deepseek: Provider = defineProvider({
  id: 'deepseek',
  label: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  billing: {
    kind: 'per-token',
    currency: 'USD',
    billingUrl: 'https://platform.deepseek.com',
  },
  credentials: [
    {
      key: 'apiKey',
      label: 'DeepSeek API key',
      secret: true,
      envVar: 'DEEPSEEK_API_KEY',
      placeholder: 'sk-…',
      helpUrl: 'https://platform.deepseek.com/api_keys',
    },
  ],
  docsUrl: 'https://api-docs.deepseek.com/',
})

/** Z.ai / Zhipu open platform (GLM). Pay-per-token. */
export const zai: Provider = defineProvider({
  id: 'zai',
  label: 'Z.ai (GLM)',
  baseUrl: 'https://api.z.ai/api/paas/v4',
  billing: {
    kind: 'per-token',
    currency: 'USD',
    billingUrl: 'https://z.ai/manage-apikey/apikey-list',
  },
  credentials: [
    {
      key: 'apiKey',
      label: 'Z.ai API key',
      secret: true,
      envVar: 'ZAI_API_KEY',
      helpUrl: 'https://z.ai/manage-apikey/apikey-list',
    },
  ],
  docsUrl: 'https://docs.z.ai/guides/overview/quick-start',
})

/** Every provider bundled with the kit. */
export const builtInProviders: Provider[] = [
  githubModels,
  xai,
  deepseek,
  zai,
]

export function findProvider(
  providers: Provider[],
  id: string,
): Provider | undefined {
  return providers.find((p) => p.id === id)
}

/** Human-readable one-liner describing how a provider charges. */
export function describeBilling(billing: BillingModel): string {
  switch (billing.kind) {
    case 'quota':
      return `Included with ${billing.source} — capped at a daily request allowance per model`
    case 'per-token':
      return `Pay per token (${billing.currency})`
    case 'subscription':
      return billing.plan
        ? `Subscription (${billing.plan})`
        : 'Subscription — no per-call metering'
  }
}
