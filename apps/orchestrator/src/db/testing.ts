/**
 * The test-database strategy (the platform's `@ezpug/db/testing`, ported).
 *
 * Tests run against a **separate database on the same server** —
 * `EZPUG_IRON_TEST_DATABASE_URL`, created by `docker/postgres/init` — so
 * nothing a test writes can touch the dev world. Inside it, isolation is per
 * test and comes from a **transaction that is always rolled back**: fast,
 * complete, and parallel-safe across Vitest workers, because an uncommitted
 * transaction is invisible to every other connection.
 *
 * Rollback isolation covers a suite's own writes, never a neighbour's, so a
 * test asserts only about rows it created and, when it must commit, stamps
 * them with its {@link testNamespace} and registers an undo.
 *
 * When the dev environment is not running, the suite **skips loudly** rather
 * than failing: `pnpm verify` on a fresh clone stays green, and the warning
 * names the command that fixes it. `EZPUG_IRON_DATABASE_TESTS=required` (the
 * extended tier) turns a missing database into an error.
 */
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TransactionRollbackError } from 'drizzle-orm'
import type { Sql } from 'postgres'
import { afterAll, beforeAll, beforeEach, expect } from 'vitest'
import { readDatabaseConfig, TEST_DATABASE_URL_VAR } from '../config'
import { loadRootEnv } from '../env'
import {
  createDatabase,
  type DatabaseHandle,
  errorMessage,
  type IronDatabase,
  type IronTransaction,
} from './client'
import { runMigrations } from './migrate'

/**
 * Run `body` inside a transaction that is rolled back no matter what it does.
 * The only way to touch the test database that leaves nothing behind.
 */
export async function withRollback<T>(
  db: IronDatabase,
  body: (tx: IronTransaction) => Promise<T>,
): Promise<T> {
  let result: T
  let produced = false
  try {
    await db.transaction(async tx => {
      result = await body(tx)
      produced = true
      tx.rollback()
    })
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error
  }
  if (!produced) throw new Error('withRollback: transaction ended without running its body')
  return result!
}

/**
 * A token derived from the test file's own path — `t-keys-postgres-1a2b3c`.
 * Stamp it into a text column of anything a suite **commits**, so a row that
 * survives a crashed run names its owner.
 */
export function testNamespace(testPath: string): string {
  const path = testPath.startsWith('file:') ? fileURLToPath(testPath) : testPath
  const name = basename(path)
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .toLowerCase()
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 6)
  return `t-${name}-${hash}`
}

export interface TestDatabase {
  readonly handle: DatabaseHandle
  readonly db: IronDatabase
  readonly sql: Sql
  /** Run one test body inside an always-rolled-back transaction. */
  rollback: <T>(body: (tx: IronTransaction) => Promise<T>) => Promise<T>
  readonly namespace: string
  /** `undefined` when the database is reachable, otherwise the reason. */
  readonly unavailable: string | undefined
}

/**
 * Suite-scoped handle on the test database: opened and migrated once in
 * `beforeAll`, closed in `afterAll`, and skipped per test when the dev
 * environment is not up. The returned object is stable, so it can be
 * captured at suite scope like `useFakeClock()` in `@ezpug/core/testing`.
 */
export function useTestDatabase(options: { applicationName?: string } = {}): TestDatabase {
  let handle: DatabaseHandle | undefined
  let unavailable: string | undefined
  let namespace: string | undefined

  beforeAll(async () => {
    const { testPath } = expect.getState()
    if (!testPath) throw new Error('useTestDatabase: vitest did not report a test path')
    namespace = testNamespace(testPath)
    loadRootEnv()
    if (!process.env[TEST_DATABASE_URL_VAR]) {
      unavailable = `${TEST_DATABASE_URL_VAR} is not set`
    } else {
      try {
        handle = createDatabase(readDatabaseConfig(process.env, { target: 'test' }), {
          applicationName: options.applicationName ?? 'ezpug-iron-test',
        })
        await handle.ping()
        await runMigrations(handle)
      } catch (error) {
        unavailable = errorMessage(error)
        await handle?.close().catch(() => {})
        handle = undefined
      }
    }

    if (!unavailable) return
    if (process.env.EZPUG_IRON_DATABASE_TESTS === 'required')
      throw new Error(`database tests are required but ${unavailable}`)
    // process.stderr, not console.warn: Vitest swallows console output from
    // hooks, and a silent skip is exactly the failure mode this guards against.
    process.stderr.write(
      `\n[33m[orchestrator] skipping database tests — ${unavailable}[0m\n` +
        '               boot the dev world with `pnpm dev:up`, or set\n' +
        '               EZPUG_IRON_DATABASE_TESTS=required to make this an error.\n\n',
    )
  })

  beforeEach(ctx => {
    if (unavailable) ctx.skip(`test database unavailable: ${unavailable}`)
  })

  afterAll(async () => {
    await handle?.close()
    handle = undefined
  })

  const required = (): DatabaseHandle => {
    if (!handle) throw new Error('test database is not open — use it inside a test')
    return handle
  }

  return {
    get handle() {
      return required()
    },
    get db() {
      return required().db
    },
    get sql() {
      return required().sql
    },
    get unavailable() {
      return unavailable
    },
    get namespace() {
      if (!namespace) throw new Error('test database is not open — use it inside a test')
      return namespace
    },
    rollback: async body => await withRollback(required().db, body),
  }
}
