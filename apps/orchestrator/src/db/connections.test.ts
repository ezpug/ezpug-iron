/**
 * **The tier's connection budget, proved** (PRD-02 T39a).
 *
 * `connections.ts` is arithmetic, and arithmetic that only lives in a comment
 * drifts the first time somebody wants one more worker. So the inequality is a
 * test, the three places the numbers bind are read back from the files that
 * bind them (`vitest.config.ts`, the `test` target's pool, the initdb SQL),
 * and — when the dev world is up — the live database is asked what limit it
 * is actually carrying and the live server what it has left over.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readDatabaseConfig } from '../config'
import {
  claimTestHandle,
  databaseNameFromUrl,
  openTestHandleCount,
  TEST_DATABASE_CONNECTION_LIMIT,
  TEST_DATABASE_SERVER_HEADROOM,
  TEST_HANDLES_PER_FILE,
  TEST_MAX_WORKERS,
  TEST_POOL_MAX,
  TEST_SUITE_CONNECTION_CEILING,
  TEST_WORKER_CONNECTION_BUDGET,
} from './connections'
import { useTestDatabase } from './testing'

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

describe('the budget', () => {
  it('fits inside the test database’s own connection limit', () => {
    expect(TEST_WORKER_CONNECTION_BUDGET).toBe(TEST_POOL_MAX * TEST_HANDLES_PER_FILE)
    expect(TEST_SUITE_CONNECTION_CEILING).toBe(TEST_MAX_WORKERS * TEST_WORKER_CONNECTION_BUDGET)
    expect(TEST_SUITE_CONNECTION_CEILING).toBeLessThanOrEqual(TEST_DATABASE_CONNECTION_LIMIT)
  })

  it('is what `vitest.config.ts` runs and what the `test` pool takes', () => {
    // The config imports the constant rather than repeating it; this is the
    // check that it still does, because a literal there is the whole bug.
    expect(read('../../vitest.config.ts')).toContain('maxWorkers: TEST_MAX_WORKERS')
    const config = readDatabaseConfig(
      { EZPUG_IRON_TEST_DATABASE_URL: 'postgres://u:p@127.0.0.1:5443/ezpug_iron_test' },
      { target: 'test' },
    )
    expect(config.poolMax).toBe(TEST_POOL_MAX)
  })

  it('is the number a fresh volume’s initdb script writes', () => {
    // The SQL cannot import a TypeScript constant, so the two are matched here.
    expect(read('../../../../docker/postgres/init/10-test-database.sql')).toContain(
      `CONNECTION LIMIT ${TEST_DATABASE_CONNECTION_LIMIT};`,
    )
  })

  it('leaves the rest of the box a share of the server', () => {
    // Not a claim about *this* Postgres — that one is below, against the live
    // server. This is the promise the number was chosen to keep.
    expect(TEST_DATABASE_CONNECTION_LIMIT + TEST_DATABASE_SERVER_HEADROOM).toBeLessThanOrEqual(97)
  })
})

describe('the per-worker ceiling', () => {
  it('refuses a handle past the budget and gives the slot back on release', () => {
    const before = openTestHandleCount()
    const releases = Array.from({ length: TEST_HANDLES_PER_FILE - before }, () => claimTestHandle())
    expect(openTestHandleCount()).toBe(TEST_HANDLES_PER_FILE)
    expect(() => claimTestHandle()).toThrow(/connection budget exceeded/)
    // Releasing is idempotent: `close()` may be called twice and a slot must
    // not be handed back twice.
    releases[0]?.()
    releases[0]?.()
    expect(openTestHandleCount()).toBe(TEST_HANDLES_PER_FILE - 1)
    for (const release of releases) release()
    expect(openTestHandleCount()).toBe(before)
  })
})

describe('databaseNameFromUrl', () => {
  it('reads the database a URL names', () => {
    expect(databaseNameFromUrl('postgres://u:p@h:5443/ezpug_iron_test')).toBe('ezpug_iron_test')
    expect(databaseNameFromUrl('postgres://u:p@h:5443/a%20b')).toBe('a b')
    expect(databaseNameFromUrl('postgres://u:p@h:5443/')).toBeNull()
    expect(databaseNameFromUrl('not a url')).toBeNull()
  })
})

describe('the live database', () => {
  const database = useTestDatabase()

  it('carries the limit `pnpm db:migrate --target=test` applies', async () => {
    const [row] = await database.sql<{ limit: number }[]>`
      select datconnlimit as "limit" from pg_database where datname = current_database()`
    expect(row?.limit).toBe(TEST_DATABASE_CONNECTION_LIMIT)
  })

  it('leaves the dev world backends the suite can never take', async () => {
    const [row] = await database.sql<{ max: string; reserved: string }[]>`
      select current_setting('max_connections') as max,
             current_setting('superuser_reserved_connections') as reserved`
    const usable = Number(row?.max) - Number(row?.reserved)
    expect(usable - TEST_DATABASE_CONNECTION_LIMIT).toBeGreaterThanOrEqual(
      TEST_DATABASE_SERVER_HEADROOM,
    )
  })
})
