#!/usr/bin/env bash
# A throwaway Hermes at the pin, for checking plugin updates on a simulator or a
# phone before a release candidate. It never touches ~/.hermes or a Hermes you
# already run: everything lives in .cache/device-check (see device_hermes.py).
#
#   scripts/device-hermes.sh start --commit <sha> [--port 9131]  # install the plugin at <sha> from GitHub, then serve
#   scripts/device-hermes.sh break                  # the installed plugin fails at its next load
#   scripts/device-hermes.sh restart [--new-token]  # restart, with a new session token if asked
#   scripts/device-hermes.sh status
#   scripts/device-hermes.sh stop                   # stop the server and remove everything
#
# CONTRIBUTING.md "Device check of plugin updates" walks through a check.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Only the functions: ci-local.sh runs its jobs when it is executed, not when it is sourced.
# shellcheck disable=SC1091
source "$ROOT/scripts/ci-local.sh"

prepare_hermes_source
requirements="$ROOT/.cache/hermes-requirements.txt"
uv export --quiet --frozen --no-dev --no-emit-project --no-hashes --project "$HERMES_SOURCE" -o "$requirements"
# --no-project: the test project installs this checkout's `ergates` package, and a server must run the plugin it installed.
exec uv run --no-project --python 3.11 --with-requirements "$requirements" python -I -B "$ROOT/scripts/device_hermes.py" "$@"
