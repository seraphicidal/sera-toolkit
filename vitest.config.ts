import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/api/src/**/*.test.ts',
      'apps/worker/src/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/dist/**', '**/index.ts', '**/*.d.ts'],
      reporter: ['text-summary', 'html'],
    },
  },
  resolve: {
    alias: {
      '@sera/contracts/types': fileURLToPath(
        new URL('./packages/contracts/src/types.ts', import.meta.url),
      ),
      '@sera/contracts': fileURLToPath(
        new URL('./packages/contracts/src/index.ts', import.meta.url),
      ),
      '@sera/engine': fileURLToPath(new URL('./packages/engine/src/index.ts', import.meta.url)),
    },
  },
});
