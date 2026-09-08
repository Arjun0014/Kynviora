import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Two projects, because the two trees are two runtimes.
 *
 * `server` is everything that runs on Node or in Postgres. `mobile` is `apps/mobile`, which runs
 * on Hermes and has to be told so: React Native's source is Flow-annotated JavaScript that esbuild
 * cannot parse and expects a native bridge Node does not have, so `react-native` resolves to
 * `apps/mobile/test/reactNativeStub.tsx` here. What that substitutes and what it therefore cannot
 * measure is written at the top of the stub.
 *
 * Splitting them rather than widening `include` is what keeps the alias off the server tree. A
 * global `react-native` alias would apply to `packages/presentation` as well, which imports
 * nothing from React Native and must go on not importing anything from it (DEC-010).
 */
const mobileRoot = fileURLToPath(new URL('./apps/mobile', import.meta.url));

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**', 'services/*/src/**', 'apps/mobile/src/**'],
    },
    projects: [
      {
        // No tsconfig `paths` resolution here, deliberately, and this is `DEV-096`.
        //
        // `resolve.tsconfigPaths: true` puts Rolldown's resolver into tsconfig **auto-discovery**
        // (`ResolveOptions { tsconfig: Some(Auto) }`), which is a filesystem walk **per specifier,
        // keyed on the importing file**, run on Rolldown's own thread pool rather than on the
        // JavaScript thread. The walk begins at the importing file itself, so its first candidate
        // is `<the importing file>/tsconfig.json` - a path that can never exist and whose miss has
        // to come back as an IO error every single time for the walk to reach the root. Any other
        // answer, from that candidate or any other, aborts the transform with
        // `Failed to load tsconfig '<that candidate>'`. That is exactly the shape of the failures
        // recorded in `DEV-096`, and every one of them named a **source file** with
        // `/tsconfig.json` appended: the first candidate.
        //
        // How much of it there was: a run of one test file did **218** `load_tsconfig` reads with
        // this flag and **2** without it. The number in flight at once is a function of how many
        // Vitest workers are asking for modules, which is why the gate failed about one run in two
        // at twelve workers, passed at four, and passed on every file alone (trap 208).
        //
        // Nothing needed it. Every `@kynviora/*` package is an npm workspace whose manifest is
        // named after the specifier and whose entry point is the same `src/index.ts` the `paths`
        // entry names - and the `mobile` project below has resolved four of them that way, 159
        // imports' worth, since it existed, with no `tsconfigPaths` and no alias.
        // `scripts/checks/moduleResolution.test.ts` holds the two answers to each other, so a
        // manifest that stopped agreeing with `tsconfig.base.json` is a failing test rather than a
        // suite quietly running code the typechecker never saw.
        test: {
          name: 'server',
          globals: false,
          environment: 'node',
          // `scripts/**` carries the device-verification harness. Only its analysis has tests here;
          // the runner needs an attached device and is invoked by hand (`npm run verify:device`),
          // so the judgements it makes are covered by CI and the evidence is not.
          include: [
            'packages/**/*.test.ts',
            'services/**/*.test.ts',
            'db/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**', 'apps/**'],
          testTimeout: 30_000,
          // 180s, raised from 60s on 2026-09-07 (`DEV-072`).
          //
          // **Fifty test files open their own PGlite instance in `beforeAll`**, each of which
          // costs an engine plus every migration. They run in parallel, so the cost of one is a
          // function of how many others are booting at the same moment - and the suite has grown
          // past the point where 60s covers it. Two files timed out on one run of `npm run verify`
          // and a different one on the next, each passing in seconds on its own.
          //
          // `main.test.ts` and `clientIntegration.test.ts` reached the same number first and set
          // it per file; this is that decision applied where the cause actually is. The tests are
          // not slow by accident - they boot a real database on purpose - and a timeout that fires
          // on load rather than on a hang teaches people to re-run rather than to look.
          hookTimeout: 180_000,
        },
      },
      {
        resolve: {
          alias: [
            { find: /^react-native$/, replacement: `${mobileRoot}/test/reactNativeStub.tsx` },
            { find: /^@\/(.*)$/, replacement: `${mobileRoot}/src/$1` },
            // `expo-crypto` is a binding onto the platform's secure random source, and importing
            // it in Node fails at module scope: `expo-modules-core` reads `__DEV__` and then reads
            // an `expo` global the native runtime installs. The stub says what it does and does
            // not claim.
            { find: /^expo-crypto$/, replacement: `${mobileRoot}/test/expoCryptoStub.ts` },
            // The rest of the platform. A screen imports its providers, a provider imports the
            // keystore or the database, and `expo-modules-core` reads a global the native runtime
            // installs at module scope - so importing a screen in Node throws before a test has
            // rendered anything. These make the import succeed and throw if anything actually
            // calls them, because a component test that reached the keystore would be claiming
            // coverage of what only `verify:device` can measure.
            {
              find: /^expo-secure-store$/,
              replacement: `${mobileRoot}/test/stubs/expo-secure-store.ts`,
            },
            { find: /^expo-sqlite$/, replacement: `${mobileRoot}/test/stubs/expo-sqlite.ts` },
            // The one stub that answers rather than throwing. What `ScanBarcode` decides - which
            // control a refusal offers, whether a read is held for confirmation, what is said
            // about a number nothing has checked - is decidable in Node, and none of it needs a
            // camera. What a camera is still needed for is written at the top of the stub.
            { find: /^expo-camera$/, replacement: `${mobileRoot}/test/stubs/expo-camera.tsx` },
            {
              find: /^expo-notifications$/,
              replacement: `${mobileRoot}/test/stubs/expo-notifications.ts`,
            },
            { find: /^expo-router$/, replacement: `${mobileRoot}/test/stubs/expo-router.tsx` },
            {
              find: /^react-native-safe-area-context$/,
              replacement: `${mobileRoot}/test/stubs/react-native-safe-area-context.tsx`,
            },
          ],
        },
        test: {
          name: 'mobile',
          setupFiles: ['./apps/mobile/test/setup.ts'],
          globals: false,
          environment: 'node',
          include: ['apps/mobile/**/*.test.ts', 'apps/mobile/**/*.test.tsx'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/.expo/**'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
