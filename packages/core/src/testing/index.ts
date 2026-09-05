/**
 * Vitest helpers for the determinism primitives (`@ezpug/core/testing`).
 *
 * Rule of thumb: our own code takes an injected `Clock`, so tests use
 * `useFakeClock()` and never `vi.useFakeTimers()` — the latter is only for
 * third-party code that reaches for `setTimeout` behind our back.
 */
import { afterEach, beforeEach, vi } from 'vitest'
import type { Clock, FakeClock, FakeClockOptions, Timer, Timestamp } from '../clock'
import { createFakeClock } from '../clock'
import type { Prng } from '../prng'
import { createPrng } from '../prng'

/**
 * A fake clock that is re-created fresh before every test in the current
 * suite, so state never leaks between tests:
 *
 * ```ts
 * const clock = useFakeClock()
 * it('times out', async () => {
 *   const machine = createMachine({ clock })
 *   await clock.advance(30_000)
 * })
 * ```
 *
 * The returned handle is stable across tests — it delegates to whichever
 * clock the current test owns — so it can be captured at suite scope.
 *
 * @param options.assertNoPendingTimers fail a test that leaves timers armed
 * (a machine that forgot to disarm its deadline). Off by default: long-lived
 * deadlines outliving a test are normal.
 */
export function useFakeClock(
  options: FakeClockOptions & { assertNoPendingTimers?: boolean } = {},
): FakeClock {
  const { assertNoPendingTimers = false, ...clockOptions } = options
  let inner = createFakeClock(clockOptions)

  beforeEach(() => {
    inner = createFakeClock(clockOptions)
  })

  afterEach(() => {
    if (assertNoPendingTimers && inner.pending() > 0)
      throw new Error(`useFakeClock: ${inner.pending()} timer(s) still armed at end of test`)
  })

  return {
    now: (): Timestamp => inner.now(),
    date: (): Date => inner.date(),
    after: (delayMs: number, fn: () => void): Timer => inner.after(delayMs, fn),
    at: (timestamp: Timestamp, fn: () => void): Timer => inner.at(timestamp, fn),
    sleep: (delayMs: number): Promise<void> => inner.sleep(delayMs),
    advance: (byMs: number): Promise<void> => inner.advance(byMs),
    advanceTo: (timestamp: Timestamp): Promise<void> => inner.advanceTo(timestamp),
    next: (): Promise<void> => inner.next(),
    runAll: (): Promise<void> => inner.runAll(),
    pending: (): number => inner.pending(),
    nextDeadline: (): Timestamp | undefined => inner.nextDeadline(),
  }
}

/**
 * A seeded PRNG re-created fresh before every test, so tests in one file
 * cannot influence each other's draws. Same stable-handle trick as
 * `useFakeClock`.
 */
export function useSeededPrng(seed: string | number): Prng {
  let inner = createPrng(seed)

  beforeEach(() => {
    inner = createPrng(seed)
  })

  return {
    get seed() {
      return inner.seed
    },
    next: () => inner.next(),
    uint32: () => inner.uint32(),
    int: (min: number, max: number) => inner.int(min, max),
    bool: (probability?: number) => inner.bool(probability),
    pick: <T>(items: readonly T[]): T => inner.pick(items),
    sample: <T>(items: readonly T[], count: number): T[] => inner.sample(items, count),
    shuffle: <T>(items: readonly T[]): T[] => inner.shuffle(items),
    uuid: () => inner.uuid(),
    fork: (label: string) => inner.fork(label),
    clone: () => inner.clone(),
  }
}

/**
 * Runs `body` against a throwaway fake clock — for a single test that needs a
 * second timeline (two machines on different clocks, say) without hooks.
 */
export async function withFakeClock<T>(
  options: FakeClockOptions,
  body: (clock: FakeClock) => Promise<T> | T,
): Promise<T> {
  return await body(createFakeClock(options))
}

/**
 * How long {@link eventually} waits before it gives up. Exported so a suite
 * that raises its own `testTimeout` can see the number it has to stay above.
 */
export const EVENTUALLY_TIMEOUT_MS = 15_000

/**
 * `vi.waitFor` with a budget that fits a loaded box.
 *
 * The assertion these tests want is "eventually", not "within a second" — and
 * one second is exactly what `vi.waitFor` gives you by default. That default
 * is a *latency* assumption, not a behavioural one, and it is wrong under
 * `pnpm verify:extended`, where the orchestrator boots beside the whole test
 * matrix: a real Postgres round trip, a WebSocket handshake or a container
 * start can each take longer than a second on a busy machine. Every
 * reproduced flake of that shape on the platform was the deadline, never the
 * behaviour, and a flaky test is a P1 against the spine (CLAUDE.md "Verify").
 *
 * So: same assertion, more patience. Two rules for using it —
 *
 * - **Never for a negative.** `eventually` proves something *happens*; to
 *   prove something does not, settle the world (advance the clock, await the
 *   machine) and assert once. Waiting 15 s for nothing is 15 s wasted.
 * - **Stay inside the test timeout.** A suite using this needs
 *   `testTimeout` above {@link EVENTUALLY_TIMEOUT_MS}, or vitest kills the
 *   test first and reports "test timed out" instead of the assertion's own
 *   diff — the whole point of waiting is to be told what was still wrong.
 *
 * The tighter `interval` is deliberate too: a suite driving a fake clock
 * re-checks cheaply, and the sooner it sees the state it wants, the fewer
 * deadlines it drags along with it.
 */
export function eventually<T>(
  assertion: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  // `?? `, not a spread: a caller threading an optional `timeout` through
  // would otherwise pass `undefined` and silently reinstate vitest's 1 s.
  return vi.waitFor(assertion, {
    timeout: options.timeout ?? EVENTUALLY_TIMEOUT_MS,
    interval: options.interval ?? 25,
  })
}

export type { Clock, FakeClock, Prng }
