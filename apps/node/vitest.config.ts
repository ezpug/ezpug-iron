import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Above `EVENTUALLY_TIMEOUT_MS` (`@ezpug/core/testing`): a red run here is
    // the assertion's own diff, never a loaded box. The dockerode suite starts
    // a real container when the daemon is there, which is seconds on its own.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
