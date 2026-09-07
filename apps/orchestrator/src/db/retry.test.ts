/**
 * **The redial** (PRD-02 T37c). `store.contract.test.ts` failed once under a
 * full `pnpm verify` and passed on every run of the same command afterwards;
 * the throw came out of `postgres`'s `begin` inside `withRollback`, i.e. out
 * of *opening* the transaction, not out of anything the contract asserts.
 *
 * One such failure reproduces on demand: hold connections against the compose
 * image's `max_connections` of 100 and the next `begin` on a fresh connection
 * is refused `53300 sorry, too many clients already` — what a dozen Vitest
 * workers at a pool of ten apiece can do to each other. But sampling
 * `pg_stat_activity` through two whole verifies says this box peaked at 18
 * connections, so the ceiling is *not* what it hit that night; the honest
 * reading is a slower cousin — a handshake past its budget, a socket dropped
 * under load — and every one of them has the same shape: **the connection did
 * not happen, and nothing of ours had run**.
 *
 * So the acquire is redialled, which covers all of them, and the test pool is
 * sized so the ceiling stays out of reach as the suite grows. These tests are
 * the fix's teeth and need no database: what is pinned is what the helper does
 * with an error, and the clock is injected so nothing here waits.
 */
import type { Clock } from '@ezpug/core'
import { TransactionRollbackError } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import type { IronDatabase, IronTransaction } from './client'
import {
  isTransientDatabaseError,
  TRANSIENT_BACKOFF_MS,
  withRollback,
  withTransientRetry,
} from './testing'

/** What postgres.js throws: an `Error` carrying a `code`. */
function dbError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * A clock whose `sleep` is instant and whose timeline moves by exactly what
 * was slept — so a test asserts the backoff it expected and the budget is
 * spent by waiting, not by wall time.
 */
function recordingClock(): { clock: Clock; waits: number[]; spend: (ms: number) => void } {
  let current = 0
  const waits: number[] = []
  const unused = (): never => {
    throw new Error('recordingClock: the retry does not arm timers')
  }
  return {
    waits,
    spend: ms => {
      current += ms
    },
    clock: {
      now: () => current,
      date: () => new Date(current),
      after: unused,
      at: unused,
      sleep: async ms => {
        waits.push(ms)
        current += ms
      },
    },
  }
}

/**
 * A stand-in for the pool: `transaction` fails with `failures` in order
 * before it lets the body run. Drizzle's real one calls `postgres`'s `begin`
 * first, which is where the flake threw.
 */
function flakyDatabase(failures: readonly Error[]): { db: IronDatabase; attempts: () => number } {
  let attempt = 0
  const db = {
    transaction: async (body: (tx: IronTransaction) => Promise<unknown>) => {
      const failure = failures[attempt++]
      if (failure) throw failure
      // Drizzle's `tx.rollback()` throws, and the throw is what leaves the
      // transaction; `withRollback` swallows exactly that one.
      const tx = {
        rollback: () => {
          throw new TransactionRollbackError()
        },
      } as unknown as IronTransaction
      return await body(tx)
    },
  } as unknown as IronDatabase
  return { db, attempts: () => attempt }
}

describe('isTransientDatabaseError', () => {
  it('names the crowd, not the code', () => {
    expect(isTransientDatabaseError(dbError('53300', 'sorry, too many clients already'))).toBe(true)
    expect(isTransientDatabaseError(dbError('CONNECT_TIMEOUT'))).toBe(true)
    expect(isTransientDatabaseError(dbError('CONNECTION_CLOSED'))).toBe(true)
    expect(isTransientDatabaseError(dbError('ECONNRESET'))).toBe(true)
    expect(isTransientDatabaseError(dbError('57P03'))).toBe(true)
  })

  it('leaves the signals that mean something else alone', () => {
    // Nothing is listening: the dev world is down. That is the loud skip, and
    // retrying it would put seconds on every fresh clone's verify.
    expect(isTransientDatabaseError(dbError('ECONNREFUSED'))).toBe(false)
    expect(isTransientDatabaseError(dbError('ENOTFOUND'))).toBe(false)
    // The pool was closed — a suite using its handle after `afterAll`.
    expect(isTransientDatabaseError(dbError('CONNECTION_ENDED'))).toBe(false)
    // A real answer from a live connection.
    expect(isTransientDatabaseError(dbError('23505', 'duplicate key value'))).toBe(false)
    expect(isTransientDatabaseError(new Error('boom'))).toBe(false)
    expect(isTransientDatabaseError(undefined)).toBe(false)
  })
})

describe('withTransientRetry', () => {
  it('redials on the backoff it documents, and answers once the box lets go', async () => {
    const { clock, waits } = recordingClock()
    let calls = 0
    const answer = await withTransientRetry(
      async () => {
        calls++
        if (calls <= 2) throw dbError('53300')
        return 'connected'
      },
      { clock },
    )
    expect(answer).toBe('connected')
    expect(calls).toBe(3)
    expect(waits).toEqual([...TRANSIENT_BACKOFF_MS].slice(0, 2))
  })

  it('gives up when the backoff runs out, carrying the error the box gave', async () => {
    const { clock, waits } = recordingClock()
    await expect(
      withTransientRetry(
        async () => {
          throw dbError('53300', 'sorry, too many clients already')
        },
        { clock },
      ),
    ).rejects.toThrow('sorry, too many clients already')
    expect(waits).toEqual(TRANSIENT_BACKOFF_MS)
  })

  it('never redials what is not the box', async () => {
    const { clock, waits } = recordingClock()
    let calls = 0
    await expect(
      withTransientRetry(
        async () => {
          calls++
          throw dbError('23505', 'duplicate key value')
        },
        { clock },
      ),
    ).rejects.toThrow('duplicate key value')
    expect(calls).toBe(1)
    expect(waits).toEqual([])
  })

  it('stops at the budget rather than blow the timeout it runs under', async () => {
    const { clock, waits, spend } = recordingClock()
    let calls = 0
    await expect(
      withTransientRetry(
        async () => {
          calls++
          spend(5_000) // a connect_timeout's worth of silence
          throw dbError('CONNECT_TIMEOUT')
        },
        { clock, budgetMs: 9_000 },
      ),
    ).rejects.toThrow('CONNECT_TIMEOUT')
    // 5 s, redial, 10 s — past the budget before a third attempt is started.
    expect(calls).toBe(2)
    expect(waits).toEqual([TRANSIENT_BACKOFF_MS[0]])
  })
})

describe('withRollback', () => {
  it('redials a transaction the box refused, and runs the body once', async () => {
    const { clock } = recordingClock()
    const { db, attempts } = flakyDatabase([
      dbError('53300', 'sorry, too many clients already'),
      dbError('53300', 'sorry, too many clients already'),
    ])
    const body = vi.fn(async () => 'the contract held')
    expect(await withRollback(db, body, { clock })).toBe('the contract held')
    expect(attempts()).toBe(3)
    expect(body).toHaveBeenCalledTimes(1)
  })

  it('never redials once the body has started — that would be a replay', async () => {
    const { clock } = recordingClock()
    const { db, attempts } = flakyDatabase([])
    const body = vi.fn(async () => {
      // The same code, but now it came from a statement the body issued: the
      // connection is ours, and running the body twice could double whatever
      // it did outside the transaction.
      throw dbError('53300', 'sorry, too many clients already')
    })
    await expect(withRollback(db, body, { clock })).rejects.toThrow('too many clients')
    expect(attempts()).toBe(1)
    expect(body).toHaveBeenCalledTimes(1)
  })

  it('passes a real failure straight through', async () => {
    const { clock } = recordingClock()
    const { db, attempts } = flakyDatabase([dbError('23505', 'duplicate key value')])
    await expect(withRollback(db, async () => 'unreached', { clock })).rejects.toThrow(
      'duplicate key value',
    )
    expect(attempts()).toBe(1)
  })
})
