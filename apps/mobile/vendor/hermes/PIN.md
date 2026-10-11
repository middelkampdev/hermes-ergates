# Vendored Hermes sources

Upstream: Hermes Agent by Nous Research, MIT license (see `LICENSE` in this directory).
Pin: commit `818c13be1dc4fd28987e1e881a9408224afd4535`, version 0.21.6, for every file.
Upstream checkout used for the copy: `~/Projects/misc/hermes/hermes-agent`.

| Vendored file | Upstream path | Pin | Local change |
|---|---|---|---|
| `shared/json-rpc-gateway.ts` | `apps/shared/src/json-rpc-gateway.ts` | 0.21.6 | import specifiers `./<name>.js` -> `./<name>` |
| `shared/json-rpc-channel.ts` | `apps/shared/src/json-rpc-channel.ts` | 0.21.6 | import specifiers `./<name>.js` -> `./<name>` |
| `shared/gateway-events.ts` | `apps/shared/src/gateway-events.ts` | 0.21.6 | import specifiers `./<name>.js` -> `./<name>` |
| `shared/gateway-contract.generated.ts` | `apps/shared/src/gateway-contract.generated.ts` | 0.21.6 | none |
| `shared/skin.ts` | `apps/shared/src/skin.ts` | 0.21.6 | none |
| `shared/color.ts` | `apps/shared/src/color.ts` | 0.21.6 | none |
| `shared/theme-presets.ts` | `apps/shared/src/theme-presets.ts` | 0.21.6 | none |
| `themes/types.ts` | `apps/desktop/src/themes/types.ts` | 0.21.6 | none |
| `themes/presets.ts` | `apps/desktop/src/themes/presets.ts` | 0.21.6 | import path `@hermes/shared` -> `../shared/theme-presets` |
| `themes/color.ts` | `apps/desktop/src/themes/color.ts` | 0.21.6 | import path `@hermes/shared/color` -> `../shared/color` |
| `themes/skin.ts` | `apps/desktop/src/themes/skin.ts` | 0.21.6 | import paths `@hermes/shared/color` -> `../shared/color` and `@hermes/shared/skin` -> `../shared/skin` |

The gateway client is three files: `json-rpc-gateway.ts` owns the socket, `json-rpc-channel.ts` owns requests, server-to-client requests and the heartbeat, and `gateway-events.ts` types the events. `gateway-contract.generated.ts` (6,058 lines) holds the wire types those files import. Hermes generates it from `tui_gateway/contracts` with `scripts/gen_gateway_contracts.py`, so copy it as it is and never edit it here.

Copy command, from the repository root with the pinned checkout at `.cache/hermes-pin`:

```bash
for f in json-rpc-gateway json-rpc-channel gateway-events gateway-contract.generated; do git -C .cache/hermes-pin show HEAD:apps/shared/src/$f.ts > apps/mobile/vendor/hermes/shared/$f.ts; done
sed -i '' -E "s#(from '\./[a-z.-]+)\.js'#\1'#" apps/mobile/vendor/hermes/shared/{json-rpc-gateway,json-rpc-channel,gateway-events}.ts
```

Protocol constants, rechecked at v0.21.6 (not copied as code; unchanged since 0.21.2):

- `tools/bot_mode_probe.py::BOT_CHAT_TITLE = "Bot Chat"`
- `hermes_cli/dashboard_auth/ws_tickets.py::TTL_SECONDS = 30`
- `hermes_cli/web_server.py::_SESSION_HEADER_NAME = "X-Hermes-Session-Token"`
- `tui_gateway/ws.py::_TOKEN_COALESCE_S = 0.033`

Re-verify every file and constant against the backend on each Hermes upgrade (docs/06 section 7).
