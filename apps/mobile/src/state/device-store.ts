/**
 * The device-local store (docs/05 section 3): connections, per-connection roster
 * organization, prefs, drafts, outbox and unfinished agent setups. Everything here is device-local; the
 * only part meant for Hermes is each organization's outbox of pin and section changes, which the agents
 * feature sends (docs/05 "Organization outbox").
 *
 * `createDeviceStore(storage, secrets)` takes its dependencies as arguments so this
 * module stays importable under plain Node (unit tests inject in-memory fakes from
 * `persistence.ts`). The default `useDeviceStore` export wires up the real
 * sealed AsyncStorage blob and SecureStore adapters but is created with `skipHydration: true`, so
 * merely importing this module never reads AsyncStorage; the app calls
 * `useDeviceStore.persist.rehydrate()` once it is actually running on device.
 */
import { create } from 'zustand'
import { persist, type PersistStorage } from 'zustand/middleware'

import type { SecretStore } from '@/gateway/secrets'

import { recoverOrgOutbox, type OrgOutboxItem } from './org-outbox'
import { organize, syncWithHermes } from './org-sync'
import { emptyOrganization, orgActions, type BotRow, type Organization } from './organization'
import { expired, recoverAfterRestart, type OutboxItem } from './outbox'
import type { ProvisioningRun } from './provisioning'
import { authSecretStore, createDeviceBlobStorage, DEVICE_STORAGE_KEY, secretKey } from './persistence'

export interface Connection {
  id: string
  label: string
  baseUrl: string
  authMode: 'token' | 'password'
  primary: boolean
  lastProfile?: string
  createdAt: number
}

export interface Prefs {
  appearance: 'system' | 'light' | 'dark'
  themeName: string
  haptics: boolean
  locale: string
  keepRecentOffline: boolean
  /** Set once the rooted or jailbroken phone notice was dismissed, so it shows one time. */
  rootedNoticeSeen: boolean
}

export const defaultPrefs: Prefs = {
  appearance: 'system',
  themeName: 'default',
  haptics: true,
  locale: 'en-US',
  keepRecentOffline: false,
  rootedNoticeSeen: false
}

/** Persisted schema version (also encoded in `DEVICE_STORAGE_KEY`). */
export const DEVICE_STATE_VERSION = 1

/** Drafts are keyed `${connectionId}:${profile}` (docs/05 section 3, "Drafts/outbox"). */
export function draftKey(connectionId: string, profile: string): string {
  return `${connectionId}:${profile}`
}

/** The subset of DeviceState that is sealed into AsyncStorage; actions are excluded. */
export interface PersistedDeviceState {
  connections: Connection[]
  organization: Record<string, Organization>
  prefs: Prefs
  drafts: Record<string, string>
  outbox: OutboxItem[]
  /** Accepted agents whose setup has not finished (docs/11 section 4.1). */
  provisioning: ProvisioningRun[]
}

export interface DeviceState extends PersistedDeviceState {
  addConnection(connection: Connection): void
  updateConnection(id: string, patch: Partial<Omit<Connection, 'id'>>): void
  /** Removes the connection and everything device-local that is scoped to it: organization, drafts, outbox, agent setups and its three SecureStore entries. Prefs and other connections are untouched. */
  removeConnection(id: string): Promise<void>
  setPrimaryConnection(id: string): void

  setPrefs(patch: Partial<Prefs>): void

  setDraft(connectionId: string, profile: string, text: string): void
  clearDraft(connectionId: string, profile: string): void

  addOutboxItem(item: OutboxItem): void
  updateOutboxItem(localId: string, patch: Partial<OutboxItem>): void
  removeOutboxItem(localId: string): void

  /** Adds the run, or replaces the one with the same proposal id. */
  saveProvisioningRun(run: ProvisioningRun): void
  removeProvisioningRun(proposalId: string): void

  // The organization, scoped per connection id (docs/10 "Home sections and pinned members").
  /**
   * Runs one `orgActions` action on the organization as Home shows it
   * (`sharedView`, from `rows`, the roster as Home reads it): this phone keeps
   * the pin order, row order and section list, and the pin and section
   * changes are queued for Hermes (`org-sync.ts`).
   */
  organize(connectionId: string, rows: BotRow[], action: (view: Organization) => Organization): void
  /** After every roster read (`syncWithHermes` in `org-sync.ts`). An empty roster changes nothing. */
  syncWithHermes(connectionId: string, rows: BotRow[]): void
  forgetProfile(connectionId: string, profile: string, now: number): void
  toggleCollapsed(connectionId: string, sectionId: string): void
  markUnread(connectionId: string, profile: string): void
  markRead(connectionId: string, profile: string, now: number): void
  markManyUnread(connectionId: string, profiles: string[]): void
  markManyRead(connectionId: string, profiles: string[], now: number): void
  acknowledgeExchanges(connectionId: string, profile: string, identities: string[]): void
  /** Applies one of the pure `org-outbox.ts` functions to this connection's organization outbox. */
  updateOrgOutbox(connectionId: string, fn: (outbox: OrgOutboxItem[]) => OrgOutboxItem[]): void
}

export interface CreateDeviceStoreOptions {
  /** Defer the initial storage read to an explicit `store.persist.rehydrate()` call. @default false */
  skipHydration?: boolean
  /** Ids for queued organization changes; tests pass a counter. */
  newId?: () => string
}

let changeCounter = 0
const newChangeId = (): string => `${Date.now().toString(36)}-${++changeCounter}`

/**
 * Fields added after the first release: a blob without them, or with a
 * wrong-type `rowOrder` or `outbox`, loads with empty ones. A pin or section
 * write whose answer never came goes out again (`recoverOrgOutbox`). An
 * organization without `firstSync` was stored before pins and sections were
 * shared with Hermes: its first roster read writes its values (`update`).
 */
function withOrganizationDefaults(organization: Record<string, Organization>): Record<string, Organization> {
  return Object.fromEntries(
    Object.entries(organization).map(([id, org]) => [
      id,
      {
        ...org,
        exchangeAcks: org.exchangeAcks ?? {},
        rowOrder: Array.isArray(org.rowOrder) ? org.rowOrder.filter((p): p is string => typeof p === 'string') : [],
        outbox: Array.isArray(org.outbox) ? recoverOrgOutbox(org.outbox) : [],
        firstSync: org.firstSync === 'install' || org.firstSync === 'done' ? org.firstSync : 'update'
      }
    ])
  )
}

/** Applies the outbox restart-recovery rule (docs/05 section 5) to persisted state as it is merged in. */
function mergeDeviceState(persistedState: unknown, currentState: DeviceState): DeviceState {
  const persisted = (persistedState ?? {}) as Partial<PersistedDeviceState>
  const now = Date.now()
  const outbox = (persisted.outbox ?? currentState.outbox).map(recoverAfterRestart).filter(item => !expired(item, now))
  return {
    ...currentState,
    connections: persisted.connections ?? currentState.connections,
    organization: withOrganizationDefaults(persisted.organization ?? currentState.organization),
    prefs: { ...currentState.prefs, ...persisted.prefs },
    drafts: persisted.drafts ?? currentState.drafts,
    outbox,
    provisioning: persisted.provisioning ?? currentState.provisioning
  }
}

export function createDeviceStore(storage: PersistStorage<PersistedDeviceState>, secrets: SecretStore, options: CreateDeviceStoreOptions = {}) {
  const newId = options.newId ?? newChangeId
  return create<DeviceState>()(
    persist(
      set => {
        // An action that changes nothing returns its input: then the state stays
        // the same object, so no subscriber re-renders and no organization is created.
        const updateOrg = (connectionId: string, fn: (org: Organization) => Organization) =>
          set(state => {
            const current = state.organization[connectionId] ?? emptyOrganization()
            const next = fn(current)
            return next === current ? state : { organization: { ...state.organization, [connectionId]: next } }
          })

        return {
          connections: [],
          organization: {},
          prefs: { ...defaultPrefs },
          drafts: {},
          outbox: [],
          provisioning: [],

          addConnection: connection => set(state => ({ connections: [...state.connections, connection] })),

          updateConnection: (id, patch) =>
            set(state => ({
              connections: state.connections.map(c => (c.id === id ? { ...c, ...patch } : c))
            })),

          setPrimaryConnection: id =>
            set(state => ({
              connections: state.connections.map(c => ({ ...c, primary: c.id === id }))
            })),

          removeConnection: async id => {
            set(state => {
              const organization = { ...state.organization }
              delete organization[id]
              const prefix = draftKey(id, '')
              const drafts = Object.fromEntries(Object.entries(state.drafts).filter(([key]) => !key.startsWith(prefix)))
              return {
                connections: state.connections.filter(c => c.id !== id),
                organization,
                drafts,
                outbox: state.outbox.filter(item => item.connectionId !== id),
                provisioning: state.provisioning.filter(run => run.connectionId !== id)
              }
            })
            await Promise.all([
              secrets.remove(secretKey(id, 'token')),
              secrets.remove(secretKey(id, 'cookie')),
              secrets.remove(secretKey(id, 'mode'))
            ])
          },

          setPrefs: patch => set(state => ({ prefs: { ...state.prefs, ...patch } })),

          setDraft: (connectionId, profile, text) =>
            set(state => ({ drafts: { ...state.drafts, [draftKey(connectionId, profile)]: text } })),

          clearDraft: (connectionId, profile) =>
            set(state => {
              const drafts = { ...state.drafts }
              delete drafts[draftKey(connectionId, profile)]
              return { drafts }
            }),

          addOutboxItem: item => set(state => ({ outbox: [...state.outbox, item] })),

          updateOutboxItem: (localId, patch) =>
            set(state => ({ outbox: state.outbox.map(i => (i.localId === localId ? { ...i, ...patch } : i)) })),

          removeOutboxItem: localId => set(state => ({ outbox: state.outbox.filter(i => i.localId !== localId) })),

          saveProvisioningRun: run =>
            set(state => ({ provisioning: [...state.provisioning.filter(r => r.proposalId !== run.proposalId), run] })),

          removeProvisioningRun: proposalId => set(state => ({ provisioning: state.provisioning.filter(r => r.proposalId !== proposalId) })),

          organize: (connectionId, rows, action) => updateOrg(connectionId, org => organize(org, rows, action, newId)),
          syncWithHermes: (connectionId, rows) =>
            set(state => {
              const current = state.organization[connectionId]
              const next = rows.length === 0 ? current : syncWithHermes(current, rows, newId)
              return next === current || next === undefined ? state : { organization: { ...state.organization, [connectionId]: next } }
            }),
          forgetProfile: (connectionId, profile, now) => updateOrg(connectionId, org => orgActions.forget(org, profile, now)),
          toggleCollapsed: (connectionId, sectionId) => updateOrg(connectionId, org => orgActions.toggleCollapsed(org, sectionId)),
          markUnread: (connectionId, profile) => updateOrg(connectionId, org => orgActions.markUnread(org, profile)),
          markRead: (connectionId, profile, now) => updateOrg(connectionId, org => orgActions.markRead(org, profile, now)),
          markManyUnread: (connectionId, profiles) => updateOrg(connectionId, org => orgActions.markManyUnread(org, profiles)),
          markManyRead: (connectionId, profiles, now) => updateOrg(connectionId, org => orgActions.markManyRead(org, profiles, now)),
          acknowledgeExchanges: (connectionId, profile, identities) => updateOrg(connectionId, org => orgActions.acknowledgeExchanges(org, profile, identities)),
          updateOrgOutbox: (connectionId, fn) =>
            updateOrg(connectionId, org => {
              const outbox = fn(org.outbox)
              return outbox === org.outbox ? org : { ...org, outbox }
            })
        }
      },
      {
        name: DEVICE_STORAGE_KEY,
        storage,
        skipHydration: options.skipHydration,
        // The schema version used to live only inside the storage key. Declaring it
        // here too gives `migrate` a hook for the next shape change; today every
        // earlier blob has the same shape, so it passes through unchanged (without a
        // `migrate`, zustand discards a blob whose version does not match).
        version: DEVICE_STATE_VERSION,
        migrate: persisted => persisted as PersistedDeviceState,
        partialize: state => ({
          connections: state.connections,
          organization: state.organization,
          prefs: state.prefs,
          drafts: state.drafts,
          outbox: state.outbox,
          provisioning: state.provisioning
        }),
        merge: mergeDeviceState
      }
    )
  )
}

type PersistCapable = { persist: { hasHydrated(): boolean; onFinishHydration(cb: () => void): () => void } }

/** Resolves once the store's initial storage read has finished (or immediately if it already has, or was skipped). */
export function waitForHydration(store: PersistCapable): Promise<void> {
  if (store.persist.hasHydrated()) {
    return Promise.resolve()
  }
  return new Promise(resolve => {
    const unsubscribe = store.persist.onFinishHydration(() => {
      unsubscribe()
      resolve()
    })
  })
}

/**
 * The app-wide store. Created with `skipHydration: true` so importing this module
 * never reads AsyncStorage; call `useDeviceStore.persist.rehydrate()` once, from the
 * app's real runtime entry point, then `waitForHydration(useDeviceStore)` if you need
 * to know when it's done.
 */
export const useDeviceStore = createDeviceStore(createDeviceBlobStorage<PersistedDeviceState>(), authSecretStore, { skipHydration: true })
