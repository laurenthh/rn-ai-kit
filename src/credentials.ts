/**
 * Credential resolution.
 *
 * Each provider declares the fields it needs (`Provider.credentials`); this
 * module stores, resolves, and reports on them. Resolution order per field is
 * stored value → environment fallback, matching travel-copilot's original
 * "SecureStore user key → .env" behaviour, generalised to N providers and N
 * fields per provider.
 *
 * The environment is injected rather than read from `process.env`, because
 * the package must not assume a Node-like global exists.
 */

import type { CredentialField, Provider } from './providers'
import type { KVStorage } from './storage'
import { tolerant } from './storage'

/** Values supplied by the host's environment (Expo `extra`, `.env`, …). */
export type EnvSource = Record<string, string | undefined>

export type CredentialStore = {
  /** Resolve one field: stored value → env fallback → null. */
  get(providerId: string, fieldKey: string): Promise<string | null>
  set(providerId: string, fieldKey: string, value: string): Promise<void>
  clear(providerId: string, fieldKey: string): Promise<void>
  /** True when a value is persisted (ignores the env fallback). */
  hasStored(providerId: string, fieldKey: string): Promise<boolean>
  /** Resolve every declared field for a provider. */
  resolve(provider: Provider): Promise<ResolvedCredentials>
  /** Required fields that resolve to nothing. Empty ⇒ provider is usable. */
  missingFields(provider: Provider): Promise<CredentialField[]>
  isConfigured(provider: Provider): Promise<boolean>
  /** Forget every stored field for a provider. */
  clearProvider(provider: Provider): Promise<void>
}

export type ResolvedCredentials = {
  values: Record<string, string>
  /** Which fields came from the environment rather than storage. */
  fromEnv: string[]
  missing: CredentialField[]
}

export function credentialStorageKey(
  providerId: string,
  fieldKey: string,
): string {
  return `rn-ai-kit.cred.${providerId}.${fieldKey}`
}

export function createCredentialStore(opts: {
  secrets: KVStorage
  env?: EnvSource
}): CredentialStore {
  const store = tolerant(opts.secrets)
  const env = opts.env ?? {}

  async function get(
    providerId: string,
    fieldKey: string,
  ): Promise<string | null> {
    const stored = await store.get(credentialStorageKey(providerId, fieldKey))
    if (stored) return stored
    return null
  }

  function envValue(field: CredentialField): string | null {
    if (!field.envVar) return null
    const raw = env[field.envVar]
    return raw && raw.length > 0 ? raw : null
  }

  async function resolveField(
    providerId: string,
    field: CredentialField,
  ): Promise<{ value: string | null; fromEnv: boolean }> {
    const stored = await get(providerId, field.key)
    if (stored) return { value: stored, fromEnv: false }
    const fallback = envValue(field)
    return { value: fallback, fromEnv: fallback !== null }
  }

  return {
    get,

    async set(providerId, fieldKey, value) {
      await store.set(credentialStorageKey(providerId, fieldKey), value)
    },

    async clear(providerId, fieldKey) {
      await store.delete(credentialStorageKey(providerId, fieldKey))
    },

    async hasStored(providerId, fieldKey) {
      return (await get(providerId, fieldKey)) !== null
    },

    async resolve(provider) {
      const values: Record<string, string> = {}
      const fromEnv: string[] = []
      const missing: CredentialField[] = []

      for (const field of provider.credentials) {
        const resolved = await resolveField(provider.id, field)
        if (resolved.value !== null) {
          values[field.key] = resolved.value
          if (resolved.fromEnv) fromEnv.push(field.key)
        } else if (!field.optional) {
          missing.push(field)
        }
      }

      return { values, fromEnv, missing }
    },

    async missingFields(provider) {
      return (await this.resolve(provider)).missing
    },

    async isConfigured(provider) {
      return (await this.missingFields(provider)).length === 0
    },

    async clearProvider(provider) {
      for (const field of provider.credentials) {
        await store.delete(credentialStorageKey(provider.id, field.key))
      }
    },
  }
}

/** Error thrown when a call is attempted without the required credentials. */
export class MissingCredentialsError extends Error {
  readonly providerId: string
  readonly fields: CredentialField[]

  constructor(provider: Provider, fields: CredentialField[]) {
    const names = fields.map((f) => f.label).join(', ')
    super(
      `${provider.label} is not configured — missing: ${names}. ` +
        `Add it in Settings${
          provider.docsUrl ? ` (get one at ${provider.docsUrl})` : ''
        }.`,
    )
    this.name = 'MissingCredentialsError'
    this.providerId = provider.id
    this.fields = fields
  }
}

/** Build the request headers for a provider from resolved credentials. */
export function buildAuthHeaders(
  provider: Provider,
  values: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(provider.extraHeaders ?? {}),
  }

  switch (provider.auth.kind) {
    case 'bearer': {
      const token = values[provider.auth.credentialKey]
      if (token) headers.Authorization = `Bearer ${token}`
      break
    }
    case 'header': {
      const token = values[provider.auth.credentialKey]
      if (token) headers[provider.auth.header] = token
      break
    }
    case 'none':
      break
  }

  return headers
}
