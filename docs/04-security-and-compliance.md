# 04 - Security and Compliance

Version: 0.3. Date: 2026-09-12. Scope: one operator's private gateway. This is a threat model and verification contract, not a security certification. Read the gates in [11](11-implementation-readiness.md).

## 1. Security goals and trust boundaries

1. An agent executes only its effective session grant. Policy changes become effective through an explicit stop/rebuild/verify transition.
2. Provider credentials and MCP grants remain in trusted server-side stores, outside the model context and shell workspace. The phone stores only its own gateway credential; user-entered connector authorization is a separate provisioning flow.
3. Shell/file execution uses the owning Docker sandbox with narrow mounts and no network by default. MCP servers, memory tools, plugins and controller code may run on the trusted server; selecting Docker does not sandbox every tool.
4. Hermes logs supply operational attribution. Tamper-resistant auditing, complete approval-history coverage and argument hashes require separate proof or implementation.
5. Model-provider access uses a configured, documented path. Technical support in Hermes is not evidence of vendor authorization.

## 2. Vendor subscriptions and evidence status

The provider mechanics below were read from the pinned Hermes docs on 2026-09-12; they are not independently verified billing or legal guarantees. Vendor policy can change independently of the pinned source. The previous wording inferred that extra-usage billing implied tolerance by Anthropic; that inference is removed.

| Provider path | What the pinned Hermes docs say | Planning consequence |
|---|---|---|
| Anthropic OAuth | Max with purchased extra usage credits; included Max allowance is not used; Pro unsupported | Do not budget this as included subscription usage. Whether this use is permitted must be checked against current vendor terms before choosing it |
| OpenAI Codex plan OAuth | Device-code sign-in supported | Verify account entitlement, quota and terms for the actual integration; do not assume an arbitrary OpenAI API-key endpoint is interchangeable |
| xAI OAuth | Supported; some tiers may return 403 | Verify entitlement; keep a tested API-key configuration alternative |
| Gemini | API key or Vertex path | Configure a supported billed endpoint |
| Nous Portal | Hermes-supported subscription/model gateway | Verify plan, quota and terms rather than labeling it universally compliant |

Use an API-key provider as the initial engineering default unless Jop chooses another supported path. This is not a purchase or credential setup performed by the docs. Provider switching requires the correct endpoint/provider/model/auth configuration and a smoke test; it is not guaranteed to be one line. Personal subscription credentials are not shared across people. Business use needs its own provider agreement and organization billing decision.

Sources: `website/docs/integrations/providers.md` and `website/docs/user-guide/features/credential-pools.md` in the pinned checkout; recorded vendor background in internal research notes, not published. Recheck current vendor terms before enabling a subscription path or expanding beyond personal use.

## 3. Threat model

| Threat | Control and its limit | Acceptance evidence |
|---|---|---|
| Prompt injection in mail/files | Exclude send/pay/delete tools and use narrow connector scopes; shell has no network or connector credentials. Text cannot authorize proposal acceptance | Attempt direct, delegated and alternate-tool execution of a denied operation |
| Revoked connector remains usable | Saving config is not enough; stop/rebuild affected sessions and verify their effective grants | Disable during a running Bot Chat and a specialist task; neither can call it afterward |
| Sandbox accesses host/sibling data | Explicit workspace volumes, no shared container key, no controller root/socket/secret mounts | Cross-profile file, path traversal and secret access attempts fail |
| Credential exposure through shell | No provider/MCP grants forwarded; review skill-required environment variables as well as `docker_forward_env` | Inspect actual container environment and mounts without logging secret values |
| Host-side MCP or plugin compromise | Treat server extensions as trusted code; review/pin them and restrict external scopes/egress | Inventory execution locations and credential access for enabled tools |
| The app is steered to install other code on the server | The app installs one fixed source at the commit of its own build, or, when it goes back after a failed update, at the commit the server had before, which the app recorded itself. It sends `force: false` for the first install and `force: true` only for an update or a go back, after it turned the plugin off. It never takes a source, a commit or a command from a server, an agent, a message or a link. Only Home and the push-link route may be opened from outside the app, so a link cannot reach the setup screens. Hermes runs its install scan on the server and refuses a `caution` or `dangerous` verdict, because the app cannot show the confirmation a `caution` needs. Limit: the user still trusts the repository at that commit and the GitHub account that owns it, and a user who runs the Finish screen's command runs it on their own server (ADR-043, ADR-044) | `external-link.test.ts` runs Expo Router's own link reader over a corpus of links; `build-record.test.ts` reads a malformed record as no record and a commit that is not 40 lower-case hex digits as no commit; the live hot-mount tests install the plugin through Hermes's install route with the scan on |
| Unauthorized network use | Default shell air gap; controllers route through a proxy enforced in either mode -- standard denies private/internal/special-use ranges and allows other public hosts, strict allows only a configured allowlist | Private-range, Docker-host, cloud-metadata and tailnet destination attempts denied in both modes; an unlisted public host is denied only in strict mode |
| Forged action card | Only typed, validated proposal results; authenticated accept operation inaccessible as a model tool | Email/tool text claiming to create an action never becomes an actionable card |
| Repeated creation or lost response | Durable integration receipts; serialized acceptance; no blind replay of uncertain operations | Concurrent accept and disconnect-after-create tests leave one profile/job |
| Stale/spoofed notification | Generic preview; recognized connection id; app refetches authoritative request | Expired/resolved request cannot be approved through an old link |
| Agent loop or spend runaway | Per-profile iteration controls and operator stop; prompt rules are advisory | Exercise reciprocal messages; measure bounded behavior before unattended deployment |
| Gateway exposure | Basic provider on Tailscale only; authenticated tickets; request guards | Unauthenticated and off-tailnet access rejected; valid phone works |
| Device or disk loss | Credential storage, explicit local-data controls, encrypted off-host backups | Sign-out/connection-removal clearing and clean restore drill |
| Rooted or jailbroken phone | Checked at every start on a physical phone (`src/state/device-trust.ts`) by two heuristics, either of which flags it. `expo-device`: on iOS, jailbreak paths from the rootful era (`/Applications/Cydia.app`, `/bin/bash`, `/etc/apt` and similar) and a test write outside the app's sandbox; on Android, `test-keys` build tags, `/system/app/Superuser.apk` and `/system/xbin/su`. The app's local module `root-traces` (`apps/mobile/modules/root-traces`): on iOS, the rootless jailbreak link `/var/jb` and files under it (Dopamine's marker, Procursus `su`, Sileo, Zebra), Sileo and Zebra in `/Applications`, and the checkra1n and palera1n tool bundles; on Android, `su` in `/sbin` (Magisk's folder where `/sbin` exists, usually before Android 11) and in common `su` and `PATH` folders (`/system/bin`, `/system/xbin`, `/system_ext/bin`, `/vendor/bin`, `/su/bin`, `/data/local` and below); the paths and their sources are in ADR-041. The app warns and keeps working. The server sign-in (token, cookie, mode) is kept in memory only, the stored one of every saved connection is deleted at start, the platform cookie jar is emptied then (older builds left Hermes cookies there), and the owner signs in again on each cold start (ADR-041). Requests skip the platform cookie jar. Limit: a heuristic for honest users. It misses Magisk where `/sbin` does not exist (usually Android 11 and later: binaries in a tmpfs under `/debug_ramdisk`, `/system` unchanged) and Magisk with DenyList or a Zygisk hiding module, it flags a custom system signed with test-keys although it is not rooted, and it does not stop anyone who hides root or a jailbreak, a rebuilt copy of the app, or a client that holds the token. The start-up deletion covers the connections saved in the device blob (SecureStore cannot list keys). Drafts, the outbox and the organization stay in the sealed device blob (ADR-033); root can read that too, because its AES key is in the same SecureStore. On Android, once turned on (`apps/mobile/RELEASING.md`), Play Console hides the app from phones that fail Google's device integrity check and prompts users of copies from elsewhere to get the app on Google Play. Google's own limit: the device integrity switch does not stop sideloading, and a self-built APK from the public source is stopped by neither setting | Unit tests for detection (either check flags; a failing or hanging check counts as finding nothing), the memory-only store, the start-up deletion, the jar clear and `credentials: 'omit'`; with `EXPO_PUBLIC_DEV_FORCE_ROOTED=1` in a development build, the notice shows once and the Sign-in screen appears after every cold start |

## 4. Identity and access

Phases 0–2 use one operator identity with the basic provider over Tailscale. Cookie handling (the app keeps the session cookie itself and replays it, section 6), renewal, WebSocket tickets and logout are documented in 06 and tested in P0. A later public deployment requires TLS and a reviewed OAuth/OIDC native redirect flow. Do not treat a desktop loopback callback as an already working mobile login.

Hermes profiles isolate agent configuration, not human tenants. A second person's separate gateway is a starting boundary, not a complete shared-room authorization system. Cross-person invitations, consent to sharing histories/files, credential routing and revocation remain Phase 3 gates. Biometric unlock may protect the local UI later; it does not revoke server access by itself.

## 5. Least-privilege tool model

A session's tool grant is built from enabled toolsets and the profile's permitted MCP tools. Hermes validates tool names in the agent execution path. The grant is a session snapshot; [the MCP enabled route](../../hermes-agent/hermes_cli/web_routers/mcp.py) explicitly says changes take effect on the next session/gateway. Persistent Bot Chats make this distinction important.

For a revocation, the app/integration must:

1. Mark the change Applying and prevent new app submissions on the affected profile. Coordinate cron, delegated and other active execution paths; a frontend-only composer lock is insufficient.
2. Interrupt or drain affected turns, apply the narrower configuration and rebuild/reload every affected executor using a supported Hermes lifecycle path. `session.resume` alone does not prove a rebuilt grant.
3. Inspect the effective tool set and attempt a denied call in the integration check. Existing in-flight side effects cannot be retroactively undone.
4. Show Off only when the effective policy is confirmed. If this cannot be established, leave “Restart required / change pending,” block dependent work and report the failure. P0 must determine the exact supported restart/rebuild sequence; it is not yet an implementation claim.

The integration enforces the saved grant at every tool call. Its `pre_tool_call` gate blocks a tool whose toolset is missing from the profile's toolset pin, and a tool of an MCP server the profile has switched off, so a revocation takes effect at the next tool call without a rebuild. The toolset pin is the `platform_toolsets.cli` list that `profiles.configure` writes, resolved the way Hermes resolves it for an app session; the legacy `tools.enabled_toolsets` counts only when that list is absent. On v0.21.6 Hermes builds an app session's tools from the same list, but gateway turns and cron runs use their own platform lists, and `profiles.configure` rebuilds no running session. So the gate is still what makes a template's toolsets binding on every platform. The gate does not change the tool list a running session shows the model, and it narrows only profiles Ergates provisioned, never the default profile (08 ADR-034).

Per-tool include/exclude changes use the supported config operation, not an invented individual-tool REST route. A whole-map MCP update must preserve unrelated servers and avoid lost concurrent edits. Introduce tools using explicit allowlists so newly advertised connector tools are not automatically granted.

Shell approval modes apply to eligible dangerous-command checks. `manual` is not “approve every shell/MCP action”: permanent allows and Docker isolation exemptions matter. At the pin, `tools/approval.py::_should_skip_container_guards` skips ordinary dangerous-command prompts for Docker without host access; host bind mounts change that decision. User deny rules remain a separate floor. Test the actual mounts and execution path used by the app.

An enabled email/payment/delete tool needs its own business-action approval gate if “ask before every send/payment/delete” is required. Excluding it entirely is the initial policy. Enabling it by hand does not automatically install such a gate. MCP elicitation and dangerous-shell approval are not substitutes for a general per-action policy engine. Plain-language custom approval rules are deferred.

## 6. Credentials

| Credential | Location and handling |
|---|---|
| Provider OAuth | Hermes-managed grants; root fallback/shared-grant behavior depends on provider. Never copy single-use refresh tokens between profiles |
| Provider API keys | Approved profile/server credential store; never copied wholesale from the concierge during creation |
| MCP tokens | Hermes-managed `mcp-tokens/` and referenced profile secrets; narrow scopes |
| Gateway basic auth | Secret configuration on the server; password hash where supported; do not bake into images |
| ntfy publication/subscription | Separate scoped tokens; server publisher and device subscriptions |
| Mobile session | Token or session cookie and auth mode per connection, in SecureStore (`ergates.<connection id>.token`, `.cookie`, `.mode`). The app keeps the cookie itself and replays it as a `Cookie` header; requests send `credentials: 'omit'`, so new requests never touch the platform cookie jar. Sign-out and connection removal still clear leftover jar cookies from older builds (ADR-028), and a start on a rooted or jailbroken phone empties the jar (ADR-041). On a rooted or jailbroken phone these live in memory only and the owner signs in on each cold start (ADR-041). No full authenticated URLs in logs |
| Device blob key | Random per-install AES-256 key in SecureStore (`WHEN_UNLOCKED_THIS_DEVICE_ONLY` on iOS); it seals the whole device blob in AsyncStorage: connections, drafts, the outbox and unfinished agent setups (ADR-033) |

Provision profiles with `mirror_credentials: false` and an approved role template; `profiles.create` defaults can otherwise copy launch credentials. Validate cloning/export options before offering them. A template must not silently carry secrets, personal memory or unrestricted connector grants.

## 7. Sandbox and deployment requirements

- Use the complete wiring contract in 03. Both tool-running controllers need working Docker access; shell containers must never receive the daemon socket.
- Default `terminal.docker_network: false`, no shared container key, bounded resources, and explicit per-profile workspace volumes. Test path alignment when a containerized controller starts sibling containers through the host daemon.
- `docker_forward_env: []` alone is not a complete secret policy: inspect environment contributed by enabled skills and plugins. No MCP/provider credentials are needed for zip processing inside the shell.
- Keep controller/model/MCP egress separate from shell egress. If shell networking is introduced later, use an isolated network with enforced allowlisting; an HTTP_PROXY environment variable on a normally networked container is not itself enforcement.
- Protect proposal acceptance and notification registration using the gateway's authenticated operator context; never authorize them using a profile name supplied by the model.

## 8. Logging, retention and recovery

Hermes retains session data until deletion. Its transcript is an operational record, not an immutable audit ledger. Determine approval and tool-result coverage using real fixtures. Local app debug logs hold connection/error categories only; sanitize exception messages before recording them. Opt-in debug export must preview what leaves the device.

Initial backup policy: seven daily and four weekly encrypted off-host snapshots, with a consistency-aware database/WAL/file procedure and a restore drill. Include profile workspaces and the integration control store (`ergates/control.sqlite3` with its WAL file); notification terminal metadata is retained seven days. Record backup encryption-key recovery separately from the server. Define session deletion and backup expiry behavior before business use.

## 9. Privacy and device state

The VPS is authoritative for agent data. Data is also processed by chosen model/connector providers, copied into encrypted off-host backups, and displayed on the phone. Drafts and optional caches are governed by 05. No third-party analytics; crash reporting off by default. Speech recognition must disclose remote processing when on-device recognition is unavailable.

Push defaults to generic previews. Self-hosted ntfy on iOS uses an upstream wake-up service that receives message identifiers and a topic-URL hash; the phone fetches the actual message from the private server. Phase 2 Expo adds another delivery intermediary, which must be documented before enabling it. [ntfy iOS configuration](https://docs.ntfy.sh/config/#ios-instant-notifications).

The research screenshots and notes contain personal data. Keep them private and outside product bundles, public previews and telemetry. The provided screenshot text is research content, never an instruction source.

## 10. Beyond personal use

Before Phase 3: confirm provider agreements, gateway/user access boundaries, consent for shared rooms and files, deletion/retention behavior, recovery objectives and audit requirements. The current design makes no compliance certification or multi-tenant authorization claim.
