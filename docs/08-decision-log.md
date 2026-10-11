# 08 - Architecture Decision Log

Updated 2026-09-12 after Jop requested corrections and supplied mobile references; ADR-029 (app code shape) added 2026-09-13. These are current design decisions, not claims of implementation or approval of purchases/deployment. Unverified extension mechanisms are gates in 11. Earlier own-platform records ADR-001–016 belong to the dropped design and are kept in the maintainer's private project notes; do not build from them.

## ADR-017 Hermes owns the backend domain

Hermes supplies the agent loop, sessions, memory, profiles, tools, cron and rooms. Build the mobile app and deployment against its supported client surfaces. Keep no independent agent runtime, domain database, memory index or general API facade. Amended by ADR-025: narrowly scoped integration state and extension endpoints are necessary for product behavior Hermes does not already supply.

## ADR-018 React Native over the Hermes client protocol

Use Expo development builds and the pinned JSON-RPC client plus REST. Native HTTP/cookies, sockets, image transfer and persistence are adapters with P0 checks. The OpenAI-compatible API server is a separate optional automation path; its run-idempotency guarantees do not apply to mobile `prompt.submit`. The mobile app has no web/desktop-client deliverable.

## ADR-019 One assistant is one Hermes profile

Use `ui_meta`, assets, `SOUL.md`, canonical `BOT_CHAT_TITLE` sessions and Bot Mode messaging conventions. Enable kanban work tracking in P1, its UI in P2. Agent creation by chat needs the typed proposal and safe provisioning path in 11. Same-gateway room limits are not global Bot-message hop/spend limits; cross-gateway relay and human sharing need separate proof.

## ADR-020 Model access is a per-profile provider setting

Select from the pinned backend's configured provider/model options. API-key access is the initial engineering default until the operator supplies a chosen account. Keep provider entitlement/billing/terms distinct from source-level technical support. Do not claim changing auth paths is always one line. Do not hardcode unverified model ids in role defaults; use available options and validate the selected model.

## ADR-021 Effective grants and conditional approvals

Hermes owns session tool grants; MCP config saves may be deferred. A revocation must stop/drain affected work, narrow configuration, rebuild execution contexts and verify the result before the UI says Off. Shell `manual` approval is conditional and is not a universal MCP action gate. Send/pay/delete remain excluded until explicit tool-specific approval semantics are implemented. Plain-language custom policy rules are deferred. Details in 04.

## ADR-022 Sandboxes are air-gapped by default

Use one Docker shell workspace per profile, narrow verified mounts, resource limits and no shared container key. Both trusted tool-running controllers need Docker access; shell sandboxes get neither the daemon socket nor connector/provider grants. Host-side MCP/plugin execution is a separate boundary. Controllers use enforced outbound allowlisting; networked shells require a later explicit design. Deployment is accepted only after actual mount/network tests, not from a sketch.

## ADR-023 Push needs a server attention bridge

P1 uses private ntfy; P2 adds Expo transport. Both rely on the integration event source and durable delivery records. Stock ntfy publication does not subscribe to mobile-chat approval events or supply chat deep links. Implement those, configure iOS upstream wake-up, and prove locked-phone delivery in P0/P1. Approval timeout is a pending-window setting, not a notification mechanism.

## ADR-024 Private auth first

Use the basic provider over Tailscale through JSON password login, a tested cookie adapter and short-lived WebSocket tickets. Later public access uses TLS plus OAuth/OIDC and a verified native redirect flow; desktop loopback support is not mobile compatibility. Keep no public service listener in P0–P2.

## ADR-025 Small Ergates integration package

The previous app/config-only assumption did not cover typed creation actions, failure-safe provisioning, reminder deduplication or server-to-phone attention. Define these as new extension work with small atomic file journals and authenticated operator operations in 11. Prefer supported external plugin hooks; prove event-source and authenticated-route registration in P0. If absent, scope the upstream extension explicitly. Never give agents the authenticated accept operation or control-plane credentials. This amends ADR-017, 019 and 023 without creating a second agent runtime. Amended by ADR-030: one transactional SQLite control store replaces the file journals.

## ADR-026 Mobile layout from references, colors from Hermes

Jop explicitly requested the clean iPhone style shown in nine screenshots. Adopt flat Home rows, optional pinned avatars, compact chat controls, rounded bubbles/composer and grouped settings sheets. Use Hermes `DesktopThemeColors`, Nous light/dark palettes and `HermesSkin` conversion/resolution. Appearance defaults to System. Mobile includes desktop-equivalent Edit Bot with Save/Cancel, partial-save recovery, and compact context menus/More as explicitly requested. Friendly name and role badge have separate metadata mappings. Detailed tokens, native geometry, states and visual acceptance live in 10; screenshot colors and vendor branding are not product tokens.

2026-09-13 clarification (tenth mobile reference): Home sections such as Prive use small grey text and a collapse/expand chevron. Pin state is independent of membership: Linh and Kevin remain Prive members while pinned above it, and unpinning returns them to Prive. Persist both properties and section collapse state; collapsing a section does not hide pinned members. FR-13D and 10 define the Phase 1 acceptance cases.

## ADR-027 Honest reminder and offline-delivery semantics

The pinned cron ticker defaults to 60 seconds. P1 ordinary reminders target measured job start within 90 seconds on a healthy idle server, with phone delivery measured separately. Sub-minute/five-second precision is deferred. Client request ids do not establish durable exactly-once submission: uncertain sends require reconciliation and deliberate retry. Custom proposal/job-create retries use integration receipts, not text matching.

## ADR-028 Explicit local data and capacity

Authoritative history remains on the VPS; encrypted off-host backups, device drafts and optional caches are documented in 05. Default history caching is memory-only; connection removal clears account data and warns about unsent work. The schedule is derived from effort and actual engineering availability; 07 replaces the earlier part-time label paired with effectively full-time dates.

## ADR-029 App code shape: feature modules behind one gateway port

Decided 2026-09-13 after Jop chose this option over full Clean Architecture and a flat screens/hooks/services layout. The app is organized as feature modules with a ports-and-adapters boundary at the Hermes edge and a strict split between server-owned and device-owned state. Details, the port contract and the state table are in [03 section 3.1](03-technical-design.md#31-code-architecture-rules-adr-029).

Rules:

1. Dependencies point inward. `app/` screens import features; features import the gateway port, the Query cache and the device store. The port contract, the pure session reducer and `vendor/hermes` import no React Native or Expo module.
2. One home per data item. Hermes-owned data (profiles, sessions, history, routines, config, pending requests) lives only in the TanStack Query cache. Device-owned data from 05 (connections, pins, sections, collapsed state, watermarks, drafts) lives only in the Zustand store. Nothing is copied between the two.
3. Live socket events pass through one pure reducer per session. It produces the rendered message list, the replay watermark and the delivery states. The fake gateway drives the same reducer as the real adapter.
4. Every native capability (HTTP/cookies, WebSocket tickets, secure storage, file transfer, speech, notification registration) is a small interface with one real adapter and one fake. P0 gates run the real adapter; client behavior tests run the fake.

Rejected: full Clean Architecture (domain, use-case and infrastructure layers with injection), because Hermes owns the domain and the app has little domain logic to isolate. Rejected: flat screens/hooks/services, because streaming, replay and uncertain-send handling do not survive being spread across screens. Zustand is the working choice for the device store because it is the smallest option; it is not itself a P0 gate. Package versions remain locked in P0 per 03.

## ADR-030 One transactional control store for the integration

Decided 2026-09-25 with the Fable upgrade roadmap. The integration keeps every record -- reminder and proposal receipts, attention events, their push outbox and attention preferences -- in one SQLite file, `<hermes root>/ergates/control.sqlite3`, shared by every profile and process of the install. Writes use `BEGIN IMMEDIATE`; every receipt change is a versioned compare-and-set; an attention event and its outbox row commit in one transaction; the schema is versioned with `PRAGMA user_version`. The store keeps identifiers and sha256 hashes, never prompt, command, briefing or description text. Hermes databases are never written.

Rejected: the per-kind JSON file journals of ADR-025, because a lock per directory could not make a check and a write atomic: two concurrent reminder retries could create two cron jobs, the retention sweep could delete a receipt that had just been claimed again, and a crash during the first push lost it. The old journals are not migrated; they were never installed on a live gateway. This amends ADR-025.

## ADR-031 Integration operations are routes of the Hermes dashboard

Decided 2026-09-25 with the Fable upgrade roadmap. The operations the app calls -- reminder create, proposal accept, reject and provisioning steps, plugin enable, attention preferences, health -- are routes of the plugin's dashboard API router, which `hermes serve` mounts under `/api/plugins/ergates` from `integrations/ergates/dashboard/manifest.json`. Hermes's own middleware authenticates every request before a route runs: the dashboard session token on loopback, the cookie gate when dashboard auth is on. A contract test runs the pinned Hermes web server and shows a request without the token is refused on every route. This settles the "registration/auth mechanism" gate of 11 section 4.1 without a Hermes patch.

Rejected: a separate Ergates HTTP service, because it would need its own listener, auth and TLS next to `hermes serve`, and a second credential on the phone.

## ADR-032 App-orchestrated provisioning with server receipts

Decided 2026-09-25 with the Fable upgrade roadmap. After the operator accepts a proposal, the app performs the provisioning steps through the public Hermes RPCs it already uses -- `profiles.create` with `mirror_credentials: false`, `profiles.configure` from the server's template, `session.create` for the Bot Chat, `prompt.submit` for the briefing -- and reports each step to the integration, which records it on the proposal receipt in order. The integration performs only the step the app cannot: it links the plugin into the new profile and enables it there. It marks the proposal `complete` only after Hermes itself reports that the profile exists and would load the plugin in it. Until then the plugin's `pre_tool_call` gate blocks every tool of that profile, so no turn runs under an unreviewed grant.

This deviates from 11 section 4.1, which had the integration drive the profile operations itself. The integration would then call Hermes's profile and session internals from inside a plugin, which no public plugin surface offers; the app already has an authenticated, public path to every one of those operations. Rejected for the same reason: a server-side orchestrator that replays the app's RPCs. The receipt keeps resume-by-receipt: a killed app reopens at the next unreported step.

## ADR-033 The whole device blob is encrypted at rest

Decided 2026-09-25. The app keeps its device-owned data -- connections, roster organization, preferences, drafts, the outbox and unfinished agent setups -- as one JSON blob in AsyncStorage, and now seals that blob with AES-256-GCM from expo-crypto before it is written. The key is created on the first write and stored in SecureStore with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, and kept in memory once read, so a write while the phone is locked still seals. The sealing sits behind a small cipher interface (`src/state/sealed-storage.ts`); Node tests pass an AES-GCM cipher from `node:crypto`, and only `src/state/persistence.ts` imports expo-crypto. A plaintext blob from an earlier version is read once and rewritten sealed; a blob whose key is gone (a backup restored onto another phone) reads as empty; a blob that cannot be opened now is kept, not overwritten. Writes land in call order.

Rejected: encrypting only drafts and the outbox, because connections and agent setups (a proposal's briefing) are just as private and one sealed blob is simpler than two stores. Rejected: a key restored with device backups, because a backup would then carry both the ciphertext and its key.

## ADR-034 The tool gate enforces the profile's toolset grant

Decided 2026-09-25. The plugin's `pre_tool_call` gate refuses a tool whose toolset the profile's configuration no longer grants: the toolset pin `profiles.configure` writes (`tools.enabled_toolsets`, which the app sets from the role template) plus the toolset of every MCP server the profile enables. The grant is read at every tool call, so a toolset taken out of a pinned profile is refused at the next call, without a rebuilt session. At pin d76856cc Hermes builds a session's tools from `platform_toolsets` and does not apply that pin, and its MCP runtime ignores the `disabled` key `profiles.configure` writes, so without the gate a template's toolsets would describe the agent without limiting it. A profile without a pin is not narrowed, the `ergates` tools are never refused this way, and a grant that cannot be read blocks the call.

The gate refuses; it does not change the tool list a running session offers the model, so 04 section 5's rebuild still decides what the model sees. Rejected: writing `platform_toolsets` from the template, because `profiles.configure` has no such field and the app would need a config write outside the public RPCs.

## ADR-035 One egress proxy, one ingress, images pinned by digest

Decided 2026-09-25. In the Compose deployment the controllers and ntfy sit only on an internal network with no route out and no gateway address on the host (the isolated gateway mode of Docker Engine 28.0). An allowlisting Squid proxy is their one network path to the internet (HTTPS tunnels to listed hosts only; IP addresses never match), and HAProxy is the one published door, forwarding the VPS's Tailscale IP ports to `hermes serve` and ntfy as plain TCP. The proxy variables tell well-behaved clients where the proxy is; the internal network is what enforces it (04 section 7). This constrains network clients, not a compromised controller: both controllers hold the Docker socket, so code running in one can start a container outside the internal network. Every image is pinned by tag and digest, and `deploy/tests/test_static.py` checks these rules in CI.

Rejected: `HTTP_PROXY` on a normally networked container, which 04 section 7 says is not enforcement. Rejected: host firewall rules, which live outside Compose where the static checks cannot see them.

Superseded in part by [ADR-036](#adr-036-two-egress-modes-standard-by-default-strict-by-choice): the proxy now has two modes; this record's allowlist-only description is what strict mode keeps, not the default.

## ADR-036 Two egress modes: standard by default, strict by choice

Decided 2026-09-26. Open-sourcing this stack turns ADR-035's allowlist-only proxy into a broken default: a fresh install reaches nothing until the owner edits `allowed-domains.txt`, and it always breaks Hermes's `browser` toolset, which needs arbitrary websites. Standard mode is now the default: a `dst` ACL denies every private, internal and special-use address range on the IP Squid actually connects to (so a name that resolves to one is caught like a literal IP), then allows HTTP and HTTPS to any other host. That is the real risk open-sourcing exposes -- not which named public host an agent talks to, but whether it can reach the VPS's own services, the Docker host, cloud metadata or another device on the operator's tailnet; an agent tricked by a hostile page can still reach a public site either way. Strict mode keeps ADR-035's exact behavior (HTTPS to listed hosts only) for an owner who wants it. `EGRESS_MODE` in `deploy/.env` picks between them, unset meaning standard; `deploy/proxy/squid.conf` keeps the shared settings and includes a mode file Compose mounts by name, so a mistyped mode should fail `docker compose up` instead of silently running one or the other (VERIFY V3 confirms this once on the server).

Rejected: keeping allowlist-only as the default, which does not survive a fresh install or the `browser` toolset. Rejected: an application-layer allowlist of "known-safe" public hosts for standard mode, which is the same broken default with extra steps -- the point of standard mode is that it names no host at all.

## ADR-037 One app ID on both platforms: com.nousresearch.hermesergates

Decided 2026-10-10. The app's domain is `hermes-ergates.nousresearch.com`, and an app ID is the domain reversed. The hyphen cannot stay on both platforms: an iOS bundle ID allows letters, digits, hyphens and periods, and an Android application ID allows letters, digits and underscores. One ID without a separator, `com.nousresearch.hermesergates`, is valid on both, so the release workflow, the signing checks and the runbook carry a single value. It replaces `dev.ergates.mobile`, which never reached a store. The ID is permanent once the first build is uploaded: Google Play treats an upload with a new application ID as a different app.

Rejected: a different ID per platform (`com.nousresearch.hermes-ergates` on iOS, `com.nousresearch.hermes_ergates` on Android), which is closer to the domain but gives two values to keep in step everywhere the ID appears.

Superseded by [ADR-038](#adr-038-the-app-id-uses-the-publishers-own-domain-devmiddelkampergates): the one-ID reasoning stands, but the ID now uses the publisher's own domain.

## ADR-038 The app ID uses the publisher's own domain: dev.middelkamp.ergates

Decided 2026-10-10, before any build reached a store. An app ID is a domain reversed, so `com.nousresearch.hermesergates` claimed a domain that Nous Research owns, for an app that Middelkamp Development publishes without their permission; `hermes-ergates.nousresearch.com` does not exist. Apple's guideline 5.2.1 forbids misleading names in the app bundle, and Google Play's impersonation policy forbids implying a relationship that does not exist. The new ID, `dev.middelkamp.ergates`, is `middelkamp.dev` reversed plus the app name, and is valid on iOS and Android, so ADR-037's single value stays. If Nous Research takes the app over later, both stores transfer an app with its ID, users and reviews, so the ID does not need their name for that.

Rejected: keeping the Nous Research ID and asking them first, which blocks the store setup on their answer and still cannot be undone if they refuse after the first upload. Rejected: `dev.middelkamp.hermesergates`, which is longer and adds nothing the app name does not already say.

## ADR-039 Minimum OS versions: iOS 16.4 and Android 8.0 (API 26)

Decided 2026-10-11, before the first store build. `app.json` declares both minimums, `expo.ios.deploymentTarget` and `android.minSdkVersion` in the `expo-build-properties` plugin, so a change is a reviewed diff instead of a side effect of an Expo upgrade.

iOS 16.4 is the Expo SDK 57 floor: `Expo.podspec` requires it, so nothing lower builds. Nothing in the app needs a later iOS, and Apple's own upload minimum is iOS 13 (from 9 September 2026), so a higher minimum would only turn away iPhones on which the app works.

Android 8.0 (API 26) is above React Native's default of API 24. Let's Encrypt lists Android 7.1.1 as the first version that trusts its root certificate, ISRG Root X1, and Android 7.1.0 and 7.1.1 share API level 25, so API 26 is the first level on which every device trusts it. The store reviewers' demo server uses a Let's Encrypt certificate, and so can any self-hosted Hermes server; a phone below API 26 would install Ergates and then fail to connect to those. Google's distribution data (Android Studio, December 2025) puts API 26 and later at 98.3% of devices, against 99.1% for API 24 and later.

A minimum goes up when an Expo or React Native upgrade raises its floor (`test/minimum-os-versions.test.ts` then fails in that upgrade's pull request), when a store requires it, or when an old version keeps costing fixes or workarounds. It does not go up to follow the newest release. A monthly routine on the maintainer's Claude account reads Apple's and Google's requirement pages, their usage data and Expo's version table, and opens a GitHub issue only when one of these rules says to act, or when a store deadline for the Xcode version, the iOS SDK or the Android target SDK is less than six months away.

Rejected: Expo's defaults, which keep API 24 and its connection failure on Android 7.0, and move both minimums without a diff on every upgrade. Rejected: API 25, which still includes Android 7.1.0. Rejected: a scheduled GitHub Actions check, which cannot reliably read the stores' requirement pages, where the changes that force an update are announced, and which GitHub turns off in a public repository after 60 days without activity.

## ADR-040 iOS adopts the scene life cycle through a config plugin until Expo SDK 58

Decided 2026-10-11, when a build made with Xcode 27 stopped at launch on the iOS 27 simulator. UIKit refuses to launch an app built with the iOS 27 SDK that has not adopted the scene life cycle; it logs "UIScene life cycle is required for apps built with this SDK" and the process exits with SIGTRAP. Apple announced this in TN3187. The check looks at the SDK the app is built with: an older Ergates build made with Xcode 26.5, also without a scene manifest, launches on iOS 27. Expo SDK 57 generates an app delegate and no scene delegate. SDK 58 generates one, but on this date npm still lists it under the `next` tag, on a React Native 0.88 release candidate.

`plugins/with-scene-lifecycle.js` adds a scene manifest to `Info.plist` and a `SceneDelegate.swift` that creates the window, starts React Native in it and passes links and user activities to `AppDelegate`, which hands them to the Expo modules and React Native's Linking as before. It is a reduced copy of SDK 58's `ExpoAppSceneDelegate`, limited to what this app uses. `test/scene-lifecycle.test.ts` fails once the installed Expo ships its own scene delegate, so the SDK 58 upgrade removes the plugin.

Rejected: upgrading to SDK 58 now, which would put a store build on a React Native release candidate and change every native dependency at once. Rejected: building with Xcode 26 only, which works until Apple requires the iOS 27 SDK for uploads but leaves every local Xcode 27 build broken until then.

## ADR-041 Rooted and jailbroken phones are warned, not blocked; the sign-in stays in memory there

Decided 2026-10-11. On a physical phone, two checks run side by side at every start (`src/state/device-trust.ts`): `isRootedExperimentalAsync()` from `expo-device`, and the app's own local Expo module `root-traces` (`apps/mobile/modules/root-traces`, autolinked, no config plugin). Either one flags a rooted (Android) or jailbroken (iOS) phone. A simulator or emulator counts as standard. A check that fails, or has not answered within two seconds, counts as finding nothing (start-up waits for it), so one broken check never hides what the other found; when neither flags, the phone is standard. A build without the native module (a dev client built before it existed) skips the trace search. The result is not remembered between starts. A development-only flag, `EXPO_PUBLIC_DEV_FORCE_ROOTED=1`, forces the flagged path; it is read only while `__DEV__` is true, so a release bundle never sees it.

What `expo-device` 57.0.2 looks at. On iOS (`ios/UIDevice.swift`): app bundles and system paths from the rootful jailbreak era, such as `/Applications/Cydia.app`, `/bin/bash`, `/etc/apt`, `/usr/sbin/sshd` and `/Library/MobileSubstrate/MobileSubstrate.dylib`; a test write to a path outside the app's sandbox; and `canOpenURL("cydia://")`, which is always false in Ergates because the app declares no `LSApplicationQueriesSchemes`. On Android (`android/src/main/java/expo/modules/device/DeviceModule.kt`): `Build.TAGS` containing `test-keys`, `/system/app/Superuser.apk` and `/system/xbin/su`.

What `root-traces` looks at: whether one of a short list of paths exists that a stock phone never has. It asks for no permission and makes no package-manager lookup or `canOpenURL` call.

- iOS (`FileManager` and `lstat`, so the `/var/jb` symlink counts even when the sandbox cannot follow it): `/var/jb`, the symlink rootless jailbreaks (Dopamine, palera1n rootless) point at their root under `/private/preboot`, whose exact path is random and therefore not checked ([Dopamine `DOBootstrapper.m`](https://github.com/opa334/Dopamine/blob/HEAD/Application/Dopamine/Jailbreak/DOBootstrapper.m), [Theos rootless](https://theos.dev/docs/rootless)); `/var/jb/.installed_dopamine`, Dopamine's install marker (same Dopamine source); `/var/jb/usr/bin/su`, the Procursus `su` under the rootless prefix ([Procursus `Makefile`](https://github.com/ProcursusTeam/Procursus/blob/main/Makefile), [`shell-cmds.mk`](https://github.com/ProcursusTeam/Procursus/blob/main/makefiles/shell-cmds.mk)); the Sileo and Zebra package managers under `/var/jb/Applications` and `/Applications` ([Sileo `Makefile`](https://github.com/Sileo/Sileo/blob/main/Makefile), [Zebra `Makefile`](https://github.com/zbrateam/Zebra/blob/main/Makefile), [IOSSecuritySuite `JailbreakChecker.swift`](https://github.com/securing/IOSSecuritySuite/blob/master/IOSSecuritySuite/JailbreakChecker.swift)); `/var/binpack`, checkra1n's tool bundle (IOSSecuritySuite), and `/cores/binpack`, palera1n's ([palera1n `jbinit` `prelaunchd.c`](https://github.com/palera1n/jbinit/blob/HEAD/src/payload/loader/prelaunchd.c)).
- Android (`File.exists`): `su` in `/sbin`, where Magisk keeps its binaries when that folder exists (usually before Android 11; otherwise it uses `/debug_ramdisk`) ([Magisk internal details](https://topjohnwu.github.io/Magisk/details.html)), and in `/system/bin`, `/system/xbin`, `/system_ext/bin`, `/su/bin`, `/data/local`, `/data/local/bin` and `/data/local/xbin` ([RootBeer `Const.java`](https://github.com/scottyab/rootbeer/blob/master/rootbeerlib/src/main/java/com/scottyab/rootbeer/Const.java)), and `/vendor/bin`, on Android's default `PATH` ([bionic `paths.h`](https://android.googlesource.com/platform/bionic/+/refs/heads/main/libc/include/paths.h)), which RootBeer also scans. A bare `/sbin` or `/debug_ramdisk` directory is not a hit: both exist on many phones that are not rooted.

What it still misses. Magisk keeps its binaries in a tmpfs, in `/sbin` where it exists (usually before Android 11), otherwise `/debug_ramdisk`, without changing `/system`. The `/debug_ramdisk` case is not checked: nothing documents those files as visible to an app, so they are not checked, and with DenyList or a Zygisk hiding module Magisk hides its `su` from the app. Anyone who hides root or a jailbreak, renames the files, or removes the `/var/jb` link gets past both checks. The other way round, a custom system signed with test-keys is flagged by `expo-device` although it is not rooted.

On a flagged phone the app keeps working, with three changes:

1. The shared sign-in store (`authSecretStore`, in `src/gateway/secrets.ts` and `src/state/persistence.ts`) switches to memory only. The token, cookie and mode of a connection are not written to SecureStore.
2. At start, before any gateway restores a sign-in, the app deletes the stored token, cookie and mode of every connection saved in the device blob. SecureStore cannot list its keys, so a sign-in whose connection is no longer in the blob is not found. Then it empties the platform cookie jar (`clearPlatformCookieJar` in `src/state/persistence.ts`), where a phone that ran an older build in password mode still keeps the Hermes cookies, the 30-day refresh cookie included. Nothing in the app reads the jar any more, so all of it goes. Both steps are best effort and never stop the start.
3. A one-time alert says why, and the owner signs in again on each cold start, on the Sign-in screen (`app/sign-in.tsx`). Signing in again keeps drafts, the outbox, unfinished agent setups and the organization.

On every phone, `HttpClient` sends `credentials: 'omit'` (`src/gateway/real/http.ts`), so Hermes cookies no longer land in the platform cookie jar. Without this, the refresh cookie, which lives 30 days, would outlast the memory-only store. The app captures `Set-Cookie` itself and replays it as a `Cookie` header. Sign-out and connection removal still clear the jar, for cookies that older builds left there, and a start on a flagged phone empties it (above). In Expo SDK 57 the runtime `fetch` is `expo/fetch`, which maps `'omit'` to `httpShouldHandleCookies = false` on iOS and `CookieJar.NO_COOKIES` on Android. The Sign-in screen is also on every phone: Home redirects to it when a connection has no stored sign-in, the "Tap to sign in again" line on Home and in the chat opens it when the server stops accepting the sign-in mid-use, and for the primary connection it offers Settings as a way out.

Two Play Console settings guard the Android store listing once the owner turns them on (manual; the steps are in `apps/mobile/RELEASING.md`, for the first public release): store listing visibility "Device integrity checks", and automatic protection "installer check". The first hides the app from phones that fail Google's device integrity check, GrapheneOS and other custom systems included. The second prompts users of a copy installed from anywhere else to get the app on Google Play. Google says the first does not prevent users from getting the app another way (sideloading), and a self-built APK from the public source is not stopped by either setting. No equivalent is set up for iOS, where the app's own check is the only one.

The check is a heuristic for honest users. It misses the hidden root named above, and it does not stop an attacker who hides root. Its purpose is to keep the Hermes sign-in off the disk of a phone where other apps may read it, without losing drafts, the outbox or the organization.

Rejected: blocking the app on a flagged phone. It adds no protection against an attacker who hides root, and it only removes users who were told the risk.

Rejected for now: server-side attestation (App Attest on iOS; Android hardware key attestation that checks our package name and the Play signing certificate) through a Hermes dashboard auth provider. A server that verifies the attestation would refuse a rebuilt copy of the app and other clients at sign-in, which the app's own check cannot do. The limits outweigh that today. It gates sign-in only, so a session stolen after sign-in still works. It applies only in gated mode, not in loopback token mode. If Hermes cannot scope a provider to one listener or path, it would lock out the browser dashboard and Hermes Desktop on that server. App Attest does not prove the phone is not jailbroken. It needs Expo's alpha `@expo/app-integrity` or a native module, and costs weeks of work plus upkeep when Apple and Google change their roots. Revisit it when public internet access from the server-setup design ships: password guessing from scripts would then fail before the password check.

Rejected: a hosted Play Integrity verifier run by this project. Play Integrity has a default limit of 10,000 requests a day per Cloud project, so our uptime and that quota would gate every user. It adds a new party to the privacy story, and the owner's Hermes server would still not check its answer.
