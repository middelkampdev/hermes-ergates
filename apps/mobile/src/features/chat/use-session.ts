/**
 * useSession: the React binding of `createSessionController` for one profile's
 * Bot Chat. Every rule lives in `session-controller.ts` and the pure modules it
 * wires, all tested in plain Node; this file only supplies what React Native
 * owns: the device store's outbox, the skin store, `__DEV__` and the app
 * returning to the foreground (ADR-029 rule 3).
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { AppState, type AppStateStatus } from 'react-native'

import type { GatewayPort } from '@/gateway/port'
import type { ProfileSummary } from '@/gateway/types'

import { useDeviceStore } from '@/state/device-store'
import { useSkinStore } from '@/theme/skin-store'

import { createSessionController, type OutboxStore, type SessionCommands, type SessionView } from './session-controller'

export type { SessionPhase } from './session-controller'

/** What a chat screen reads: the current view plus the commands. */
export type UseSessionResult = SessionView & SessionCommands

export interface UseSessionOptions {
  enabled?: boolean
  connectionId?: string
  /** Test seam; defaults to the device store's outbox. */
  outbox?: OutboxStore
}

/** The device store's outbox slice, as the send queue needs it. */
const deviceOutbox: OutboxStore = {
  list: () => useDeviceStore.getState().outbox,
  add: item => useDeviceStore.getState().addOutboxItem(item),
  update: (localId, patch) => useDeviceStore.getState().updateOutboxItem(localId, patch),
  remove: localId => useDeviceStore.getState().removeOutboxItem(localId)
}

export function useSession(port: GatewayPort, profile: string, summary: ProfileSummary | undefined, options: UseSessionOptions = {}): UseSessionResult {
  const enabled = options.enabled ?? true
  const connectionId = options.connectionId ?? 'primary'
  const outbox = options.outbox ?? deviceOutbox
  const ingestSkin = useSkinStore(s => s.ingest)
  // The resolved canonical pointer, not the summary object: the roster query
  // hands back a new object on every refetch, and the chat must re-open when the
  // roster finally reports a pointer it did not have (an errored first roster
  // makes `summary` undefined, which is exactly when the lookup can read an
  // empty-but-successful list as "this bot never had a chat").
  const pointer = summary?.canonical_session?.resolved_id ?? summary?.canonical_session?.id ?? null

  // One controller, and so one reducer state, per chat.
  const controller = useMemo(
    () => createSessionController({ port, profile, connectionId, outbox, ingestSkin, allowDevInject: __DEV__ }),
    [port, profile, connectionId, outbox, ingestSkin]
  )
  const view = useSyncExternalStore(controller.subscribe, controller.getView)

  useEffect(() => {
    if (!enabled) {
      return
    }
    void controller.open(summary)
    return () => controller.close()
    // `summary` is read through `pointer`; see the comment on `pointer`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, enabled, pointer])

  // Resynchronise when the app returns to the foreground (iOS kills the socket
  // within seconds of suspension).
  useEffect(() => {
    const onChange = (status: AppStateStatus): void => {
      if (status === 'active' && controller.getView().phase === 'ready') {
        void controller.reconnect()
      }
    }
    const sub = AppState.addEventListener('change', onChange)
    return () => sub.remove()
  }, [controller])

  return useMemo(
    () => ({
      ...view,
      send: controller.send,
      retry: controller.retry,
      stop: controller.stop,
      answerClarify: controller.answerClarify,
      answerApproval: controller.answerApproval,
      refetchHistory: controller.refetchHistory,
      dispatchReconciled: controller.dispatchReconciled,
      devInjectEvent: controller.devInjectEvent,
      reconnect: controller.reconnect,
      clearError: controller.clearError
    }),
    [view, controller]
  )
}
