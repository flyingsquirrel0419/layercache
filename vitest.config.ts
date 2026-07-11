import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
    // tests/integration/redis/* need a real ioredis client; the setup file mocks
    // 'ioredis' with ioredis-mock, so they only run via vitest.integration.config.ts.
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
