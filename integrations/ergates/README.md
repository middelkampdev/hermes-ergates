# ergates (Hermes plugin)

Small, dependency-free Hermes Agent plugin for the Ergates project. It gives
the agents a validated agent-proposal tool and a reminder tool that a retry
never duplicates, blocks tool calls the Ergates rules forbid, records
approval requests and finished routine turns as attention events with an
ntfy push, and serves the app's server operations as authenticated routes
of `hermes serve`. Every record lives in one transactional SQLite control
store under the Hermes root (ADR-030).

This package does **not** create profiles or run a scheduler. The app
performs the provisioning steps and reports each one; the plugin records
them and does the one step the app cannot do, enabling itself in the new
profile (ADR-032). Hermes cron stays the scheduler.

See `docs/11-implementation-readiness.md` section 4 and
`docs/03-technical-design.md` sections 8-9 in the repository root for the
contracts this package implements.

## Layout

```
integrations/ergates/
  plugin.yaml          # Hermes directory-plugin manifest
  __init__.py          # Hermes entry point: register(ctx)
  dashboard/
    manifest.json      # tells `hermes serve` to mount api.py (no dashboard page)
    api.py             # the HTTP routes under /api/plugins/ergates (FastAPI router)
    index.js           # empty dashboard bundle, so the dashboard reports no error
  ergates/             # the actual logic, plain importable package
    hermes_adapter.py  # the only module that imports Hermes
    paths.py           # hermes_root(), store_path(), templates_dir()
    store.py           # ControlStore: SQLite, WAL, BEGIN IMMEDIATE, versioned schema
    reminders.py       # ReminderService: idempotent reminders on top of Hermes cron
    proposals.py       # ergates.agent-proposal.v1 validation, hash, ProposalService
    templates.py       # proposal templates under <root>/ergates/templates/
    attention.py       # AttentionService: events, outbox rows, prefs, expiry, retention
    delivery.py        # DeliveryWorker: leased outbox delivery to ntfy, deep link
    settings.py        # the install-wide push settings in the root's config.yaml
    operations.py      # every HTTP route as a framework-free method
    policy.py          # the pre_tool_call tool gate
    tool.py            # ctx.register_tool / ctx.register_hook wiring
    flush.py           # `python -m ergates.flush`: due pushes, expiry, retention
    install.py         # `python -m ergates.install`: templates, the plugin in every profile
```

This folder is what a user installs, so it holds only the plugin's runtime
files. The tests are a separate project next to it:

```
integrations/ergates-tests/
  pyproject.toml       # installs this plugin as an editable dependency
  tests/               # pytest suite, no Hermes needed; test_hermes_boundary.py
                       # fails when a module other than ergates/hermes_adapter.py
                       # or dashboard/api.py imports Hermes
  contract/            # facts read from the pinned Hermes source as text, and
                       # Hermes's install scan of this folder
    live/              # the adapter, the routes and the gate run against the
                       # pinned Hermes itself; `scripts/ci-local.sh contract`
                       # runs both suites
```

## Install

Hermes loads a user plugin from the ACTIVE home's `plugins/` folder, and only
when that home's `config.yaml` lists it in `plugins.enabled`
(`hermes_cli/plugins_discovery.py`). A named profile runs with its own home,
so the plugin is installed once at the root and linked into each profile:

1. Link or mount this directory at `<hermes root>/plugins/ergates`
   (`~/.hermes/plugins/ergates` on a laptop; a read-only bind mount at
   `/opt/data/plugins/ergates` in the Compose deployment, see
   `deploy/docker-compose.yml`).
2. Enable it in the root's `config.yaml`:
   ```yaml
   plugins:
     enabled:
       - ergates
   ```
   `hermes serve` runs with the root as its home, so this is what makes it
   mount the routes; it also loads the plugin in the default profile.
3. For every other profile, `POST /api/plugins/ergates/profiles/<name>/plugin`
   links `<root>/profiles/<name>/plugins/ergates` to the root's copy and adds
   `ergates` to that profile's `plugins.enabled`. The app calls it as the
   `plugin_enabled` provisioning step. It takes effect on the profile's next
   session.

`python -m ergates.install` does steps 2 and 3 for the default profile and
every named profile at once, and installs the proposal templates: it checks
every `<template_id>.json` in `--templates` (default `/opt/ergates/templates`,
where `deploy/docker-compose.yml` mounts `deploy/templates`) the way the
accept route would, then makes `<root>/ergates/templates/` hold exactly
those files. One invalid template installs nothing. `--check` changes no
template or plugin setting and reports the same facts; the exit code is 0
only when every profile would load the plugin and the templates match. Run
it as the user that owns the Hermes root, inside the Hermes runtime, and
restart `hermes serve` after the first run so it loads the plugin's hooks
and tools. (On Hermes v0.21.6 the routes alone would mount on their first
request.)

## Configuration

Install-wide settings live in the Hermes root's `config.yaml` (the default
profile's), under `plugins.entries.ergates.settings`. Every profile's hooks
and `python -m ergates.flush` read them there (`ergates/settings.py`), so a
push goes to the same place whichever profile raised it:

| Key | Default | Purpose |
|---|---|---|
| `ntfy.server` | unset (push disabled) | ntfy server base URL |
| `ntfy.topic` | unset (push disabled) | ntfy topic to publish attention events to |
| `ntfy.token` | unset | ntfy publish token (Bearer), or `user:pass` for Basic |
| `ntfy.connection_id` | unset | app connection id used to build the `Click` deep link |

Values are read as written; `${VAR}` references are not expanded. One
setting is per profile, read with `ctx.get_config` from that profile's own
`config.yaml`:

| Key | Default | Purpose |
|---|---|---|
| `attention.completed_platforms` | `["cron"]` | platforms whose finished turns push "A routine finished" (by default routines only, not every chat reply); `[]` turns them off |

No credentials are ever read from, or written into, this repository or the
store. Push is skipped (not an error) whenever `ntfy.server` or `ntfy.topic`
is unset; the event and its outbox row are still recorded.

## Upgrading from 0.1

An install that ran version 0.1.0 needs three changes by hand:

- **The sweep takes no `--profile`.** `python -m ergates.flush --profile <name>`
  now exits 2 (`unrecognized arguments`) and sweeps nothing. Remove the
  flag from the crontab line: the sweep opens the store and reads the push
  settings under the Hermes root, whichever `HERMES_HOME` it runs with.
- **Push settings live in the root's `config.yaml` only.** `ntfy.*` settings
  kept in a named profile's `config.yaml` are ignored, and
  `ntfy.default_profile` is gone. Move `ntfy.server`, `ntfy.topic`,
  `ntfy.token` and `ntfy.connection_id` to
  `plugins.entries.ergates.settings` in `<hermes root>/config.yaml`.
  `attention.completed_platforms` stays per profile.
- **Existing named profiles need the plugin enabled.** Hermes loads the
  plugin in a profile only from that profile's own `plugins/` folder, with
  `ergates` in its `plugins.enabled` (see Install). Call
  `POST /api/plugins/ergates/profiles/<name>/plugin` once per named profile,
  or run `python -m ergates.install` (see Install), which does this for every
  profile at once. The route links to the root's copy and never replaces a
  folder: remove a copy of the plugin at
  `<root>/profiles/<name>/plugins/ergates` first, or the route answers 500
  `internal`. It takes effect on the profile's next session.

## HTTP API

`hermes serve` mounts `dashboard/api.py` under `/api/plugins/ergates`
(ADR-031), at startup and, on Hermes v0.21.6, also on the first request
after the plugin was enabled, without a restart. Hermes's own middleware
authenticates every request first: the dashboard session token on loopback,
the cookie gate when dashboard auth is on. Hermes also runs each route in the
profile scope of a `profile` path or query parameter, and answers a name it
refuses in its own shape (400, or 404 `Profile '<name>' does not exist.`, as
`{"detail"}`) before the route runs. JSON in and out; every error is
`{"error": {"code": "<code>", "message": "<safe text>"}}`. One
`ControlStore` serves every request of the process.

| Method and path | Success | Errors |
|---|---|---|
| `GET /health` | 200 `{"ok": true, "schema_version": 1, "plugin_version": "<version>"}`, the version in `plugin.yaml` | 503 `store_unavailable` |
| `POST /reminders` `{profile, schedule, timezone, prompt, request_id, label?}` | 201 new, 200 existing, 202 uncertain; body `{"receipt"}` | 409 `conflict` (with `receipt`), 400 `invalid`, 404 `unknown_profile` |
| `GET /proposals/{id}` | 200 `{"proposal"}` | 404 `not_found` |
| `POST /proposals/{id}/accept` `{proposal}` | 200 `{"proposal"}` with `template` | 409 `hash_mismatch` / `not_acceptable` / `name_taken`, 410 `expired`, 422 `unknown_template` |
| `POST /proposals/{id}/reject` | 200 `{"proposal"}` | 409 `not_acceptable` |
| `POST /proposals/{id}/steps` `{step, status}` | 200 `{"proposal"}`; `briefing` `done` completes it | 409 `out_of_order` / `not_ready` |
| `POST /profiles/{profile}/plugin` | 200 `{"profile", "enabled": true}` | 404 `unknown_profile` |
| `GET /attention/prefs?scope=<name or *>` (`?profile=<name>` still names one profile) | 200 `{"prefs"}` | 400 `invalid` |
| `PUT /attention/prefs` `{profile, muted, quiet_start, quiet_end}` | 200 `{"prefs"}` | 400 `invalid` |

Also on every route: 400 `invalid` for a body that is not a JSON object or a
field that fails validation, 404 `not_found` for an unknown proposal,
503 `store_unavailable` when the control store cannot be opened, and 500
`internal` (message `The request could not be completed.`) for a failure
the route does not name, such as a Hermes call that raised; the log names
the exception class only. A client treats `internal` like any code it does
not know. Only the accept answer carries the proposal's `template`; every
other proposal answer has `"template": null` (repeat the accept to read it
again: an accepted proposal answers 200 with its receipt).

`POST /reminders` checks, in order: the fields (a `timezone` must be an IANA
zone; a `label` is at most 64 printable characters and never defaults to
prompt text), that the profile exists, that Hermes cron accepts the
schedule, that Hermes cron's prompt scan (invisible Unicode, "do not
tell the user" and other injection phrases) accepts the prompt, and that
Hermes cron's gateway lifecycle guard, run in the profile, accepts it too
(it refuses a prompt that reads as a command to stop or restart the
gateway, plain prose such as "kill time before the Hermes gateway meeting"
included). Only then does it create, so a schedule or prompt Hermes
refuses is a 400 with a fixed message, never an uncertain create the app
would resend. A second identical request waits up to 5 s for the first
and answers the same receipt.

## Tools and the tool gate

- `ergates_propose_agent` validates a proposal, records its receipt as
  `proposed` and returns it. It never creates a profile.
- `ergates_create_reminder` creates a reminder in the calling agent's
  profile with the same checks as `POST /reminders`. It sends no request
  id, so the same schedule, time zone and prompt in one profile is one
  reminder however often the model asks, until a one-shot has run: the
  same request after that makes a new one.
- The `pre_tool_call` hook (`ergates/policy.py`) blocks, in this order:
  every tool of a profile whose accepted proposal is still being
  provisioned; `cronjob_manage` with `action: create` (agents use
  `ergates_create_reminder`); and a tool whose toolset the profile's
  configuration no longer grants. When a hook callback raises, Hermes blocks
  the tool with a message that quotes the exception text, which can carry
  tool arguments. So the gate turns any failure of its own into a block with
  a fixed message.
- The grant (`hermes_adapter.granted_toolsets`) is the toolset pin that
  `profiles.configure` writes, `platform_toolsets.cli` in the profile's
  `config.yaml` (the app sets it from the template), resolved with Hermes's
  own `_get_platform_tools`, plus the toolset `mcp-<server>` of every MCP
  server the profile enables. The legacy `tools.enabled_toolsets` counts only
  when `platform_toolsets.cli` is absent. The grant is read at every tool
  call, so a toolset or MCP server taken away is blocked at the next call, in
  a running session too. Hermes builds an app session's tools from the same
  list, but `profiles.configure` rebuilds no running session, and gateway
  turns and cron runs use their own platform lists, so the agent can still
  see a tool the gate refuses. The rule applies only to a profile Ergates
  provisioned (an accepted or complete proposal whose `configured` step was
  reported), so never to the default profile, and the `ergates` tools are
  never blocked this way. A template must pin the owner toolset names Hermes
  registers a tool's toolset under (`web`, not a sub-toolset such as
  `search`): pinning a sub-toolset name grants every tool of its owner
  toolset, not only that sub-toolset's own tools.

The profile is always `ctx.profile_name` read at the moment of the call
(`hermes_adapter.current_profile`), never once at registration: a
multiplexed gateway serves several profiles from one process. Hermes names
the profile of a home that is neither the root nor `<root>/profiles/<name>`
`custom`; the gate finds no `custom` profile to read the grant from, so it
blocks every tool call there (fail closed).

## The control store

One SQLite file per Hermes install: `<hermes root>/ergates/control.sqlite3`.
`paths.hermes_root()` is `hermes_constants.get_default_hermes_root()` inside
Hermes, which maps a profile home (`<root>/profiles/<name>`) back to the
root, so every profile and every process (gateway, `hermes serve`, the
flush) shares it. The file and its folder are created private (`0600`,
`0700`).

| Table | Holds |
|---|---|
| `reminder_receipts` | receipt id (request id or payload hash), request id, profile, state (`creating`, `created`, `uncertain`), cron job id and unique job name, advisory timezone, payload hash, prompt hash, version |
| `proposal_receipts` | proposal id, state (`proposed`, `accepted`, `complete`, `rejected`), proposal hash, reserved profile name, `expires_at`, source session id, version |
| `proposal_steps` | status (`done`, `uncertain`, `failed`) of each provisioning step the app reports |
| `attention_events` | approval or completion event: profile, session, surface, correlation hash, state (`pending`, `resolved`, `expired`), choice, times |
| `attention_outbox` | one push per event: state (`due`, `sent`, `cancelled`, `gave_up`), attempts, next attempt, lease, last error class |
| `attention_prefs` | per profile (`*` = default): muted, quiet hours |

Rules the store enforces:

- Every write is `BEGIN IMMEDIATE`, so a read-modify-write never
  interleaves with another writer, in this process or another one. A second
  writer waits up to the busy timeout (5 s).
- Every receipt change is a versioned compare-and-set: it names the version
  it read and changes nothing when another writer got there first.
- An attention event and its outbox row commit in one transaction. Delivery
  writes only the outbox row; an event's state changes only through
  resolution or expiry.
- The schema is versioned with `PRAGMA user_version`; a file written by a
  newer plugin is refused.
- No column holds prompt, command, briefing or description text. Receipts
  and events keep identifiers and sha256 hashes (docs/04 sections 4 and 8).

### Retention and expiry

`python -m ergates.flush` applies these (nothing inside Hermes runs a timer):

| Record | Rule |
|---|---|
| Approval event | expires 1800 s after it was created (the profiles' `approvals.timeout`); its due push is cancelled, never sent |
| Terminal attention event (resolved, expired, completion) | deleted 7 days after `resolved_at`, with its outbox row |
| Unaccepted proposal receipt (proposed or rejected) | deleted 24 h after its `expires_at`; accepted and complete receipts are kept for resume-by-receipt |
| Reminder receipt | deleted when Hermes cron reports its job gone, or after 30 days without use |

## Reminders

`ReminderService.create(profile, schedule, timezone, prompt, request_id=..., label=...)`
returns a `ReminderOutcome` with `status` `created`, `existing`, `conflict`
or `uncertain`, and the receipt. `hermes_adapter.HermesCron` is its cron:
each call runs in the profile's own home, as Hermes's `cron.manage` RPC
does, and a create goes through the same function as the app's Routines
screen, so Hermes's prompt scan and scheduler registration apply. On v0.21.6
that RPC also binds the profile's secrets and terminal policy; a reminder
create reads no secret and runs no command, so the adapter takes the home
only.

- **The receipt id** is the caller's `request_id` (the app's per-attempt
  outbox id) when given, else the payload hash. The same id with a
  different payload is a `conflict` and creates no job.
- **Two identical requests at the same moment** create one job: the second
  waits for the first creator (up to 5 s) and returns the same receipt.
- **A job deleted natively** (Routines screen) is created again once, by
  the one request that still holds the version that saw it missing.
- **A one-shot that already ran** stays in Hermes cron as a completed job
  for 7 days by default. Without a request id (the agent tool) it counts
  as deleted, so the same request after the run makes a new reminder. With
  a request id it stays the receipt's job: the app sends a new id per
  attempt, so the same id again is a retry of a request that was served.
- **Every create is reconciled by name first**: the job name
  (`[bot:<profile>] <label> · <8 hex>`) is unique per receipt and payload.
  One match is adopted, none is created once, several leave the receipt
  `uncertain`; without a request id, completed jobs do not count. A create
  whose answer was lost, or a `creating` receipt older than 60 s, is
  reconciled the same way.
- **Timezone is advisory.** Hermes v0.21.6 has no per-job timezone, so the
  zone stays in the idempotency key and comes back as `timezone_advisory`;
  a reminder fires in the time zone Hermes resolves for the profile
  (`HERMES_TIMEZONE`, which the multiplexed gateway ignores, else `timezone`
  in the profile's `config.yaml`; the machine's local time when neither is
  set).

## Proposals

`ergates_propose_agent` validates the model's arguments, attaches the
backend-owned `source_session_id` (from the handler's `session_id` or
`task_id`, never from `args`), records the receipt as `proposed`, and
returns the proposal as JSON. The operator then accepts it exactly as
proposed, without edits, or rejects it through the HTTP API.

Accepting answers the proposal's template, read from
`<hermes root>/ergates/templates/<template_id>.json` (fields `template_id`,
`soul`, `enabled_toolsets`, `enabled_mcp_servers`); an unknown template is a
422 and reserves nothing. The app then performs the provisioning steps in
order and reports each one: `profile_created` (`profiles.create` with
`mirror_credentials: false`), `plugin_enabled` (after
`POST /profiles/{profile}/plugin`), `configured` (`profiles.configure` from
the template), `bot_chat`, `briefing`. A reported `briefing` `done` marks
the proposal `complete` only after Hermes confirms the profile exists and
would load this plugin there; until then the tool gate blocks every tool
of that profile (ADR-032).

## Attention and push

- `pre_approval_request` records a pending approval and its outbox row, then
  sends the push on a short-lived thread, so a slow ntfy server never delays
  the in-app approval card. A coalesced follower (`coalesced=True`) or the
  `smart` guardian pre-check records nothing.
- `post_approval_response` resolves the oldest pending approval with the
  same `(session_key, pattern_key, command hash, surface)` and cancels its
  due push. The hooks carry no approval id at the pin.
- `post_llm_call` records a finished turn from `attention.completed_platforms`
  and pushes "A routine finished". It reads only `session_id` and
  `platform`, never the messages.
- A muted profile gets events but no pushes. Quiet hours (`HH:MM` in the
  Hermes time zone, see "Periodic sweep"; may wrap midnight) hold
  completion pushes, and their retries, until they end; approval pushes
  ignore them.
- A worker leases an outbox row for 60 s before it sends, so two workers
  never send one row at once, and a worker that dies mid-send leaves a lease
  that runs out. Failed attempts back off 30 s, 120 s, 600 s, 600 s; the
  fifth failure gives up. Push is at least once. Each push carries its event
  id as ntfy's `X-Sequence-ID`, so a push sent again replaces the first one
  in the ntfy Android app (1.22.2 or later, server 2.16.0 or later); the iOS
  app shows both. Either one opens the same chat.
- The body is always `You have a new request`; the title is `Hermes needs
  your approval` or `A routine finished`; the `Click` link is
  `ergates://chat/<session>?connection=<id>&profile=<name>`. Errors are
  logged by class name only, so a token echoed in an HTTP error never
  reaches a log.

## Periodic sweep

```bash
HERMES_HOME=/opt/data python -m ergates.flush [--quiet]
# ergates.flush: retried=0 expired_notifications=0 pruned_notifications=0 pruned_proposals=0 pruned_reminders=0
```

It opens the store under the Hermes root, reads the install-wide push
settings from the root's `config.yaml`, and asks Hermes cron whether each
reminder's job still exists. No credential is ever passed as an argument or
printed. `deploy/README.md` schedules it from host cron every two minutes,
inside the container.

Run it as the user that owns the Hermes root (`hermes` in the container).
Root runs are not supported: SQLite creates the store's `-wal` and `-shm`
files as the user that opens the store and does not hand them over, so a
root run can leave files the Hermes user cannot open, and every hook then
fails. The sweep refuses to start as root when another user owns the Hermes
root. If a root process opened the store anyway, repair it inside the
container with `chown -R hermes:hermes /opt/data/ergates`.

Quiet hours are read in the time zone Hermes cron uses: `HERMES_TIMEZONE`
(which the multiplexed gateway ignores), else `timezone` in the
`config.yaml` of the process's Hermes home (the root's for the sweep, the
profile's for a hook), else the server's local time. Give every profile the
same zone: a hook holds a completion push by its profile's zone, and the
sweep schedules the retries by the root's.

## Development

Requires [`uv`](https://docs.astral.sh/uv/) and Python 3.11. Standard
library only at runtime (`sqlite3`, `json`, `hashlib`, `urllib`, `zoneinfo`,
`threading` and friends); `dashboard/api.py` uses the FastAPI that Hermes
ships. `pytest`, `pytest-cov` and `pyyaml` are test dependencies only, listed
in `integrations/ergates-tests/pyproject.toml`; `ergates.settings` imports
`yaml` lazily, from the Hermes runtime that ships it. That test project
installs this folder as an editable dependency, so the tests always run
against the code here.

```bash
cd integrations/ergates-tests
uv run --python 3.11 pytest

# the CI gate: the same run with branch coverage of ergates/, at least 90%
uv run --python 3.11 pytest --cov --cov-fail-under=90
```

The contract tests need a checkout of the Hermes source at the pin. From the
repository root, `scripts/ci-local.sh contract` prepares one under
`.cache/hermes-pin` (a detached `git worktree add` from your Hermes clone)
and runs two suites: `integrations/ergates-tests/contract/` reads the
pinned files as text, and `contract/live/` under it imports the pinned
Hermes, with its locked dependencies exported from the pin's `uv.lock`, in
a temporary Hermes root. Or point `HERMES_SOURCE` at a clean checkout of
`818c13be1dc4fd28987e1e881a9408224afd4535` (v0.21.6). Never point either
suite at a real `~/.hermes`: the live suite makes its own. The live
hot-mount test installs the plugin through Hermes's install route, which on
a source checkout first prepares Hermes's own dependency runtime (about
560 MB in the temporary root, downloads included): it needs the network and
takes about a minute.

Hermes scans every plugin install (`tools/plugin_guard.py`). A `safe`
verdict installs; `caution` needs a confirmation the app's one-tap setup
cannot show; `dangerous` blocks the install even with `force`. Both contract
suites scan the files git tracks in this folder and fail unless the verdict
is `safe`, and the live hot-mount install runs with the scan on. Keep test
code and its fixtures in `integrations/ergates-tests`.
