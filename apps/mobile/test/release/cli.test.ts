/// <reference types="node" />
/**
 * scripts/release/cli.mjs as the release workflow runs it: a node process
 * with the GitHub run in its environment.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const APP = path.resolve(import.meta.dirname, '../..')
const CLI = path.join(APP, 'scripts/release/cli.mjs')
const APP_VERSION: string = JSON.parse(readFileSync(path.join(APP, 'app.json'), 'utf8')).expo.version
// The real git binary, resolved once: the symlink tests below redirect the
// `git` on PATH to a throwaway repository via `-C`, and still need the real
// executable underneath to do that.
const REAL_GIT = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()

let scratch: string

function cli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...env } })
}

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'release-cli-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('cli metadata', () => {
  it('prints the outputs and appends them to GITHUB_OUTPUT', () => {
    const output = path.join(scratch, 'github-output')
    writeFileSync(output, 'earlier=1\n')

    const result = cli(['metadata'], {
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: `v${APP_VERSION}-rc.3`,
      GITHUB_RUN_NUMBER: '17',
      BUILD_NUMBER_OFFSET: '100',
      BUILD_NUMBER_OVERRIDE: '',
      GITHUB_OUTPUT: output,
    })

    const lines = `tag=v${APP_VERSION}-rc.3\nversion=${APP_VERSION}\nchannel=rc\nbuild-number=117\n`
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(lines)
    expect(readFileSync(output, 'utf8')).toBe(`earlier=1\n${lines}`)
  })

  it('fails with an error annotation on a branch', () => {
    const result = cli(['metadata'], { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'develop', GITHUB_RUN_NUMBER: '17' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('::error::A release run needs a release tag, but this run is on the branch develop.')
  })
})

describe('cli set-build-number', () => {
  it('writes the build number into a copy of app.json and keeps the rest', () => {
    const file = path.join(scratch, 'app.json')
    copyFileSync(path.join(APP, 'app.json'), file)
    const before = JSON.parse(readFileSync(file, 'utf8'))

    const result = cli(['set-build-number', '42', file])

    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect(result.status).toBe(0)
    expect(after.expo.ios.buildNumber).toBe('42')
    expect(after.expo.android.versionCode).toBe(42)
    delete after.expo.ios.buildNumber
    delete after.expo.android.versionCode
    expect(after).toEqual(before)
  })

  it('refuses a build number that is not a whole number', () => {
    const file = path.join(scratch, 'app.json')
    copyFileSync(path.join(APP, 'app.json'), file)

    const result = cli(['set-build-number', '4x', file])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('::error::The build number must be a whole number from 1 to 2100000000, got NaN.')
    expect(readFileSync(file, 'utf8')).toBe(readFileSync(path.join(APP, 'app.json'), 'utf8'))
  })
})

describe('cli ios-signing', () => {
  it('refuses a development profile before it writes anything', () => {
    const exportOptions = path.join(scratch, 'ExportOptions.plist')

    const result = cli(['ios-signing', exportOptions], {
      APPLE_TEAM_ID: 'AB12CD34EF',
      PROFILE_NAME: 'Ergates Development',
      PROFILE_UUID: '0f5e3c9a-1111-4222-8333-944455556666',
      PROFILE_TEAM_ID: 'AB12CD34EF',
      PROFILE_APP_ID: 'AB12CD34EF.com.nousresearch.hermesergates',
      PROFILE_GET_TASK_ALLOW: 'true',
      PROFILE_DEVICES: '',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe('::error::The provisioning profile is a development or ad hoc profile. Create an App Store profile (RELEASING.md).\n')
    expect(existsSync(exportOptions)).toBe(false)
  })
})

describe('cli secrets', () => {
  const RELEASE_ENV = [
    'APPLE_TEAM_ID=AB12CD34EF',
    'IOS_DIST_CERT_PASSWORD=p12-secret',
    'APP_STORE_CONNECT_KEY_ID=ZX98YW76VU',
    'APP_STORE_CONNECT_ISSUER_ID=69a6de7e-1234-47e3-a053-5b8c7c11a4d1',
    'ANDROID_UPLOAD_KEY_ALIAS=upload',
    'ANDROID_UPLOAD_KEYSTORE_PASSWORD=keystore-secret',
    'ANDROID_UPLOAD_KEY_PASSWORD=keystore-secret',
    '',
  ].join('\n')
  const P8 = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n'
  const PLAY_JSON = JSON.stringify({ type: 'service_account', client_email: 'ci@ergates.iam.gserviceaccount.com', private_key: 'k' })

  function releaseFolder(env = RELEASE_ENV, parent = scratch): string {
    const dir = path.join(parent, 'release')
    mkdirSync(dir, { mode: 0o700 })
    const files: Record<string, string | Buffer> = {
      'release.env': env,
      'ios-distribution.p12': Buffer.from([48, 130, 1, 2]),
      'ios-appstore.mobileprovision': Buffer.from([48, 128, 6, 9]),
      'asc-api-key.p8': P8,
      'android-upload.jks': Buffer.from([48, 130, 10, 4]),
      'play-service-account.json': PLAY_JSON,
    }
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content, { mode: 0o600 })
    return dir
  }

  function fakeBin(): string {
    const bin = path.join(scratch, 'bin')
    mkdirSync(bin, { recursive: true })
    return bin
  }

  /** A fake `gh` recording every call (argv and stdin) to GH_LOG, and able to simulate the environment or its tag policy already existing. */
  function writeFakeGh(bin: string, { environmentExists = false, policyPresent = false } = {}): string {
    const policies = policyPresent
      ? { total_count: 1, branch_policies: [{ id: 1, name: 'v*', type: 'tag' }] }
      : { total_count: 0, branch_policies: [] }
    const stub = [
      '#!/usr/bin/env bash',
      `{ printf 'gh'; printf ' %s' "$@"; printf '\\n'; printf 'stdin=%s\\n' "$(cat)"; } >> "$GH_LOG"`,
      'case "$*" in',
      `  "api repos/{owner}/{repo}/environments/app-stores") exit ${environmentExists ? 0 : 1} ;;`,
      `  "api repos/{owner}/{repo}/environments/app-stores/deployment-branch-policies") echo '${JSON.stringify(policies)}' ;;`,
      'esac',
      '',
    ].join('\n')
    writeFileSync(path.join(bin, 'gh'), stub, { mode: 0o755 })
    return path.join(scratch, 'gh.log')
  }

  /**
   * git as gitProblems() calls it. `rev-parse --show-toplevel` reports
   * $FAKE_GIT_ROOT, or fails (repository root unknown) when that is unset;
   * `check-ignore` exits $FAKE_GIT_CHECK_IGNORE_EXIT (0 ignored, 1 not
   * ignored, anything else "cannot verify"). One stub file; each test passes
   * its own values through the environment, not the script text.
   */
  function writeFakeGit(bin: string) {
    const stub = [
      '#!/usr/bin/env bash',
      'case "$1" in',
      '  rev-parse)',
      '    if [ -z "${FAKE_GIT_ROOT:-}" ]; then exit 1; fi',
      '    printf \'%s\\n\' "$FAKE_GIT_ROOT"',
      '    ;;',
      '  check-ignore)',
      '    exit "${FAKE_GIT_CHECK_IGNORE_EXIT:-0}"',
      '    ;;',
      '  *)',
      '    exit 1',
      '    ;;',
      'esac',
      '',
    ].join('\n')
    writeFileSync(path.join(bin, 'git'), stub, { mode: 0o755 })
  }

  /**
   * Real git, redirected: every call runs as `git -C $FAKE_GIT_ROOT ...`, so
   * gitProblems() (whose git calls always run with `cwd: APP_DIR`, the real
   * checkout) is made to see a throwaway repository instead. Unlike
   * writeFakeGit above, `check-ignore` is not canned: it is real git,
   * genuinely evaluating the path argument it is given against that
   * repository's own ignore rules and its own containment check. That is
   * the only way to reproduce (and verify the fix for) a `RELEASE_DIR` that
   * is a symlink: the bug is specifically about which path text and cwd
   * reach git, and a canned exit code cannot tell the two apart.
   */
  function writeRealGitRedirect(bin: string) {
    const stub = ['#!/usr/bin/env bash', 'exec "$REAL_GIT" -C "$FAKE_GIT_ROOT" "$@"', ''].join('\n')
    writeFileSync(path.join(bin, 'git'), stub, { mode: 0o755 })
  }

  /** A real, throwaway git repository under scratch (never the checked-out repo), with a release/ folder inside it that releaseFolder() fills. */
  function releaseFolderInRealRepo(ignoreReleaseFolder: boolean): { repoDir: string; symlink: string } {
    const repoDir = path.join(scratch, 'repo')
    mkdirSync(repoDir)
    const init = spawnSync(REAL_GIT, ['init', '-q'], { cwd: repoDir })
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`)
    if (ignoreReleaseFolder) writeFileSync(path.join(repoDir, '.gitignore'), 'release/\n')
    const dir = releaseFolder(RELEASE_ENV, repoDir)
    const symlink = path.join(scratch, 'release-symlink')
    symlinkSync(dir, symlink, 'dir')
    return { repoDir, symlink }
  }

  /** Stands in for keytool: creates an empty file at the -keystore path and exits 0, so the success path of make-upload-keystore runs without a real JDK. */
  function writeFakeKeytool(bin: string) {
    const stub = [
      '#!/usr/bin/env bash',
      'prev=""',
      'for arg in "$@"; do',
      '  if [ "$prev" = "-keystore" ]; then : > "$arg"; fi',
      '  prev="$arg"',
      'done',
      'exit 0',
      '',
    ].join('\n')
    writeFileSync(path.join(bin, 'keytool'), stub, { mode: 0o755 })
  }

  it('check names what is missing and uploads nothing', () => {
    const dir = path.join(scratch, 'release')
    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(path.join(dir, 'release.env'), 'APPLE_TEAM_ID=AB12CD34EF\n', { mode: 0o600 })

    const result = cli(['secrets-check'], { ERGATES_RELEASE_DIR: dir })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('::error::IOS_DIST_CERT_PASSWORD is missing in release.env.')
    expect(result.stderr).toContain('::error::ios-distribution.p12 is missing.')
  })

  it('secrets-check refuses a release folder that is not mode 700', () => {
    const dir = releaseFolder()
    chmodSync(dir, 0o750)

    const result = cli(['secrets-check'], { ERGATES_RELEASE_DIR: dir })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`::error::${dir} is readable by other users: chmod 700 it.`)
  })

  it('secrets-check refuses a secret file that is not mode 600', () => {
    const dir = releaseFolder()
    const envFile = path.join(dir, 'release.env')
    chmodSync(envFile, 0o644)

    const result = cli(['secrets-check'], { ERGATES_RELEASE_DIR: dir })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`::error::${envFile} is readable by other users: chmod 600 it.`)
  })

  it('secrets-check succeeds when the release folder is outside this repository', () => {
    // No git stub here: real git decides, and this scratch folder (under the
    // OS temp dir) really is outside the checked-out repository, so
    // gitProblems must skip the check-ignore call entirely.
    const dir = releaseFolder()

    const result = cli(['secrets-check'], { ERGATES_RELEASE_DIR: dir })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`✓ ${dir}: every secret of the app-stores environment is ready`)
  })

  it('secrets-check succeeds when the release folder is inside the repository and git ignores it', () => {
    const dir = releaseFolder()
    const bin = fakeBin()
    writeFakeGit(bin)

    const result = cli(['secrets-check'], {
      ERGATES_RELEASE_DIR: dir,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_GIT_ROOT: scratch,
      FAKE_GIT_CHECK_IGNORE_EXIT: '0',
    })

    expect(result.status).toBe(0)
  })

  it('secrets-check refuses when the release folder is inside the repository and git does not ignore it', () => {
    const dir = releaseFolder()
    const bin = fakeBin()
    writeFakeGit(bin)

    const result = cli(['secrets-check'], {
      ERGATES_RELEASE_DIR: dir,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_GIT_ROOT: scratch,
      FAKE_GIT_CHECK_IGNORE_EXIT: '1',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`::error::${dir} is not ignored by git. Stop: the secrets could be committed.`)
  })

  it('secrets-check refuses when git cannot say whether an inside release folder is ignored', () => {
    const dir = releaseFolder()
    const bin = fakeBin()
    writeFakeGit(bin)

    const result = cli(['secrets-check'], {
      ERGATES_RELEASE_DIR: dir,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_GIT_ROOT: scratch,
      FAKE_GIT_CHECK_IGNORE_EXIT: '128',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`::error::cannot verify ${dir} is ignored by git.`)
  })

  it('secrets-check refuses when git cannot report the repository root at all', () => {
    const dir = releaseFolder()
    const bin = fakeBin()
    writeFakeGit(bin)

    const result = cli(['secrets-check'], { ERGATES_RELEASE_DIR: dir, PATH: `${bin}:${process.env.PATH ?? ''}` })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`::error::cannot verify ${dir} is ignored by git.`)
  })

  it('secrets-check succeeds when the release folder is a symlink outside the repository to an ignored folder inside it', () => {
    // The macOS /tmp -> /private/tmp case: ERGATES_RELEASE_DIR is a symlink
    // whose own path is outside the work tree, but whose target resolves
    // inside it. The realpath-based inside/outside decision correctly calls
    // this "inside"; the git check-ignore probe must still succeed, by
    // running on the resolved path relative to the resolved repo root.
    const bin = fakeBin()
    writeRealGitRedirect(bin)
    const { repoDir, symlink } = releaseFolderInRealRepo(true)

    const result = cli(['secrets-check'], {
      ERGATES_RELEASE_DIR: symlink,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      REAL_GIT,
      FAKE_GIT_ROOT: repoDir,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`✓ ${symlink}: every secret of the app-stores environment is ready`)
  })

  it('secrets-check refuses when the release folder is a symlink outside the repository to a folder inside it that git does not ignore', () => {
    const bin = fakeBin()
    writeRealGitRedirect(bin)
    const { repoDir, symlink } = releaseFolderInRealRepo(false)

    const result = cli(['secrets-check'], {
      ERGATES_RELEASE_DIR: symlink,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      REAL_GIT,
      FAKE_GIT_ROOT: repoDir,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`::error::${symlink} is not ignored by git. Stop: the secrets could be committed.`)
  })

  it('upload creates the environment with its tag rule and sends every value on stdin', () => {
    const bin = fakeBin()
    const GH_LOG = writeFakeGh(bin, { environmentExists: false, policyPresent: false })

    const result = cli(['secrets-upload'], { ERGATES_RELEASE_DIR: releaseFolder(), PATH: `${bin}:${process.env.PATH ?? ''}`, GH_LOG })

    expect(result.status).toBe(0)
    expect(result.stdout).not.toMatch(/p12-secret|keystore-secret|BEGIN PRIVATE KEY/)
    expect(result.stdout).toContain('✓ environment app-stores created\n')
    expect(result.stdout).toContain('✓ secret APP_STORE_CONNECT_PRIVATE_KEY\n')
    expect(result.stdout).toContain('✓ variable APPLE_TEAM_ID\n')
    const log = readFileSync(GH_LOG, 'utf8')
    const calls = log.split('\n').filter(line => line.startsWith('gh '))
    expect(calls.slice(0, 4)).toEqual([
      'gh api repos/{owner}/{repo}/environments/app-stores',
      'gh api --method PUT repos/{owner}/{repo}/environments/app-stores --input -',
      'gh api repos/{owner}/{repo}/environments/app-stores/deployment-branch-policies',
      'gh api --method POST repos/{owner}/{repo}/environments/app-stores/deployment-branch-policies --input -',
    ])
    expect(calls).toHaveLength(4 + 11 + 1)
    expect(calls.join('\n')).not.toMatch(/p12-secret|keystore-secret/)
    expect(log).toContain('gh secret set IOS_DIST_CERT_PASSWORD --env app-stores\nstdin=p12-secret\n')
    expect(log).toContain('gh secret set ANDROID_UPLOAD_KEYSTORE_BASE64 --env app-stores\nstdin=MIIKBA==\n')
    expect(log).toContain('stdin={"name":"v*","type":"tag"}\n')
  })

  it('upload repairs an already-existing environment and does not duplicate an already-present tag policy', () => {
    const bin = fakeBin()
    const GH_LOG = writeFakeGh(bin, { environmentExists: true, policyPresent: true })

    const result = cli(['secrets-upload'], { ERGATES_RELEASE_DIR: releaseFolder(), PATH: `${bin}:${process.env.PATH ?? ''}`, GH_LOG })

    expect(result.status).toBe(0)
    expect(result.stdout).not.toMatch(/p12-secret|keystore-secret|BEGIN PRIVATE KEY/)
    expect(result.stdout).toContain('✓ environment app-stores updated\n')
    const log = readFileSync(GH_LOG, 'utf8')
    const calls = log.split('\n').filter(line => line.startsWith('gh '))
    expect(calls.slice(0, 3)).toEqual([
      'gh api repos/{owner}/{repo}/environments/app-stores',
      'gh api --method PUT repos/{owner}/{repo}/environments/app-stores --input -',
      'gh api repos/{owner}/{repo}/environments/app-stores/deployment-branch-policies',
    ])
    expect(calls.some(call => call.includes('--method POST'))).toBe(false)
    expect(calls).toHaveLength(3 + 11 + 1)
    expect(calls.join('\n')).not.toMatch(/p12-secret|keystore-secret/)
  })

  it('make-upload-keystore refuses two different passwords before it runs keytool', () => {
    const env = RELEASE_ENV.replace('ANDROID_UPLOAD_KEY_PASSWORD=keystore-secret', 'ANDROID_UPLOAD_KEY_PASSWORD=other-secret')
    const dir = releaseFolder(env)
    rmSync(path.join(dir, 'android-upload.jks'))

    const result = cli(['make-upload-keystore'], { ERGATES_RELEASE_DIR: dir })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(
      '::error::ANDROID_UPLOAD_KEY_PASSWORD must be the same as ANDROID_UPLOAD_KEYSTORE_PASSWORD: a PKCS12 keystore has one password.\n'
    )
    expect(existsSync(path.join(dir, 'android-upload.jks'))).toBe(false)
  })

  it('make-upload-keystore never prints the alias value', () => {
    const alias = 'dummy-alias-do-not-leak-5f2a9c1d'
    const env = RELEASE_ENV.replace('ANDROID_UPLOAD_KEY_ALIAS=upload', `ANDROID_UPLOAD_KEY_ALIAS=${alias}`)
    const dir = releaseFolder(env)
    rmSync(path.join(dir, 'android-upload.jks'))
    const bin = fakeBin()
    writeFakeKeytool(bin)

    const result = cli(['make-upload-keystore'], { ERGATES_RELEASE_DIR: dir, PATH: `${bin}:${process.env.PATH ?? ''}` })

    expect(result.status).toBe(0)
    for (const line of result.stdout.split('\n')) expect(line).not.toContain(alias)
    expect(result.stdout).toContain(`✓ ${path.join(dir, 'android-upload.jks')} created`)
  })
})
