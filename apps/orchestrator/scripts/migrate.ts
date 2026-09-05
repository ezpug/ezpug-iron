/**
 * Apply pending migrations. `pnpm db:migrate` in dev (`pnpm dev:up` runs it
 * for both databases), and the migration step of the deploy script (T35) in
 * production — one code path for all.
 *
 *   pnpm db:migrate                 # EZPUG_IRON_DATABASE_URL
 *   pnpm db:migrate --target=test   # EZPUG_IRON_TEST_DATABASE_URL
 */
import process from 'node:process'
import { type DatabaseTarget, readDatabaseConfig, redactUrl } from '../src/config'
import { createDatabase, errorMessage } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { loadRootEnv } from '../src/env'

loadRootEnv()

const target: DatabaseTarget = process.argv.includes('--target=test') ? 'test' : 'app'

const config = readDatabaseConfig(process.env, { target })
const handle = createDatabase(config, { applicationName: 'ezpug-iron-migrate' })

try {
  await handle.ping()
  await runMigrations(handle)
  console.log(`[orchestrator] migrations applied to ${redactUrl(config.url)}`)
} catch (error) {
  console.error(`[orchestrator] ${errorMessage(error)}`)
  process.exitCode = 1
} finally {
  await handle.close()
}
