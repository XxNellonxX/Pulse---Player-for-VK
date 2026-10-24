import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Native/gateway regression suites use node:test and run separately.
  test: { include: ['src/**/*.test.{ts,tsx}'] },
})
