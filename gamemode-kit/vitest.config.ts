import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The link test opens a real socket against the fake orchestrator over
    // Node HTTP and the build test runs Vite in library mode over a fixture
    // widget: both are seconds, not milliseconds, and above
    // `EVENTUALLY_TIMEOUT_MS` (`@ezpug/core/testing`) so a red run is the
    // assertion's own diff and never a loaded box.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
