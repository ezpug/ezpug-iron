/**
 * **The test tier's connection budget** (PRD-02 T39a).
 *
 * A Postgres server is a fixed number of backends — the dev one this repo
 * ships is `max_connections = 100` — and it is shared: the dev orchestrator
 * container, a `pnpm dev` on the host, a `psql`, and the test suite all dial
 * the same postmaster. Nothing bounded the suite's appetite. Vitest opens one
 * worker per core (eleven on this box), a worker runs a file, and a file may
 * hold several pools at once — `deployments.extended.test.ts` stands two
 * orchestrators and a sweep beside them. Eleven times three pools of five is
 * a hundred and sixty-five connections asked of a server that has ninety-seven
 * to give, and the first `verify:extended` of T39 collected the answer:
 * `53300 sorry, too many clients already`, then `CONNECT_TIMEOUT` through
 * every redial. {@link withTransientRetry} is the shock absorber, not the fix;
 * over-subscription this large outlasts any backoff.
 *
 * So the appetite is declared here, as arithmetic that has to fit:
 *
 * ```
 *   TEST_MAX_WORKERS × (TEST_POOL_MAX × TEST_HANDLES_PER_FILE) ≤ TEST_DATABASE_CONNECTION_LIMIT
 *          6         × (      5      ×          2           ) = 60 ≤ 60
 * ```
 *
 * Three numbers, three places they bind, and `connections.test.ts` proves the
 * inequality and the headroom:
 *
 * - {@link TEST_MAX_WORKERS} is `maxWorkers` in `vitest.config.ts`.
 * - {@link TEST_POOL_MAX} is the `test` target's pool in `../config.ts`.
 * - {@link TEST_HANDLES_PER_FILE} is enforced where handles are made
 *   ({@link claimTestHandle}, called by `createDatabase`): a worker that opens
 *   one pool too many on the test database fails loudly and immediately,
 *   naming this budget, instead of quietly taking somebody else's share.
 * - {@link TEST_DATABASE_CONNECTION_LIMIT} is the test **database's** own
 *   `CONNECTION LIMIT`, applied by `pnpm db:migrate --target=test` (so
 *   `pnpm dev:up` sets it) and by the initdb script on a fresh volume.
 *
 * That last one is the guard rail rather than the fix: the arithmetic is what
 * keeps the suite inside its budget, and the database limit is what keeps a
 * suite that ever breaks the arithmetic from taking the dev world down with
 * it. Whatever the suite does, `max_connections − 3 reserved − 60 = 37`
 * backends stay available to every other process on the box.
 */
import type { Sql } from 'postgres'

/**
 * Connections the **test database** will hand out at all, across every
 * process. Sized so the rest of the box — a dev orchestrator's pool of ten, a
 * `pnpm dev` beside it, a migrate, a `psql` — keeps a comfortable share of
 * the server's hundred; see {@link TEST_DATABASE_SERVER_HEADROOM}.
 */
export const TEST_DATABASE_CONNECTION_LIMIT = 60

/**
 * Backends the server must still have for everything that is not the suite,
 * after the reserved ones and the test database's whole limit are taken.
 * Asserted against the live `max_connections` in `connections.test.ts`.
 */
export const TEST_DATABASE_SERVER_HEADROOM = 30

/**
 * Pool size of a handle on the test database (the `test` target's default).
 *
 * Not shrinkable below what an orchestrator standing on it needs: the extended
 * suites run a **real service** against this database — client requests, the
 * webhook worker, the reaper and the stream, all at once — and a first attempt
 * at this budget that took the pool to three starved
 * `conformance.extended.test.ts` until a flow ran out its ninety seconds. The
 * factor that gives instead is the handle count below.
 */
export const TEST_POOL_MAX = 5

/**
 * Pools one test file may hold on the test database at the same time. Two is
 * what the heaviest file needs — an orchestrator and the namespace sweep
 * beside it — and `deployments.extended.test.ts`, which stands two
 * orchestrators, sweeps before it opens the second so it never holds three. A
 * file that wants a third is a budget change, made here, not a surprise at
 * three in the morning.
 */
export const TEST_HANDLES_PER_FILE = 2

/**
 * Vitest workers for `@ezpug/orchestrator` — `maxWorkers` in its
 * `vitest.config.ts`. Not a performance knob: it is the multiplier of
 * {@link TEST_WORKER_CONNECTION_BUDGET}, and it is the number that makes the
 * arithmetic above fit.
 */
export const TEST_MAX_WORKERS = 6

/** Connections one worker may hold at its worst moment. */
export const TEST_WORKER_CONNECTION_BUDGET = TEST_POOL_MAX * TEST_HANDLES_PER_FILE

/** Connections the whole suite may hold at its worst moment. */
export const TEST_SUITE_CONNECTION_CEILING = TEST_MAX_WORKERS * TEST_WORKER_CONNECTION_BUDGET

/**
 * Open test-database handles in this process. A Vitest worker is a process
 * and runs one file at a time, so this is the per-file count of the budget.
 */
let openTestHandles = 0

/**
 * Take a slot in {@link TEST_HANDLES_PER_FILE}, or refuse. Returns the release
 * — called when the handle is closed, and idempotent, because `close()` is.
 *
 * Only handles on the test database are counted: an app pool is a deployment's
 * business and this budget has nothing to say about it.
 */
export function claimTestHandle(): () => void {
  if (openTestHandles >= TEST_HANDLES_PER_FILE)
    throw new Error(
      `test-database connection budget exceeded: this worker already holds ` +
        `${openTestHandles} pools and TEST_HANDLES_PER_FILE is ${TEST_HANDLES_PER_FILE} ` +
        `(db/connections.ts). Close a handle, or raise the budget there and keep ` +
        `TEST_MAX_WORKERS × TEST_POOL_MAX × TEST_HANDLES_PER_FILE ≤ ` +
        `${TEST_DATABASE_CONNECTION_LIMIT}.`,
    )
  openTestHandles++
  let released = false
  return () => {
    if (released) return
    released = true
    openTestHandles--
  }
}

/** How many test-database pools this process holds open (for the budget's test). */
export function openTestHandleCount(): number {
  return openTestHandles
}

/** The database a `postgres://` URL names, or `null` when it names none. */
export function databaseNameFromUrl(url: string): string | null {
  try {
    const name = decodeURIComponent(new URL(url).pathname.slice(1))
    return name === '' ? null : name
  } catch {
    return null
  }
}

/**
 * Give the test database {@link TEST_DATABASE_CONNECTION_LIMIT} and no more.
 * Idempotent, and **not fatal when it is refused**: only the owner may alter a
 * database, and a CI Postgres or a managed instance may say no. The limit is
 * the guard rail; the arithmetic is the fix, and it holds either way. Returns
 * what happened so the caller can print one line.
 */
export async function ensureTestDatabaseConnectionLimit(
  sql: Sql,
  databaseName: string,
  limit: number = TEST_DATABASE_CONNECTION_LIMIT,
): Promise<{ applied: boolean; reason?: string }> {
  // An identifier cannot be a bind parameter and the limit cannot either, so
  // both are made safe here: the name is double-quoted with its own quotes
  // doubled, the limit is coerced to an integer.
  const quoted = `"${databaseName.replaceAll('"', '""')}"`
  const value = Math.trunc(limit)
  if (!Number.isFinite(value) || value < 1) throw new Error(`invalid connection limit: ${limit}`)
  try {
    await sql.unsafe(`alter database ${quoted} with connection limit ${value}`)
    return { applied: true }
  } catch (error) {
    return { applied: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
