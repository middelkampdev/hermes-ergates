/**
 * Where the app goes once the user is signed in to a server (after Connect
 * and after Sign in again): the setup screen when the plugin needs something
 * from the user, Home when it does not or when nothing is known about it.
 * Plain async code over the gateway port, so Node tests drive it with
 * FakeGateway.
 */

import type { GatewayPort } from '@/gateway/port'

import type { BuildRecord } from './build-record'
import { checkServer, type ServerCheck } from './server-check'

export type SetupRoute = '/' | '/server' | '/server/finish'

/**
 * The route a check leads to. A missing or a turned off plugin is the setup
 * screen's to offer; a plugin that Hermes has not loaded, or that is older
 * than this app needs, can only be finished on the server, so those open the
 * Finish screen at once. Everything else needs nothing from the user now.
 */
export function routeAfterCheck(check: ServerCheck): SetupRoute {
  switch (check.kind) {
    case 'missing':
    case 'disabled':
      return '/server'
    case 'not_loaded':
    case 'outdated':
      return '/server/finish'
    default:
      return '/'
  }
}

/**
 * Checks the server once and says where to go. A check that fails goes Home,
 * a 401 included: the sign-in just worked, so a refusal this soon is for Home
 * to handle the way it handles any session that ends.
 */
export async function afterSignIn(port: GatewayPort, build: BuildRecord | null): Promise<SetupRoute> {
  try {
    return routeAfterCheck(await checkServer(port, build))
  } catch {
    return '/'
  }
}
