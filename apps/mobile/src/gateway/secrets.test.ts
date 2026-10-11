import { describe, expect, it } from 'vitest'

import { createAuthSecretStore, MemorySecretStore } from './secrets'

// The persistent MemorySecretStore stands in for SecureStore.
function setup() {
  const persistent = new MemorySecretStore()
  return { persistent, store: createAuthSecretStore(persistent) }
}

describe('createAuthSecretStore', () => {
  it('passes through to the persistent store by default', async () => {
    const { persistent, store } = setup()
    expect(store.memoryOnly).toBe(false)
    await store.set('k', 'v')
    expect(await persistent.get('k')).toBe('v')
    expect(await store.get('k')).toBe('v')
    await store.remove('k')
    expect(await persistent.get('k')).toBeNull()
  })

  it('keeps a new sign-in out of the persistent store in memory-only mode', async () => {
    const { persistent, store } = setup()
    store.useMemoryOnly()
    expect(store.memoryOnly).toBe(true)
    await store.set('k', 'v')
    expect(await store.get('k')).toBe('v')
    expect(await persistent.get('k')).toBeNull()
  })

  it('does not read a sign-in left in the persistent store in memory-only mode', async () => {
    const { persistent, store } = setup()
    await persistent.set('k', 'old')
    store.useMemoryOnly()
    expect(await store.get('k')).toBeNull()
  })

  it('removes a leftover persistent copy when a refreshed cookie is written', async () => {
    const { persistent, store } = setup()
    await persistent.set('k', 'old')
    store.useMemoryOnly()
    await store.set('k', 'new')
    expect(await persistent.get('k')).toBeNull()
    expect(await store.get('k')).toBe('new')
  })

  it('forgets the memory copy on remove', async () => {
    const { store } = setup()
    store.useMemoryOnly()
    await store.set('k', 'v')
    await store.remove('k')
    expect(await store.get('k')).toBeNull()
  })

  it('removes a leftover persistent copy on remove in memory-only mode', async () => {
    const { persistent, store } = setup()
    await persistent.set('k', 'old')
    store.useMemoryOnly()
    await store.remove('k')
    expect(await persistent.get('k')).toBeNull()
  })

  it('keeps using memory after the switch when asked to switch again', async () => {
    const { persistent, store } = setup()
    store.useMemoryOnly()
    await store.set('k', 'v')
    store.useMemoryOnly()
    expect(store.memoryOnly).toBe(true)
    expect(await store.get('k')).toBe('v')
    expect(await persistent.get('k')).toBeNull()
  })
})
