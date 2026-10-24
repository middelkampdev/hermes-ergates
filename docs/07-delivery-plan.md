# 07 - Delivery Plan

Version: 0.4. Date: 2026-09-13. Team assumption: one developer, initially 20 focused engineering hours/week. Dates are not commitments. Code, deployment and live evidence have not yet been produced.

## 1. Phase 0 - Prove the foundations

Start with a 3–5 person-day feasibility pass, included in the estimate below. Resolve native auth/cookies, tool revocation, sandbox file transfer, integration hook/auth registration, and a locked-iPhone notification from a server event. Record unsupported hooks as scoped upstream work; do not advance dependent features on mock-only evidence.

Deliverables:

1. A validated server configuration on the test server (Ergates ships no deployment, ADR-046; settings in 03 section 9 and 04 section 7): pinned build, private port, working Docker access for both controllers, verified workspace paths, air-gapped shells, outbound limits, explicit gateway profile multiplexing.
2. Expo development build with the Hermes client and palette sources vendored at the pin behind the `GatewayPort` contract and its real native adapter (03 section 3.1); basic auth, fresh socket tickets, secure credential handling and no automatic mutation retries.
3. One chat screen in the clean layout and Nous System appearance: streaming, image byte attachment, approval/clarify cards, replay/history recovery and uncertain-send state. Streaming, replay and delivery state come from the pure session reducer, not from screen code.
4. Two profiles and one ordinary reminder on each, proving that a specialist's cron store is actually scheduled. Verify cron/interactive concurrency and credential isolation under the chosen processes.
5. Attention integration spike: approval-created event while the app is closed → private ntfy → locked iPhone → correct authenticated chat; iOS upstream and Tailscale behavior recorded.
6. Sanitized real fixtures and a fake `GatewayPort` adapter that passes the same chat, replay and uncertain-send scenarios as the real adapter; the backup and restore steps used on the test server, recorded with the P0 evidence; restore onto empty storage and repeat the core smoke checks.

Exit: the P0 gates in [11](11-implementation-readiness.md) pass with recorded evidence. A missing integration hook or permission-enforcement path produces an implementation decision and revised estimate, not a silently dropped requirement.

## 2. Phase 1 - Team on the phone

1. Home roster with pinned agents, name/role previews, focused roster search and compact New Agent menu. Sections such as Prive use a small grey name and a tap-to-collapse/expand chevron. Pin state and section membership remain independent: Linh and Kevin can belong to Prive while pinned above it, and unpinning either returns their row to Prive without reassignment. Persist membership, pins and collapsed state across relaunch; collapsing Prive leaves pinned avatars visible (FR-13D, 10). Bot action menus include unread, pins, sections, Hide/recovery and More > Copy ID/Delete; deletion includes verified cleanup/recovery.
2. Concierge typed proposals, explicit user acceptance, journaled specialist provisioning with narrow credentials/tools, canonical Bot Chat and briefing recovery. Self-description/avatar changes use validated actions.
3. Agent collaboration and event attribution in each Bot Chat; kanban tools and work-recording protocol enabled for both concierge and specialists. The board UI is P2.
4. Ordinary routines with explicit timezone/next run, lifecycle, history and concurrency-safe creation. Measure scheduling and delivery separately; precise short timers remain deferred.
5. Production attention bridge and ntfy deep links, subscription preferences, retry/expiry/dedup handling and generic previews. Raising an approval timeout alone does not satisfy push delivery.
6. Connector catalog/details, OAuth handoff and result polling, tool include/exclude settings, effective-state revocation UX. Configure Outlook read/draft and ClickUp with reviewed scopes; send/pay/delete remain excluded.
7. Document/zip intake, verified sandbox transfer, artifact cards, HEIC conversion and workspace browsing; voice with on-device/remote-processing disclosure.
8. Grouped Settings and agent details, mobile Edit Bot with desktop-equivalent fields and Save/Cancel, conflict/partial-save recovery, memory view, staged skills/tools, measured usage, appearance/theme, haptics and accessible error states.

Exit: all eight MVP criteria in [01](01-vision-and-scope.md#8-success-criteria-for-phase-1-mvp), corresponding matrix gates in 11, and visual acceptance in 10. Run the reminder timing batch and report actual results; do not label provider acceptance as phone delivery.

## 3. Phase 2 - Collaboration and native push

Same-gateway rooms (2–6 Bots), merged exchange view, conversation-content search/quote reply, kanban UI, template export/import and bot duplication with reviewed configuration and secret/memory controls, multi-gateway connection registry, and native Expo notification transport/actions. Prove authenticated action handling and request expiry before shipping Allow/Deny from a notification. Add webhooks and optional Telegram only with their own acceptance flows. Cross-person access is still P3.

## 4. Phase 3 - Beyond personal use

Proceed when needed: public TLS exposure, OAuth/OIDC native handoff, separate user gateways, reviewed room-sharing authorization and cross-gateway relay/liveness, provider agreements/billing, and audit/retention requirements. A second gateway does not by itself establish business roles or unattended shared rooms. Multi-tenant roles inside one gateway stay out of scope.

## 5. Effort and capacity

The previous 54-person-day plan over 11 calendar weeks assumed almost full-time capacity despite being labeled part-time. It also omitted integration work now explicit in 11. The following ranges are planning allowances, to be revised after P0 evidence. One person-day means eight focused engineering hours; meetings, vendor waits and app distribution delays are additional.

| Phase | Included work | Person-days | Calendar weeks at 2.5 days/week |
|---|---|---|---|
| 0 | Feasibility gates, deployment/auth, chat/theme skeleton, fixtures and restore | 16–22 | 6.4–8.8 |
| 1 | Agent lifecycle/integration, mobile editor/actions, connectors/permissions, routines/push, files/voice, polish | 28–40 | 11.2–16.0 |
| 2 | Rooms/board/templates/search, multi-gateway, Expo transport/actions | 14–20 | 5.6–8.0 |
| 3 | Public/native auth, cross-person sharing and operational requirements | 8–12 | 3.2–4.8 |
| Total | All phases | 66–94 | 26.4–37.6 |

P0–P1 is 44–62 person-days, approximately 18–25 calendar weeks at this assumed capacity. Calculate any new schedule as effort / actual available engineering days per week. Do not attach calendar dates until availability and P0 feasibility are known. These ranges are estimates, not measured productivity or a promise to build all later phases.

## 6. Current defaults and remaining choices

| Item | Working decision | Status |
|---|---|---|
| Name | Ergates | Working name; no need to block technical work on branding |
| Design | Supplied mobile layouts + Hermes theme system, Nous default, System appearance | Explicit user direction, 2026-09-12 |
| Backend/client | Pinned Hermes + Expo React Native | Current architecture |
| App code shape | Feature modules behind one gateway port; TanStack Query for Hermes data, Zustand for device data, pure session reducer for live events | ADR-029, explicit user direction, 2026-09-13 |
| Model credentials | API-key path as engineering default; account/provider selected during setup | Actual provider/budget remains an operator choice; no purchase implied |
| Private access | Basic provider over Tailscale, native cookie/ticket adapter | P0 integration gate |
| Creation by chat | Typed proposal plus authenticated integration provisioning | Specified in 11; supersedes client-card-only assumption |
| Push | ntfy with attention bridge/deep links/iOS upstream; Expo in P2 | P0 feasibility and P1 release gate |
| Reminder precision | Ordinary reminders with measured latency; sub-minute/5-second precision deferred | Corrected scope; revisit separately if required |
| Capacity | 20 engineering hours/week | Planning assumption; recalculate from actual availability |

## 7. Risks and mitigations

| Risk | Response |
|---|---|
| Internal RPC drift | Pin backend/client/theme together; run old behavior scenarios on new backend before accepting new fixtures |
| Native networking/auth surprises | Real development builds in P0; cookie jar, secure cookie, certificate and tailnet tests |
| Integration lifecycle hooks unavailable | Early proof; scoped upstream change and explicit schedule impact |
| Permission revocation not immediate | Stop/rebuild/verify gate; pending state until enforcement confirmed |
| iOS push misses or slow cron | Locked-phone tests, durable delivery state, separate latency measurements, no precise-timer promise |
| Files invisible in sibling Docker container | Explicit host/container mount mapping and round-trip artifact test |
| Scope grows into desktop/admin parity | Preserve simple Home/Chat; advanced details secondary; phase gates |
| Vendor entitlement or terms change | Recheck before enabling path; test alternate provider configuration |
| Part-time capacity | Effort ranges and capacity-based schedule; P2/P3 optional |

## 8. Definition of done

A feature has correct behavior, a focused client check where useful, the relevant real-backend/device acceptance gate, updated contracts and documentation, and a clear failure/recovery state. A change that reads or writes Hermes data goes through the gateway port; a change that needs a native capability adds or extends an adapter together with its fake (ADR-029). Sensitive data is absent from logs/fixtures. Validate phone-facing changes on the target iPhone and Android, in both Nous appearances and large text. Use tests for meaningful behavior rather than mandatory implementation-mirroring tests for every screen. Record what was actually run; unexecuted checks remain pending.
