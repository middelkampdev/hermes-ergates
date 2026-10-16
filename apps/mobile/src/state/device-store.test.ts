import { describe, expect, it, vi } from 'vitest'

import { createDeviceStore, defaultPrefs, draftKey, waitForHydration, type Connection, type PersistedDeviceState } from './device-store'
import { orgActions, type BotRow } from './organization'
import { UNSENT_RETENTION_MS, type OutboxItem } from './outbox'
import type { ProvisioningRun } from './provisioning'
import { NodeCipher } from '@test/node-cipher'

import { DEVICE_STORAGE_KEY, MemorySecretStore, createMemoryStateStorage, createMemoryStorageJson, createSealedStorageJson, secretKey } from './persistence'
import { SEALED_PREFIX } from './sealed-storage'

/** The raw ciphertext bytes of a stored value, decoded past the sealed prefix and its base64 wrapper. */
function sealedBytes(raw: string): Buffer {
  return Buffer.from(raw.slice(SEALED_PREFIX.length), 'base64')
}

function newStore() {
  return createDeviceStore(createMemoryStorageJson<PersistedDeviceState>(), new MemorySecretStore())
}

const conn1: Connection = { id: 'c1', label: 'A', baseUrl: 'http://a.example', authMode: 'token', primary: true, createdAt: 1 }
const conn2: Connection = { id: 'c2', label: 'B', baseUrl: 'http://b.example', authMode: 'password', primary: false, createdAt: 2 }

/** Linh is pinned in Hermes; Kevin and Mia have no Hermes values yet. */
const roster: BotRow[] = [
  { profile: 'linh', hidden: false, lastActivityAt: 300, pinned: true, revision: 1 },
  { profile: 'kevin', hidden: false, lastActivityAt: 200 },
  { profile: 'mia', hidden: false, lastActivityAt: 100 }
]

const prive = { id: 'prive', name: 'Prive', collapsed: false, order: 0 }

function counter() {
  let n = 0
  return () => String(++n)
}

describe('connections', () => {
  it('adds and updates connections', () => {
    const store = newStore()
    store.getState().addConnection(conn1)
    store.getState().updateConnection('c1', { label: 'Renamed', lastProfile: 'linh' })
    expect(store.getState().connections).toEqual([{ ...conn1, label: 'Renamed', lastProfile: 'linh' }])
  })

  it('setPrimaryConnection makes exactly one connection primary', () => {
    const store = newStore()
    store.getState().addConnection(conn1)
    store.getState().addConnection(conn2)
    store.getState().setPrimaryConnection('c2')
    expect(store.getState().connections.find(c => c.id === 'c1')?.primary).toBe(false)
    expect(store.getState().connections.find(c => c.id === 'c2')?.primary).toBe(true)
  })
})

describe('organization actions', () => {
  it('runs organizing actions on the shared view, keeps the order here and queues pins and sections, per connection id', () => {
    const store = createDeviceStore(createMemoryStorageJson<PersistedDeviceState>(), new MemorySecretStore(), { newId: counter() })
    const s = () => store.getState()
    s().syncWithHermes('c1', roster)
    expect(s().organization.c1.rowOrder).toEqual(['linh', 'kevin', 'mia'])
    expect(s().organization.c1.pins).toEqual(['linh'])

    s().organize('c1', roster, view => orgActions.moveRowsToSection(orgActions.createSection(view, prive), ['mia', 'kevin'], 'prive'))
    s().organize('c1', roster, view => orgActions.pinMany(view, ['kevin']))
    s().organize('c1', roster, view => orgActions.applyMove(view, { kind: 'pin', profile: 'kevin', before: 'linh' }))
    let org = s().organization.c1
    expect(org.sections).toEqual([prive])
    expect(org.rowOrder).toEqual(['linh', 'kevin', 'mia'])
    expect(org.pins).toEqual(['kevin', 'linh'])
    expect(org.outbox.map(item => [item.id, item.profile, item.field, item.status])).toEqual([
      ['1', 'kevin', 'section', 'queued'],
      ['2', 'mia', 'section', 'queued'],
      ['3', 'kevin', 'pinned', 'queued']
    ])

    s().toggleCollapsed('c1', 'prive')
    s().markUnread('c1', 'kevin')
    org = s().organization.c1
    expect(org.sections[0].collapsed).toBe(true)
    expect(org.manualUnread.kevin).toBe(true)

    s().markRead('c1', 'kevin', 900)
    org = s().organization.c1
    expect(org.manualUnread.kevin).toBeUndefined()
    expect(org.lastOpenedAt.kevin).toBe(900)
    expect(s().organization.c2).toBeUndefined()
  })

  it('leaves the state object alone when an action changes nothing, and creates no organization', () => {
    const store = newStore()
    const before = store.getState()
    store.getState().syncWithHermes('c1', [])
    store.getState().organize('c1', roster, view => orgActions.unpin(view, 'mia'))
    expect(store.getState()).toBe(before)
    expect(store.getState().organization.c1).toBeUndefined()
    store.getState().syncWithHermes('c1', roster)
    const synced = store.getState()
    store.getState().syncWithHermes('c1', roster)
    expect(store.getState()).toBe(synced)
  })

  it('leaves the state object alone when marking already-set profiles unread or read again', () => {
    const store = newStore()
    store.getState().markManyUnread('c1', ['kevin', 'linh'])
    const afterUnread = store.getState()
    store.getState().markManyUnread('c1', ['kevin', 'linh'])
    expect(store.getState()).toBe(afterUnread)

    store.getState().markManyRead('c1', ['kevin', 'linh'], 900)
    const afterRead = store.getState()
    store.getState().markManyRead('c1', ['kevin', 'linh'], 900)
    expect(store.getState()).toBe(afterRead)
  })

  it('hydrates an organization from before shared pins and sections for its first sync, and keeps a later state', async () => {
    const storage = createMemoryStorageJson<PersistedDeviceState>()
    const org = { pins: ['kevin'], rowOrder: [], sections: [], membership: {}, manualUnread: {}, lastOpenedAt: {}, exchangeAcks: {}, outbox: [] }
    await storage.setItem('ergates-device-v1', {
      state: { connections: [conn1], organization: { c1: org, c2: { ...org, firstSync: 'done' }, c3: { ...org, firstSync: 'install' } } as never, prefs: defaultPrefs, drafts: {}, outbox: [], provisioning: [] },
      version: 1
    })
    const store = createDeviceStore(storage, new MemorySecretStore())
    await waitForHydration(store)
    expect(['c1', 'c2', 'c3'].map(id => store.getState().organization[id].firstSync)).toEqual(['update', 'done', 'install'])
  })

  it('hydrates an organization without a row order, or with a wrong-type one, with an empty order', async () => {
    const storage = createMemoryStorageJson<PersistedDeviceState>()
    const org = { pins: ['kevin'], sections: [], membership: {}, manualUnread: {}, lastOpenedAt: {}, exchangeAcks: {} }
    await storage.setItem('ergates-device-v1', {
      state: {
        connections: [conn1],
        organization: { c1: org, c2: { ...org, rowOrder: 'kevin' }, c3: { ...org, rowOrder: ['mia', 7, 'kevin'] } } as never,
        prefs: defaultPrefs,
        drafts: {},
        outbox: [],
        provisioning: []
      },
      version: 1
    })
    const store = createDeviceStore(storage, new MemorySecretStore())
    await waitForHydration(store)
    expect(store.getState().organization.c1.rowOrder).toEqual([])
    expect(store.getState().organization.c2.rowOrder).toEqual([])
    expect(store.getState().organization.c3.rowOrder).toEqual(['mia', 'kevin'])
    expect(store.getState().organization.c1.pins).toEqual(['kevin'])
  })
})

describe('drafts', () => {
  it('keys drafts by connectionId:profile and leaves others alone', () => {
    const store = newStore()
    store.getState().setDraft('c1', 'linh', 'hello')
    store.getState().setDraft('c1', 'kevin', 'hi')
    expect(store.getState().drafts[draftKey('c1', 'linh')]).toBe('hello')
    expect(store.getState().drafts[draftKey('c1', 'kevin')]).toBe('hi')

    store.getState().clearDraft('c1', 'linh')
    expect(store.getState().drafts[draftKey('c1', 'linh')]).toBeUndefined()
    expect(store.getState().drafts[draftKey('c1', 'kevin')]).toBe('hi')
  })
})

describe('removeConnection', () => {
  it('clears that connection organization, drafts, outbox and secure entries, keeping prefs and other connections', async () => {
    const secrets = new MemorySecretStore()
    await secrets.set(secretKey('c1', 'token'), 'tok')
    await secrets.set(secretKey('c1', 'cookie'), 'ck')
    await secrets.set(secretKey('c1', 'mode'), 'token')

    const store = createDeviceStore(createMemoryStorageJson<PersistedDeviceState>(), secrets)
    store.getState().addConnection(conn1)
    store.getState().addConnection(conn2)
    store.getState().markUnread('c1', 'linh')
    store.getState().setDraft('c1', 'linh', 'hi')
    store.getState().setDraft('c2', 'kevin', 'yo')
    store.getState().addOutboxItem({ localId: 'l1', connectionId: 'c1', profile: 'linh', text: 'x', createdAt: Date.now(), status: 'draft' })
    store.getState().addOutboxItem({ localId: 'l2', connectionId: 'c2', profile: 'kevin', text: 'y', createdAt: Date.now(), status: 'draft' })
    store.getState().setPrefs({ haptics: false })

    await store.getState().removeConnection('c1')

    const state = store.getState()
    expect(state.connections.map(c => c.id)).toEqual(['c2'])
    expect(state.organization.c1).toBeUndefined()
    expect(state.drafts[draftKey('c1', 'linh')]).toBeUndefined()
    expect(state.drafts[draftKey('c2', 'kevin')]).toBe('yo')
    expect(state.outbox.map(o => o.localId)).toEqual(['l2'])
    expect(state.prefs.haptics).toBe(false)

    expect(await secrets.get(secretKey('c1', 'token'))).toBeNull()
    expect(await secrets.get(secretKey('c1', 'cookie'))).toBeNull()
    expect(await secrets.get(secretKey('c1', 'mode'))).toBeNull()
  })
})

describe('persistence', () => {
  it('shares state across store instances backed by the same storage', async () => {
    const storage = createMemoryStorageJson<PersistedDeviceState>()
    const secrets = new MemorySecretStore()

    const store1 = createDeviceStore(storage, secrets)
    await waitForHydration(store1)
    store1.getState().addConnection(conn1)
    store1.getState().organize('c1', roster, view => orgActions.pin(view, 'kevin'))
    store1.getState().setDraft('c1', 'linh', 'hello')
    store1.getState().setPrefs({ themeName: 'dark' })

    const store2 = createDeviceStore(storage, secrets)
    await waitForHydration(store2)
    const state2 = store2.getState()

    expect(state2.connections).toEqual([conn1])
    expect(state2.organization.c1.pins).toEqual(['linh', 'kevin'])
    expect(state2.organization.c1.outbox).toMatchObject([{ profile: 'kevin', field: 'pinned', pinned: true, status: 'queued' }])
    expect(state2.drafts[draftKey('c1', 'linh')]).toBe('hello')
    expect(state2.prefs.themeName).toBe('dark')
  })

  it('keeps a connection\'s pending plugin setup across a restart', async () => {
    const storage = createMemoryStorageJson<PersistedDeviceState>()
    const commit = 'e'.repeat(40)
    const a = createDeviceStore(storage, new MemorySecretStore())
    await waitForHydration(a)
    a.getState().addConnection(conn1)
    a.getState().updateConnection('c1', { pendingPluginSetup: commit })

    const b = createDeviceStore(storage, new MemorySecretStore())
    await waitForHydration(b)

    expect(b.getState().connections).toEqual([{ ...conn1, pendingPluginSetup: commit }])
  })

  it('keeps what a connection knows about its plugin updates across a restart', async () => {
    const storage = createMemoryStorageJson<PersistedDeviceState>()
    const updateState = {
      autoUpdatePlugin: false,
      askedUpdateFor: 'b'.repeat(40),
      pluginUpdate: { target: 'b'.repeat(40), previous: 'a'.repeat(40), previousSchema: 2 },
      pluginRemountsFrom: '0.21.6',
      pluginUpdatedNotice: { from: '0.2.0', to: '0.3.0' },
      pluginWentBack: { to: 'a'.repeat(40), from: 'b'.repeat(40) }
    }
    const a = createDeviceStore(storage, new MemorySecretStore())
    await waitForHydration(a)
    a.getState().addConnection(conn1)
    a.getState().updateConnection('c1', updateState)

    const b = createDeviceStore(storage, new MemorySecretStore())
    await waitForHydration(b)

    expect(b.getState().connections).toEqual([{ ...conn1, ...updateState }])
  })

  it('recovers submitting outbox items as unconfirmed and drops expired ones on rehydrate', async () => {
    const storage = createMemoryStorageJson<PersistedDeviceState>()
    const secrets = new MemorySecretStore()
    const now = Date.now()

    const submitting: OutboxItem = { localId: 'l1', connectionId: 'c1', profile: 'linh', text: 'hi', createdAt: now, status: 'submitting' }
    const expiredUnsent: OutboxItem = { localId: 'l2', connectionId: 'c1', profile: 'linh', text: 'old', createdAt: now - UNSENT_RETENTION_MS - 1000, status: 'queued_unsent' }
    const freshDraft: OutboxItem = { localId: 'l3', connectionId: 'c1', profile: 'linh', text: 'draft', createdAt: now, status: 'draft' }

    const seeded: PersistedDeviceState = {
      connections: [],
      organization: {},
      prefs: defaultPrefs,
      drafts: {},
      outbox: [submitting, expiredUnsent, freshDraft],
      provisioning: []
    }
    await storage.setItem('ergates-device-v1', { state: seeded, version: 0 })

    const store = createDeviceStore(storage, secrets)
    await waitForHydration(store)

    const outbox = store.getState().outbox
    expect(outbox.find(i => i.localId === 'l1')?.status).toBe('unconfirmed')
    expect(outbox.find(i => i.localId === 'l2')).toBeUndefined()
    expect(outbox.find(i => i.localId === 'l3')?.status).toBe('draft')
  })
})

describe('exchange acknowledgements (spec 12.1, ADR-028)', () => {
  it('stores identities per connection and profile and round-trips through storage', async () => {
    const storage = createMemoryStorageJson<PersistedDeviceState>()
    const a = createDeviceStore(storage, new MemorySecretStore())
    a.getState().acknowledgeExchanges('c1', 'kevin', ['send:call_1', 'answer:31'])
    a.getState().acknowledgeExchanges('c1', 'kevin', ['answer:31', 'return:proc_1'])
    expect(a.getState().organization.c1.exchangeAcks).toEqual({ kevin: ['send:call_1', 'answer:31', 'return:proc_1'] })
    await new Promise(resolve => setTimeout(resolve, 0))

    const b = createDeviceStore(storage, new MemorySecretStore())
    await waitForHydration(b)
    expect(b.getState().organization.c1.exchangeAcks).toEqual({ kevin: ['send:call_1', 'answer:31', 'return:proc_1'] })
  })

  it('hydrates a persisted organization that predates the field with an empty acknowledgement map', async () => {
    const storage = createMemoryStorageJson<PersistedDeviceState>()
    await storage.setItem('ergates-device-v1', {
      state: {
        connections: [conn1],
        organization: { c1: { pins: ['kevin'], sections: [], membership: {}, manualUnread: {}, lastOpenedAt: {} } as never },
        prefs: defaultPrefs,
        drafts: {},
        outbox: [],
        provisioning: []
      },
      version: 1
    })
    const store = createDeviceStore(storage, new MemorySecretStore())
    await waitForHydration(store)
    expect(store.getState().organization.c1.exchangeAcks).toEqual({})
    expect(store.getState().organization.c1.pins).toEqual(['kevin'])
  })

  it('clears acknowledgements with the rest of the connection state on removal', async () => {
    const store = newStore()
    store.getState().addConnection(conn1)
    store.getState().acknowledgeExchanges('c1', 'kevin', ['send:call_1'])
    await store.getState().removeConnection('c1')
    expect(store.getState().organization.c1).toBeUndefined()
  })
})

describe('agent setup runs (docs/11 section 4.1)', () => {
  const run = (proposalId: string, connectionId = 'c1'): ProvisioningRun => ({
    proposalId,
    connectionId,
    sourceProfile: 'concierge',
    proposal: { proposal_id: proposalId, briefing: 'Seed facts.' },
    startedAt: 1
  })

  it('keeps an accepted agent setup across a restart until it is removed', async () => {
    const storage = createMemoryStorageJson<PersistedDeviceState>()
    const a = createDeviceStore(storage, new MemorySecretStore())
    await waitForHydration(a)
    a.getState().saveProvisioningRun(run('p-1'))
    a.getState().saveProvisioningRun({ ...run('p-1'), startedAt: 2 })

    const b = createDeviceStore(storage, new MemorySecretStore())
    await waitForHydration(b)
    expect(b.getState().provisioning).toEqual([{ ...run('p-1'), startedAt: 2 }])

    b.getState().removeProvisioningRun('p-1')
    expect(b.getState().provisioning).toEqual([])
  })

  it('reads a blob from before agent setups as having none', async () => {
    const storage = createMemoryStorageJson<PersistedDeviceState>()
    await storage.setItem('ergates-device-v1', { state: { connections: [conn1], organization: {}, prefs: defaultPrefs, drafts: {}, outbox: [] } as never, version: 1 })
    const store = createDeviceStore(storage, new MemorySecretStore())
    await waitForHydration(store)
    expect(store.getState().provisioning).toEqual([])
  })

  it('reads a blob from before the root notice as not having shown it', async () => {
    const storage = createMemoryStorageJson<PersistedDeviceState>()
    const { rootedNoticeSeen: _omitted, ...oldPrefs } = defaultPrefs
    await storage.setItem('ergates-device-v1', { state: { connections: [conn1], organization: {}, prefs: oldPrefs, drafts: {}, outbox: [] } as never, version: 1 })
    const store = createDeviceStore(storage, new MemorySecretStore())
    await waitForHydration(store)
    expect(store.getState().prefs.rootedNoticeSeen).toBe(false)
  })

  it('drops a connection agent setups with the connection', async () => {
    const store = newStore()
    store.getState().addConnection(conn1)
    store.getState().saveProvisioningRun(run('p-1', 'c1'))
    store.getState().saveProvisioningRun(run('p-2', 'c2'))
    await store.getState().removeConnection('c1')
    expect(store.getState().provisioning.map(r => r.proposalId)).toEqual(['p-2'])
  })
})

describe('the device blob at rest', () => {
  const legacyRun: ProvisioningRun = {
    proposalId: 'p-9',
    connectionId: 'c1',
    sourceProfile: 'concierge',
    proposal: { proposal_id: 'p-9', briefing: 'Seed facts about the Acme account.' },
    startedAt: 5
  }
  const legacyDraft: OutboxItem = { localId: 'l1', connectionId: 'c1', profile: 'linh', text: 'call Dirk back', createdAt: Date.now(), status: 'draft' }
  const legacyState: PersistedDeviceState = {
    connections: [conn1],
    organization: { c1: { pins: ['linh'], rowOrder: [], sections: [], membership: {}, manualUnread: {}, lastOpenedAt: {}, exchangeAcks: {}, outbox: [], firstSync: 'update' } },
    prefs: { ...defaultPrefs, themeName: 'dark' },
    drafts: { 'c1:linh': 'the invoice from Dirk' },
    outbox: [legacyDraft],
    provisioning: [legacyRun]
  }
  const secretTexts = ['Dirk', 'Acme', 'a.example', 'linh']

  it('an install upgrading with a plaintext blob loses nothing, and the blob is stored encrypted at once', async () => {
    const disk = createMemoryStateStorage()
    await disk.setItem(DEVICE_STORAGE_KEY, JSON.stringify({ state: legacyState, version: 1 }))
    const storage = createSealedStorageJson<PersistedDeviceState>(disk, new NodeCipher())

    const upgraded = createDeviceStore(storage, new MemorySecretStore())
    await waitForHydration(upgraded)

    expect(upgraded.getState().connections).toEqual([conn1])
    expect(upgraded.getState().organization.c1.pins).toEqual(['linh'])
    expect(upgraded.getState().prefs.themeName).toBe('dark')
    expect(upgraded.getState().drafts).toEqual({ 'c1:linh': 'the invoice from Dirk' })
    expect(upgraded.getState().outbox).toEqual([legacyDraft])
    expect(upgraded.getState().provisioning).toEqual([legacyRun])

    const atRest = (await disk.getItem(DEVICE_STORAGE_KEY)) as string
    expect(atRest.startsWith(SEALED_PREFIX)).toBe(true)
    const atRestBytes = sealedBytes(atRest)
    for (const text of secretTexts) {
      expect(atRestBytes.includes(text)).toBe(false)
    }
  })

  it('stores every later write encrypted, and the next launch reads all of it', async () => {
    const disk = createMemoryStateStorage()
    await disk.setItem(DEVICE_STORAGE_KEY, JSON.stringify({ state: legacyState, version: 1 }))
    const storage = createSealedStorageJson<PersistedDeviceState>(disk, new NodeCipher())
    const first = createDeviceStore(storage, new MemorySecretStore())
    await waitForHydration(first)

    first.getState().setDraft('c1', 'kevin', 'ask Dirk about the Acme contract')

    const next = createDeviceStore(storage, new MemorySecretStore())
    await waitForHydration(next)
    expect(next.getState().drafts).toEqual({ 'c1:linh': 'the invoice from Dirk', 'c1:kevin': 'ask Dirk about the Acme contract' })
    expect(next.getState().provisioning).toEqual([legacyRun])
    const atRest = (await disk.getItem(DEVICE_STORAGE_KEY)) as string
    expect(atRest.startsWith(SEALED_PREFIX)).toBe(true)
    expect(sealedBytes(atRest).includes('contract')).toBe(false)
  })
})

describe('default useDeviceStore', () => {
  it('is importable in Node with sane defaults and never touches AsyncStorage on import', async () => {
    vi.resetModules()
    const AsyncStorageModule = await import('@react-native-async-storage/async-storage')
    const getItemSpy = vi.spyOn(AsyncStorageModule.default, 'getItem')
    const setItemSpy = vi.spyOn(AsyncStorageModule.default, 'setItem')

    const mod = await import('./device-store')

    expect(mod.useDeviceStore.getState().connections).toEqual([])
    expect(mod.useDeviceStore.getState().prefs).toEqual(mod.defaultPrefs)
    expect(getItemSpy).not.toHaveBeenCalled()
    expect(setItemSpy).not.toHaveBeenCalled()

    getItemSpy.mockRestore()
    setItemSpy.mockRestore()
  })
})

describe('deleting a section', () => {
  it('queues No section for its members and removes it, for that connection only', () => {
    const store = newStore()
    const s = () => store.getState()
    const inPrive = roster.map(row => (row.profile === 'kevin' ? { ...row, sectionId: 'prive', sectionName: 'Prive' } : row))
    s().syncWithHermes('c1', inPrive)
    expect(s().organization.c1.sections).toEqual([prive])
    s().organize('c1', inPrive, view => orgActions.deleteSection(view, 'prive'))
    expect(s().organization.c1.sections).toEqual([])
    expect(s().organization.c1.rowOrder).toEqual(['linh', 'mia', 'kevin'])
    expect(s().organization.c1.outbox).toMatchObject([{ profile: 'kevin', field: 'section', sectionId: null, sectionName: null }])
    expect(s().organization.c2).toBeUndefined()
  })
})

describe('the organization outbox', () => {
  const pinLinh = { id: 'o1', profile: 'linh', field: 'pinned', pinned: true, status: 'queued' } as const

  it('changes one connection outbox through one action, and leaves the state alone when nothing changes', () => {
    const store = newStore()
    store.getState().updateOrgOutbox('c1', outbox => [...outbox, pinLinh])
    expect(store.getState().organization.c1.outbox).toEqual([pinLinh])
    expect(store.getState().organization.c2).toBeUndefined()
    const before = store.getState()
    store.getState().updateOrgOutbox('c1', outbox => outbox)
    store.getState().updateOrgOutbox('c2', outbox => outbox)
    expect(store.getState()).toBe(before)
  })

  it('keeps queued changes across a restart, and sends an unanswered write again', async () => {
    const storage = createMemoryStorageJson<PersistedDeviceState>()
    const secrets = new MemorySecretStore()
    const first = createDeviceStore(storage, secrets, { newId: counter() })
    await waitForHydration(first)

    first.getState().organize('c1', roster, view => orgActions.pin(view, 'mia'))
    first.getState().updateOrgOutbox('c1', outbox => outbox.map(item => ({ ...item, status: 'sending' })))
    first.getState().updateOrgOutbox('c1', outbox => [...outbox, { id: 'o2', profile: 'kevin', field: 'section', sectionId: 'prive', sectionName: 'Prive', status: 'sent', revision: 4 }])
    first.getState().syncWithHermes('c2', roster)

    const second = createDeviceStore(storage, secrets)
    await waitForHydration(second)
    expect(second.getState().organization.c1.outbox.map(item => [item.id, item.status])).toEqual([
      ['1', 'queued'],
      ['o2', 'sent']
    ])
    expect(second.getState().organization.c1.firstSync).toBe('install')
    expect(second.getState().organization.c2.firstSync).toBe('done')
  })

  it('hydrates an organization from before the outbox with an empty one', async () => {
    const storage = createMemoryStorageJson<PersistedDeviceState>()
    const org = { pins: ['kevin'], rowOrder: [], sections: [], membership: {}, manualUnread: {}, lastOpenedAt: {}, exchangeAcks: {} }
    await storage.setItem('ergates-device-v1', {
      state: { connections: [conn1], organization: { c1: org, c2: { ...org, outbox: 'o1' } } as never, prefs: defaultPrefs, drafts: {}, outbox: [], provisioning: [] },
      version: 1
    })
    const store = createDeviceStore(storage, new MemorySecretStore())
    await waitForHydration(store)
    expect(store.getState().organization.c1.outbox).toEqual([])
    expect(store.getState().organization.c2.outbox).toEqual([])
    expect(store.getState().organization.c1.firstSync).toBe('update')
    expect(store.getState().organization.c2.firstSync).toBe('update')
  })

  it('clears queued changes with the connection, and a deleted agent takes its changes along', async () => {
    const store = newStore()
    const s = () => store.getState()
    s().updateOrgOutbox('c1', () => [pinLinh])
    s().syncWithHermes('c2', roster)
    s().updateOrgOutbox('c2', () => [{ ...pinLinh, profile: 'kevin' }, pinLinh])

    s().forgetProfile('c2', 'linh', 5)
    expect(s().organization.c2.outbox.map(item => item.profile)).toEqual(['kevin'])
    expect(s().organization.c2.pins).toEqual([])
    expect(s().organization.c2.rowOrder).toEqual(['kevin', 'mia'])
    expect(s().organization.c2.lastOpenedAt.linh).toBe(5)

    await s().removeConnection('c1')
    expect(s().organization.c1).toBeUndefined()
    expect(s().organization.c2.outbox).toHaveLength(1)
  })
})
