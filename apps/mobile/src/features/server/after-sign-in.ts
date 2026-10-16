/**
 * Where the app goes once the user is signed in to a server (after Connect
 * and after Sign in again): the update screen when an update is ready to ask
 * about, the setup screen when the plugin needs something from the user, Home
 * when it does not or when nothing is known about it.
 * Plain async code over the gateway port, so Node tests drive it with
 * FakeGateway.
 */

import type { GatewayPort } from '@/gateway/port'
import type { Connection } from '@/state/device-store'

import type { BuildRecord } from './build-record'
import { checkServer, hermesVersionIn, type ServerCheck } from './server-check'
import { updateAction } from './update-trigger'

export type SetupRoute = '/' | '/server' | '/server/finish' | '/server/update'

/**
 * The route a check leads to. A missing or a turned off plugin is the setup
 * screen's to offer; a plugin that Hermes has not loaded, that waits for a
 * restart, or that is older than this app needs and cannot be updated from
 * here can only be finished on the server, so those open the Finish screen at
 * once. A plugin the app can update goes Home, where its notice carries the
 * one-tap Update: whether the update screen opens by itself, once per update,
 * is `updateAction`'s to say. Everything else needs nothing from the user now.
 */
export function routeAfterCheck(check: ServerCheck): SetupRoute {
  switch (check.kind) {
    case 'missing':
    case 'disabled':
      return '/server'
    case 'not_loaded':
    case 'restart_needed':
      return '/server/finish'
    case 'outdated':
      return check.update === null ? '/server/finish' : '/'
    default:
      return '/'
  }
}

/**
 * Checks the server once and says where to go. An update that is ready to ask
 * about comes first (the switch off and an update the user was asked about
 * never do), then the rules of `routeAfterCheck`. An update that runs without
 * asking goes Home, which runs it on its own fresh check. A check that fails
 * goes Home, a 401 included: the sign-in just worked, so a refusal this soon
 * is for Home to handle the way it handles any session that ends.
 */
export async function afterSignIn(port: GatewayPort, build: BuildRecord | null, connection: Connection): Promise<SetupRoute> {
  try {
    const check = await checkServer(port, build)
    return updateAction(check, connection, hermesVersionIn(check)) === 'open_screen' ? '/server/update' : routeAfterCheck(check)
  } catch {
    return '/'
  }
}
