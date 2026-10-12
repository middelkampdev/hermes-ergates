# Live checks for the owner

Continuous integration proves what can be proven without a VPS, a phone and
a real model: the unit suites, the contract suites against the pinned
Hermes, and the static checks of `deploy/`. The checks below need the real
thing. Run them on the VPS (and a phone on the same tailnet) before the
stack holds real data, and again after every Hermes image update. Record
the date and the result under each check; a failed check is a finding, not
a footnote.

Commands run from `deploy/` on the VPS. `EXEC` below is short for
`docker compose exec -T -u hermes -e PYTHONPATH=/opt/data/plugins/ergates hermes-serve`.

## Before the first start

### V1 Squid and HAProxy accept their configs

```bash
docker compose run --rm --no-deps --entrypoint squid egress-proxy -k parse -f /etc/squid/squid.conf
docker compose run --rm --no-deps --entrypoint haproxy ingress -c -f /usr/local/etc/haproxy/haproxy.cfg
```

Expected: squid prints no `ERROR` or `FATAL` line; haproxy prints
`Configuration file is valid`.

`-k parse` only validates syntax; it never starts Squid, so it never opens
`/var/log/squid/access.log` and proves nothing about a real run. Start it
for real and check its log too:

```bash
docker compose up -d egress-proxy
docker compose logs egress-proxy | grep FATAL || echo "no FATAL line"
```

Expected: `no FATAL line` (a log Squid cannot open after dropping to the
`proxy` user stops it at start with one).

Result:

## The stack

### V2 The controllers can use the Docker socket

```bash
docker compose exec hermes-serve id hermes
docker compose exec -u hermes hermes-serve docker ps
docker compose exec -u hermes hermes-gateway docker ps
```

Expected: `id` lists the socket's group; both `docker ps` calls list the
running containers. The image's own setup adds the group at boot; this
proves it survives the privilege drop.

Result:

### V3 Egress goes through the proxy and nowhere else

`EGRESS_MODE` in `.env` picks which mode the stack is running; run the
part below that matches it. `docker compose up -d egress-proxy` switches
modes without restarting anything else, so both parts can be run in one
session.

#### Standard mode (default; unset `EGRESS_MODE` also means this one)

```bash
docker compose exec -u hermes hermes-serve curl -sS -o /dev/null -w '%{http_code}\n' https://example.com
docker compose exec -u hermes hermes-serve curl -sS -o /dev/null -w '%{http_code}\n' http://example.com
docker compose exec -u hermes hermes-serve curl -sS -o /dev/null -w '%{http_code}\n' https://169.254.169.254
docker compose exec -u hermes hermes-serve curl -sS -o /dev/null -w '%{http_code}\n' "https://$(docker network inspect deploy_edge --format '{{(index .IPAM.Config 0).Gateway}}')"
docker compose exec -u hermes hermes-serve curl -sS -o /dev/null -w '%{http_code}\n' https://<another device's Tailscale IP, 100.64.0.0/10 or its IPv6 ULA>
docker compose exec -u hermes hermes-serve curl -sS --noproxy '*' --max-time 10 -o /dev/null https://example.com
docker compose logs --tail 20 egress-proxy
```

Expected: `example.com` answers with a real HTTP status over both `https://`
and `http://` (a public host, either port); `169.254.169.254` (the
link-local range cloud metadata lives at), the `deploy_edge` gateway (the
Docker host, reachable from `egress-proxy` on its non-internal network) and
the other Tailscale IP (the carrier-grade NAT range Tailscale addresses
also live in) each fail with `CONNECT tunnel failed, response 403`; the
`--noproxy` call fails (no route out). The proxy log shows `TCP_DENIED`
lines for every refused one.

Result:

#### Strict mode (`EGRESS_MODE=strict`)

```bash
docker compose exec -u hermes hermes-serve curl -sS -o /dev/null -w '%{http_code}\n' https://ntfy.sh
docker compose exec -u hermes hermes-serve curl -sS -o /dev/null -w '%{http_code}\n' https://example.com
docker compose exec -u hermes hermes-serve curl -sS -o /dev/null -w '%{http_code}\n' https://1.1.1.1
docker compose exec -u hermes hermes-serve curl -sS --noproxy '*' --max-time 10 -o /dev/null https://ntfy.sh
docker compose exec -u hermes hermes-serve curl -sS -o /dev/null -w '%{http_code}\n' http://ntfy.sh
docker compose logs --tail 20 egress-proxy
```

Expected: the first prints `200` (a listed host); `example.com` (unlisted)
and `1.1.1.1` (an IP literal never matches a listed name) fail with
`CONNECT tunnel failed, response 403`; the `--noproxy` call fails (no
route out, or the name does not resolve); plain `http://` is refused with
`403`. The proxy log shows `TCP_DENIED` lines for the refused ones. Repeat
the second and fourth line from `hermes-gateway`, and from `ntfy` with its
busybox `wget` (the image is Alpine without `curl`):
`docker compose exec ntfy wget -q -O /dev/null https://example.com` fails.

Result:

#### A mistyped mode stops the proxy

The Compose mount sets `create_host_path: false`, so a mode file that does
not exist should stop the proxy instead of starting it with an empty
directory in place of the rules. Docker documents that a `--mount` bind of a
missing path errors; the Compose reference does not state what `false`
does, so check it once:

```bash
EGRESS_MODE=stirct docker compose up -d egress-proxy
docker compose ps egress-proxy
docker compose up -d egress-proxy
```

Expected: the first command fails with a "bind source path does not
exist" error naming `mode-stirct.conf`, and `ps` shows the proxy is not
running with that mount. The last command (no override) starts it again
in the mode `.env` sets. If the first command starts the proxy, that is a finding:
Squid then reads a directory as its rules file.

Result:

#### Network isolation (either mode)

The `internal` network's isolated gateway (Docker Engine 28.0 or later,
`driver_opts: com.docker.network.bridge.gateway_mode_ipv4: isolated`, IPv6
off) is what keeps a client on that network from reaching a host service
such as sshd even if it ignores the proxy settings entirely. Confirm it
assigns no gateway address, from the VPS host (not inside a container --
the image may not carry `ip`/`iproute2`):

```bash
docker inspect ergates-hermes-serve --format '{{range $net, $cfg := .NetworkSettings.Networks}}{{$net}} gateway={{$cfg.Gateway}}{{"\n"}}{{end}}'
```

Expected: the `internal` network's line shows `gateway=` with nothing after
it. If a gateway address does show (an older Engine, or the option silently
ignored), that is a finding: confirm it is at least unreachable,

```bash
docker compose exec -u hermes hermes-serve curl -sS --connect-timeout 3 --noproxy '*' -o /dev/null -w '%{http_code}\n' "http://<that address>:22"
```

expecting no HTTP code at all (connection refused or timed out, not a
response), and raise the Engine version with the owner. Either way, service
names on `internal` must still resolve and connect directly, proxy or not:

```bash
docker compose exec -u hermes hermes-serve curl -sS --connect-timeout 3 -o /dev/null -w '%{http_code}\n' http://egress-proxy:3128
docker compose exec -u hermes hermes-gateway curl -sS --connect-timeout 3 -o /dev/null -w '%{http_code}\n' http://hermes-serve:9119/
docker compose exec -u hermes hermes-gateway curl -sS --connect-timeout 3 -o /dev/null -w '%{http_code}\n' http://ntfy:80/
```

Expected: a real HTTP status from each (Squid's own `403` for a non-CONNECT
request counts, and so does any answer of `hermes serve`'s auth gate), not a
resolution or connection failure -- the isolation removes the path to the
host, not to sibling services.

Result:

### V4 Only the Tailscale IP answers, and only with auth

From a device on the tailnet, and from one off it (the VPS's public IP):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://<TAILSCALE_IP>:9119/api/plugins/ergates/health
curl -sS -o /dev/null -w '%{http_code}\n' http://<PUBLIC_IP>:9119/api/plugins/ergates/health
```

Expected: `401` on the tailnet (Hermes's dashboard auth, before any Ergates
code runs); the public address does not connect. The app signs in over the
tailnet and its chat opens, so the WebSocket passes the ingress.

The `401` above is the cookie gate, not a token curl can carry on its own:
the dashboard bind is non-loopback, so every request needs the session
cookie `/login` sets, wherever it originates from, including inside a
container. Confirm the other half of the gate by signing in at
`http://<TAILSCALE_IP>:9119/login` in a browser with the dashboard trio
from `.env`: the same health URL now answers `200` in that browser.

Result:

### V5 The plugin is in every profile, and the routes are mounted

```bash
$EXEC python -m ergates.install --check; echo "exit $?"
```

Expected: `templates=installed`, one `plugin=enabled` line per profile, and
`exit 0`. Then, signed in in the app, open the concierge and ask it to
propose a bookkeeper; the proposal card appears (the routes answer).

`hermes-gateway` is where the hooks and the tool gate actually fire. It
mounts the same plugin folder and the same data volume, so its own `--check`
needs no option:

```bash
docker compose exec -T -u hermes -e PYTHONPATH=/opt/data/plugins/ergates hermes-gateway python -m ergates.install --check; echo "exit $?"
```

Expected: the same `templates=installed` line, the same `plugin=enabled` line
per profile and `exit 0` as `hermes-serve` printed. After a `git pull` of this
repository, the plugin's current templates are installed in one of two ways.
Restart `hermes-serve` and then send it one request (open the app, or call
`/api/plugins/ergates/health`): the restart alone installs nothing, and the
first request after it does. Or run `python -m ergates.install` (without
`--check`, on `hermes-serve`), which installs them at once. Plugin enablement
in a profile made by hand only changes on a re-run of the installer; the app
enables the plugin in the profiles it creates.

Result:

### V6 The sweep runs inside `hermes-serve`, and refuses root

Signed in at `http://<TAILSCALE_IP>:9119/login` in a browser (V4), open
`http://<TAILSCALE_IP>:9119/api/plugins/ergates/health` twice, two or three
minutes apart. Then run one pass by hand, once as `hermes` and once as root:

```bash
$EXEC python -m ergates.flush
docker compose exec -T -e PYTHONPATH=/opt/data/plugins/ergates hermes-serve python -m ergates.flush; echo "exit $?"
```

Expected: in both answers `sweep.interval_seconds` is `120` and
`sweep.last_error` is `null`, and `sweep.last_run_at` is a number that moved
forward between the two. The `hermes` run prints one
`ergates.flush: retried=...` line; the root run prints
`refusing to run as root` and `exit 2`.

The one-line summary also proves the image's `python` can `import
hermes_cli` and PyYAML (the sweep needs `HermesCron` and the root's
settings) and that a `hermes` user exists to run it as. If either were
missing, this check would show a traceback instead of that line.

Result:

## Concurrency the unit tests cannot reach

### V7 Two sessions of one profile call tools at the same moment

Hermes guards every `pre_tool_call` callback against running twice at once,
and for `pre_tool_call` a skipped callback becomes a block with
`pre_tool_call plugin callback timed out or is still running`
(`hermes_cli/plugins_dispatch.py:233-236`). On v0.21.6 the guard's key holds
the call's identity, its `tool_call_id`, else its `turn_id`
(`plugins_dispatch.py:160-173`, `281-291`), so two sessions of one gateway
process that call a tool in the same instant no longer skip each other. A
skip still follows a callback that timed out (30 s by default,
`plugins_dispatch.py:155`): Hermes then suppresses that callback for 60 s
for every call (`plugins_dispatch.py:55`, `285-287`). This check confirms
that no call is skipped on the real server.

1. Open two Bot Chats of one specialist (two sessions of one profile).
2. In both, at the same second, send: "Call the todo tool 20 times in a
   row, adding items 1 to 20, then tell me how many calls were blocked."
3. `docker compose logs hermes-gateway hermes-serve | grep -c "skipped after previous timeout or while still running"`

Expected: every call succeeds, and the count is `0`. Any skip is a finding:
record how often, and raise it with the owner.

Result:

### V8 Two routines that finish at the same moment both push

`post_llm_call` has the same guard, without the block: a skipped callback
means a finished routine records no event and sends no push. On v0.21.6 the
hook gets the turn's `turn_id` (`agent/turn_finalizer.py:466-476`), so two
routines that finish together are two keys and should not skip each other.

1. In the app, create two routines in two profiles, both due in the same
   minute (a one-shot `in 3m` for each, saved within a few seconds).
2. Wait for both to run.
3. `$EXEC python -c "import sqlite3; c = sqlite3.connect('/opt/data/ergates/control.sqlite3'); print(c.execute(\"select kind, profile, state from attention_events where kind = 'completion' order by created_at desc limit 4\").fetchall())"`

Expected: two new `completion` rows and two "A routine finished" pushes.
One row means the guard dropped a push: record it as a finding.

Result:

## The phone

### V9 A push reaches a locked iPhone

Before subscribing the phone, confirm its ntfy app's server URL is typed
exactly as ntfy's `NTFY_BASE_URL`, which `docker-compose.yml` builds from
`TAILSCALE_IP` and `NTFY_PORT` in `.env` as
`http://<TAILSCALE_IP>:<NTFY_PORT>`; `docker compose config | grep NTFY_BASE_URL`
prints it. A MagicDNS name works fine for browsing but silently breaks the
iOS wake-up, which hashes the base URL ntfy was configured with into every
poll request.

With Tailscale connected on the phone, the ntfy app subscribed to
`ergates-attention` with the device's read-only token, and the phone
locked for at least five minutes: ask a specialist to run a shell command
that needs approval (`terminal`, for example `ls /`).

Expected: within a minute the locked phone shows "Hermes needs your
approval" / "You have a new request". Tapping it opens the Ergates app in
that specialist's chat, where the approval card waits. Repeat on Android.

Result:

### V10 A push sent twice

Stop ntfy for three minutes around an approval so the first send fails and
the sweep sends it again (`docker compose stop ntfy`, ask for an approval,
wait, `docker compose start ntfy`, wait for the next sweep).

Expected: Android shows one notification (the second replaces the first by
its event id); iOS shows two. Both open the same chat. The retried publish
carries an `X-Sequence-ID` header; ntfy v2.28.0 answers it normally, not
`400` -- check the app's own log of the retried request, or
`docker compose logs ntfy`, if either platform shows the wrong count.

Result:

### V11 Notification settings

In the app, mute one specialist, then ask it for an approval: no push, the
approval card still appears in the app. Set quiet hours around the current
time for another specialist and let one of its routines finish: the push
arrives when the quiet hours end, not before. The hours you enter are the
time zone Hermes is configured for, not the phone's.

Then open notification settings with no agent selected (mute or quiet
hours "for all") and save there: the setting applies to every specialist
that has no override of its own.

Result:

### V12 Deep links, cold and warm

On the simulator (`xcrun simctl openurl booted '<link>'`) and on a phone,
with the app closed and with it open:

- `ergates://chat/<session>?connection=<your connection id>&profile=<name>`
  opens that profile's chat;
- the same link with an unknown connection id opens connection selection;
- from a cold start, Back goes to Home, not to a synthesized chat screen;
- a cold start of the same link, with a connection and profile already
  stored on the device, loads that profile's card directly -- never
  "Sign-in required.".

Result:

### V13 The device data is encrypted at rest

`expo-crypto` is a native module, so a build that adds it needs a new dev
client, not a JS reload:

```bash
cd apps/mobile && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npx expo run:ios
```

Install it over the data from the previous version and do TWO cold
launches, not one: the first launch reads the legacy plaintext blob and
re-saves it sealed; only the second exercises decryption (`TextDecoder`).

Expected after the second launch: connections, drafts and unfinished agent
setups are all still there. On the simulator, nothing in the app's storage
holds a draft's text in the clear:

```bash
dir="$(xcrun simctl get_app_container booted dev.middelkamp.ergates data)/Library/Application Support/dev.middelkamp.ergates/RCTAsyncLocalStorage_V1"
grep -rl "ergates-sealed-v1:" "$dir"
grep -rl "<a word from one of your drafts>" "$dir"
```

The first `grep` names a file; the second finds none.

Separately, check the two locked-launch cases (a locked phone can only reach
either through a background path -- a notification tap or the OS resuming a
backgrounded app -- never a fresh tap on the home screen icon):

- **A legacy plaintext blob and no key yet** (this build's very first launch,
  while locked): the read returns the plaintext as is, so the owner still
  sees connections and drafts, not an empty app. Sealing it fails silently
  (the keychain refuses a write while locked); the blob stays plaintext
  until a later launch that happens unlocked reseals it.
- **An already-sealed blob and an existing key, locked launch:** the
  keychain read throws while locked, so the read comes back empty and
  nothing is written under that name (the stored blob is kept, not
  overwritten). Unlock and relaunch: the stored data is back.

Result:

## Agents and permissions

### V14 A proposal becomes a working agent

Accept a proposal in the app and watch the five setup steps finish. Once
the agent is ready, have it use one of its tools: the template's plugin
setting must survive `profiles.configure`, and `mirror_credentials: false`
must still reach the model provider -- a specialist that cannot call its
provider is a silent setup failure, not a missing feature.

Then start another proposal and kill the app three times, reopening the
concierge chat after each: right after "profile created", right after a
step report, and right after the briefing turn is sent. Each time, setup
continues at the next step, and the end state is one profile and one
briefing, never two.

In the new agent's first reply, check whether a tool call was refused with
"This agent is still being set up". The briefing turn starts before the app
reports it and the proposal completes, and the tool gate blocks the agent's
tools until then; a refusal here is that known open design question, and
worth recording with how often it happens.

Result:

### V15 A toolset taken away is refused at the next call

In a running Bot Chat of a specialist made from `general-assistant`, ask for
a web search (it works). Remove `web` from its toolsets in the app. Ask
again in the same chat, and ask it to delegate the search to a sub-agent.

Expected: both refused with "This tool is turned off for this agent."
(docs/04 section 3, "Revoked connector remains usable").

Result:

### V16 A routine from the app, saved twice

Create a routine and turn the phone's network off right after Save, so the
answer is uncertain. Once the network is back, Save again: the button now
reads "Try again", not "Save", so tap that.

Expected: the Routines list, which reads Hermes cron itself, shows exactly
one routine, not two. The list hides the ` · <8 hex>` tag the server adds
to the cron label, and renaming the routine afterward keeps the same job
(no new tag, no second entry). On a device build, confirm
`Intl.DateTimeFormat().resolvedOptions().timeZone` in the routine screen
resolves to a real IANA name (for example `Europe/Amsterdam`), not `UTC`
and not empty.

Separately, right after restarting the controllers (a fresh `hermes serve`
process), create one reminder from the app over Tailscale and time it: the
first reminder create after a fresh start must still finish within 60
seconds.

Result:

## Operations

### V17 Approval events arrive while no app is connected

Close the app everywhere, ask for an approval from a routine (a routine
whose prompt runs a shell command), and wait.

Expected: the push arrives; this is the event source docs/11 section 4.2
asks about.

Result:

### V18 Sandbox workspace paths line up

In a specialist's chat, have the agent write a file in its workspace with
the shell, then read it back in a new session. Check on the host that the
file sits under the reviewed workspace path of `data/hermes`.

Result:

### V19 Backup and restore drill

Follow deploy/README.md "Backup" and "Restore drill" on a disposable host.

Result:

### V20 The Hermes image and the contract pin

```bash
docker compose exec hermes-serve hermes --version
```

The integration's contract tests run against Hermes `818c13be` (release
v0.21.6), and the image in `docker-compose.yml` is built from that same
commit. Record what the command prints; its first line should name v0.21.6.
If it names another version, the containers still run an older image:
recreate them from the compose file. Do not swap the pinned digest for the
registry's plain `v0.21.6` tag, which is an older build.

Result:

### V21 A green CI run on a real remote

Push this branch to a real Git remote once and open the Actions run for it.

Expected: every job in `.github/workflows/ci.yml` -- `workflow-lint` (the
`lint` job of `scripts/ci-local.sh`), `mobile` (including its ESLint step),
`integration`, `contract` (including `contract/live`, within its own
timeout), `deploy` -- finishes green. A local `scripts/ci-local.sh` run is
not a substitute for this: it reuses a warm `node_modules` and does not
prove a clean-runner install.

Result:

## App checks on a device

These do not depend on the deployment above; they are the remaining live
checks against the mobile app itself.

### V22 Proposal cards render live and stay usable

Accept a proposal and watch its card while it is live: `tool.complete` for
`ergates_propose_agent` carries the decoded result, and the card renders
the same way after leaving the chat and reopening it (the history row's
`toolName` and `result` reproduce it). Cards render upright under the
newest message, and stay tappable with the on-screen keyboard open.

Result:

### V23 Offline and overlapping chat sends

In a chat, turn off the phone's network and send two messages, then turn
the network back on: the second message shows queued and does not
interrupt or reorder the first (`queued_unsent` until reconnect, then sent
in order). Separately, start a send that is slow to acknowledge, leave the
chat screen and come back before it resolves: exactly one submit reaches
the server, and the bubble resolves once, not twice.

Result:

### V24 Home edit mode dragging on Android

On an Android phone, with a pinned concierge and at least three other pins
(enough to wrap onto a second line), one empty section, one collapsed section
with a few agents, one expanded section with a few agents, and enough agents
to scroll:

1. Build the dev client from `apps/mobile` with `npx expo run:android`. The
   build passes; before the cookies patch it stopped at
   `Could not find method jcenter()`.
2. Edit in place: open Home, scroll halfway down and tap the edit icon. The
   same list stays at the same scroll position: selection circles slide in
   from the left while the rows move right, ≡ handles fade in on the right,
   time and unread dots stay left of the handles, the avatars get a badge at
   the top left and a move handle at the top right, the concierge included,
   the icons cross-fade into ✕ and "0 selected". Collapsed sections stay
   collapsed; a tap on a header still collapses or expands it. Tap ✕: the
   same animation plays back. With Settings → Accessibility → Remove
   animations on, both changes are instant.
3. Handle and scroll: touching a ≡ handle and moving at once lifts its row
   (no hold needed), also in a list long enough to scroll; a swipe on a row
   body, or a very fast flick that starts on a handle, scrolls the list and
   moves no row; a tap on a row toggles its circle, a tap on an avatar
   toggles its badge.
4. Cross-group drops: drag a No section row into a section, in front of a
   row there; drag it back above the first section header (No section);
   drag one right under the empty section's header; drag one right under
   the collapsed section's header: it joins that section at its top (expand
   it to see). Each stays where it was dropped after tapping ✕.
5. Pinned avatars: drag an avatar by its move handle to the right, onto the
   second line, and back to the left; the pin order follows. The concierge
   moves the same way: drag another pin in front of it and it steps aside,
   like any other pin.
6. Section drag: touch a section header's ≡: only the section headers show,
   the touched header stays under the finger; drag it and drop: the sections
   take the new order and the list comes back. Touch the ≡ and lift without
   dragging: the whole list comes back. On a debug build, note whether the
   headers-only list appears before the header moves.
7. Auto-scroll: drag a row to the bottom edge, then to the top edge: the list
   scrolls both ways and the row drops where the finger is.
8. Haptics: with Settings → Haptics on, a light tap on pick-up and on drop
   (rows and avatars); with Haptics off, none.
9. Back: the system Back button leaves Edit mode, also right after a drop,
   and Home keeps the new order.
10. Section page: long-press a section name, on Home and in Edit mode: the
    Section page opens. Rename a section; delete another and confirm: its
    agents appear at the end of No section, pins unchanged.
11. Handle area: hold a row's ≡ column near the row's top edge, then near its
    bottom edge (not on the glyph), and drag: the row lifts and moves each
    time; the list does not scroll instead. The same on a section header's ≡.
12. Several at once: select two rows from different groups and one avatar,
    tap Move to…, pick a section: all three land in that section (the pinned
    one stays pinned) and the list keeps its other rows in order. The bottom
    bar slides up with the first selection and down after the action.
13. New message: note the order, send a message to an agent in the middle of
    No section from another device or chat, and come back to Home: the row
    shows the new message and does not move, in Home and in Edit mode.
14. Scroll position: scroll to the end of the list; tap a section's ≡
    without dragging, then drag a section header one place and drop: the
    list does not jump; the same rows stay on screen.
15. Leaving the app: touch a section's ≡ and, still holding it, leave the
    app (Home gesture); come back: the whole list shows and nothing moved.
16. TalkBack: turn TalkBack on, focus a No section row and use the actions
    menu: Move up and Move down move it one place, and the list shows it
    there; on a section header, Move up, Move down and Edit section work; on
    a pinned avatar, Move left and Move right work, the concierge included,
    and it reads "selected" or "not selected".
17. Scroll starting on a header handle: start a scroll gesture with your
    finger landing on a section header's ≡, instead of a row. Expected: the
    list may briefly show only the section headers before the scroll
    continues and the full list returns; the scroll position holds either
    way. This is a known, accepted side effect of switching to headers-only
    on touch-down, not a defect by itself -- judge on this device whether the
    flash (if any) is short enough to leave alone.
18. Swipe to select with auto-scroll: with nothing selected, put a finger on
    the circle of the first No section row and move it straight down over
    the circles. Expected: the list does not scroll under the finger; each
    row the finger passes gets a filled circle, section headers get none,
    and the count in the title follows. Move back up two rows: those two
    rows are empty again. Keep going down to the bottom edge of the list
    (above the bottom bar) and hold still: the list scrolls down by itself,
    faster the closer the finger is to the edge, the rows that pass under
    the finger are selected, and the scrolling stops at the end of the list.
    Then move up to the top edge and hold: the list scrolls back up and
    stops at the top. Lift, then start a new swipe on a selected row's
    circle and move down: the swipe deselects instead. A plain tap on a
    circle still toggles only that row, a swipe on a row body still scrolls
    the list, and the ≡ handles still drag.
19. Drop skeletons: in Edit mode, unpin the agents one at a time: when
    the last one leaves, the pinned area shows three dashed ghost avatars
    with "Drag an agent here to pin it", and the rows below do not move. With TalkBack on it reads "Pinned
    agents, empty. Drag an agent here, or select one and choose Pin." The
    empty section shows a dashed "Drag agents here" row under its header;
    the collapsed section shows none. Tap ✕: both fade out and the list
    looks as it did before Edit mode; tap the edit icon again: they fade
    back in.
20. Row into the pinned area, with Hermes Desktop connected to the same
    gateway (as in V25): in a list long enough to scroll, scroll down, then
    drag a No section row by its ≡ up to the top edge: the list scrolls up
    until the pinned area shows. Over the avatars the row fades so the
    avatars show through it, and a thin vertical bar marks the spot; both
    go back when the finger moves back over the rows. Drop between the
    first and second avatar: the row cross-fades into the avatar at that
    spot, and after one roster refresh Desktop shows the agent pinned. Drop a row onto the empty pinned skeleton too (after step 19):
    it becomes the first pin.
21. Pin into a section: drag an avatar by its move handle down over the
    rows, past the first screen (the list scrolls down by itself), and drop
    it where the thin line sits in front of a row of a section: the avatar
    fades out, the row grows in there, and Desktop shows the agent unpinned
    and in that section. Drop another avatar on the empty section's "Drag
    agents here" row: it joins that section. Drop one right under the
    collapsed section's header: it joins that section at its top. Drop one
    in the space under the last row: it lands at the end of the list.
    Release one over the Edit bar: it stays pinned.

Result:

### V25 Pins and sections shared with Hermes Desktop

With Hermes Desktop on the Mac and the app on a phone, both connected to the
same gateway (docs/05 "Bot metadata compatibility", "Organization outbox"):

1. Phone to Desktop: on the phone, pin an agent and move another into a
   section. Within one Desktop roster refresh (a few seconds) Desktop shows
   the first agent pinned and the second filed under that section (named on
   a Desktop that reads `sectionName`, otherwise under the section Desktop
   already knows by that id).
2. Desktop to phone: on Desktop, unpin that agent and drag the other one
   back to Unassigned. Pull to refresh Home on the phone: the avatar leaves
   the pinned area and the row goes back to No section.
3. Offline, one change: turn on Airplane mode on the phone and pin exactly
   one agent. The app stays responsive: scroll Home and open Settings. Turn
   Airplane mode off; within a few seconds the pin reaches Hermes and Desktop
   shows it, with no alert.
4. Offline, two changes: turn on Airplane mode on the phone, pin an agent and
   move another into a section. Home shows both at once. Force-quit the app
   and open it again: both still show. Turn Airplane mode off and open Home:
   within a few seconds Desktop shows both changes, and no alert appears.
5. Conflict retry: pull to refresh Home so its roster is current, then
   within the same few seconds change that agent's pin on Desktop and move
   the agent into a section on the phone. The phone's write still carries
   the revision from the read a moment before Desktop's change, so Hermes
   refuses it once; the phone rereads the agent and reapplies its own move.
   Expected: both changes stick -- the move reaches Desktop and Desktop's
   pin is still there (the retry's re-read already had it, and the phone's
   rewrite kept it).
6. Rename and delete: rename a section on the phone; on a Desktop that reads
   `sectionName` its members show under the new name. Delete the section on
   the phone: Desktop shows its members under Unassigned.
7. Concierge on a new install: install the app fresh against a gateway
   whose concierge has no pinned value in Hermes: it shows pinned on the
   phone and on Desktop. Unpin it on Desktop, reinstall the app: it stays
   unpinned.

Result:
