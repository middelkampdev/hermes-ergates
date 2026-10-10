import { describe, expect, it } from 'vitest'

import { appStoreProfileProblems, exportOptionsPlist } from '../../scripts/release/ios-signing.mjs'

const APP = { teamId: 'AB12CD34EF', bundleId: 'com.nousresearch.hermesergates' }
const PROFILE = {
  name: 'Ergates App Store',
  uuid: '0f5e3c9a-1111-4222-8333-944455556666',
  teamId: 'AB12CD34EF',
  appId: 'AB12CD34EF.com.nousresearch.hermesergates',
  getTaskAllow: 'false',
  hasDevices: false,
}

describe('appStoreProfileProblems', () => {
  it('accepts an App Store profile for the app and the team', () => {
    expect(appStoreProfileProblems(PROFILE, APP)).toEqual([])
  })

  it('names a profile of another team or another app', () => {
    expect(appStoreProfileProblems({ ...PROFILE, teamId: 'ZZ99ZZ99ZZ', appId: 'ZZ99ZZ99ZZ.com.nousresearch.hermesergates' }, APP)).toEqual([
      'The provisioning profile belongs to team ZZ99ZZ99ZZ, not to APPLE_TEAM_ID AB12CD34EF.',
      'The provisioning profile is for the app ID ZZ99ZZ99ZZ.com.nousresearch.hermesergates, not AB12CD34EF.com.nousresearch.hermesergates.',
    ])
    expect(appStoreProfileProblems({ ...PROFILE, appId: 'AB12CD34EF.*' }, APP)).toEqual([
      'The provisioning profile is for the app ID AB12CD34EF.*, not AB12CD34EF.com.nousresearch.hermesergates.',
    ])
  })

  it('refuses a development or ad hoc profile', () => {
    const problem = 'The provisioning profile is a development or ad hoc profile. Create an App Store profile (RELEASING.md).'
    expect(appStoreProfileProblems({ ...PROFILE, getTaskAllow: 'true' }, APP)).toEqual([problem])
    expect(appStoreProfileProblems({ ...PROFILE, hasDevices: true }, APP)).toEqual([problem])
  })

  it('refuses a file that is not a profile', () => {
    const empty = { name: '', uuid: '', teamId: '', appId: '', getTaskAllow: '', hasDevices: false }
    expect(appStoreProfileProblems(empty, APP)).toEqual([
      'The provisioning profile has no Name or UUID. Is IOS_APPSTORE_PROFILE_BASE64 a .mobileprovision file?',
      'The provisioning profile belongs to team (none), not to APPLE_TEAM_ID AB12CD34EF.',
      'The provisioning profile is for the app ID (none), not AB12CD34EF.com.nousresearch.hermesergates.',
      'The provisioning profile is a development or ad hoc profile. Create an App Store profile (RELEASING.md).',
    ])
  })
})

describe('exportOptionsPlist', () => {
  it('signs manually for App Store Connect with the profile of the app', () => {
    expect(exportOptionsPlist({ teamId: 'AB12CD34EF', bundleId: 'com.nousresearch.hermesergates', profileName: 'Ergates App Store' })).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>destination</key>',
        '  <string>export</string>',
        '  <key>manageAppVersionAndBuildNumber</key>',
        '  <false/>',
        '  <key>method</key>',
        '  <string>app-store-connect</string>',
        '  <key>provisioningProfiles</key>',
        '  <dict>',
        '    <key>com.nousresearch.hermesergates</key>',
        '    <string>Ergates App Store</string>',
        '  </dict>',
        '  <key>signingCertificate</key>',
        '  <string>Apple Distribution</string>',
        '  <key>signingStyle</key>',
        '  <string>manual</string>',
        '  <key>teamID</key>',
        '  <string>AB12CD34EF</string>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n')
    )
  })

  it('escapes XML characters in a profile name', () => {
    expect(exportOptionsPlist({ teamId: 'AB12CD34EF', bundleId: 'com.nousresearch.hermesergates', profileName: 'Ergates & "Store" <1>' })).toContain(
      '    <string>Ergates &amp; &quot;Store&quot; &lt;1&gt;</string>'
    )
  })
})
