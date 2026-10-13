/**
 * The server check as a TanStack query. React adapter only: the rules live in
 * `server-check.ts`. Screens pass the build record in (read from the app's
 * config there), so this feature never imports `expo-constants` and stays
 * importable in Node.
 */

import { skipToken, useQuery } from '@tanstack/react-query'

import { useGatewayRegistry } from '@/gateway/registry'
import type { Connection } from '@/state/device-store'

import type { BuildRecord } from './build-record'
import { checkServer, pollInterval } from './server-check'

export const serverCheckKey = (connectionId: string) => ['server-check', connectionId] as const

/**
 * The check of one connection's server; idle without a connection. `poll`
 * re-checks every 5 seconds, for a screen that waits for the server to change,
 * until the server refuses the session. A rejected check is the `unauthorized`
 * error: send the user to sign in.
 */
export function useServerCheck(connection: Connection | null, build: BuildRecord | null, opts: { poll?: boolean } = {}) {
  // The registry hands out the same port `useGateway` does; it is read here because a hook cannot take a missing connection.
  const registry = useGatewayRegistry()
  return useQuery({
    queryKey: connection ? serverCheckKey(connection.id) : ['server-check', null],
    queryFn: connection ? () => checkServer(registry.get(connection), build) : skipToken,
    staleTime: 60_000,
    refetchInterval: query => pollInterval(opts.poll === true, query.state.error),
    retry: false
  })
}
