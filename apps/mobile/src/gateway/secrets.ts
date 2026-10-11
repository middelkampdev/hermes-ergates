/**
 * Minimal secret storage contract, next to the port so the device store can use
 * it without importing an adapter. The SecureStore adapter lives in
 * src/state/persistence.ts; `MemorySecretStore` is the in-memory fake.
 */
export interface SecretStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
}

/**
 * The sign-in storage the app hands to the gateway and the device store. It
 * starts as a pass-through to the persistent store. `useMemoryOnly()` switches
 * it, for the rest of the process, to keep the sign-in out of the phone's
 * storage (used on rooted and jailbroken phones, where other apps may read it).
 */
export interface AuthSecretStore extends SecretStore {
  readonly memoryOnly: boolean
  useMemoryOnly(): void
}

export function createAuthSecretStore(persistent: SecretStore): AuthSecretStore {
  const memory = new MemorySecretStore()
  let memoryOnly = false
  return {
    get memoryOnly() {
      return memoryOnly
    },
    useMemoryOnly() {
      memoryOnly = true
    },
    async get(key) {
      return memoryOnly ? memory.get(key) : persistent.get(key)
    },
    async set(key, value) {
      if (!memoryOnly) {
        return persistent.set(key, value)
      }
      await memory.set(key, value)
      // A copy stored before the switch would outlive this write: drop it so a refreshed cookie never leaves the old one on disk.
      await persistent.remove(key)
    },
    async remove(key) {
      if (!memoryOnly) {
        return persistent.remove(key)
      }
      await memory.remove(key)
      await persistent.remove(key)
    }
  }
}
