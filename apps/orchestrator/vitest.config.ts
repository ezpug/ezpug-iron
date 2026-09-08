import { defineConfig } from 'vitest/config'
import { TEST_MAX_WORKERS } from './src/db/connections.ts'

export default defineConfig({
  test: {
    // The database suites are real Postgres round trips inside a rollback
    // transaction, run beside the rest of the workspace; above
    // `EVENTUALLY_TIMEOUT_MS` (`@ezpug/core/testing`) so a red run is the
    // assertion's own diff and never a loaded box.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // **Not a performance setting** (PRD-02 T39a). One worker is one process
    // holding up to `TEST_POOL_MAX × TEST_HANDLES_PER_FILE` connections, and
    // this is the multiplier that keeps the whole suite inside the test
    // database's own `CONNECTION LIMIT`. Vitest's default is one worker per
    // core, which on a twelve-core box asks a hundred-connection Postgres for
    // more than it has — `db/connections.ts` does the arithmetic and
    // `db/connections.test.ts` proves it.
    maxWorkers: TEST_MAX_WORKERS,
  },
})
