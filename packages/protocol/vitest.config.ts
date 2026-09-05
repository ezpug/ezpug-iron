import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Above `EVENTUALLY_TIMEOUT_MS` (`@ezpug/core/testing`): a red run here is
    // the assertion's own diff, never a loaded box.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
