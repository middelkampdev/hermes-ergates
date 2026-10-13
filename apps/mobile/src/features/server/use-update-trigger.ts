/**
 * What Home does about an update the server check offers, as one hook. React
 * adapter only: the rules live in `update-trigger.ts`, the run without asking
 * in `silent-update.ts`. Home passes the check it holds, whether it is in
 * view, and how to open the Update ready screen.
 */

import { useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import type { GatewayPort } from '@/gateway/port'
import type { Connection } from '@/state/device-store'

import type { BuildRecord } from './build-record'
import { runningKind } from './pending-setup'
import type { PluginNotice } from './plugin-notice'
import type { ServerCheck } from './server-check'
import { updateSilently } from './silent-update'
import { actionToTake, answerKey, updateLineFor, updatedNoticeLine } from './update-trigger'
import { offerOf } from './update-view'
import { serverCheckKey } from './use-server-check'

export interface UpdateTriggerInput {
  gateway: GatewayPort
  connection: Connection
  build: BuildRecord | null
  check: Pick<UseQueryResult<ServerCheck>, 'data' | 'dataUpdatedAt' | 'isStale'>
  /** True while the screen is in view: nothing opens or runs from behind another screen. */
  focused: boolean
  /** Opens the Update ready screen. Keep it stable between renders. */
  openUpdate: () => void
}

/**
 * Opens the Update ready screen or runs the update without asking, once for
 * each fresh check answer, and returns the two lines Home may show: the one
 * that offers the update, and the one that says it was done without asking.
 */
export function useUpdateTrigger({ gateway, connection, build, check, focused, openUpdate }: UpdateTriggerInput): { line: PluginNotice | null; updatedNotice: string | null } {
  const queryClient = useQueryClient()
  const doneKey = useRef<string | null>(null)
  // The line that offers the update would otherwise show while the update runs, until the check answers again.
  const [running, setRunning] = useState(false)
  const { data, dataUpdatedAt, isStale } = check
  const connectionId = connection.id

  useEffect(() => {
    if (!focused) {
      return
    }
    const key = answerKey(connectionId, dataUpdatedAt)
    const action = actionToTake({ check: data, connection, key, doneKey: doneKey.current, fresh: !isStale, running: runningKind(connectionId) })
    if (action === null) {
      return
    }
    doneKey.current = key
    if (action === 'open_screen') {
      openUpdate()
      return
    }
    const offer = offerOf(data)
    if (offer === null || build === null) {
      return
    }
    setRunning(true)
    void (async () => {
      try {
        const outcome = await updateSilently(gateway, build, connectionId, offer)
        // A refused session is Home's sign-in line to show; asking again would only repeat it.
        if (outcome.kind !== 'sign_in') {
          await queryClient.invalidateQueries({ queryKey: serverCheckKey(connectionId) })
        }
      } catch {
        // The run records its own end; whatever went wrong shows in the next check.
      } finally {
        setRunning(false)
      }
    })()
  }, [focused, data, dataUpdatedAt, isStale, connection, connectionId, build, gateway, openUpdate, queryClient])

  return {
    line: running ? null : updateLineFor(data, connection),
    updatedNotice: connection.pluginUpdatedNotice === undefined ? null : updatedNoticeLine(connection.pluginUpdatedNotice)
  }
}
