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
 *
 * And it survives a **busy box** (PRD-02 T37c). Opening a connection is the
 * one part of a database test that has nothing to do with what the test
 * asserts and everything to do with what else the box is running: a cold
 * `pnpm verify` puts a dozen Vitest workers, the orchestrator's own pools and
 * a `dotnet build` on one machine, and the transaction a test opens can lose
 * that race — `53300 sorry, too many clients already`, a handshake that
 * outlasts its budget, a socket the kernel drops. None of those is the store's
 * fault and none of them is a red build worth reading, so the acquire is
 * **redialled** ({@link withTransientRetry}) while the crowd is what failed,
 * and the pool the tests take is sized for the crowd (`DATABASE_DEFAULTS` in
 * `../config.ts`).
 */
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Clock, systemClock } from '@ezpug/core'
import { inArray, like, TransactionRollbackError } from 'drizzle-orm'
import type { Sql } from 'postgres'
import { afterAll, beforeAll, beforeEach, expect } from 'vitest'
import { type DatabaseConfig, readDatabaseConfig, TEST_DATABASE_URL_VAR } from '../config'
import { loadRootEnv } from '../env'
import {
  createDatabase,
  type DatabaseHandle,
  errorMessage,
  type IronDatabase,
  type IronTransaction,
} from './client'
import { runMigrations } from './migrate'
import * as schema from './schema'

/**
 * **What a crowded box does to a connection, and nothing else.** Every code
 * here means "the connection did not happen"; not one of them can be reached
 * once a statement of ours is running, so retrying is a redial and never a
 * replay.
 *
 * Postgres's own (`53300` is the one a cold `pnpm verify` reproduces: twelve
 * workers times a pool of ten against `max_connections`), then postgres.js's
 * socket-level names. Deliberately **not** here:
 *
 * - `ECONNREFUSED` / `ENOTFOUND` — nothing is listening. That is the dev
 *   world being down, which is the *skip* signal: retrying it would put
 *   seconds on every fresh clone's verify and change nothing.
 * - `CONNECTION_ENDED` — the pool was closed. That is a suite using a handle
 *   after `afterAll`, a bug that must stay visible.
 * - every `4xxxx` / `2xxxx` — a real answer from a live connection.
 */
const TRANSIENT_DATABASE_ERROR_CODES: ReadonlySet<string> = new Set([
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now — a Postgres still starting up
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  'CONNECT_TIMEOUT', // postgres.js: the handshake outlasted connect_timeout
  'CONNECTION_CLOSED', // postgres.js: the socket went away mid-flight
  'CONNECTION_DESTROYED', // postgres.js: queued behind a socket that then died
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
])

/** True when `error` is the box being busy rather than the code being wrong. */
export function isTransientDatabaseError(error: unknown): boolean {
  const code: unknown = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && TRANSIENT_DATABASE_ERROR_CODES.has(code)
}

export interface TransientRetryOptions {
  /** Waits between attempts, in order. Its length is the retry count. */
  readonly backoffMs?: readonly number[]
  /**
   * Give up rather than start another attempt once this much time has passed.
   * The point is the caller's own deadline: a test has `testTimeout` and a
   * `beforeAll` has `hookTimeout`, and a retry that blows through one turns a
   * flake into a *worse* flake.
   */
  readonly budgetMs?: number
  /** Which errors are worth a redial. Defaults to {@link isTransientDatabaseError}. */
  readonly retryable?: (error: unknown) => boolean
  /** Injected, so a test of the retry never actually waits (`@ezpug/core`). */
  readonly clock?: Clock
  /** Named in the note a retry writes to stderr. */
  readonly what?: string
}

/** Waits between redials: ~2.3 s of retrying in total, front-loaded. */
export const TRANSIENT_BACKOFF_MS: readonly number[] = [200, 600, 1_500]

/**
 * Run `operation`, redialling while it fails on the box being busy. Loud on
 * purpose: a retry writes one line to stderr, because a box that needs three
 * of them is a box someone should look at, and a silent retry is how a real
 * connection leak hides for a month.
 */
export async function withTransientRetry<T>(
  operation: () => Promise<T>,
  options: TransientRetryOptions = {},
): Promise<T> {
  const clock = options.clock ?? systemClock
  const backoff = options.backoffMs ?? TRANSIENT_BACKOFF_MS
  const budgetMs = options.budgetMs ?? Number.POSITIVE_INFINITY
  const retryable = options.retryable ?? isTransientDatabaseError
  const what = options.what ?? 'the test database'
  const started = clock.now()
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const wait = backoff[attempt]
      if (wait === undefined || !retryable(error)) throw error
      if (clock.now() - started >= budgetMs) throw error
      process.stderr.write(
        `[33m[orchestrator] ${what}: ${errorMessage(error)} — redialling in ${wait} ms ` +
          `(attempt ${attempt + 2}/${backoff.length + 1})[0m\n`,
      )
      await clock.sleep(wait)
    }
  }
}

/**
 * Run `body` inside a transaction that is rolled back no matter what it does.
 * The only way to touch the test database that leaves nothing behind.
 *
 * Opening that transaction is retried while the box is what refused it
 * (T37c). Retried **only until the body starts**: after that a redial would
 * be a replay, and a body may count calls, mint tokens or write through a
 * connection this transaction does not own.
 */
export async function withRollback<T>(
  db: IronDatabase,
  body: (tx: IronTransaction) => Promise<T>,
  options: TransientRetryOptions = {},
): Promise<T> {
  let entered = false
  return await withTransientRetry(
    async () => {
      entered = false
      let result: T
      let produced = false
      try {
        await db.transaction(async tx => {
          entered = true
          result = await body(tx)
          produced = true
          tx.rollback()
        })
      } catch (error) {
        if (!(error instanceof TransactionRollbackError)) throw error
      }
      if (!produced) throw new Error('withRollback: transaction ended without running its body')
      return result!
    },
    {
      what: 'opening a test transaction',
      // Comfortably inside the 20 s `testTimeout` the suite runs under.
      budgetMs: 8_000,
      ...options,
      retryable: error => !entered && (options.retryable ?? isTransientDatabaseError)(error),
    },
  )
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
      const config = readDatabaseConfig(process.env, { target: 'test' })
      // One attempt: a fresh pool each time, closed when it does not come up,
      // so a redial never leaks the connections of the one before it.
      const open = async (): Promise<DatabaseHandle> => {
        const candidate = createDatabase(config, {
          applicationName: options.applicationName ?? 'ezpug-iron-test',
        })
        try {
          await candidate.ping()
          await runMigrations(candidate)
          return candidate
        } catch (error) {
          await candidate.close().catch(() => {})
          throw error
        }
      }
      try {
        handle = await withTransientRetry(open, {
          what: 'opening the test database',
          // Inside the 20 s `hookTimeout`: a connect budget of 5 s plus the
          // backoff still leaves the loud skip room to be printed.
          budgetMs: 9_000,
        })
      } catch (error) {
        unavailable = errorMessage(error)
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

/**
 * **Everything a namespace ever committed** — the sweep every suite that
 * writes outside a rollback shares (PRD-02 T26a).
 *
 * A suite that has to commit (an HTTP path has no transaction to roll back)
 * stamps {@link testNamespace} into the *name* of every API key it mints, and
 * every other row it writes hangs off one of those keys. So the whole of a
 * run's residue is reachable from `api_keys.name like '<namespace>-%'` — the
 * ids the process happens to remember are not needed, and that matters:
 * `afterAll` is the one hook a cancelled run never reaches. A red
 * `pnpm verify` cancels its siblings mid-flight, and the keys they left
 * behind used to make the *next* run fail `conflict: an API key named … already
 * exists` on a change that had nothing to do with them (found in T26; the
 * rows were deleted by hand).
 *
 * Hence: call it in `beforeAll` as well as `afterAll`. The `beforeAll` call is
 * the one that keeps the suite honest, because it cleans up after a run that
 * is already over.
 *
 * Deletes in foreign-key order, and releases anything the swept servers were
 * holding (a GSLT lease outlives the row that took it, since the lease is a
 * pointer and not a reference).
 */
export async function sweepNamespace(db: IronDatabase, namespace: string): Promise<void> {
  const keys = await db
    .select({ id: schema.apiKeys.id })
    .from(schema.apiKeys)
    .where(like(schema.apiKeys.name, `${namespace}-%`))
  const keyIds = keys.map(row => row.id)
  if (keyIds.length === 0) return

  const matchIds = (
    await db
      .select({ id: schema.matches.id })
      .from(schema.matches)
      .where(inArray(schema.matches.keyId, keyIds))
  ).map(row => row.id)
  if (matchIds.length > 0) {
    await db
      .delete(schema.webhookDeliveries)
      .where(inArray(schema.webhookDeliveries.matchId, matchIds))
    await db.delete(schema.matchEvents).where(inArray(schema.matchEvents.matchId, matchIds))
    await db.delete(schema.matchCommands).where(inArray(schema.matchCommands.matchId, matchIds))
    // Round backups hang off a match too (the sim reports them since T14).
    await db.delete(schema.backups).where(inArray(schema.backups.matchId, matchIds))
    // Player tokens (T24) name a match; the widget flow mints them.
    await db.delete(schema.playerTokens).where(inArray(schema.playerTokens.matchId, matchIds))
  }

  const serverIds = (
    await db
      .select({ id: schema.servers.id })
      .from(schema.servers)
      .where(inArray(schema.servers.keyId, keyIds))
  ).map(row => row.id)
  if (serverIds.length > 0) {
    await db
      .delete(schema.serverTokens)
      .where(inArray(schema.serverTokens.fleetServerId, serverIds))
    // A lease is a pointer, not a reference: nothing would stop the delete,
    // and the account would sit out of the pool forever (T17).
    await db
      .update(schema.gsltTokens)
      .set({ leasedByServerId: null })
      .where(inArray(schema.gsltTokens.leasedByServerId, serverIds))
  }
  await db.delete(schema.servers).where(inArray(schema.servers.keyId, keyIds))
  await db.delete(schema.matches).where(inArray(schema.matches.keyId, keyIds))

  // A node a swept key enrolled (T12) references it, so it goes with it.
  const nodeIds = (
    await db
      .select({ id: schema.nodes.id })
      .from(schema.nodes)
      .where(inArray(schema.nodes.enrolledByKeyId, keyIds))
  ).map(row => row.id)
  if (nodeIds.length > 0) {
    await db.delete(schema.nodeEnrolments).where(inArray(schema.nodeEnrolments.nodeId, nodeIds))
    await db.delete(schema.nodes).where(inArray(schema.nodes.id, nodeIds))
  }

  await db
    .delete(schema.apiKeyBudgetNotices)
    .where(inArray(schema.apiKeyBudgetNotices.keyId, keyIds))
  await db
    .delete(schema.apiKeyWebhookSecrets)
    .where(inArray(schema.apiKeyWebhookSecrets.keyId, keyIds))
  await db.delete(schema.apiKeys).where(inArray(schema.apiKeys.id, keyIds))
}

/**
 * {@link sweepNamespace} through a connection of the sweep's own — what a
 * suite calls, because the pool it was using is opened after the `beforeAll`
 * sweep and closed before the `afterAll` one.
 */
export async function sweepTestNamespace(
  database: DatabaseConfig,
  namespace: string,
): Promise<void> {
  const cleanup = createDatabase(database, { applicationName: 'ezpug-iron-test-cleanup' })
  try {
    await sweepNamespace(cleanup.db, namespace)
  } finally {
    await cleanup.close()
  }
}
