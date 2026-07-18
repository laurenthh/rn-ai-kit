/**
 * Storage inversion.
 *
 * The package never imports React Native. Anything that needs to persist —
 * API keys, rate-limit deadlines, usage counters — goes through a `KVStorage`
 * supplied by the host app. Travel-copilot passes a SecureStore-backed store
 * for secrets and an AsyncStorage-backed one for everything else; tests pass
 * an in-memory map.
 *
 * This mirrors the file-access inversion in `rn-backup-kit`.
 */

export interface KVStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * The two stores the kit needs.
 *
 * `secrets` should be backed by real secure storage (Keychain / Keystore) —
 * it only ever holds credentials. `data` holds non-sensitive counters and
 * deadlines and can be plain key-value storage. Passing the same store for
 * both works but puts credentials in unencrypted storage; only do that in
 * tests.
 */
export interface StorageBundle {
  secrets: KVStorage
  data: KVStorage
}

/** In-memory `KVStorage`, for tests and for non-persistent hosts. */
export function createMemoryStorage(
  initial?: Record<string, string>,
): KVStorage {
  const map = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    async get(key) {
      return map.get(key) ?? null
    },
    async set(key, value) {
      map.set(key, value)
    },
    async delete(key) {
      map.delete(key)
    },
  }
}

/** In-memory bundle with independent secret and data stores. */
export function createMemoryStorageBundle(initial?: {
  secrets?: Record<string, string>
  data?: Record<string, string>
}): StorageBundle {
  return {
    secrets: createMemoryStorage(initial?.secrets),
    data: createMemoryStorage(initial?.data),
  }
}

/**
 * Prefix every key of an existing store.
 *
 * Useful when the host app's storage is shared with unrelated app state and
 * you want the kit's keys namespaced away from it.
 */
export function namespaced(storage: KVStorage, prefix: string): KVStorage {
  const k = (key: string) => `${prefix}${key}`
  return {
    get: (key) => storage.get(k(key)),
    set: (key, value) => storage.set(k(key), value),
    delete: (key) => storage.delete(k(key)),
  }
}

/**
 * Wrap a store so every operation resolves rather than throws.
 *
 * The kit's persistence is best-effort: a failed counter write must never
 * take down a working chat call. Matches how travel-copilot's `secureStore`
 * swallowed storage errors at each call site.
 */
export function tolerant(storage: KVStorage): KVStorage {
  return {
    async get(key) {
      try {
        return await storage.get(key)
      } catch {
        return null
      }
    },
    async set(key, value) {
      try {
        await storage.set(key, value)
      } catch {
        /* best-effort */
      }
    },
    async delete(key) {
      try {
        await storage.delete(key)
      } catch {
        /* best-effort */
      }
    },
  }
}
