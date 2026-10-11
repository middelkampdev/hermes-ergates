# Vendored Hermes sources

Upstream: Hermes Agent by Nous Research, MIT license (see `LICENSE` in this directory).
Pin: commit `818c13be1dc4fd28987e1e881a9408224afd4535`, version 0.21.6, for every file except where the table names another pin.
Upstream checkout used for the copy: `~/Projects/misc/hermes/hermes-agent`.

| Vendored file | Upstream path | Pin | Local change |
|---|---|---|---|
| `shared/json-rpc-gateway.ts` | `apps/shared/src/json-rpc-gateway.ts` | `d76856cc6971b6e0e1903b5369498bcc4bb83a60` (0.21.2) | none |
| `shared/skin.ts` | `apps/shared/src/skin.ts` | 0.21.6 | none |
| `shared/color.ts` | `apps/shared/src/color.ts` | 0.21.6 | none |
| `shared/theme-presets.ts` | `apps/shared/src/theme-presets.ts` | 0.21.6 | none |
| `themes/types.ts` | `apps/desktop/src/themes/types.ts` | 0.21.6 | none |
| `themes/presets.ts` | `apps/desktop/src/themes/presets.ts` | 0.21.6 | import path `@hermes/shared` -> `../shared/theme-presets` |
| `themes/color.ts` | `apps/desktop/src/themes/color.ts` | 0.21.6 | import path `@hermes/shared/color` -> `../shared/color` |
| `themes/skin.ts` | `apps/desktop/src/themes/skin.ts` | 0.21.6 | import paths `@hermes/shared/color` -> `../shared/color` and `@hermes/shared/skin` -> `../shared/skin` |

`shared/json-rpc-gateway.ts` stays at the old pin until the app answers the server-to-client requests that Hermes v0.21.6 sends for approvals and questions (Task 5b on this branch).

Protocol constants, rechecked at v0.21.6 (not copied as code; unchanged since 0.21.2):

- `tools/bot_mode_probe.py::BOT_CHAT_TITLE = "Bot Chat"`
- `hermes_cli/dashboard_auth/ws_tickets.py::TTL_SECONDS = 30`
- `hermes_cli/web_server.py::_SESSION_HEADER_NAME = "X-Hermes-Session-Token"`
- `tui_gateway/ws.py::_TOKEN_COALESCE_S = 0.033`

Re-verify every file and constant against the backend on each Hermes upgrade (docs/06 section 7).
