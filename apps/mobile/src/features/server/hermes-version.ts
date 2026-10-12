/**
 * Where a Hermes version stands against the versions CI has tested the plugin
 * on. Hermes reports a clean `X.Y.Z` base version, or `unknown` when it cannot
 * tell; anything else is not a version this module places.
 */

import type { HermesRange } from './build-record'

/** `in_range` is tested; `untested` is newer than the newest tested minor; `unknown` is a version (or range) this module cannot read. */
export type HermesFit = 'in_range' | 'too_old' | 'untested' | 'unknown'

type Triple = [number, number, number]

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/
const MINOR = /^(\d+)\.(\d+)$/

/** The numbers of an `X.Y.Z` version; null for anything else (`unknown`, `0.21`, `0.21.6rc1`, a suffix, a blank). */
export function parseHermesVersion(v: string | undefined): Triple | null {
  const match = v === undefined ? null : VERSION.exec(v)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function olderThan(a: Triple, b: Triple): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] < b[i]
    }
  }
  return false
}

export function hermesFit(version: string | undefined, range: HermesRange): HermesFit {
  const found = parseHermesVersion(version)
  const oldest = parseHermesVersion(range.oldest)
  const newest = MINOR.exec(range.newestMinor)
  if (!found || !oldest || !newest) {
    return 'unknown'
  }
  if (olderThan(found, oldest)) {
    return 'too_old'
  }
  const [major, minor] = found
  const [newestMajor, newestMinor] = [Number(newest[1]), Number(newest[2])]
  return major > newestMajor || (major === newestMajor && minor > newestMinor) ? 'untested' : 'in_range'
}
