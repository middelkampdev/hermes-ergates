/**
 * ADR-029 "App code shape" as dependency-cruiser rules (docs/08-decision-log.md,
 * docs/03-technical-design.md section 3.1). Every rule name starts with the
 * ADR-029 rule number it enforces. Run: `npm run depcruise`.
 *
 * Tests (`*.test.ts` and everything under `test/`) may reach into a feature's
 * internals and the real adapter: they test those internals, and the live
 * gates run the real adapter (ADR-029 rule 4).
 */

/** Test code: exempt from the public-index, adapter-behind-port and native-capability rules. */
const TEST = '(^test/|\\.test\\.ts$)'

/** Modules that must run unchanged in Node (ADR-029 rule 1, Global Constraints). */
const PURE_CORE = '^(src/gateway/port\\.ts|src/features/chat/session-reducer\\.ts|src/features/chat/session-controller\\.ts|src/state/organization\\.ts|src/state/org-outbox\\.ts|src/state/org-sync\\.ts|vendor/hermes/)'

/** React, React Native and Expo packages, resolved into node_modules. */
const REACT_NATIVE_OR_EXPO = '^node_modules/(react|react-native|expo|expo-[^/]+|@expo/[^/]+|react-native-[^/]+|@react-native[^/]*/[^/]+)/'

/** Session internals only the session controller may wire together (ADR-029 rule 3). */
const SESSION_INTERNALS = '^src/features/chat/(session-reducer|send-queue|session-sync|canonical-chat)\\.ts$'

module.exports = {
  forbidden: [
    {
      name: 'adr029-1-pure-core-no-react-native',
      comment: 'The port contract, the session reducer, the session controller, the Home organization, its outbox and its sync with Hermes, and vendor/hermes import no React, React Native or Expo module, directly or through another module.',
      severity: 'error',
      from: { path: PURE_CORE },
      to: { path: REACT_NATIVE_OR_EXPO, reachable: true }
    },
    {
      name: 'adr029-1-gateway-points-inward',
      comment: 'The gateway (port, types, errors, adapters, registry) must not import screens, features, the device store, the theme, UI or lib code.',
      severity: 'error',
      from: { path: '^src/gateway/' },
      to: { path: '^(app|src/(features|state|theme|ui|lib))/' }
    },
    {
      name: 'adr029-1-store-points-inward',
      comment: 'The device store must not import screens, features, the theme or UI.',
      severity: 'error',
      from: { path: '^src/state/' },
      to: { path: '^(app|src/(features|theme|ui))/' }
    },
    {
      name: 'adr029-1-adapter-behind-port',
      comment: 'Only src/gateway may import the real adapter (src/gateway/real); screens, features, the store and UI see the port.',
      severity: 'error',
      from: { path: '^(app|src/(features|state|theme|ui|lib))/', pathNot: TEST },
      to: { path: '^src/gateway/real/' }
    },
    {
      name: 'adr029-1-nothing-imports-screens',
      comment: 'app/ is the outermost layer: nothing under src/ imports a screen.',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^app/' }
    },
    {
      name: 'adr029-1-feature-index-from-other-feature',
      comment: 'A feature imports another feature only through that feature\'s public index (src/features/<name>/index.ts).',
      severity: 'error',
      from: { path: '^src/features/([^/]+)/', pathNot: TEST },
      to: { path: '^src/features/[^/]+/', pathNot: ['^src/features/$1/', '^src/features/[^/]+/index\\.ts$'] }
    },
    {
      name: 'adr029-1-feature-index-from-outside',
      comment: 'Screens, UI and every other non-feature module import a feature only through its public index (src/features/<name>/index.ts).',
      severity: 'error',
      from: { pathNot: `(^src/features/|${TEST})` },
      to: { path: '^src/features/[^/]+/', pathNot: '^src/features/[^/]+/index\\.ts$' }
    },
    {
      name: 'adr029-1-no-circular',
      comment: 'Dependencies point one way: no module imports itself back through a chain of other modules.',
      severity: 'error',
      from: {},
      to: { circular: true }
    },
    {
      name: 'adr029-1-no-unresolvable',
      comment: 'Every import resolves to a file. An import the checker cannot resolve is an edge that every other rule here would miss.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true }
    },
    {
      name: 'adr029-2-store-holds-no-hermes-data',
      comment: 'Hermes-owned data lives only in the TanStack Query cache: the device store imports neither the Query cache nor any gateway module except the secret-store contract.',
      severity: 'error',
      from: { path: '^src/state/' },
      to: { path: ['^node_modules/@tanstack/', '^src/gateway/'], pathNot: '^src/gateway/secrets\\.ts$' }
    },
    {
      name: 'adr029-2-gateway-holds-no-cache',
      comment: 'The gateway caches nothing: it imports neither the Query cache nor the device store library.',
      severity: 'error',
      from: { path: '^src/gateway/' },
      to: { path: '^node_modules/(@tanstack|zustand)/' }
    },
    {
      name: 'adr029-3-thin-session-binding',
      comment: 'use-session.ts is a thin React binding over createSessionController: it does not wire the reducer, send queue, resync or canonical chat itself.',
      severity: 'error',
      from: { path: '^src/features/chat/use-session\\.ts$' },
      to: { path: SESSION_INTERNALS }
    },
    {
      name: 'adr029-3-no-session-stand-in',
      comment: 'The fake gateway is an adapter only. It never wires the session modules itself; scenario tests drive the real session controller.',
      severity: 'error',
      from: { path: '^test/fake-gateway/' },
      to: { path: SESSION_INTERNALS }
    },
    {
      name: 'adr029-4-native-capability-in-its-adapter',
      comment: 'Each native capability is imported only by its one real adapter module.',
      severity: 'error',
      from: { pathNot: `(^src/gateway/real/|^src/state/persistence\\.ts$|^src/features/files/attach\\.ts$|^src/features/voice/speech-port\\.ts$|${TEST})` },
      to: { path: '^node_modules/(@react-native-cookies/cookies|expo-secure-store|expo-crypto|@react-native-async-storage/async-storage|expo-file-system|expo-document-picker|expo-image-picker|expo-image-manipulator|expo-speech-recognition)/' }
    },
    {
      name: 'adr029-4-drag-libraries-in-home-list',
      comment: 'react-native-sortables and react-native-reanimated back the one Home list, its drag lists and its Edit mode motion; only the files in src/ui/home-list/ may import them, except that src/ui/RowContent.tsx may import react-native-reanimated only, for the Home row\'s animated slide of the time and the unread dot.',
      severity: 'error',
      from: { pathNot: `(^src/ui/home-list/|^src/ui/RowContent\\.tsx$|${TEST})` },
      to: { path: '^node_modules/(react-native-sortables|react-native-reanimated)/' }
    },
    {
      name: 'adr029-4-sortables-in-home-list',
      comment: 'react-native-sortables is for src/ui/home-list/ only; src/ui/RowContent.tsx may import react-native-reanimated, not this.',
      severity: 'error',
      from: { path: '^src/ui/RowContent\\.tsx$' },
      to: { path: '^node_modules/react-native-sortables/' }
    },
    {
      name: 'adr029-4-gesture-handler-at-the-root',
      comment: 'react-native-gesture-handler must be set up once, at the app root; only app/_layout.tsx may import it, and the Home list for its swipe-to-select gesture, which must win over the scroll view: src/ui/home-list/use-swipe-select.ts builds it, src/ui/home-list/HomeRow.tsx attaches it to the row circle, and src/ui/home-list/PinnedArea.tsx attaches the same gesture (built by the same file) to each pinned avatar\'s selection badge.',
      severity: 'error',
      from: { pathNot: `(^app/_layout\\.tsx$|^src/ui/home-list/use-swipe-select\\.ts$|^src/ui/home-list/HomeRow\\.tsx$|^src/ui/home-list/PinnedArea\\.tsx$|${TEST})` },
      to: { path: '^node_modules/react-native-gesture-handler/' }
    }
  ],
  required: [
    {
      name: 'adr029-3-scenarios-drive-the-controller',
      comment: 'Every scenario test drives the real session controller, the same one the app uses.',
      severity: 'error',
      module: { path: '^test/scenarios/.+\\.test\\.ts$' },
      to: { path: '^src/features/chat/session-controller\\.ts$' }
    }
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
      mainFields: ['module', 'main', 'types', 'typings']
    }
  }
}
