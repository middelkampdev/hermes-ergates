#!/usr/bin/env bash
# The device check of plugin updates on an iOS simulator, run by Maestro. It
# starts a throwaway Hermes with an older plugin (scripts/device-hermes.sh),
# Metro with the app's DEV connect hook, and a development build of the app.
# Then it runs the flows in apps/mobile/.maestro/device-check and changes the
# server between them. At the end it stops everything and removes the app.
#
#   scripts/device-check.sh --device <simulator udid> --old <sha> [--app <path to Ergates.app>]
#
# --old is the plugin commit the server starts with. The app updates it to HEAD,
# the commit of this checkout. Both must be pushed, because the plugin installs
# from GitHub. --app defaults to the newest Debug-iphonesimulator build in
# Xcode's DerivedData. The app on that simulator loses its data, so use a
# simulator you keep for tests. CONTRIBUTING.md "Device check of plugin
# updates" walks through a check.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES="$ROOT/scripts/device-hermes.sh"
STATE="$ROOT/.cache/device-check"
LOGS="$ROOT/.cache/device-check-logs"
FLOWS="$ROOT/apps/mobile/.maestro/device-check"
PLUGIN="integrations/ergates"
APP_ID=dev.middelkamp.ergates
METRO_PORT=8082
METRO_TIMEOUT_SECONDS=120

usage() {
  sed -n 's/^#   /usage: /p' "${BASH_SOURCE[0]}" >&2
  exit 2
}

fail() {
  echo "device-check: $*" >&2
  exit 1
}

# A full commit that a branch on GitHub holds, as far as the last fetch knows.
pushed() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] && [[ -n "$(git -C "$ROOT" branch -r --contains "$1" 2>/dev/null)" ]]
}

# The API_LEVEL line of the plugin source on stdin, or 0 for a plugin from before it had one.
api_level() {
  local level
  level="$(sed -n 's/^API_LEVEL = \([0-9][0-9]*\)$/\1/p')"
  echo "${level:-0}"
}

simulator_state() {
  xcrun simctl list devices | sed -n "s/.*($device) (\([A-Za-z]*\)).*/\1/p"
}

device="" old="" app=""
while (($#)); do
  [[ $# -ge 2 ]] || usage
  case "$1" in
    --device) device="$2" ;;
    --old) old="$2" ;;
    --app) app="$2" ;;
    *) usage ;;
  esac
  shift 2
done
[[ -n "$device" && -n "$old" ]] || usage
# The app's build record names this commit, and reads the plugin's version and API level from the checkout.
build="$(git -C "$ROOT" rev-parse HEAD)"

command -v maestro >/dev/null || fail "Maestro is not installed (https://docs.maestro.dev/getting-started/installing-maestro)"
git -C "$ROOT" fetch --quiet origin
pushed "$old" || fail "--old must be a full commit that is pushed to GitHub"
pushed "$build" || fail "HEAD must be pushed to GitHub"
git -C "$ROOT" diff --quiet HEAD -- "$PLUGIN" || fail "commit and push the changes in $PLUGIN first: the update installs the plugin at HEAD"
if [[ -z "$app" ]]; then
  # shellcheck disable=SC2012 # ls -t sorts by time; the paths hold no newlines.
  app="$(ls -dt "$HOME"/Library/Developer/Xcode/DerivedData/*/Build/Products/Debug-iphonesimulator/Ergates.app 2>/dev/null | head -1 || true)"
fi
[[ -d "$app" ]] || fail "no development build of the app; build one with npx expo run:ios, or pass --app"
[[ -n "$(simulator_state)" ]] || fail "no simulator $device; xcrun simctl list devices shows them"
[[ ! -e "$STATE" ]] || fail "a device check runs already, or one did not clean up; run scripts/device-hermes.sh stop first"
if lsof -nP -iTCP:"$METRO_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "something listens on port $METRO_PORT already, where this check runs Metro"
fi

metro_pid="" booted_here=false installed=false
cleanup() {
  local code=$?
  set +e
  if [[ -n "$metro_pid" ]]; then
    kill -- -"$metro_pid" 2>/dev/null
  fi
  "$HERMES" stop >/dev/null
  if $installed; then
    xcrun simctl uninstall "$device" "$APP_ID"
  fi
  if $booted_here; then
    xcrun simctl shutdown "$device"
  fi
  if ((code == 0)); then
    rm -rf "$LOGS"
    echo "The device check passed."
  else
    echo "The device check failed. Metro's log and Maestro's screenshots are in $LOGS." >&2
  fi
}
trap cleanup EXIT

rm -rf "$LOGS"
mkdir -p "$LOGS"

"$HERMES" start --commit "$old"

# Metro in its own process group, so that cleanup stops npx and everything it started.
set -m
(
  cd "$ROOT/apps/mobile"
  set -a
  # shellcheck disable=SC1091
  . "$STATE/metro.env"
  set +a
  ERGATES_PLUGIN_COMMIT="$build" exec npx expo start --clear --port "$METRO_PORT"
) >"$LOGS/metro.log" 2>&1 &
metro_pid=$!
set +m
for ((waited = 0; ; waited++)); do
  if [[ "$(curl -sf "http://127.0.0.1:$METRO_PORT/status" 2>/dev/null || true)" == *running* ]]; then
    break
  fi
  kill -0 "$metro_pid" 2>/dev/null || fail "Metro stopped; see $LOGS/metro.log"
  ((waited < METRO_TIMEOUT_SECONDS)) || fail "Metro did not start in $METRO_TIMEOUT_SECONDS seconds; see $LOGS/metro.log"
  sleep 1
done

if [[ "$(simulator_state)" != Booted ]]; then
  xcrun simctl boot "$device"
  booted_here=true
  xcrun simctl bootstatus "$device" -b >/dev/null
fi
xcrun simctl uninstall "$device" "$APP_ID" 2>/dev/null || true
installed=true
xcrun simctl install "$device" "$app"
# On a new install the development client opens its menu over the app, and a tap
# meant for the app lands in the menu. Its floating Tools button is turned off too.
for key in EXDevMenuShowsAtLaunch EXDevMenuShowFloatingActionButton; do
  xcrun simctl spawn "$device" defaults write "$APP_ID" "$key" -bool false
done
xcrun simctl spawn "$device" defaults write "$APP_ID" EXDevMenuIsOnboardingFinished -bool true
# The development client opens the bundle at --initialUrl, without its launcher screen.
xcrun simctl launch "$device" "$APP_ID" --initialUrl "http://127.0.0.1:$METRO_PORT" >/dev/null

flow() {
  MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true \
    maestro test --device "$device" --debug-output "$LOGS/maestro" "$FLOWS/$1"
}

# After going back, Finish says the previous version is back, and whether this app can use it: an
# older plugin with a lower API level than the build's needs the update again.
if (($(git -C "$ROOT" show "$old:$PLUGIN/ergates/__init__.py" | api_level) < $(api_level <"$ROOT/$PLUGIN/ergates/__init__.py"))); then
  ending="The previous version is back, but this app needs a newer plugin\..*"
else
  ending="The previous version is back\. Your server is ready\."
fi

flow 1-update.yaml
"$HERMES" break
"$HERMES" restart --new-token
MAESTRO_DEVICE_CHECK_TOKEN="$(<"$STATE/token")" flow 2-go-back.yaml
"$HERMES" restart
MAESTRO_DEVICE_CHECK_ENDING="$ending" flow 3-went-back.yaml
