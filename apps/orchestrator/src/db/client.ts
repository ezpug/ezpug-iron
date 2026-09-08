/**
 * The Postgres connection: one pool per process, created explicitly at
 * startup and passed down — no ambient singleton, the same injection rule as
 * the clock in `@ezpug/core`. Anything that reads or writes takes a
 * {@link DatabaseExecutor} so it works identically inside and outside a
 * transaction. The platform's `packages/db/src/client.ts`, ported.
 */
import type { ExtractTablesWithRelations } from 'drizzle-orm'
import type { PostgresJsDatabase, PostgresJsTransaction } from 'drizzle-orm/postgres-js'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { Sql } from 'postgres'
import postgres from 'postgres'
import { type DatabaseConfig, redactUrl, TEST_DATABASE_URL_VAR } from '../config'
import { claimTestHandle } from './connections'
import * as schema from './schema'

export type IronSchema = typeof schema
export type IronDatabase = PostgresJsDatabase<IronSchema>
export type IronTransaction = PostgresJsTransaction<
  IronSchema,
  ExtractTablesWithRelations<IronSchema>
>

/**
 * What a repository function should accept: the pool or an open transaction.
 * Never narrow a parameter to `IronDatabase` — that makes the function
 * impossible to compose into a transaction later.
 */
export type DatabaseExecutor = IronDatabase | IronTransaction

export interface DatabaseHandle {
  readonly db: IronDatabase
  /** The raw postgres.js client — for DDL, `LISTEN`, and migrations. */
  readonly sql: Sql
  readonly config: DatabaseConfig
  /** One round trip; throws with a redacted URL when the server is unreachable. */
  ping: () => Promise<void>
  /** Drain the pool. Every process that opens a handle closes it on shutdown. */
  close: () => Promise<void>
}

export interface CreateDatabaseOptions {
  /**
   * Shows up as `application_name` in `pg_stat_activity` — name the process
   * (`orchestrator`, `migrate`, `test`) so a stuck query is attributable.
   */
  applicationName?: string
}

/**
 * Open a pool. The caller owns its lifetime and must `close()` it.
 *
 * A pool on the **test** database also takes a slot in the tier's per-worker
 * budget (`connections.ts`, T39a) and gives it back on `close()`. That is the
 * only asymmetry between the two targets, and it is deliberate: the suite is
 * the one caller that runs a dozen copies of itself on one Postgres.
 */
export function createDatabase(
  config: DatabaseConfig,
  options: CreateDatabaseOptions = {},
): DatabaseHandle {
  const releaseBudget = config.source === TEST_DATABASE_URL_VAR ? claimTestHandle() : undefined
  const sql = postgres(config.url, {
    max: config.poolMax,
    idle_timeout: config.idleTimeoutSeconds,
    connect_timeout: config.connectTimeoutSeconds,
    connection: {
      application_name: options.applicationName ?? 'ezpug-iron',
      statement_timeout: config.statementTimeoutMs,
    },
    // Postgres notices ("relation already exists, skipping") are noise unless
    // someone asked to see the traffic.
    onnotice: config.logQueries ? undefined : () => {},
  })

  const db = drizzle(sql, {
    schema,
    casing: 'snake_case',
    logger: config.logQueries,
  })

  return {
    db,
    sql,
    config,
    async ping() {
      try {
        await sql`select 1`
      } catch (error) {
        throw new Error(
          `cannot reach ${config.source}=${redactUrl(config.url)}: ${errorMessage(error)}`,
          { cause: error },
        )
      }
    },
    async close() {
      try {
        await sql.end({ timeout: 5 })
      } finally {
        releaseBudget?.()
      }
    },
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
