# 09 - Glossary

| Term | Meaning |
|---|---|
| Hermes Agent | The upstream agent runtime, profile/state system, tools, memory, cron and gateway used by Ergates |
| `hermes serve` | Headless HTTP/JSON-RPC backend for clients, normally port 9119; does not serve the dashboard SPA |
| `hermes dashboard` | HTTP server mode that also serves the admin SPA; use a separate port or instead of serve on the selected endpoint |
| `hermes gateway` | Messaging-platform and cron process; multiplexing must be enabled to service secondary profiles |
| Profile / agent | One Hermes home/configuration identity presented as an assistant; not a human tenant or role |
| Concierge | Default profile, seeded with delegation instructions and the custom proposal capability |
| Bot Chat | Canonical persistent session using the pinned `BOT_CHAT_TITLE` convention, where teammate messaging is available |
| Session | Owning connection/profile plus Hermes conversation identity; distinguish live runtime ids from persisted identity when reconnecting |
| Room | Hermes group-chat primitive; same-gateway driver first, cross-gateway relay/sharing separately verified |
| Turn | One model execution started by a prompt, routine or message |
| Event row | Compact app rendering of verified activity/status/completion data |
| Choice card | Native rendering of a Hermes clarify request and its actual waiting/expiry state |
| Approval card | Authenticated request view with backend choices; not a general authorization policy by itself |
| Agent proposal | Typed data from the proposed Ergates tool; acceptance is a separate authenticated user operation |
| Provisioning receipt | Integration record of accepted proposal, payload hash and completed creation/configuration/briefing steps |
| Connector | Reviewed MCP server configured on a profile with explicit tool contribution and credential scopes |
| Effective grant | Tools currently available to an execution context; a saved configuration change may not yet be effective |
| Tool switch | User-facing policy control with Applying/Off states tied to verified execution changes |
| Routine | Hermes cron job; display name commonly prefixed `[bot:<profile>]`; not a precise timer guarantee |
| Reminder receipt | Integration idempotency record linking one normalized creation request to one Hermes cron job |
| Kanban | Shared Hermes task board; agent tools in P1, native board view in P2 |
| Memory | Profile memory files and session retrieval supplied by Hermes |
| Skill | Hermes/agentskills.io playbook folder; may declare scripts and environment needs requiring review |
| Template | Reviewed profile export/import with explicit secret and personal-memory controls |
| Sandbox | Docker execution environment for the owning profile's shell/files; does not automatically isolate host MCP/plugin tools |
| Egress proxy | Outbound route that the server owner may enforce, for example with a proxy; Ergates ships none (ADR-046). Setting a proxy environment variable alone is not enforcement |
| Connection | App-local trusted gateway registration: id, label, URL and auth state |
| Replay epoch / sequence | In-process event-ring identity and ordering; neither is a durable message id |
| Delivery unconfirmed | A request may have reached the server, but the client cannot establish its outcome; never silently resend |
| Native PKCE | Later browser-based native auth flow; Hermes loopback support needs a mobile redirect compatibility check |
| Attention bridge | Proposed integration connecting server events to durable notification delivery while the app is closed |
| ntfy | P1 push transport; iOS instant delivery uses an upstream wake-up path |
| Theme / skin | Hermes semantic palette: built-in desktop presets or a resolved `HermesSkin` converted for the client |
| Nous | Default Hermes desktop theme; blue accent, light/dark neutral surfaces |
| Ergates | Working product name of the mobile app and its small integration package |
