import { describe, expect, it } from 'vitest'

import { hermesFit, parseHermesVersion } from './hermes-version'

const RANGE = { oldest: '0.21.6', newestMinor: '0.21' }

describe('parseHermesVersion', () => {
  it('reads the three numbers of a clean version', () => {
    expect(parseHermesVersion('0.21.6')).toEqual([0, 21, 6])
    expect(parseHermesVersion('12.3.45')).toEqual([12, 3, 45])
  })

  it.each([['unknown'], [''], [undefined], ['0.21'], ['0.21.6rc1'], ['0.21.6+3.gabc1234'], ['v0.21.6'], [' 0.21.6'], ['0.21.6.1'], ['0.21.x']])('reads nothing from %j', value => {
    expect(parseHermesVersion(value)).toBeNull()
  })
})

describe('hermesFit', () => {
  it.each([['0.21.6'], ['0.21.9'], ['0.21.100']])('puts %s in range', version => {
    expect(hermesFit(version, RANGE)).toBe('in_range')
  })

  it.each([['0.21.5'], ['0.20.9'], ['0.9.99']])('finds %s older than the oldest tested', version => {
    expect(hermesFit(version, RANGE)).toBe('too_old')
  })

  it.each([['0.22.0'], ['0.30.1'], ['1.0.0']])('finds %s newer than the newest tested minor', version => {
    expect(hermesFit(version, RANGE)).toBe('untested')
  })

  it.each([['unknown'], [''], [undefined], ['0.21'], ['0.21.6rc1']])('cannot place %j', version => {
    expect(hermesFit(version, RANGE)).toBe('unknown')
  })

  it('compares numbers, not text', () => {
    expect(hermesFit('0.9.0', { oldest: '0.10.0', newestMinor: '0.10' })).toBe('too_old')
    expect(hermesFit('0.10.1', { oldest: '0.9.0', newestMinor: '0.10' })).toBe('in_range')
  })

  it('follows the range it is given', () => {
    expect(hermesFit('0.22.1', { oldest: '0.21.6', newestMinor: '0.22' })).toBe('in_range')
    expect(hermesFit('0.23.0', { oldest: '0.21.6', newestMinor: '0.22' })).toBe('untested')
  })

  it('cannot place any version against a range it cannot read', () => {
    expect(hermesFit('0.21.6', { oldest: '0.21', newestMinor: '0.21' })).toBe('unknown')
    expect(hermesFit('0.21.6', { oldest: '0.21.6', newestMinor: 'latest' })).toBe('unknown')
  })
})
