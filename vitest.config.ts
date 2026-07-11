import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
    // tests/integration/redis/* need a live Redis server (globalSetup in
    // vitest.integration.config.ts), so they only run via that config.
    exclude: ['**/node_modules/**', '**/dist/**', '**/docs-web/**', 'tests/integration/redis/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts', 'src/index.ts', 'src/edge.ts']
    },
    environment: 'node',
    globals: true
  }
})
