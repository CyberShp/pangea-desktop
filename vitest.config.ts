import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Node test suites run separately via npm run test:release-tools; do not load
    // them as Vitest suites (their test registrations belong to node:test).
    exclude: [...configDefaults.exclude, '.pangea-build/**', 'test/*.test.mjs']
  }
})
