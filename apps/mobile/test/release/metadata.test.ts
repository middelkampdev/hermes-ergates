import { describe, expect, it } from 'vitest'

import {
  MAX_BUILD_NUMBER,
  formatOutputs,
  parseReleaseTag,
  resolveRelease,
  withBuildNumber,
} from '../../scripts/release/metadata.mjs'

const TAG_RUN = { refType: 'tag', refName: 'v0.3.0-rc.2', runNumber: '41', offset: '', override: '', appVersion: '0.3.0' }

describe('parseReleaseTag', () => {
  it('reads the version and the rc channel from an RC tag', () => {
    expect(parseReleaseTag('v0.3.0-rc.1')).toEqual({ version: '0.3.0', channel: 'rc' })
  })

  it('reads a clean tag as the final channel', () => {
    expect(parseReleaseTag('v0.3.1')).toEqual({ version: '0.3.1', channel: 'final' })
    expect(parseReleaseTag('v10.20.300')).toEqual({ version: '10.20.300', channel: 'final' })
  })

  it.each(['0.3.0', 'v0.3', 'v0.3.0-beta.1', 'v0.3.0-rc', 'v0.3.0-rc.01', 'v01.3.0', 'v0.3.0+1', 'release/0.3.0', ''])(
    'refuses %j',
    tag => {
      expect(parseReleaseTag(tag)).toBeNull()
    }
  )
})

describe('resolveRelease', () => {
  it('gives the version, the channel and the run number as the build number', () => {
    expect(resolveRelease(TAG_RUN)).toEqual({ tag: 'v0.3.0-rc.2', version: '0.3.0', channel: 'rc', buildNumber: 41 })
  })

  it('adds the offset to the run number', () => {
    expect(resolveRelease({ ...TAG_RUN, offset: '900' }).buildNumber).toBe(941)
  })

  it('takes the override over the run number and the offset', () => {
    expect(resolveRelease({ ...TAG_RUN, offset: '900', override: '1234' }).buildNumber).toBe(1234)
  })

  it('refuses an override, an offset or a run number that is not a whole number', () => {
    expect(() => resolveRelease({ ...TAG_RUN, override: '12a' })).toThrow('The build-number input must be a whole number from 1 to 2100000000, got "12a".')
    expect(() => resolveRelease({ ...TAG_RUN, override: '0' })).toThrow('The build-number input must be a whole number')
    expect(() => resolveRelease({ ...TAG_RUN, offset: '-5' })).toThrow('The BUILD_NUMBER_OFFSET variable must be a whole number of 0 or more, got "-5".')
    expect(() => resolveRelease({ ...TAG_RUN, runNumber: '' })).toThrow('GITHUB_RUN_NUMBER must be a whole number of 1 or more, got "".')
  })

  it('refuses a build number above the Google Play maximum', () => {
    expect(() => resolveRelease({ ...TAG_RUN, offset: String(MAX_BUILD_NUMBER) })).toThrow(
      `The build number ${MAX_BUILD_NUMBER + 41} is above 2100000000, the highest versionCode Google Play accepts.`
    )
  })

  it('refuses a run whose app.json version is not the tag version', () => {
    expect(() => resolveRelease({ ...TAG_RUN, appVersion: '0.2.0' })).toThrow(
      'apps/mobile/app.json has version 0.2.0, but the tag v0.3.0-rc.2 is version 0.3.0. gflow runs .gflow/set-version.sh when it starts a release; check that the script ran and its commit is in the tag.'
    )
  })

  it('refuses a manual run started on a branch', () => {
    expect(() => resolveRelease({ ...TAG_RUN, refType: 'branch', refName: 'develop' })).toThrow(
      'A release run needs a release tag, but this run is on the branch develop. Start a manual run on the tag: gh workflow run release.yml --ref vX.Y.Z-rc.N'
    )
  })

  it('refuses a tag that is not a release tag', () => {
    expect(() => resolveRelease({ ...TAG_RUN, refName: 'v0.3.0-beta.1' })).toThrow(
      'A release run needs a release tag (vX.Y.Z or vX.Y.Z-rc.N), but this run is on the tag v0.3.0-beta.1.'
    )
  })
})

describe('formatOutputs', () => {
  it('writes one name=value line per output for GITHUB_OUTPUT', () => {
    expect(formatOutputs({ tag: 'v0.3.0', version: '0.3.0', channel: 'final', buildNumber: 7 })).toBe(
      'tag=v0.3.0\nversion=0.3.0\nchannel=final\nbuild-number=7\n'
    )
  })
})

describe('withBuildNumber', () => {
  const APP = { expo: { name: 'Ergates', version: '0.3.0', ios: { bundleIdentifier: 'dev.middelkamp.ergates' }, android: { package: 'dev.middelkamp.ergates' } } }

  it('sets the iOS build number and the Android version code and keeps the rest', () => {
    expect(withBuildNumber(APP, 42)).toEqual({
      expo: {
        name: 'Ergates',
        version: '0.3.0',
        ios: { bundleIdentifier: 'dev.middelkamp.ergates', buildNumber: '42' },
        android: { package: 'dev.middelkamp.ergates', versionCode: 42 },
      },
    })
    expect(APP.expo.ios).toEqual({ bundleIdentifier: 'dev.middelkamp.ergates' })
  })

  it('refuses a build number Google Play would refuse', () => {
    expect(() => withBuildNumber(APP, 0)).toThrow('The build number must be a whole number from 1 to 2100000000, got 0.')
    expect(() => withBuildNumber(APP, MAX_BUILD_NUMBER + 1)).toThrow('got 2100000001')
  })
})
