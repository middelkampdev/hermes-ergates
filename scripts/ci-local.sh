#!/usr/bin/env bash
# The CI jobs, runnable on a laptop. .github/workflows/ci.yml calls this same
# script for every job, so a local run and a CI run execute the same commands.
#
#   scripts/ci-local.sh              # every job in JOBS, in order
#   scripts/ci-local.sh mobile lint  # only these jobs
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JOBS=(lint mobile integration contract deploy)
# Jobs that run only when named. `contract-live` is the live half of `contract`
# alone, for the weekly run against the newest Hermes release
# (.github/workflows/contract-latest.yml).
NAMED_JOBS=(contract-live)

# The workflow files (actionlint) and the shell scripts themselves (bash -n,
# then shellcheck), including the release scripts that otherwise first run in
# a release.
job_lint() {
  local scripts=("$ROOT/scripts/ci-local.sh" "$ROOT/.gflow/set-version.sh" "$ROOT"/apps/mobile/scripts/release/*.sh)
  local script
  for script in "${scripts[@]}"; do
    bash -n "$script"
  done
  uvx --from shellcheck-py==0.11.0.1 shellcheck "${scripts[@]}"
  (cd "$ROOT" && uvx --from actionlint-py==1.7.12.25 actionlint)
}

# CI starts from an empty runner and always runs `npm ci`. Locally the job keeps
# a working node_modules (a running Metro uses it) unless it is missing or
# CI_LOCAL_FRESH=1 is set.
job_mobile() {
  cd "$ROOT/apps/mobile"
  if [[ -n "${CI:-}" || "${CI_LOCAL_FRESH:-0}" == "1" || ! -d node_modules ]]; then
    npm ci --no-audit --no-fund
  fi
  npm run typecheck
  npm run lint
  npm run test:coverage
  npm run depcruise
}

# The plugin's tests are their own project, integrations/ergates-tests, so the
# plugin folder users install holds only runtime code. Its pyproject.toml
# installs the plugin as an editable dependency, with pytest, pytest-cov and
# pyyaml. --locked makes uv fail instead of rewriting the committed uv.lock
# that pins them.
TESTS_DIR="$ROOT/integrations/ergates-tests"
UV_TEST=(uv run --locked --python 3.11)

# The test suite, plus the coverage gate.
job_integration() {
  cd "$TESTS_DIR"
  "${UV_TEST[@]}" pytest --cov --cov-fail-under=90
}

# Same pin in integrations/ergates-tests/contract/pinned.py and .github/workflows/ci.yml (contract job `ref`).
# pinned.py also holds the release's version (HERMES_PIN_VERSION), which the plugin's `requires_hermes` names.
HERMES_PIN="818c13be1dc4fd28987e1e881a9408224afd4535"

# Fails unless $1 is a Hermes checkout at the expected commit without local
# changes or untracked files (`git diff` would miss the untracked ones). The
# expected commit is HERMES_EXPECTED_REF when set and not empty (the CI job
# `contract-latest` sets it to the newest Hermes release), else the pin. Same
# rule as `expected_ref()` in integrations/ergates-tests/contract/pinned.py.
# Checks every git exit code itself: `set -e` does not apply inside a function
# called from an `if`.
check_pin() {
  local expected="${HERMES_EXPECTED_REF:-$HERMES_PIN}" head changes
  if ! head="$(git -C "$1" rev-parse HEAD)" || [[ "$head" != "$expected" ]]; then
    echo "ci-local: $1 is at ${head:-no commit}, not the expected Hermes commit $expected (HERMES_EXPECTED_REF, else the pin)" >&2
    return 1
  fi
  if ! changes="$(git -C "$1" status --porcelain)" || [[ -n "$changes" ]]; then
    echo "ci-local: $1 has local changes or untracked files; the contract tests need the pinned files as committed" >&2
    return 1
  fi
}

# Exports HERMES_SOURCE, a checkout at the pin (or at HERMES_EXPECTED_REF):
#  - HERMES_SOURCE when set (CI checks the pin, or the newest release, out there);
#  - else $ROOT/.cache/hermes-pin, created once as a detached `git worktree add`
#    from HERMES_REPO (default ~/Projects/misc/hermes/hermes-agent), or fetched
#    from GitHub when that clone does not have the pinned commit.
# The only write to an existing Hermes clone is that `git worktree add`: when
# it fails, or the cache is left half-made, the script prints what to clean up
# and leaves the clone alone.
prepare_hermes_source() {
  if [[ -n "${HERMES_SOURCE:-}" ]]; then
    check_pin "$HERMES_SOURCE"
    return
  fi
  if [[ -n "${HERMES_EXPECTED_REF:-}" ]]; then
    echo "ci-local: HERMES_EXPECTED_REF needs HERMES_SOURCE; the cache in $ROOT/.cache/hermes-pin is always at the pin" >&2
    return 1
  fi
  local cache="$ROOT/.cache/hermes-pin"
  local repo="${HERMES_REPO:-$HOME/Projects/misc/hermes/hermes-agent}"
  local hint="ci-local: could not prepare $cache. Delete it and run again; if git says the worktree is still registered, run \`git -C $repo worktree prune\` yourself."
  if [[ ! -e "$cache" ]]; then
    mkdir -p "$ROOT/.cache"
    if git -C "$repo" cat-file -e "$HERMES_PIN^{commit}" 2>/dev/null; then
      if ! git -C "$repo" worktree add --detach "$cache" "$HERMES_PIN"; then
        echo "$hint" >&2
        return 1
      fi
    elif ! { git init -q "$cache" &&
      git -C "$cache" fetch -q --depth 1 https://github.com/NousResearch/hermes-agent "$HERMES_PIN" &&
      git -C "$cache" checkout -q --detach FETCH_HEAD; }; then
      echo "$hint" >&2
      return 1
    fi
  fi
  if ! check_pin "$cache"; then
    echo "$hint" >&2
    return 1
  fi
  export HERMES_SOURCE="$cache"
}

# Two pytest runs. `contract/` reads the pinned source as text and runs the
# pinned install scanner (standard library only) on the plugin folder, which
# must rate it `safe` (test_install_scan.py); it needs no Hermes dependency.
# `contract/live/` imports the pinned Hermes itself and installs the plugin
# through it, and runs `hermes plugins validate`, the catalog's admission
# check, on the plugin folder (test_catalog_validate.py), so it runs with
# Hermes's locked runtime dependencies, exported from the pin's own uv.lock
# into .cache/ (the export writes nothing in the Hermes checkout).
job_contract() {
  prepare_hermes_source
  cd "$TESTS_DIR"
  "${UV_TEST[@]}" pytest contract
  contract_live
}

# Only `contract/live/`, the install scan and the catalog validator included.
# The text suite pins exact Hermes line numbers, which move in nearly every
# release, so the weekly run against the newest release skips it.
job_contract_live() {
  prepare_hermes_source
  contract_live
}

# Needs HERMES_SOURCE (prepare_hermes_source).
contract_live() {
  cd "$TESTS_DIR"
  local requirements="$ROOT/.cache/hermes-requirements.txt"
  mkdir -p "$ROOT/.cache"
  uv export --quiet --frozen --no-dev --no-emit-project --no-hashes --project "$HERMES_SOURCE" -o "$requirements"
  "${UV_TEST[@]}" --with-requirements "$requirements" pytest contract/live
}

job_deploy() {
  cd "$ROOT"
  docker compose -f deploy/docker-compose.yml --env-file deploy/.env.example config --quiet
  uv run --no-project --python 3.11 --with pytest --with pyyaml pytest -p no:cacheprovider deploy/tests
}

main() {
  local selected=("$@")
  if [[ ${#selected[@]} -eq 0 ]]; then
    selected=("${JOBS[@]}")
  fi
  local job
  for job in "${selected[@]}"; do
    if [[ " ${JOBS[*]} ${NAMED_JOBS[*]} " != *" $job "* ]]; then
      echo "ci-local: unknown job '$job' (jobs: ${JOBS[*]} ${NAMED_JOBS[*]})" >&2
      return 2
    fi
  done
  for job in "${selected[@]}"; do
    echo "==> $job"
    ("job_${job//-/_}")
  done
  echo "ci-local: passed: ${selected[*]}"
}

main "$@"
