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
import { redactUrl } from '../config'
import { type DatabaseHandle, errorMessage } from './client'

/**
 * Where `drizzle-kit generate` writes, and where `runMigrations` reads. One
 * level below the package root from `src/db/` and from `dist/` alike, so a
 * bundled build (PRD-02 T4) finds the same folder.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url))

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
