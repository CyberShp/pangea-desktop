import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // This dependency-free suite runs with node --test before release preparation.
    exclude: [...configDefaults.exclude, '.pangea-build/**', 'test/release-version-check.test.mjs']
  }
})
