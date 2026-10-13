# Ergates mobile

React Native (Expo SDK 57) client for a team of Hermes Agent assistants. Design and contracts: `../../docs/`.

## Run on the iOS simulator

1. Start a local Hermes backend in token mode (loopback bind, no password gate):

   ```bash
   export HERMES_DASHBOARD_SESSION_TOKEN="$(openssl rand -hex 16)"
   echo "$HERMES_DASHBOARD_SESSION_TOKEN"   # paste this into the app's Connect screen
   hermes serve --host 127.0.0.1 --port 9119 --skip-build
   ```

2. Build and launch the development client (first build takes several minutes):

   ```bash
   cd apps/mobile
   npm install
   npx expo run:ios
   ```

   Later runs only need Metro: `npx expo start`, then open the Ergates app on the simulator.

3. In the app: Connect with `http://127.0.0.1:9119` and the token. Home shows the roster; tap the concierge to chat.

For a gateway on the Tailscale VPS (password mode) enter its URL; the app reads `/api/status`, sees `auth_required: true`, and asks for provider, username and password.

## The server plugin in development

After Connect the app checks the Ergates plugin on the server and, when it is missing, offers to install it (ADR-043 in `../../docs/08-decision-log.md`). It installs `middelkampdev/hermes-ergates/integrations/ergates` at the commit in its build record. `app.config.ts` writes that record into the app's config: the plugin's version and API level from the plugin's files, the oldest tested Hermes from `requires_hermes` in `plugin.yaml`, the newest from `expo.extra.hermesTestedThrough` in `app.json`, and the commit.

By default the commit is `git rev-parse HEAD` of the checkout. The server downloads it from GitHub, so a commit that is not pushed cannot be installed. To try the one-tap install from your branch, start Metro with a commit that is on GitHub and whose `integrations/ergates` passes Hermes's install scan:

```bash
ERGATES_PLUGIN_COMMIT=<40-hex commit> npx expo start
```

A build made without git and without `ERGATES_PLUGIN_COMMIT` has no commit. Its setup screen says that this build does not know which plugin version to install, and offers no install. An `ERGATES_PLUGIN_COMMIT` that is set but is not a full commit of 40 lowercase hex characters stops the build. The release workflows set it to the commit of the tag they build. The one tap also needs a Hermes between the oldest and the newest tested version. Hermes 0.21.6, the pin, is inside that range.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Vitest in Node: reducer, outbox, organization, theme, adapters, and the session controller driven by the fake gateway |
| `npm run test:coverage` | The same tests with the coverage gate (thresholds in `vitest.config.mts`) |
| `npm run typecheck` | `tsc --noEmit` (TypeScript 6 strict) |
| `test/design-tokens.test.ts` | Part of `npm test`: fails on a raw type, radius, opacity, spacing or size number (including a `size` prop and a size constant) or a color string under `app/` and `src/ui/` (docs/10 section 4a). Development builds also have Settings › Developer tools › Design system |
| `npm run depcruise` | The ADR-029 dependency rules in `.dependency-cruiser.cjs` |
| `npm run lint` | ESLint with `eslint-config-expo` (hooks rules included); fails on any warning |
| `../../scripts/ci-local.sh mobile` | The CI `mobile` job: typecheck, lint, coverage gate, dependency rules |
| `ERGATES_LIVE=1 ERGATES_TOKEN=… npx vitest run test/live` | Smoke check against a real backend (docs/11 section 3) |
| `ERGATES_LIVE=1 ERGATES_RECORD=1 ERGATES_TOKEN=… ERGATES_OUT=… npx vitest run test/live/agent-traffic-record.live.test.ts` | Re-record the bot-to-bot traffic fixtures (sanitize by hand before copying into `test/fixtures/agent-traffic/`) |
| `npx expo prebuild --platform ios --clean` | Regenerate the native project after changing plugins in `app.json` |
| `scripts/release/upload-secrets.sh --check` | Store releases run in GitHub Actions from gflow tags, to TestFlight and Google Play internal testing; this checks the secrets in the git-ignored `.release/` before they are uploaded. Setup and every release: [RELEASING.md](RELEASING.md) |

## App artwork

The Crew artwork with the speech bubble is `assets/brand/crew-speech-source.png`.
The original remains in `assets/brand/crew-source.png`. Run
`npm run assets:generate` to export the iOS icon, Android legacy/adaptive/themed
icons, and light/dark splash images from that source. The export keeps the
approved faces and overlap; it only resizes the image and creates ink masks.

`app.json` selects these files. Android uses a white adaptive background and
transparent ink in the foreground and monochrome layers. The full artwork fits
inside the central safe circle. The iOS icon is an opaque 1024 × 1024 PNG.
The `expo-splash-screen` plugin configures both native launch screens.

After changing artwork, regenerate and rebuild the native projects. A JavaScript
reload does not replace installed launcher icons or native launch screens.
Check launch screens in a preview or release build, not Expo Go or the dev client.

## Layout

```text
app/            expo-router screens (layout and wiring only)
src/gateway/    GatewayPort contract (port.ts: ConnectedGateway, BOT_CHAT_TITLE), wire types, error mapping,
                transcript normalizer, secret-store contract, real adapter (HTTP, auth, socket), registry
src/features/   one folder per feature, each with a public index.ts: chat (reducer, session controller,
                canonical chat, send queue), agents (roster, editor, agent proposals and their
                provisioning), routines, files, voice, settings, attention (push deep link,
                notification settings), server (the plugin check, the setup run, the pending setup and the
                rules behind `app/server/`); `app/+native-intent.tsx` sends a push link to `app/open.tsx`
                and lets only Home and push links in from outside the app
src/state/      Zustand device store: connections, pins, sections, unread, drafts, outbox, prefs,
                agent setups; persisted as one AES-GCM-sealed blob (sealed-storage.ts, persistence.ts)
src/theme/      vendored Hermes palettes resolved for React Native; skin sync
src/ui/         shared components
test/fixtures/  sanitized recorded backend shapes
test/fake-gateway/  FakeGateway (same GatewayPort), in-memory outbox, transcript window helper
test/scenarios/     behavior tests: the real session controller against the FakeGateway
vendor/hermes/  pinned upstream client and theme sources (MIT), see PIN.md
patches/        patch-package fixes that `npm install` and `npm ci` apply (postinstall): @react-native-cookies/cookies
                asks for mavenCentral() instead of jcenter(), which Gradle 9 removed; decode-uri-component 0.2.2
                (expo-router's query parsing) gets the linear decoder from 0.5.0 (GHSA-vcc3-ghjq-m6fr), because
                0.5.0 is ESM-only; drop it once expo-router no longer depends on 0.2.x
```

Rules (ADR-029), enforced by `npm run depcruise`:

- Screens, UI and other features import a feature only through its `src/features/<name>/index.ts`.
- The gateway and the device store never import screens or features; only `src/gateway` imports the real adapter.
- The port, the session reducer, the session controller and `vendor/hermes` import no React, React Native or Expo module.
- The device store holds no Hermes data: it imports neither TanStack Query nor the gateway (except the secret-store contract).
- `use-session.ts` is a thin React binding of `createSessionController` (`session-controller.ts`); the scenario tests drive that same controller.
- Each native module (cookies, secure storage, crypto, AsyncStorage, file pickers, speech) is imported by its one adapter.
- No import cycles, and every import resolves to a file.

Development-only hooks (compiled out of release bundles): `EXPO_PUBLIC_DEV_GATEWAY_URL`/`EXPO_PUBLIC_DEV_GATEWAY_TOKEN` (auto-connect), `EXPO_PUBLIC_DEV_INITIAL_ROUTE` and `EXPO_PUBLIC_DEV_ROUTE_URL` (navigate on launch), and the chat route params `?devSend=<prompt>`, `?devFocus=1`, `?devInject=refused|waiting|sending|mixed` (synthetic `message_agent` frames through the normal reducer path). `npm run typecheck` passes on a fresh checkout without `.expo/types` (CI runs it that way); `expo start` regenerates `.expo/types/router.d.ts`.
