import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Native tsconfig `paths` resolution (Vite 7+), replacing the vite-tsconfig-paths plugin.
  resolve: { tsconfigPaths: true },
  test: {
    globals: false,
    environment: 'node',
    // `scripts/**` carries the device-verification harness. Only its analysis has tests here;
    // the runner needs an attached device and is invoked by hand (`npm run verify:device`), so
    // the judgements it makes are covered by CI and the evidence is not.
    include: [
      'packages/**/*.test.ts',
      'services/**/*.test.ts',
      'db/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**', 'services/*/src/**'],
    },
  },
});
