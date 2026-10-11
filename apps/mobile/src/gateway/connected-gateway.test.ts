/**
 * Screens see only the port (ADR-029 rule 1): the registry hands out
 * `ConnectedGateway`, never the `RealGateway` class. A compile-time check;
 * `npm run typecheck` fails when the registry leaks the adapter type again.
 */
import { describe, expectTypeOf, it } from 'vitest'

import type { ConnectedGateway, GatewayPort } from './port'
import type { GatewayRegistry, useGateway } from './registry'

describe('ConnectedGateway', () => {
  it('is the only gateway type the registry hands out', () => {
    expectTypeOf<ReturnType<GatewayRegistry['get']>>().toEqualTypeOf<ConnectedGateway>()
    expectTypeOf<ReturnType<GatewayRegistry['probe']>>().toEqualTypeOf<ConnectedGateway>()
    expectTypeOf<ReturnType<typeof useGateway>>().toEqualTypeOf<ConnectedGateway>()
  })

  it('is the port plus restore(), which names the sign-in it found', () => {
    expectTypeOf<ConnectedGateway>().toExtend<GatewayPort>()
    expectTypeOf<ConnectedGateway['restore']>().toEqualTypeOf<() => Promise<'none' | 'token' | 'password'>>()
  })
})
