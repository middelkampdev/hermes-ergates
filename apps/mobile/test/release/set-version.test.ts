/// <reference types="node" />
/**
 * .gflow/set-version.sh, run with bash on a copy of the files it writes, the
 * way gflow runs it: the clean X.Y.Z as the only argument, with the branch
 * gflow has checked out. The copy is a git repository whose HEAD names that
 * branch; it needs no commit.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../../../..')
const SCRIPT = '.gflow/set-version.sh'

/** Every file the script writes, with the lines it must produce for 9.8.7. */
const EXPECTED: Record<string, string[]> = {
  'apps/mobile/app.json': ['    "version": "9.8.7",'],
  'apps/mobile/package.json': ['  "version": "9.8.7",'],
  'apps/mobile/package-lock.json': ['  "version": "9.8.7",', '      "version": "9.8.7",'],
  'integrations/ergates/pyproject.toml': ['version = "9.8.7"'],
  'integrations/ergates/plugin.yaml': ['version: 9.8.7'],
  'integrations/ergates/ergates/__init__.py': ['__version__ = "9.8.7"'],
  'integrations/ergates/dashboard/manifest.json': ['  "version": "9.8.7",'],
  'integrations/ergates/uv.lock': ['version = "9.8.7"'],
  'integrations/ergates-tests/uv.lock': ['version = "9.8.7"'],
}
const FILES = Object.keys(EXPECTED)

let copy: string

function read(root: string, file: string): string {
  return readFileSync(path.join(root, file), 'utf8')
}

function run(...args: string[]) {
  return spawnSync('bash', [path.join(copy, SCRIPT), ...args], { encoding: 'utf8' })
}

function onBranch(branch: string) {
  spawnSync('git', ['-C', copy, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`])
}

function unchanged() {
  for (const file of FILES) {
    expect(read(copy, file), file).toBe(read(ROOT, file))
  }
}

/** The lines of `file` in the copy that differ from the repository's own file. */
function changedLines(file: string): string[] {
  const before = read(ROOT, file).split('\n')
  const after = read(copy, file).split('\n')
  expect(after).toHaveLength(before.length)
  return after.filter((line, index) => line !== before[index])
}

beforeEach(() => {
  copy = mkdtempSync(path.join(tmpdir(), 'set-version-'))
  for (const file of [SCRIPT, ...FILES]) {
    cpSync(path.join(ROOT, file), path.join(copy, file), { recursive: true })
  }
  spawnSync('git', ['init', '-q', copy])
  onBranch('release/0.3.0')
})

afterEach(() => {
  rmSync(copy, { recursive: true, force: true })
})

describe('set-version.sh', () => {
  it.each(['release/0.3.0', 'hotfix/0.3.1', 'release-chore/0.3.0/set-version'])(
    'on %s writes the version into every version line and changes no other line',
    branch => {
      onBranch(branch)

      const result = run('9.8.7')

      expect(result.status).toBe(0)
      for (const file of FILES) {
        expect(changedLines(file), file).toEqual(EXPECTED[file])
      }
    }
  )

  it.each(['develop', 'chore/set-version-0.4.0', 'feature/login'])('on %s changes nothing and says why', branch => {
    onBranch(branch)

    const result = run('9.8.7')

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(
      `set-version: ${branch} is not a release or hotfix branch; its version comes from gflow's release and hotfix merges, so nothing changed\n`
    )
    unchanged()
  })

  it('changes nothing on a second run with the same version', () => {
    run('9.8.7')
    const first = FILES.map(file => read(copy, file))

    const again = run('9.8.7')

    expect(again.status).toBe(0)
    expect(again.stdout).toBe('')
    expect(FILES.map(file => read(copy, file))).toEqual(first)
  })

  it.each([['0.3.0-rc.1'], ['v0.3.0'], ['0.3'], ['01.2.3'], ['']])('refuses %j and writes nothing', version => {
    const result = run(version)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('expected a version like 1.2.3')
    unchanged()
  })

  it('writes no file when one of them lost its version line', () => {
    const plugin = 'integrations/ergates/plugin.yaml'
    writeFileSync(path.join(copy, plugin), read(copy, plugin).replace(/^version: .*\n/m, ''))

    const result = run('9.8.7')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`${plugin}: expected one version line`)
    for (const file of FILES.filter(name => name !== plugin)) {
      expect(read(copy, file), file).toBe(read(ROOT, file))
    }
  })
})
