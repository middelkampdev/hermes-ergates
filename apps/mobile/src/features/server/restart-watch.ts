/**
 * What the Finish page has seen of the restart an update run asked for, as
 * one value the page folds every poll into. Pure: the update run keeps it per
 * connection (`restartWatchOf` in `update-run.ts`), so a page that mounts
 * again does not lose it.
 */

import type { ServerCheck } from './server-check'

/**
 * What the page has seen of the restart an update run asked for. `seen` is
 * the first sign that the server restarted; `oldCodeAnswered` is whether the
 * old code has answered (`restart_needed`) since, which makes its silence
 * after that a sign too.
 */
export interface RestartWatch {
  oldCodeAnswered: boolean
  seen: boolean
}

/** Nothing seen yet. */
export const NOT_WATCHED: RestartWatch = { oldCodeAnswered: false, seen: false }

/**
 * Folds one poll into the watch. Signs of a restart: the server could not be
 * reached, it refused the session (a restart signs the user out unless the
 * server has a fixed sign-in secret), or the old code answered earlier and
 * the plugin now does not come up (`not_loaded`) or cannot open its data
 * (`unavailable`), which catches a restart that fits between two polls. Once
 * seen it stays seen. Answers `watch` itself when the poll changes nothing.
 */
export function watchRestart(watch: RestartWatch, check: ServerCheck | null, signedOut: boolean): RestartWatch {
  const oldCodeAnswered = watch.oldCodeAnswered || check?.kind === 'restart_needed'
  const stoppedAnswering = watch.oldCodeAnswered && (check?.kind === 'not_loaded' || check?.kind === 'unavailable')
  const seen = watch.seen || signedOut || check?.kind === 'unknown' || stoppedAnswering
  return oldCodeAnswered === watch.oldCodeAnswered && seen === watch.seen ? watch : { oldCodeAnswered, seen }
}
