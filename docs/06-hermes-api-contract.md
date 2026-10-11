# 06 - Hermes Client Contract

Version: 0.3. Date: 2026-09-12. Source-reviewed against Hermes 0.21.2, commit `d76856cc6971b6e0e1903b5369498bcc4bb83a60`, the pin until 2026-10-11. The pin is now 0.21.6 (`818c13be1dc4fd28987e1e881a9408224afd4535`); entries that name v0.21.6 were rechecked there. v0.21.6 sends approval, clarify, sudo and secret prompts as server-to-client requests, so the prompt entries below still describe 0.21.2. Implementation/live fixtures: pending Phase 0.

This is the app's intended dependency surface. **Source-confirmed** entries below were checked in handlers/types. Examples use illustrative ids and paths, not captured traffic. Additional feature handlers are an inventory until their complete bodies, errors and lifecycle are recorded. Ergates-specific operations in 11 are proposed integration APIs, never upstream Hermes methods.

## 1. Transport and scope

Use `hermes serve` REST plus newline-delimited JSON-RPC 2.0 over `/api/ws`. Vendor `apps/shared/src/json-rpc-gateway.ts` at the backend pin and adapt the native socket/HTTP/cookie edges. Every request/response and event is routed by its owning connection, profile and session. Add a trailing newline to the frames below when writing directly; normally the client library handles framing.

`gateway.ready` announces readiness and `replay_epoch`; its `skin` field carries the resolved skin payload. A socket profile is selected with `?profile=<encoded-name>`. Do not infer REST scoping from that socket: use the specific router's profile parameter, body field or managed-file policy. The endpoint inventory below is not permission to read arbitrary host files.

## 2. Authentication (source-confirmed)

Source: `hermes_cli/dashboard_auth/routes.py`, `ws_tickets.py`, `native_flow.py`, and the auth middleware in the pinned checkout.

| Method | Route | Request / response and use |
|---|---|---|
| GET | `/api/status` | Public discovery: `auth_required`, providers/flows and installation/version information |
| POST | `/auth/password-login` | JSON `provider`, `username`, `password`, optional `next`; success `{ok:true,next:...}` plus session cookies |
| GET | `/api/auth/me` | Authenticated session identity and expiry |
| POST | `/api/auth/ws-ticket` | Authenticated cookie or native Bearer session; response `{ticket,ttl_seconds}`; 30-second, single-use ticket |
| POST | `/auth/logout` | Revoke/clear the session where supported; clears cookies and redirects to login; app also clears local credentials/data |
| GET | `/api/health` | Liveness |
| GET | `/auth/native/authorize` | Later native PKCE authorization; mobile redirect compatibility is not yet implemented |
| POST | `/auth/native/token` | JSON `{code,code_verifier}`; native token exchange |
| POST | `/auth/native/refresh` | Native rotating-refresh flow; not the basic-cookie renewal mechanism |

Basic login is JSON, not HTTP Basic Authorization. Retain/replay the server's cookies using a tested native adapter; inspect secure-cookie behavior on the chosen private HTTP/HTTPS endpoint. Do not assume React Native and a system browser share a cookie jar.

After login, mint a fresh ticket and open:

```text
ws://<private-gateway>:9119/api/ws?profile=default&ticket=<single-use-ticket>
```

Use `wss` for an HTTPS gateway. Query values are URL-encoded and redacted from logs. Reconnect always mints another ticket. Handle 401/expired session, 429 login throttling and WebSocket closes 4401 (authentication) / 4403 (request guard). Native token exchange uses `code_verifier`, not a field named `verifier`.

## 3. Core JSON-RPC (source-confirmed subsets)

Source: `tui_gateway/methods_prompt.py`, `methods_session.py`, `methods_profiles.py`, `methods_config.py`, `ws.py`, and the shared client.

| Method | Parameters used | Important semantics |
|---|---|---|
| `gateway.ping`, `gateway.capabilities` | No feature-specific params | Heartbeat/capability discovery |
| `session.list` | Supported list filters recorded in fixtures | Select the owning Bot Chat; do not invent a second canonical chat on each launch |
| `session.create` | `title`, `profile`, optional verified server `cwd` | Creates runtime session; canonical title is `BOT_CHAT_TITLE` (`Bot Chat` at this pin) |
| `session.resume` | `session_id` (and supported title lookup when needed) | Reattach; does not prove updated tool configuration was rebuilt |
| `session.history` | `session_id`, pagination supported by the handler | Durable transcript/row ids; confirm paging shape in fixtures |
| `session.events.since` | `session_id`, **`last_seen`** | Result `events`, `latest_seq`, `truncated`, `count`, `epoch` |
| `session.status`, `session.info`, `session.usage` | `session_id` | State and usage; inspect pending requests on recovery |
| `prompt.submit` | `session_id`, `text`, optional `queued` | JSON-RPC id correlates reply only. No verified durable submit-idempotency key; omit unsupported `surface:"mobile"` |
| `session.steer`, `session.interrupt`, `session.compress` | `session_id`; text for steer | Explicit user intent; compression failure must remain visible |
| `image.attach` | `session_id`, **`path`** | Server-visible existing path; rejects a bytes-only `data` call |
| `image.attach_bytes` | `session_id`, **`content_base64`**; optional `filename`, `ext` | Remote bytes path; `data` is an alias; server validates type and its own byte cap |
| `file.attach` | `session_id`, `path` or `data_url` (+ `name`) | Verified at v0.21.6 (`tui_gateway/methods_prompt.py:976-996`, `tui_gateway/prompt_attachments.py:187-192`): the handler accepts either an existing gateway path or a data URL that it stages under the session's `attachments/`; the phone sends `data_url` + `name` and puts the returned `ref_text` in the prompt. The REST upload route stays the path for large files |
| `approval.respond` | `session_id`, `request_id`, `choice` | `once`, `session`, `always`, `deny`; include identity even when fallback lookup is possible |
| `clarify.respond` | Owning session/request plus answer in the advertised single/batch shape | Capture actual variants before implementing multi-select; expiry is authoritative |
| `profiles.list` | Gateway profile inventory | Includes `ui_meta`, `ui_meta_revisions`, `has_avatar` |
| `profiles.describe` | `name` | Editor snapshot: model/provider, SOUL, skills, toolsets and MCP servers; record the complete shape in P1 fixtures |
| `profiles.create` | `name`, optional `description`, `soul`, `model`, `provider`, clone options, `no_alias`, **`mirror_credentials`**, `share_auth` | For fresh Ergates provisioning set `mirror_credentials:false`; defaults can copy launch secrets |
| `profiles.configure` | `name`, `ui_meta`, `ui_meta_expected_revisions`, `soul`, `description`, `model`, `provider`, allowed config sections | Inspect `ok`, individual `applied` values, metadata conflicts and model confirmation; not an all-or-nothing transaction |
| `profiles.set_asset` | `name`, `asset:"avatar"`, `data` or `clear:true` | PNG/JPEG/WebP, up to 2 MB per handler |
| `profiles.get_asset` | Supported profile/asset params | Record reply shape before avatar implementation |
| `config.get` | `key:"skin"` | This handler returns `{value:<skin-name>}`; full colors come from ready/change events |
| `model.options` | Profile-scoped request | Provider/model picker; do not assume a generic quota percentage |

### Representative requests

Replay (sending `seq` would not advance the handler's default `last_seen`):

```json
{"jsonrpc":"2.0","id":17,"method":"session.events.since","params":{"session_id":"session-example","last_seen":42}}
```

An empty successful replay has this shape; values are illustrative:

```json
{"jsonrpc":"2.0","id":17,"result":{"events":[],"latest_seq":42,"truncated":false,"count":0,"epoch":"example-epoch"}}
```

Attach a phone image, then submit only after the attachment response succeeds. The string below is a placeholder to replace with actual base64 bytes:

```json
{"jsonrpc":"2.0","id":18,"method":"image.attach_bytes","params":{"session_id":"session-example","filename":"photo.jpg","content_base64":"<actual JPEG bytes encoded as base64>"}}
```

```json
{"jsonrpc":"2.0","id":19,"method":"prompt.submit","params":{"session_id":"session-example","text":"Summarize this photo."}}
```

```json
{"jsonrpc":"2.0","id":20,"method":"approval.respond","params":{"session_id":"session-example","request_id":"approval-from-backend","choice":"once"}}
```

Do not replay the submit on timeout. Persist its uncertain state and reconcile history (05). Approval retries refetch the request's current state; an expired/resolved request must not become a new action.

## 4. REST feature surface

### Session transcript (read-only, source-confirmed)

`GET /api/sessions/{session_id}/messages?profile=<p>&limit=<1..500>&offset=<n>&order=latest|oldest[&include_compacted=true]` (`hermes_cli/web_routers/sessions.py:528-566`) returns `{session_id, profile, messages, pagination: {limit, offset, order, returned}}`. Rows carry `id`, `role`, `content`, `tool_calls` (assistant), `tool_call_id`/`tool_name` (tool rows), `timestamp`, `display_kind`, `display_metadata` and `display_content` for displayable compaction summaries. Row ids are a global autoincrement, so a session's ids are not contiguous. The app always sends `order` explicitly, reads the newest page first (`limit=500`), tails with `limit=50` after a turn or a process notification, and pages backward only while evidence that must be older is missing (a receipt without its send, a tool row without its assistant row; four automatic pages; "Older messages" pages manually). This is the only source of tool-call ids and tool results: `session.history` tool rows carry none (`tui_gateway/session_history.py:210-216`).

### Files and images (source-confirmed)

Source: `hermes_cli/web_routers/files.py`, `web_models.py` and the managed-file policy helpers.

| Method | Route | Body / constraints |
|---|---|---|
| POST | `/api/chat/image-upload?profile=<name>` | JSON `{data_url,filename?}`; 25 MiB image cap; response `{ok,path,name,bytes,mime_type}`. **Not multipart** |
| POST | `/api/files/upload` | JSON `{path,data_url,overwrite}` under the request's managed-file policy. Use `overwrite:false` for new uploads |
| POST | `/api/files/upload-stream` | Separate multipart streaming upload; capture its exact form fields/limits before adopting |
| GET | `/api/files`, `/api/files/read`, `/api/files/download` | Managed path and policy; list/read/download according to router requirements |
| GET | `/api/fs/list`, `/api/fs/read-text`, `/api/fs/download` | Server filesystem operations with their own routing/path rules; not blanket per-profile sandbox APIs |

REST image intake example:

```json
{"filename":"photo.jpg","data_url":"data:image/jpeg;base64,<actual JPEG bytes encoded as base64>"}
```

Use the returned server path in `image.attach`. Do not set a universal upload cap from `image.generate`'s output-download limit; byte attachments and managed documents have separate caps. Record caps from the selected route in P0, validate decoded bytes before transfer, and test HEIC conversion. Validate the complete zip upload → sandbox read → artifact download path; `/api/files/upload` does not automatically target a session's Docker workspace.

### Profiles, routines, connectors and skills

These routes exist at the pin; request/response fixtures for each adopted feature remain required. Use exact verbs rather than expanding every combination in a combined CRUD row.

| Method | Route | Use / boundary |
|---|---|---|
| GET / POST | `/api/profiles` | Roster / create; prefer the documented RPC provisioning path for Ergates |
| PATCH / DELETE | `/api/profiles/{name}` | Edit or delete after current-state checks; default profile cannot be deleted |
| GET / PUT | `/api/profiles/{name}/soul` | Instructions |
| PUT | `/api/profiles/{name}/description`, `/api/profiles/{name}/model` | Role / model pin |
| POST | `/api/profiles/{name}/export`, `/api/profiles/import` | P2; verify archive content and secret/memory controls |
| GET / POST | `/api/cron/jobs` | List / raw create. Ergates create must use the idempotency contract in 11 |
| PUT | `/api/cron/jobs/{id}` | **`{updates:{...}}`**, per `CronJobUpdate` |
| POST | `/api/cron/jobs/{id}/pause`, `/resume`, `/trigger` | Lifecycle / test |
| GET | `/api/cron/jobs/{id}/runs`, `/api/cron/delivery-targets` | History and delivery targets |
| DELETE | `/api/cron/jobs/{id}` | Delete |
| GET | `/api/tools/toolsets` | List; there is no equivalent generic PUT of this list in the verified router |
| PUT | `/api/tools/toolsets/{name}` | Enable/disable supported toolset; verify configuration platform and live effect |
| GET / POST / PUT | `/api/mcp/servers` | List / add / **replace the entire map** using `{servers:{...}}`; preserve unrelated entries |
| DELETE | `/api/mcp/servers/{name}` | Remove; do not invent a per-server PUT update endpoint |
| POST | `/api/mcp/servers/{name}/test`, `/auth` | Probe / initiate authorization |
| GET / DELETE | `/api/mcp/oauth/flows/{flow_id}` | Poll / cancel authorization flow |
| PUT | `/api/mcp/servers/{name}/enabled` | `{enabled,profile?}`; takes effect on a subsequent session/gateway |
| GET / POST | `/api/mcp/catalog`, `/api/mcp/catalog/install` | Catalog / install |
| GET / POST | `/api/skills` | List / install; verify selected archive/identifier mode |
| PUT | `/api/skills/toggle` | Skill toggle; record cache/session effects |
| GET | `/api/model/options` | Provider/model options |

Profile scoping is explicit per operation: most MCP/tool/cron routes accept `?profile=`, some bodies also have `profile`, and global/profile-name routes differ. `GET /api/cron/jobs` defaults to all profiles; an agent view must scope/filter deliberately. Managed file routes resolve access from request policy rather than inheriting a WebSocket's selected profile. Capture the exact request used by the reference desktop for each screen.

### Mobile bot editor mapping

Source: `apps/desktop/src/plugins/hermes-bots/{edit-profile-dialog,profile-config}.tsx`, `labels.ts`, `types.ts`, `data.ts`, and `tui_gateway/methods_profiles.py` at the pin. Mobile supports the same configuration fields with staged Save/Cancel behavior from 10.

| Field / action | Adopted contract |
|---|---|
| Friendly name / appearance / Hide | Merge changed fields into `ui_meta['hermes-bots']`; desktop `title` is a friendly name. Preserve unknown fields and pass expected namespace revisions |
| Role badge | Proposed `ui_meta.ergates.role`; not the desktop `title` key |
| Avatar | `profiles.get_asset {name,asset:"avatar"}` → `{found,data,mime,size}` or `{found:false}`. Changed bytes/removal only via `profiles.set_asset`; maximum 2,000,000 decoded bytes |
| Description / instructions | `profiles.configure {name,description,soul}` for touched fields only |
| Model | `profiles.configure {name,provider,model}`; inspect `applied.model` and `confirm_required`; confirmed retry sends only model/provider plus `confirm_expensive_model:true` |
| Skills / toolsets / MCP | `disabled_skills`, `enabled_toolsets`, `enabled_mcp_servers` arrays in `profiles.configure`; per-tool include/exclude uses the separate MCP config path. On v0.21.6 `enabled_toolsets` is stored as the profile's `platform_toolsets.cli`, and an MCP server is turned off with `enabled: false` (`tui_gateway/methods_profiles.py:673-708`) |
| Reasoning / other advanced config | Separate supported profile-scoped config calls; capture exact keys and lifecycle before exposing each field. They are not arbitrary `profiles.configure` params |
| Notifications | Ergates subscription operation in 11; not a stock profile notification property |
| Copy ID | Display/copy the existing profile id and gateway label; no backend mutation |

Do not translate “all toolsets off” to an empty `enabled_toolsets`: on v0.21.6 an empty selection clears the pin, so the platform default applies again (`tui_gateway/methods_profiles.py:673-683`). Expose this distinction and prove a supported deny-all path before offering one. Tool/MCP configuration success alone does not establish effective revocation in running sessions.

Read before editing, submit only changed sections and inspect each result. Metadata CAS does not make SOUL/model/assets atomic or versioned. Re-read non-metadata fields before save, keep partial failures visible, and require serialization if stronger concurrency guarantees are needed. Avoid desktop's local-only fallback when reporting a server save.

`PATCH /api/profiles/{name}` is profile renaming using `new_name`; for non-default profiles it can rename directories and stop a gateway. It is **not** the friendly-name editor path above. Actual identifier migration requires reconciling jobs, sessions, subscriptions, links and caches and remains outside this editor.

## 5. Events and recovery

| Event | App handling |
|---|---|
| `gateway.ready` | Read readiness, capabilities, `replay_epoch`, full `skin`; seed theme without overwriting saved preference |
| `skin.changed` | Validate resolved skin, map built-in/default names or custom colors through Hermes converter; active connection only |
| `message.start`, `message.delta`, `message.interim`, `message.complete` | Update one assistant message; reconcile durable rows on history refresh |
| `session.info`, `session.usage` | Update session state and measured usage |
| `tool.start`, `tool.progress`, `tool.complete`, `tool.generating` | Quiet Activity view; recognize only validated integration tool results as proposal candidates |
| `status.update`, `todo.updated` | Working/status line or task detail. `kind: "process"` carries a full background-process receipt (`tui_gateway/session_notifications.py:436`): the app routes it to the receipt pipeline and never to the working line |
| `clarify.request`, `clarify.expire` | Request card; expire only matching request |
| `approval.request`, `approval.pending`, `approval.received` | Request/current-state changes; query/reconcile after reconnect |
| `background.complete` | Side-agent completion; payload is `{task_id, text}` only (`tui_gateway/methods_prompt.py:920-941`), no author or source field. The app renders it as a neutral notice and keeps `text` in Activity |
| `notification.show`, `notification.clear` | In-app attention. They are not automatically mobile pushes |
| `cron.changed` | Invalidate the owning routines list; refetch authoritative state |
| `subagent.*` | Activity details; reconnect behavior checked separately |
| `thinking.delta`, `reasoning.delta`, `reasoning.available` | Optional available reasoning, collapsed by default |
| `room.activity` | P2 room state |
| `error` | Safe user-facing state; sanitized diagnostic detail |

Deltas are coalesced server-side around 33 ms, not a phone latency guarantee. Replay is bounded and in-process. On a new epoch or `truncated:true`, refresh history plus authoritative pending approvals, routines and profile state. Compare installation identity for connection trust separately from replay epoch.

## 6. Bot and integration conventions

- Canonical title comes from `tools/bot_mode_probe.py::BOT_CHAT_TITLE` at the pin; record it alongside vendored code. The current value is `Bot Chat`.
- Routine names use `[bot:<profile>] `; this is a display convention, not a scheduler subscription or idempotency key.
- Profile metadata uses `ui_meta`; writes may carry `ui_meta_expected_revisions`, while responses expose `ui_meta_revisions`. Check per-key conflicts.
- `message_agent` is injected in canonical Bot Chat sessions. It is not a general cross-gateway mobile relay implementation.
- `ergates_propose_agent`, proposal acceptance, notification registration/event bridges and safe reminder creation are **new** contracts in 11. Confirm their extension registration and auth in P0 before fixing route names in a generated client.

## 7. Verification and upgrades

P0 records sanitized fixtures from the real pinned backend for basic login/cookie reuse, ticket expiry, connect, image bytes and REST upload, streamed turn, approval, clarify, replay gap, ring truncation, restart, rejected submit and profile creation/configuration. Include partial `profiles.configure` failures and credential-mirroring behavior. P1 extends this to the adopted feature routes and integration operations.

The fake gateway verifies rendering and client behavior; it does not prove a new backend version is compatible. Run the same behavioral scenarios against the real upgraded backend, compare with the previous fixtures, update this contract, then deliberately update fixtures. Never simply regenerate all expected outputs and call that a compatibility test.

The API server on port 8642 is optional for later automations (`/v1/runs`, capabilities, durable run idempotency). Its contracts and guarantees must not be attributed to `prompt.submit` on the mobile WebSocket path.
