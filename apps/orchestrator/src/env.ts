import { fileURLToPath } from 'node:url'

/**
 * Load the repo-root `.env` into `process.env`.
 *
 * Vitest, tsx and drizzle-kit are plain Node processes, and Turbo does not
 * inject env files — so without this `EZPUG_IRON_TEST_DATABASE_URL` is simply
 * absent and every database test silently skips. `loadEnvFile` follows the
 * same rule as `--env-file`: it never overwrites a variable that is already
 * set, so the layering documented in `.env.example` still holds.
 */
export function loadRootEnv(): void {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)))
  } catch {
    // No .env (fresh clone, CI): the process environment is all there is.
  }
}
