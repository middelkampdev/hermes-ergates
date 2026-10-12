/**
 * Rewrites a link from outside before Expo Router matches it:
 * `ergates://chat/<session>?connection=…&profile=…` goes to `/open`, never to
 * `app/chat/[profile]` with the session id as the profile. Then only Home and
 * `/open` get through: any other screen, the server screens above all, is
 * opened by the app itself, so such a link goes Home.
 * The rules and their tests live in `src/features/attention/deep-link.ts` and
 * `src/features/server/external-link.ts`.
 */

import { rewriteDeepLink } from '@/features/attention'
import { externalPath } from '@/features/server'

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return externalPath(rewriteDeepLink(path))
  } catch {
    // Expo Router: a throw here can crash the app on launch. A link the rewrite cannot read (a lone surrogate
    // in a value makes it throw) has not been through the allowlist either, so it goes Home, not on as it came.
    return '/'
  }
}
