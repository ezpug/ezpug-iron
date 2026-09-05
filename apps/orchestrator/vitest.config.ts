import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The database suites are real Postgres round trips inside a rollback
    // transaction, run beside the rest of the workspace; above
    // `EVENTUALLY_TIMEOUT_MS` (`@ezpug/core/testing`) so a red run is the
    // assertion's own diff and never a loaded box.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
