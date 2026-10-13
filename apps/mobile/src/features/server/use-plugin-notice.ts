/**
 * The server check and the notice a screen shows for it, as one hook. React
 * adapter only: the rules live in `plugin-notice.ts` (`featureNotice`,
 * `recheckState`). Screens pass the build record in, as for `useServerCheck`.
 */

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import type { Connection } from '@/state/device-store'

import type { BuildRecord } from './build-record'
import { featureNotice, recheckState, type AskedRecheck } from './plugin-notice'
import { serverCheckKey, useServerCheck } from './use-server-check'

/**
 * The check of one connection's server (idle without a connection) and the
 * notice to show for it. `error` is the last error of the feature the screen
 * shows: when it is a missing route while the cached check says ready, the
 * check is asked again once for that error, `checking` is true and `notice`
 * is the neutral "Checking your server…" until the fresh check answers.
 */
export function usePluginNotice(connection: Connection | null, build: BuildRecord | null, error?: unknown) {
  const check = useServerCheck(connection, build)
  const queryClient = useQueryClient()
  const [asked, setAsked] = useState<AskedRecheck | null>(null)
  const answeredAt = Math.max(check.dataUpdatedAt, check.errorUpdatedAt)
  const { notice, checking, recheck } = featureNotice(check.data, error, recheckState(asked, error, answeredAt))

  const connectionId = connection?.id
  useEffect(() => {
    if (!recheck || connectionId === undefined) {
      return
    }
    setAsked({ error, after: answeredAt })
    void queryClient.invalidateQueries({ queryKey: serverCheckKey(connectionId) })
  }, [recheck, error, answeredAt, connectionId, queryClient])

  return { check, notice, checking }
}
