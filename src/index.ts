export {
  createAiClient,
  RateLimitedError,
  ProviderApiError,
  NoSuitableModelError,
  type AiClient,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type ContentPart,
  type CreateAiClientOptions,
} from './client'

export {
  defineAiTask,
  parseJson,
  repairTruncatedJson,
  AiTaskError,
  type AiTask,
  type AiTaskDefinition,
  type Validator,
} from './task'

export {
  builtInProviders,
  defineProvider,
  describeBilling,
  findProvider,
  githubModels,
  deepseek,
  xai,
  zai,
  type AuthScheme,
  type BillingModel,
  type CredentialField,
  type Provider,
} from './providers'

export {
  builtInCatalog,
  directProviderCatalog,
  githubModelsCatalog,
  findModel,
  mergeCatalog,
  parseDiscoveredModels,
  resolveModel,
  satisfies,
  type ModelInfo,
  type ModelRequirements,
} from './catalog'

export {
  buildAuthHeaders,
  createCredentialStore,
  credentialStorageKey,
  MissingCredentialsError,
  type CredentialStore,
  type EnvSource,
  type ResolvedCredentials,
} from './credentials'

export {
  createUsageTracker,
  formatUsage,
  rateLimitKey,
  readTokenUsage,
  summarizeRecord,
  usageKey,
  type ModelPricing,
  type TokenUsage,
  type UsageRecord,
  type UsageSummary,
  type UsageTracker,
} from './usage'

export {
  createMemoryStorage,
  createMemoryStorageBundle,
  namespaced,
  tolerant,
  type KVStorage,
  type StorageBundle,
} from './storage'
