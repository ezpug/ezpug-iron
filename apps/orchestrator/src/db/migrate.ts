/**
 * Running migrations. Generating them is drizzle-kit's job (`pnpm db:generate`);
 * applying them is ours, because the deploy script, the dev world and the
 * test-database setup all need it programmatically.
 *
 * The SQL files in `drizzle/` are the source of truth — never `drizzle-kit
 * push` against a database that holds real data. Every file has to satisfy
 * `additive-safe.ts`; a test runs the guard over the folder.
 */
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { type EnvRecord, MIGRATIONS_DIR_VAR, redactUrl } from '../config'
import { type DatabaseHandle, errorMessage } from './client'

/**
 * Where `drizzle-kit generate` writes, and where `runMigrations` reads in a
 * checkout: one level below the package root from `src/db/`.
 *
 * **It is not where the image put them.** The bundle lands at `/app/dist/`,
 * two levels below `/`, so walking up from the module resolves `/drizzle` and
 * finds nothing — which is exactly what the first production migration hit
 * (PRD-02 T35). The image says where the SQL is with
 * `EZPUG_IRON_MIGRATIONS_DIR` instead, and {@link resolveMigrationsFolder} is
 * how both entry points ask.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url))

/**
 * The folder to apply: what the environment names, else the one beside the
 * source. This is `scripts/migrate.ts`'s door to it; the service reads the
 * same variable through `readOrchestratorConfig`'s `migrationsDir` and hands
 * the result to {@link runMigrations} at boot. Either way the layout the
 * checkout does not have is configured, never guessed.
 */
export function resolveMigrationsFolder(env: EnvRecord): string {
  return env[MIGRATIONS_DIR_VAR]?.trim() || MIGRATIONS_FOLDER
}

/**
 * Advisory lock id held for the duration of a migration run, so two deploys
 * (or two test workers) cannot apply the same file twice. Arbitrary but fixed.
 */
const MIGRATION_LOCK_ID = 4_207_331_106

export interface RunMigrationsOptions {
  /** Override for tests that apply a throwaway migration set. */
  migrationsFolder?: string
}

/**
 * Apply every pending migration, once, under an advisory lock. Idempotent: a
 * second run against an up-to-date database is a no-op.
 */
export async function runMigrations(
  handle: DatabaseHandle,
  options: RunMigrationsOptions = {},
): Promise<void> {
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER
  const reserved = await handle.sql.reserve()
  try {
    await reserved`select pg_advisory_lock(${MIGRATION_LOCK_ID})`
    await migrate(handle.db, { migrationsFolder })
  } catch (error) {
    throw new Error(
      `migration failed against ${redactUrl(handle.config.url)}: ${errorMessage(error)}`,
      { cause: error },
    )
  } finally {
    await reserved`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`.catch(() => {})
    reserved.release()
  }
}
