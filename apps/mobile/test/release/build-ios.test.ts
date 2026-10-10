/// <reference types="node" />
/**
 * build-ios.sh's own behavior, run through its `--read-profile-fields` and
 * `--require-one-workspace` test hooks (no decoded certificate, no Xcode, and
 * none of BUILD_NUMBER and the other variables the full build needs), plus
 * the secret-tracing rule that applies to the whole script.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const APP = path.resolve(import.meta.dirname, '../..')
const SCRIPT = path.join(APP, 'scripts/release/build-ios.sh')

const VALID_PROFILE_PLIST = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  '<dict>',
  '  <key>Entitlements</key>',
  '  <dict>',
  '    <key>application-identifier</key>',
  '    <string>AB12CD34EF.dev.middelkamp.ergates</string>',
  '    <key>get-task-allow</key>',
  '    <false/>',
  '  </dict>',
  '  <key>Name</key>',
  '  <string>Ergates App Store</string>',
  '  <key>TeamIdentifier</key>',
  '  <array>',
  '    <string>AB12CD34EF</string>',
  '  </array>',
  '  <key>UUID</key>',
  '  <string>0f5e3c9a-1111-4222-8333-944455556666</string>',
  '</dict>',
  '</plist>',
  '',
].join('\n')

let home: string
let scratch: string

beforeEach(() => {
  // A real HOME (even an empty one): the script reads $HOME under `set -u`
  // before it reaches the checks these tests are about, and an unset HOME
  // would stop it there instead, for an unrelated reason.
  home = mkdtempSync(path.join(tmpdir(), 'build-ios-home-'))
  scratch = mkdtempSync(path.join(tmpdir(), 'build-ios-scratch-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })
})

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', HOME: home, ...env },
  })
}

describe('build-ios.sh', () => {
  it('does not trace a secret value onto stderr under bash -x', () => {
    const secret = 'dummy-secret-do-not-leak-4f7c1e9b'

    const result = spawnSync('bash', ['-x', SCRIPT], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', HOME: home, IOS_DIST_CERT_PASSWORD: secret },
    })

    expect(result.stderr).not.toContain(secret)
  })
})

// PlistBuddy (/usr/libexec/PlistBuddy) only exists on macOS; CI's ubuntu-latest runners have no path to it.
describe.skipIf(process.platform !== 'darwin')('build-ios.sh --read-profile-fields', () => {
  it('extracts the Name, UUID and team of a valid profile plist', () => {
    const plist = path.join(scratch, 'profile.plist')
    writeFileSync(plist, VALID_PROFILE_PLIST)

    const result = run(['--read-profile-fields', plist])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(
      [
        'NAME=Ergates App Store',
        'UUID=0f5e3c9a-1111-4222-8333-944455556666',
        'TEAM_ID=AB12CD34EF',
        'APP_ID=AB12CD34EF.dev.middelkamp.ergates',
        'GET_TASK_ALLOW=false',
        'DEVICES=',
        '',
      ].join('\n')
    )
    expect(result.stderr).toBe('')
  })

  it('refuses a profile plist missing the UUID, and prints nothing else', () => {
    const plist = path.join(scratch, 'profile.plist')
    writeFileSync(plist, ['<?xml version="1.0" encoding="UTF-8"?>', '<plist version="1.0">', '<dict>', '  <key>Name</key>', '  <string>Ergates App Store</string>', '</dict>', '</plist>', ''].join('\n'))

    const result = run(['--read-profile-fields', plist])

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(`build-ios: ${plist} has no Name or UUID. Is IOS_APPSTORE_PROFILE_BASE64 a .mobileprovision file?\n`)
    expect(result.stdout).toBe('')
  })

  it('refuses a file that is not a plist at all, and prints nothing else', () => {
    const plist = path.join(scratch, 'profile.plist')
    writeFileSync(plist, 'not a plist, just garbage text\n')

    const result = run(['--read-profile-fields', plist])

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(`build-ios: ${plist} did not parse as a plist. Is IOS_APPSTORE_PROFILE_BASE64 a .mobileprovision file?\n`)
    expect(result.stdout).toBe('')
  })
})

describe('build-ios.sh --require-one-workspace', () => {
  it('prints the path of the one workspace', () => {
    const dir = path.join(scratch, 'ios')
    mkdirSync(path.join(dir, 'Ergates.xcworkspace'), { recursive: true })

    const result = run(['--require-one-workspace', dir])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${path.join(dir, 'Ergates.xcworkspace')}\n`)
  })

  it('refuses a directory with no workspace', () => {
    const dir = path.join(scratch, 'ios')
    mkdirSync(dir, { recursive: true })

    const result = run(['--require-one-workspace', dir])

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(`build-ios: expected exactly one ${dir}/*.xcworkspace, found 0\n`)
  })

  it('refuses a directory with more than one workspace', () => {
    const dir = path.join(scratch, 'ios')
    mkdirSync(path.join(dir, 'A.xcworkspace'), { recursive: true })
    mkdirSync(path.join(dir, 'B.xcworkspace'), { recursive: true })

    const result = run(['--require-one-workspace', dir])

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(`build-ios: expected exactly one ${dir}/*.xcworkspace, found 2 (${path.join(dir, 'A.xcworkspace')} ${path.join(dir, 'B.xcworkspace')})\n`)
  })
})
