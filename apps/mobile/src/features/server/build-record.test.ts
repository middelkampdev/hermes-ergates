import { describe, expect, it } from 'vitest'

import { parseBuildRecord } from './build-record'

const COMMIT = 'a'.repeat(40)

function extraWith(overrides: Record<string, unknown> = {}) {
  return {
    hermesTestedThrough: '0.21',
    ergates: {
      requiredPlugin: { version: '0.2.0', apiLevel: 1, commit: COMMIT },
      hermesRange: { oldest: '0.21.6', newestMinor: '0.21' },
      ...overrides
    }
  }
}

describe('parseBuildRecord', () => {
  it('returns the record of a valid extra', () => {
    expect(parseBuildRecord(extraWith())).toEqual({
      requiredPlugin: { version: '0.2.0', apiLevel: 1, commit: COMMIT },
      hermesRange: { oldest: '0.21.6', newestMinor: '0.21' }
    })
  })

  it('keeps no field the record does not define', () => {
    const record = parseBuildRecord(
      extraWith({
        requiredPlugin: { version: '0.2.0', apiLevel: 1, commit: COMMIT, source: 'https://example.com/other' }
      })
    )

    expect(record?.requiredPlugin).toEqual({ version: '0.2.0', apiLevel: 1, commit: COMMIT })
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'ergates'],
    ['an object without ergates', { hermesTestedThrough: '0.21' }],
    ['an ergates that is not an object', { ergates: 'x' }]
  ])('returns null for %s', (_name, extra) => {
    expect(parseBuildRecord(extra)).toBeNull()
  })

  it.each([
    ['a missing requiredPlugin', { requiredPlugin: undefined }],
    ['a missing hermesRange', { hermesRange: undefined }],
    ['a non-numeric apiLevel', { requiredPlugin: { version: '0.2.0', apiLevel: '1', commit: COMMIT } }],
    ['a fractional apiLevel', { requiredPlugin: { version: '0.2.0', apiLevel: 1.5, commit: COMMIT } }],
    ['a missing apiLevel', { requiredPlugin: { version: '0.2.0', commit: COMMIT } }],
    ['a version that is not X.Y.Z', { requiredPlugin: { version: 'latest', apiLevel: 1, commit: COMMIT } }],
    ['an oldest Hermes that is not X.Y.Z', { hermesRange: { oldest: '0.21', newestMinor: '0.21' } }],
    ['a newest minor that is not X.Y', { hermesRange: { oldest: '0.21.6', newestMinor: '0.21.6' } }]
  ])('returns null for %s', (_name, overrides) => {
    expect(parseBuildRecord(extraWith(overrides))).toBeNull()
  })

  it.each([
    ['not hex', 'xyz'],
    ['too short', 'a'.repeat(39)],
    ['too long', 'a'.repeat(41)],
    ['upper case', 'A'.repeat(40)],
    ['a number', 12345],
    ['empty', '']
  ])('turns a commit that is %s into null', (_name, commit) => {
    const record = parseBuildRecord(extraWith({ requiredPlugin: { version: '0.2.0', apiLevel: 1, commit } }))

    expect(record?.requiredPlugin.commit).toBeNull()
  })

  it('turns a missing commit into null', () => {
    const record = parseBuildRecord(extraWith({ requiredPlugin: { version: '0.2.0', apiLevel: 1 } }))

    expect(record?.requiredPlugin.commit).toBeNull()
  })
})
