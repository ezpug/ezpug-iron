import { describe, expect, it } from 'vitest'
import {
  EVENTUALLY_TIMEOUT_MS,
  eventually,
  useFakeClock,
  useSeededPrng,
  withFakeClock,
} from './index'

describe('useFakeClock', () => {
  const clock = useFakeClock({ start: 0 })

  it('hands out a clock at the configured start', async () => {
    expect(clock.now()).toBe(0)
    clock.after(1_000, () => {})
    await clock.advance(500)
    expect(clock.now()).toBe(500)
    expect(clock.pending()).toBe(1)
  })

  it('is reset for the next test — no state leaks from the one above', () => {
    expect(clock.now()).toBe(0)
    expect(clock.pending()).toBe(0)
  })

  it('drives an injected consumer', async () => {
    const seen: number[] = []
    const armDeadline = (deps: { clock: typeof clock }, at: number): void => {
      deps.clock.at(at, () => seen.push(deps.clock.now()))
    }

    armDeadline({ clock }, 30_000)
    await clock.advance(30_000)
    expect(seen).toEqual([30_000])
  })
})

describe('useSeededPrng', () => {
  const prng = useSeededPrng('helper')
  const firstDraws: number[] = []

  it('draws from the seeded stream', () => {
    expect(prng.seed).toBe('helper')
    firstDraws.push(prng.next())
    prng.next()
  })

  it('starts the same stream over for the next test', () => {
    firstDraws.push(prng.next())
    expect(firstDraws[0]).toBe(firstDraws[1])
  })

  it('exposes the full surface', () => {
    expect(typeof prng.uint32()).toBe('number')
    expect(typeof prng.int(0, 5)).toBe('number')
    expect(typeof prng.bool()).toBe('boolean')
    expect(prng.pick([1, 2, 3])).toBeGreaterThan(0)
    expect(prng.sample([1, 2, 3], 2)).toHaveLength(2)
    expect(prng.shuffle([1, 2, 3])).toHaveLength(3)
    expect(prng.uuid()).toMatch(/^[0-9a-f-]{36}$/)
    expect(prng.fork('child').seed).toBe('helper#child')
    expect(prng.clone().seed).toBe('helper')
  })
})

describe('withFakeClock', () => {
  it('runs a body against a throwaway timeline', async () => {
    const result = await withFakeClock({ start: 5_000 }, async clock => {
      let fired = false
      clock.after(100, () => {
        fired = true
      })
      await clock.advance(100)
      return { fired, now: clock.now() }
    })

    expect(result).toEqual({ fired: true, now: 5_100 })
  })
})

describe('eventually', () => {
  it('waits past the one second vitest would have given up at', async () => {
    // The regression itself: a machine transition that lands at 1.2 s under
    // load is late, not broken. `{ timeout: undefined }` is deliberate — a
    // caller threading an optional budget through must not reinstate the
    // default it was trying to avoid.
    const landsLate = deadline(1_200)
    const at = await eventually(
      () => {
        if (!landsLate()) throw new Error('not yet')
        return 'landed'
      },
      { timeout: undefined, interval: 5 },
    )

    expect(at).toBe('landed')
    expect(EVENTUALLY_TIMEOUT_MS).toBeGreaterThan(1_000)
  })

  it('rejects with the assertion’s own failure, not a bare timeout', async () => {
    // What a real red run has to read like: the diff that was still wrong when
    // the patience ran out. An explicit budget keeps this test quick.
    await expect(
      eventually(() => expect('provisioning').toBe('live'), { timeout: 60, interval: 5 }),
    ).rejects.toThrow(/live/)
  })
})

/** True once `afterMs` of real time has passed since the call. */
function deadline(afterMs: number): () => boolean {
  const start = Date.now()
  return () => Date.now() - start >= afterMs
}
