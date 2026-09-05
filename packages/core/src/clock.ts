/**
 * The clock. Every instant the system reasons about comes from here — no
 * orchestrator code, simulator, fake or test calls `Date.now()` directly
 * (CLAUDE.md "Determinism"). Structurally identical to the platform's `Clock`,
 * so a clock built on either side satisfies the other.
 *
 * Two implementations, one interface:
 *
 * - `systemClock` — real time, real timers. What production injects.
 * - `createFakeClock()` — a virtual timeline you advance by hand. What tests,
 *   the fake orchestrator and the simulator engine inject, so a Bo3 with
 *   20-minute deadlines runs in milliseconds without sleeping.
 *
 * Timers live on the clock on purpose: a deadline primitive that stores an
 * absolute timestamp but arms a real `setTimeout` would be untestable.
 * Features never reach for `setTimeout`; they ask the clock.
 */

/** An absolute instant, epoch milliseconds — the wire format for clock math. */
export type Timestamp = number

/** Handle to an armed timer. `cancel()` is idempotent. */
export interface Timer {
  cancel: () => void
}

export interface Clock {
  /** Current instant, epoch ms. The only sanctioned replacement for `Date.now()`. */
  now: () => Timestamp
  /** Current instant as a `Date`, for the ISO-8601 fact timestamps on the wire. */
  date: () => Date
  /** Fire `fn` after `delayMs` of clock time. Delays <= 0 fire on the next tick of the clock. */
  after: (delayMs: number, fn: () => void) => Timer
  /** Fire `fn` when the clock reaches `timestamp` — the shape deadlines are stored in. */
  at: (timestamp: Timestamp, fn: () => void) => Timer
  /** Resolve after `delayMs` of clock time. */
  sleep: (delayMs: number) => Promise<void>
}

/**
 * `setTimeout` truncates delays to a signed 32-bit int and fires *immediately*
 * on overflow — ~24.9 days. A server lifetime or a budget window can exceed
 * that, so the system clock re-arms in chunks instead.
 */
const MAX_TIMEOUT_MS = 2_147_483_647

/**
 * Real time, real timers — resolved through `globalThis` at call time, so
 * `vi.useFakeTimers()` still bites where a test needs it. Injected everywhere
 * in production; never in a test that asserts on timing.
 */
export function createSystemClock(): Clock {
  const clock: Clock = {
    now: () => Date.now(),
    date: () => new Date(),
    after(delayMs, fn) {
      let handle: ReturnType<typeof globalThis.setTimeout> | undefined
      let cancelled = false

      const arm = (remaining: number): void => {
        if (cancelled) return
        const slice = Math.min(Math.max(remaining, 0), MAX_TIMEOUT_MS)
        handle = globalThis.setTimeout(() => {
          const left = remaining - slice
          if (left > 0) arm(left)
          else fn()
        }, slice)
      }

      arm(delayMs)

      return {
        cancel() {
          cancelled = true
          if (handle !== undefined) globalThis.clearTimeout(handle)
        },
      }
    },
    at: (timestamp, fn) => clock.after(timestamp - clock.now(), fn),
    sleep: delayMs =>
      new Promise<void>(resolve => {
        clock.after(delayMs, resolve)
      }),
  }

  return clock
}

/** The production clock. Inject it explicitly; module-level `Date.now()` is not a substitute. */
export const systemClock: Clock = createSystemClock()

export interface FakeClockOptions {
  /** Where the timeline starts. Default: 2026-01-01T00:00:00.000Z — fixed, so fixtures never drift. */
  start?: Timestamp | Date | string
}

export interface FakeClock extends Clock {
  /** Move the timeline forward by `byMs`, firing every timer that comes due, in order. */
  advance: (byMs: number) => Promise<void>
  /** Move the timeline to an absolute instant. Never moves backwards. */
  advanceTo: (timestamp: Timestamp) => Promise<void>
  /** Jump straight to the next armed timer and fire it. No-op when nothing is armed. */
  next: () => Promise<void>
  /** Fire every armed timer, including ones armed while firing, until the timeline is quiet. */
  runAll: () => Promise<void>
  /** Number of armed timers — a leak check for machines that should have disarmed. */
  pending: () => number
  /** When the next armed timer is due, or `undefined` when none is armed. */
  nextDeadline: () => Timestamp | undefined
}

interface FakeTimer {
  due: Timestamp
  seq: number
  fn: () => void
  cancelled: boolean
}

const DEFAULT_START = Date.UTC(2026, 0, 1)

/** Runaway guard: a timer that re-arms itself would otherwise spin forever inside `advance`. */
const MAX_FIRES_PER_ADVANCE = 100_000

/** Microtask drain depth between two timer callbacks — enough for ordinary `await` chains. */
const MICROTASK_FLUSHES = 16

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < MICROTASK_FLUSHES; i++) await Promise.resolve()
}

function toTimestamp(start: Timestamp | Date | string): Timestamp {
  const value = typeof start === 'number' ? start : new Date(start).getTime()
  if (!Number.isFinite(value)) throw new RangeError(`fake clock: invalid start ${String(start)}`)
  return value
}

/**
 * A virtual timeline. Time only moves when you move it, so tests read as
 * "arm a 30s accept deadline, advance 29s, assert nothing; advance 2s, assert
 * the timeout event" with no sleeping and no flake.
 *
 * `advance` is async: it drains microtasks between callbacks, so code that
 * `await`s inside a timer callback has run by the time `advance` resolves.
 */
export function createFakeClock(options: FakeClockOptions = {}): FakeClock {
  let current = toTimestamp(options.start ?? DEFAULT_START)
  let seq = 0
  const timers: FakeTimer[] = []

  const arm = (due: Timestamp, fn: () => void): Timer => {
    const timer: FakeTimer = { due: Math.max(due, current), seq: seq++, fn, cancelled: false }
    timers.push(timer)
    return {
      cancel() {
        timer.cancelled = true
        const index = timers.indexOf(timer)
        if (index !== -1) timers.splice(index, 1)
      },
    }
  }

  // Earliest due time wins; ties fire in arming order (FIFO), like real timers.
  const takeDue = (limit: Timestamp): FakeTimer | undefined => {
    let best: FakeTimer | undefined
    for (const timer of timers) {
      if (timer.due > limit) continue
      if (!best || timer.due < best.due || (timer.due === best.due && timer.seq < best.seq))
        best = timer
    }
    if (best) {
      const index = timers.indexOf(best)
      if (index !== -1) timers.splice(index, 1)
    }
    return best
  }

  const runUntil = async (limit: Timestamp): Promise<void> => {
    let fired = 0
    for (;;) {
      const timer = takeDue(limit)
      if (!timer) break
      if (++fired > MAX_FIRES_PER_ADVANCE)
        throw new Error(
          'fake clock: timer storm — a callback keeps re-arming inside the advanced window',
        )
      current = Math.max(current, timer.due)
      timer.fn()
      await flushMicrotasks()
    }
  }

  const clock: FakeClock = {
    now: () => current,
    date: () => new Date(current),
    after: (delayMs, fn) => arm(current + delayMs, fn),
    at: (timestamp, fn) => arm(timestamp, fn),
    sleep: delayMs =>
      new Promise<void>(resolve => {
        arm(current + delayMs, resolve)
      }),

    async advance(byMs) {
      if (!Number.isFinite(byMs) || byMs < 0)
        throw new RangeError(`fake clock: advance expects a non-negative duration, got ${byMs}`)
      await clock.advanceTo(current + byMs)
    },

    async advanceTo(timestamp) {
      if (timestamp < current)
        throw new RangeError(`fake clock: cannot travel backwards (${current} → ${timestamp})`)
      await runUntil(timestamp)
      current = timestamp
      await flushMicrotasks()
    },

    async next() {
      const due = clock.nextDeadline()
      if (due === undefined) return
      await clock.advanceTo(due)
    },

    async runAll() {
      for (let rounds = 0; ; rounds++) {
        const due = clock.nextDeadline()
        if (due === undefined) return
        if (rounds > MAX_FIRES_PER_ADVANCE)
          throw new Error('fake clock: timer storm — runAll never reached a quiet timeline')
        await clock.advanceTo(due)
      }
    },

    pending: () => timers.length,

    nextDeadline() {
      let earliest: Timestamp | undefined
      for (const timer of timers) {
        if (earliest === undefined || timer.due < earliest) earliest = timer.due
      }
      return earliest
    },
  }

  return clock
}
