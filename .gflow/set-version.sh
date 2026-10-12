#!/usr/bin/env bash
# gflow's version script (gflow README, "Version script"). gflow runs it with
# the clean X.Y.Z of a new release or hotfix, never an -rc.N, and commits what
# it changed as "chore: set version X.Y.Z". It writes that one version into
# every file of the repository that carries it (apps/mobile/RELEASING.md) and
# changes nothing else. A file whose version line is not where this script
# expects it stops the run before any file is written.
#
# It writes only on a release or hotfix branch (and on gflow's release-chore
# branch for a release). gflow also runs it to move develop to the next minor,
# on develop itself or on a chore/set-version-* branch; there it changes
# nothing, so the version reaches develop only through gflow's release and
# hotfix merges, and those merges never conflict on the version lines.
#
#   .gflow/set-version.sh 0.3.0
set -euo pipefail

version="${1:-}"
if [[ ! "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "set-version: expected a version like 1.2.3, got '$version'" >&2
  exit 2
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
case "$branch" in
  release/* | hotfix/* | release-chore/*) ;;
  *)
    echo "set-version: ${branch:-a detached HEAD} is not a release or hotfix branch; its version comes from gflow's release and hotfix merges, so nothing changed"
    exit 0
    ;;
esac

node - "$version" <<'JS'
const fs = require('node:fs')

const version = process.argv[2]
// Each file with the version lines to rewrite. Every pattern must match
// exactly once; its first group is kept, the version after it is replaced.
const FILES = [
  ['apps/mobile/app.json', [/^(    "version": ")[^"]*(?=",?$)/gm]],
  ['apps/mobile/package.json', [/^(  "version": ")[^"]*(?=",?$)/gm]],
  ['apps/mobile/package-lock.json', [
    /^(  "version": ")[^"]*(?=",?$)/gm,
    /^(    "": \{\n      "name": "ergates-mobile",\n      "version": ")[^"]*(?=",?$)/gm,
  ]],
  ['integrations/ergates/pyproject.toml', [/^(version = ")[^"]*(?="$)/gm]],
  ['integrations/ergates/plugin.yaml', [/^(version: )\S+$/gm]],
  ['integrations/ergates/ergates/__init__.py', [/^(__version__ = ")[^"]*(?="$)/gm]],
  ['integrations/ergates/dashboard/manifest.json', [/^(  "version": ")[^"]*(?=",?$)/gm]],
  ['integrations/ergates/uv.lock', [/^(\[\[package\]\]\nname = "ergates"\nversion = ")[^"]*(?="$)/gm]],
  ['integrations/ergates-tests/uv.lock', [/^(\[\[package\]\]\nname = "ergates"\nversion = ")[^"]*(?="$)/gm]],
]

const updates = FILES.map(([file, patterns]) => {
  let text = fs.readFileSync(file, 'utf8')
  for (const pattern of patterns) {
    const found = text.match(pattern) ?? []
    if (found.length !== 1) {
      console.error(`set-version: ${file}: expected one version line for ${pattern}, found ${found.length}. Nothing was written.`)
      process.exit(1)
    }
    text = text.replace(pattern, (_line, head) => `${head}${version}`)
  }
  return [file, text]
})

for (const [file, text] of updates) {
  if (fs.readFileSync(file, 'utf8') !== text) {
    fs.writeFileSync(file, text)
    console.log(`set-version: ${file} -> ${version}`)
  }
}
JS
