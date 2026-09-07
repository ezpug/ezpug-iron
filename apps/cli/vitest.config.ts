import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Above `EVENTUALLY_TIMEOUT_MS` (`@ezpug/core/testing`): the CLI's suite
    // runs the real command against the fake orchestrator over a real socket,
    // and a red run here should be the assertion's diff, never a busy box.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
