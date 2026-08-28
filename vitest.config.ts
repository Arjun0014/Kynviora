import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Native tsconfig `paths` resolution (Vite 7+), replacing the vite-tsconfig-paths plugin.
  resolve: { tsconfigPaths: true },
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/**/*.test.ts', 'services/**/*.test.ts', 'db/**/*.test.ts'],
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
