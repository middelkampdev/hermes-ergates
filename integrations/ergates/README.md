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

## What this plugin does on your server

What the plugin does on a Hermes server, for anyone deciding whether to
install it.

### Network

The plugin makes one kind of network call: an HTTP POST to the ntfy server in
`ntfy.server`, to the topic in `ntfy.topic`, once per push. With either
setting unset it makes no call at all. It posts to whatever URL it is given,
and the token travels in a request header, so set an `https://` URL. A push
has a fixed body, a title, and a link that holds the session id, the profile
name and the app's connection id. It never carries message text, a command or
a tool argument. The plugin contacts no other host.

### What it writes

- `<hermes root>/ergates/control.sqlite3`, the control store, with its `-wal`
  and `-shm` files. It holds identifiers, states, times and hashes, and no
  prompt or message text.
- `<hermes root>/ergates/templates/`, the proposal templates the plugin
  ships. The plugin copies them there the first time its routes serve a
  request and keeps the folder equal to what it ships, so it removes any
  other file in it.
- A profile's `plugins/ergates` link and its `config.yaml`. When the app
  calls `POST /setup` or `POST /profiles/{name}/plugin`, or you run
  `python -m ergates.install`, the plugin links `<profile>/plugins/ergates`
  to the root's copy and adds `ergates` to that profile's `plugins.enabled`
  (and takes it out of `plugins.disabled`). It writes that `config.yaml`
  with Hermes's own `save_config` and changes no setting besides those two
  lists. A profile whose `plugins/ergates` is a real folder is reported, not
  replaced.
- Hermes cron jobs. A reminder that the app or an agent creates (through the
  `ergates_create_reminder` tool) becomes a job in that profile's Hermes
  cron.

A process that runs as root on a Hermes root another user owns writes
nothing there.

### Background work

In each process that loads the plugin's dashboard routes, the plugin starts
one daemon thread, `ergates-sweep`. Those processes are `hermes serve`,
Hermes Desktop's backend, a TUI gateway process once it imports Hermes's
dashboard server, and a plugin host under `plugins.isolation: host`. The
messaging gateway and cron processes load only the plugin's hooks and tools
and start no such thread. The first pass runs 5 seconds after the thread
starts, then one runs every `sweep.interval_seconds` (120 by default; 0 turns
the thread off). A pass sends the pushes that are due, expires approvals past
their timeout, applies the retention rules and asks Hermes cron whether each
reminder's job still exists. Several sweeps on one store are safe: each due
push goes out once. The approval hook also sends its push on a short-lived
thread. Besides these threads the plugin starts no process and runs no shell
command.

### What it reads outside its own data

- The Hermes root's `config.yaml`, for the push and sweep settings, and each
  profile's `config.yaml`, for the toolsets and MCP servers the profile
  grants, `attention.completed_platforms` and the time zone.
- One secret, `ERGATES_NTFY_TOKEN`, from the root's `.env`, through Hermes's
  `get_secret`. The plugin reads no other name from that file.
- Hermes's install metadata for the plugin
  (`<hermes root>/plugins/.install-metadata.json`) and the environment
  variable `ERGATES_INSTALL_KIND`, so that `GET /health` can say how the
  plugin was installed. The Compose file in `deploy/` sets the variable.
- Tool names, session ids and platform names in its hooks, and the `action`
  of a `cronjob_manage` call. The approval hooks see the pending command and
  store only its SHA-256 hash. No hook reads message text.

### The ntfy token

`ERGATES_NTFY_TOKEN` is a Hermes plugin secret, and Hermes keeps it in the
root's `.env`. The plugin sends it only to the ntfy server, in the
`Authorization` header. Hermes also loads the root's `.env` into the
environment of the processes it starts for that root, and its local terminal
backend strips the provider keys it knows but not this name. On a local
terminal backend, a command the agent runs can therefore read the token. The
Compose deployment runs commands in Docker with `docker_forward_env: []`,
which keeps the token out. Whichever backend you use, give the ntfy token
publish access to that one topic only.

### Tool calls

The `pre_tool_call` hook can only block a tool call. It never approves one,
and it does not change Hermes's approval settings or answer an approval
request. It blocks `cronjob_manage` with `action: create` in every profile,
because agents create reminders through `ergates_create_reminder`. In a
profile the app provisioned from a role template, it also blocks every tool
until setup is done and any tool outside the toolsets the profile's
configuration grants.

### What it never does

The plugin sends no telemetry and no usage data. It never updates itself and
never downloads code: it checks for no new version, and a newer version
reaches you only through Hermes (`hermes plugins update`). It uses the Python
standard library only and declares no dependency.

### Platforms

Linux and macOS. Enabling the plugin in a named profile creates a symlink, so
Windows is not supported.

## Layout

```
integrations/ergates/
  plugin.yaml          # Hermes directory-plugin manifest
  __init__.py          # Hermes entry point: register(ctx)
  dashboard/
    manifest.json      # tells `hermes serve` to mount api.py (no dashboard page)
    api.py             # the HTTP routes under /api/plugins/ergates (FastAPI router); starts the sweep
    index.js           # empty dashboard bundle, so the dashboard reports no error
  templates/           # the proposal templates the plugin ships, one <template_id>.json each
  ergates/             # the actual logic, plain importable package
    hermes_adapter.py  # the only module that imports Hermes
    paths.py           # hermes_root(), store_path(), templates_dir(), bundled_templates_dir()
    store.py           # ControlStore: SQLite, WAL, BEGIN IMMEDIATE, versioned schema
    reminders.py       # ReminderService: idempotent reminders on top of Hermes cron
    proposals.py       # ergates.agent-proposal.v1 validation, hash, ProposalService
    templates.py       # proposal templates under <root>/ergates/templates/
    setup.py           # installs the shipped templates there, enables the plugin in every profile
    install_info.py    # how the plugin got onto the server (git install, deployment, manual copy), for `health`
    attention.py       # AttentionService: events, outbox rows, prefs, expiry, retention
    delivery.py        # DeliveryWorker: leased outbox delivery to ntfy, deep link
    settings.py        # the install-wide push and sweep settings in the root's config.yaml
    operations.py      # every HTTP route as a framework-free method
    policy.py          # the pre_tool_call tool gate
    tool.py            # ctx.register_tool / ctx.register_hook wiring
    flush.py           # one sweep (due pushes, expiry, retention); `python -m ergates.flush`
    sweep.py           # the thread in `hermes serve` that runs a sweep every interval
    install.py         # `python -m ergates.install`: the templates, the plugin in every profile
```

This folder is what a user installs, so it holds only the plugin's runtime
files. The tests are a separate project next to it:

```
integrations/ergates-tests/
  pyproject.toml       # installs this plugin as an editable dependency
  tests/               # pytest suite, no Hermes needed; test_hermes_boundary.py
                       # fails when a module other than ergates/hermes_adapter.py
                       # or dashboard/api.py imports Hermes
  contract/            # facts read from the pinned Hermes source as text,
                       # Hermes's install scan of this folder, and the
                       # catalog rules the plugin's own files can break
    live/              # the adapter, the routes and the gate run against the
                       # pinned Hermes itself, and `hermes plugins validate`
                       # runs on this folder; `scripts/ci-local.sh contract`
                       # runs both suites
```

## Install

The plugin needs Hermes 0.21.6 or later (`requires_hermes` in `plugin.yaml`);
an older Hermes skips it.

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
   session. `POST /api/plugins/ergates/setup` with the body `{}` does this for
   the default profile and every named one at once, after it installs the
   templates, and reports each profile (see "HTTP API"). The app calls it when
   it connects to a server.

The proposal templates need no step of their own. They ship in this folder
(`templates/`), so a git install and a read-only mount both carry them, and
`hermes serve` copies them into `<root>/ergates/templates/` the first time it
serves a request, before it opens the store. It checks every
`<template_id>.json` the way the accept route would and makes the target hold
exactly those files, removing any other. One invalid template installs
nothing and leaves the previous set in place. A template that cannot be
installed is logged by state and error class only and does not stop the
routes.

`python -m ergates.install` does steps 2 and 3 for the default profile and
every named profile at once, and runs the same template install without
waiting for a request. `--check` changes no template or plugin setting and
reports the same facts; the exit code is 0 only when every profile would load
the plugin and the installed templates equal the shipped ones. Run it as the
user that owns the Hermes root, inside the Hermes runtime, and restart
`hermes serve` after the first run so it loads the plugin's hooks and tools.
(On Hermes v0.21.6 the routes alone would mount on their first request.)

Run `hermes serve`, the gateway and these commands as the user that owns the
Hermes root. A process running as root on a Hermes root that another user
owns creates, writes and changes the owner of nothing there. Its store does
not open, so every route answers 503 `store_unavailable` and the tool gate
blocks every tool call. It installs no templates, and the log says
`setup: templates failed (run hermes serve as the owner of the Hermes root)`.
The sweep thread of `hermes serve` starts, but every pass stops before it
creates anything (the log names `StoreError`).
`python -m ergates.install` and `python -m ergates.flush` refuse to start. A
Hermes root that root owns, such as root's own home, works as before.

## Configuration

Install-wide settings live in the Hermes root's `config.yaml` (the default
profile's), under `plugins.entries.ergates.settings`. Every profile's hooks,
the sweep and `python -m ergates.flush` read them there
(`ergates/settings.py`), so a push goes to the same place whichever profile
raised it. The ntfy token is a Hermes plugin secret and lives in the root's
`.env` instead:

| Key | Default | Purpose |
|---|---|---|
| `ntfy.server` | unset (push disabled) | ntfy server base URL |
| `ntfy.topic` | unset (push disabled) | ntfy topic to publish attention events to |
| `ntfy.token`: `ERGATES_NTFY_TOKEN` in `<hermes root>/.env` | unset | ntfy publish token (Bearer), or `user:pass` for Basic |
| `ntfy.connection_id` | unset | app connection id used to build the `Click` deep link |
| `sweep.interval_seconds` | `120` | seconds between two sweeps inside `hermes serve` (see "Periodic sweep"); `0` turns the sweep off |

Values are read as written; `${VAR}` references are not expanded. One
setting is per profile, read with `ctx.get_config` from that profile's own
`config.yaml`:

| Key | Default | Purpose |
|---|---|---|
| `attention.completed_platforms` | `["cron"]` | platforms whose finished turns push "A routine finished" (by default routines only, not every chat reply); `[]` turns them off |

`plugin.yaml` declares every key above in its `config_schema`, so Hermes
Desktop lists them in the plugin's settings. Desktop saves a setting in the
active profile's `config.yaml` and the token in the active profile's `.env`,
so set the install-wide ones while the default profile is active.

The token is a `type: secret` field, which Hermes keeps in `.env` as
`ERGATES_NTFY_TOKEN`. The plugin reads it through Hermes
(`install_secret` in `ergates/hermes_adapter.py`) from the root's `.env` in
every process, including a named profile's turn on a multiplexed gateway. A
named profile's `.env` is never read for it, and the multiplexed gateway
never reads it from the process environment, so keep it in that file.
Ergates has a variable name of its own because Hermes's bundled ntfy
platform reads `NTFY_TOKEN` and `NTFY_TOPIC` and treats every message on
that topic as user input. A `ntfy.token` left in `config.yaml` is ignored,
and the log names the key and `ERGATES_NTFY_TOKEN`, never the value.

No credentials are ever read from, or written into, this repository or the
store. Push is skipped (not an error) whenever `ntfy.server` or `ntfy.topic`
is unset; the event and its outbox row are still recorded.

## Upgrading from 0.2

An install that ran version 0.2.0 needs three changes by hand:

- **The ntfy token moves to `.env`.** Delete `ntfy.token` from
  `plugins.entries.ergates.settings` in `<hermes root>/config.yaml` and add
  the same value to `<hermes root>/.env` as `ERGATES_NTFY_TOKEN=<token>`.
  The plugin ignores a token left in `config.yaml` and logs a warning each
  time it reads the settings. Pushes then go out without a token, and an
  ntfy server with a deny-by-default ACL refuses them.
- **The host cron line can go.** `hermes serve` runs the sweep itself now
  (see "Periodic sweep"), so delete the crontab line that ran
  `python -m ergates.flush`. A line that stays does no harm: two sweeps on
  one store send each due push once.
- **Run the setup once.** `POST /api/plugins/ergates/setup` with the body
  `{}`, or `python -m ergates.install`, installs the templates and enables
  the plugin in every profile (see "Install"). The app calls the route when
  it connects to the server.

## Upgrading from 0.1

An install that ran version 0.1.0 needs three changes by hand:

- **The sweep takes no `--profile`.** `python -m ergates.flush --profile <name>`
  now exits 2 (`unrecognized arguments`) and sweeps nothing. `hermes serve`
  runs the sweep itself now (see "Periodic sweep"), so the crontab line can
  go. If you keep it, drop the flag: the sweep opens the store and reads the
  push settings under the Hermes root, whichever `HERMES_HOME` it runs with.
- **Push settings live in the root's `config.yaml` only.** `ntfy.*` settings
  kept in a named profile's `config.yaml` are ignored, and
  `ntfy.default_profile` is gone. Move `ntfy.server`, `ntfy.topic` and
  `ntfy.connection_id` to `plugins.entries.ergates.settings` in
  `<hermes root>/config.yaml`, and the token to `<hermes root>/.env` (see
  "Upgrading from 0.2").
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
| `GET /health` | 200 with the plugin version, API level, store, install, setup, push and sweep state (see "Health") | 503 `store_unavailable` |
| `POST /reminders` `{profile, schedule, timezone, prompt, request_id, label?}` | 201 new, 200 existing, 202 uncertain; body `{"receipt"}` | 409 `conflict` (with `receipt`), 400 `invalid`, 404 `unknown_profile` |
| `GET /proposals/{id}` | 200 `{"proposal"}` | 404 `not_found` |
| `POST /proposals/{id}/accept` `{proposal}` | 200 `{"proposal"}` with `template` | 409 `hash_mismatch` / `not_acceptable` / `name_taken`, 410 `expired`, 422 `unknown_template` |
| `POST /proposals/{id}/reject` | 200 `{"proposal"}` | 409 `not_acceptable` |
| `POST /proposals/{id}/steps` `{step, status}` | 200 `{"proposal"}`; `briefing` `done` completes it | 409 `out_of_order` / `not_ready` |
| `POST /profiles/{profile}/plugin` | 200 `{"profile", "enabled": true}` | 404 `unknown_profile` |
| `POST /setup` `{}` | 200 `{"setup": {"finished", "templates", "profiles"}}` | 400 `invalid` |
| `GET /attention/prefs?scope=<name or *>` (`?profile=<name>` still names one profile) | 200 `{"prefs"}` | 400 `invalid` |
| `PUT /attention/prefs` `{profile, muted, quiet_start, quiet_end}` | 200 `{"prefs"}` | 400 `invalid` |

`POST /setup` installs the templates the way the first request does, then
enables the plugin in the default profile and every named one, and reports
both. `setup.templates` is the state the template install ended in:
`installed`, `invalid`, `missing` or `failed`. `setup.profiles` has one
`{"name", "enabled"}` per profile, in Hermes's order, plus `"error"` with the
exception class when enabling or checking that profile raised; a
`plugins/ergates` folder that is not a link gives `FileExistsError`. A profile
that fails does not stop the others and does not make the reply an error.
`setup.finished` is true only when the templates are `installed`, there is at
least one profile and every profile is enabled. Calling it again is safe. Send
`{}` with `Content-Type: application/json`: any other body, a request not sent
as JSON included, is a 400 and touches nothing, so a page on the same site
cannot trigger a setup without a CORS preflight. Like every route, it runs
only on a store that opens, so as root on a Hermes root another user owns it
writes nothing and answers 503 `store_unavailable`.

Also on every route: 400 `invalid` for a body that is not a JSON object or a
field that fails validation, 404 `not_found` for an unknown proposal,
503 `store_unavailable` when the control store cannot be opened, 503
`store_too_new` (message `the Ergates control store needs a newer Ergates
plugin`) for a write to a store this plugin may only read (see "Schema
versions and older plugins"), and 500
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

### Health

`GET /health` is the route a client reads before it relies on the rest. It
writes nothing. The body of a plugin installed from a git commit, with the
setup finished:

```json
{"ok": true, "plugin_version": "<version>", "api_level": 1, "min_api_level": 1, "schema_version": 2,
 "store": {"plugin_schema_version": 2, "min_schema_version": 2, "writable": true},
 "install": {"kind": "git install", "commit": "<40 hex>", "catalog_name": null},
 "setup": {"finished": true, "templates": "installed", "profiles": [{"name": "default", "enabled": true}]},
 "push": {"configured": true, "token_set": true, "legacy_config_token": false},
 "sweep": {"interval_seconds": 120, "last_run_at": 1760000000.0, "last_error": null}}
```

- `plugin_version` is the version in `plugin.yaml`.
- `api_level` and `min_api_level` (`API_LEVEL` and `MIN_API_LEVEL` in
  `ergates/__init__.py`) say which routes and bodies a client may rely on.
  A route or body change a client relies on raises `API_LEVEL`.
  `MIN_API_LEVEL`, the oldest level this plugin still serves, follows at
  least one release later. A client that needs a level above `api_level`
  needs a newer plugin; one built for a level below `min_api_level` needs a
  newer client.
- `schema_version` is the store file's schema. `store.plugin_schema_version`
  is this plugin's own, `store.min_schema_version` the oldest plugin schema
  allowed to write the store and `store.writable` whether this plugin may
  (see "Schema versions and older plugins"). A store a newer plugin made
  read-only still answers 200, with `writable` false. Going back to an
  earlier plugin commit works only when that plugin's schema, the
  `plugin_schema_version` it reports (0.2.0 reports none, read as 1), is at
  least the current `min_schema_version`.
- `install` says how the plugin got onto the server
  (`ergates/install_info.py`). `deployment`: the serving process has
  `ERGATES_INSTALL_KIND=deployment`, which the Compose file in `deploy/` sets
  because it mounts the plugin read-only. `git install`: Hermes recorded a
  40-hex revision for the plugin and the plugin folder is a real folder;
  `commit` is that revision in lower case and `catalog_name` the name of
  the plugin catalog entry, or `null` for an install from a URL.
  `manual copy`: anything else, a copied or linked folder included. Only a
  git install has a `commit`. The answer never carries the record's `source`
  or a path.
- `setup` is the report `POST /setup` would give now, read without writing.
  `finished` is true only when `templates` is `installed`, there is at least
  one profile and every profile is enabled. `templates` is `installed`,
  `differ` (the installed set is not the set the plugin ships; `POST /setup`
  installs it), `invalid` or `missing`. When it is `invalid`,
  `templates_detail` says where the bad template is: `bundle` for a
  template the plugin ships that the accept route would refuse (nothing is
  installed and the previous set stays), `installed` for an entry in the
  installed folder that is not a regular file within the size limit. The key
  is absent for every other state. `profiles` has one `{"name", "enabled"}`
  per profile, plus `"error"` with the exception class when checking that
  profile raised. When Hermes cannot list the profiles, `profiles` is `[]`,
  `finished` is false and `setup.error` names the exception class.
- `push` holds three booleans and never a value. `configured`: `ntfy.server`
  and `ntfy.topic` are both set in the root's `config.yaml`. `token_set`:
  `ERGATES_NTFY_TOKEN` has a value in the root's `.env`.
  `legacy_config_token`: a `ntfy.token` key still sits in the root's
  `config.yaml`, where it is ignored. When reading them raises, the three
  are false and `push.error` names the exception class.
- `sweep` is the periodic sweep's state (see "Periodic sweep").

`health` answers 503 `store_unavailable` only when the control store cannot
be read, so the setup, push and install parts above never turn into an error
of their own. Checking the plugin in every profile and parsing `config.yaml`
is slow, so `setup` and `push` are reused for 10 seconds (`POST /setup` and
`POST /profiles/{profile}/plugin` drop them at once); `store`, `install` and
`sweep` are read at every call.

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
  own `_get_platform_tools`. Hermes's answer also lists the MCP servers an
  app session gets: none when the list holds `no_mcp`, only the listed ones
  when it names at least one enabled server, and every enabled server
  otherwise. Each of those servers adds its toolset `mcp-<server>`. A name in
  the list that resolves to a server's tools, such as `mcp-<server>` or `all`,
  grants them too, as it does in Hermes. The legacy `tools.enabled_toolsets`
  counts only when `platform_toolsets.cli` is absent: its names count as
  listed, and every MCP server the profile enables adds its toolset. Hermes
  never reads an MCP server's legacy `disabled` key. On
  `platform_toolsets.cli` the gate takes such a server's `mcp-<server>` out of
  the grant, whichever way it got in. On the legacy pin such a server adds no
  toolset of its own, but a listed name that resolves to its tools still
  grants them. The grant is read at every tool
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
| `store_meta` | facts about the store itself: `min_schema_version`, the oldest plugin schema allowed to write it |

Rules the store enforces:

- Every write is `BEGIN IMMEDIATE`, so a read-modify-write never
  interleaves with another writer, in this process or another one. A second
  writer waits up to the busy timeout (5 s).
- Every receipt change is a versioned compare-and-set: it names the version
  it read and changes nothing when another writer got there first.
- An attention event and its outbox row commit in one transaction. Delivery
  writes only the outbox row; an event's state changes only through
  resolution or expiry.
- The schema is versioned with `PRAGMA user_version`. Opening the store
  applies the missing migrations in one transaction, so a migration that
  fails leaves the file as it was.
- No column holds prompt, command, briefing or description text. Receipts
  and events keep identifiers and sha256 hashes (docs/04 sections 4 and 8).

### Schema versions and older plugins

A migration is additive unless it is marked `additive=False`. An additive
migration only adds tables, indexes, columns that need no value, and
`store_meta` rows; `integrations/ergates-tests/tests/test_store.py` checks
each one. A plugin that knows only the earlier versions keeps reading and
writing such a store and ignores the parts it does not know.

The `store_meta` row `min_schema_version` is the oldest plugin schema
allowed to write the store. Schema 2 creates it with the value 2, and
additive migrations leave it alone. A migration marked `additive=False`
(one that changes or removes anything) raises it to that migration's
version.

A plugin that opens a store newer than its own schema applies nothing. If
the marker is at or below the plugin's schema, the plugin reads and writes
as usual. If the marker is higher, missing or unreadable, the plugin only
reads. Every write then raises `StoreReadOnly`: a route answers 503
`store_too_new` and a tool answers an error. The log says so once, with
version numbers only.

Two plugin versions can share one store, for example another profile's
copy of the plugin, or a process that has not restarted since an update.
A newer plugin can therefore take writing away from an older one that is
already running, so every write repeats the check under the write lock.

Plugin 0.2.0 (schema 1) refuses every schema above its own, so it cannot
open a schema 2 store: its tool gate blocks every tool call and its routes
answer 503 `store_unavailable`. Going back to 0.2.0 after this plugin has
opened a store is not supported.

### Retention and expiry

The periodic sweep applies these (see "Periodic sweep"):

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
`soul`, `enabled_toolsets`, `enabled_mcp_servers`), where the plugin copied it
from its own `templates/` folder; an unknown template is a 422 and reserves
nothing. The app then performs the provisioning steps in
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

`hermes serve` runs the sweep itself. When Hermes imports `dashboard/api.py`
(at server start, or on the first request after an install), the plugin
starts one daemon thread, `ergates-sweep`. Its first pass runs 5 seconds
later, then one every `sweep.interval_seconds` (120 by default). A pass sends
every due push from the outbox, expires approvals past their timeout, applies
the retention rules above, and asks Hermes cron whether each reminder's job
still exists. It reads the install-wide push settings from the root's
`config.yaml`, and the token from the root's `.env`, on every pass. Only a
process that loads Hermes's dashboard server imports that file, so the
gateway and cron processes, which load only the plugin's hooks, start no
sweep.

`GET /health` reports the sweep:

```json
"sweep": {"interval_seconds": 120, "last_run_at": 1760000000.0, "last_error": null}
```

`last_run_at` is the Unix time the last pass ended, `null` before the first
one. `last_error` is that pass's error class, or `null` when it succeeded. A
failing pass never stops the thread, and the next one runs on time. The log
names the error class once, until a pass fails with another class or
succeeds. On a store a newer plugin made read-only, every pass fails with
`StoreReadOnly` and writes nothing. When the thread cannot start at all, the
log names the error class, `last_error` names it too, and the routes still
serve. With `sweep.interval_seconds: 0` no thread starts and `health`
reports `"interval_seconds": 0`.

More than one sweep can run on one store: a host cron line left from an
older setup, Hermes Desktop and `hermes serve` on one Hermes root, or one
plugin host per profile under `plugins.isolation: host`. Each write takes
the store's write lock, and a worker leases a due push before it sends it,
so every push still goes out once.

`python -m ergates.flush` runs one pass by hand and prints its counts:

```bash
HERMES_HOME=/opt/data python -m ergates.flush [--quiet]
# ergates.flush: retried=0 expired_notifications=0 pruned_notifications=0 pruned_proposals=0 pruned_reminders=0
```

No credential is ever passed as an argument or printed. Run it inside the
Hermes runtime, as the user that owns the Hermes root (`hermes` in the
container): the token comes through Hermes, so a run outside it sends its
pushes without one. As root it refuses to start when another user owns the
Hermes root (see "Install"). SQLite creates the store's `-wal` and `-shm`
files as the user that opens the store, so a root run would leave files the
Hermes user cannot open, and every hook would fail. If an older plugin left
such files, repair them inside the container with
`chown -R hermes:hermes /opt/data/ergates`.

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

The Hermes plugin catalog admits a plugin only when `hermes plugins validate`
passes on it. The live suite
(`contract/live/test_catalog_validate.py`) runs that command on the files git
tracks in this folder, next to the install scan, and fails on any failed
check or any warning. The command imports the plugin in a scratch process
and compares what `register()` registers with the tools and hooks
`plugin.yaml` declares, so declare a new tool or hook there when you add one.
It also refuses code that replaces or rebinds a Hermes function, method or
module attribute at runtime, checks that `requires_hermes` parses, and reads
the dependency declaration (the plugin declares none). The weekly
`contract-latest` job runs the live suite, and so the validator, against the
newest Hermes release. `requires_hermes` is the release that `HERMES_PIN`
names (`HERMES_PIN_VERSION` in
`integrations/ergates-tests/contract/pinned.py`): move the two together.
`contract/test_catalog_rules.py` checks that floor, the license and the home
in `plugin.yaml`, and that the section "What this plugin does on your server"
names each thing the catalog asks a plugin to disclose.
