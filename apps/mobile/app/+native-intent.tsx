/**
 * Rewrites a link from outside before Expo Router matches it:
 * `ergates://chat/<session>?connection=…&profile=…` goes to `/open`, never to
 * `app/chat/[profile]` with the session id as the profile, and a link to the
 * server screens goes Home, because only the app opens those.
 * The rules and their tests live in `src/features/attention/deep-link.ts` and
 * `src/features/server/external-link.ts`.
 */

import { rewriteDeepLink } from '@/features/attention'
import { externalPath } from '@/features/server'

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return rewriteDeepLink(externalPath(path))
  } catch {
    // Expo Router: a throw here can crash the app on launch. Keep the link as it came.
    return path
  }
}
