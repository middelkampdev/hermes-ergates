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

/** Orders two `X.Y.Z` triples by their numbers: -1 when `a` is older, 1 when it is newer, 0 when they are equal. */
export function compareTriples(a: Triple, b: Triple): -1 | 0 | 1 {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1
    }
  }
  return 0
}

export function hermesFit(version: string | undefined, range: HermesRange): HermesFit {
  const found = parseHermesVersion(version)
  const oldest = parseHermesVersion(range.oldest)
  const newest = MINOR.exec(range.newestMinor)
  if (!found || !oldest || !newest) {
    return 'unknown'
  }
  if (compareTriples(found, oldest) < 0) {
    return 'too_old'
  }
  const [major, minor] = found
  const [newestMajor, newestMinor] = [Number(newest[1]), Number(newest[2])]
  return major > newestMajor || (major === newestMajor && minor > newestMinor) ? 'untested' : 'in_range'
}
