import { describe, expect, it, vi } from 'vitest'
import type { Timestamp } from './clock'
import { createFakeClock, createSystemClock, systemClock } from './clock'

describe('systemClock', () => {
  it('reports real time', () => {
    const before = Date.now()
    const now = systemClock.now()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(systemClock.date().getTime()).toBeGreaterThanOrEqual(before)
  })

  it('fires and cancels real timers', async () => {
    const clock = createSystemClock()
    const fired: string[] = []

    clock.after(1, () => fired.push('kept'))
    clock.after(1, () => fired.push('cancelled')).cancel()
    await clock.sleep(10)

    expect(fired).toEqual(['kept'])
  })

  it('chunks delays past the 32-bit setTimeout ceiling instead of firing immediately', () => {
    vi.useFakeTimers()
    try {
      const clock = createSystemClock()
      let fired = false
      const fortyDays = 40 * 24 * 60 * 60 * 1000

      clock.after(fortyDays, () => {
        fired = true
      })

      vi.advanceTimersByTime(2_147_483_647)
      expect(fired).toBe(false) // a naive setTimeout would have fired at t=0

      vi.advanceTimersByTime(fortyDays)
      expect(fired).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a chunked timer mid-flight', () => {
    vi.useFakeTimers()
    try {
      const clock = createSystemClock()
      let fired = false
      const fortyDays = 40 * 24 * 60 * 60 * 1000
      const timer = clock.after(fortyDays, () => {
        fired = true
      })

      vi.advanceTimersByTime(2_147_483_647)
      timer.cancel()
      vi.advanceTimersByTime(fortyDays)

      expect(fired).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createFakeClock', () => {
  it('starts on a fixed instant and only moves when advanced', async () => {
    const clock = createFakeClock()
    expect(clock.now()).toBe(Date.UTC(2026, 0, 1))
    expect(clock.date().toISOString()).toBe('2026-01-01T00:00:00.000Z')

    const before = clock.now()
    await Promise.resolve()
    expect(clock.now()).toBe(before)

    await clock.advance(1_500)
    expect(clock.now()).toBe(before + 1_500)
  })

  it('accepts an ISO string or Date start', () => {
    expect(createFakeClock({ start: '2026-08-23T12:00:00.000Z' }).now()).toBe(
      Date.UTC(2026, 7, 23, 12),
    )
    expect(createFakeClock({ start: new Date(1234) }).now()).toBe(1234)
    expect(() => createFakeClock({ start: 'not-a-date' })).toThrow(RangeError)
  })

  it('fires timers only once their deadline is reached', async () => {
    const clock = createFakeClock()
    const fired: number[] = []
    clock.after(30_000, () => fired.push(clock.now()))

    await clock.advance(29_999)
    expect(fired).toEqual([])
    expect(clock.pending()).toBe(1)

    await clock.advance(1)
    expect(fired).toEqual([clock.now()])
    expect(clock.pending()).toBe(0)
  })

  it('fires due timers in deadline order, ties in arming order', async () => {
    const clock = createFakeClock()
    const order: string[] = []
    clock.after(300, () => order.push('c'))
    clock.after(100, () => order.push('a1'))
    clock.after(100, () => order.push('a2'))
    clock.after(200, () => order.push('b'))

    await clock.advance(1_000)
    expect(order).toEqual(['a1', 'a2', 'b', 'c'])
  })

  it('exposes the clock time of each firing, not the advance target', async () => {
    const clock = createFakeClock({ start: 0 })
    const stamps: Timestamp[] = []
    clock.after(100, () => stamps.push(clock.now()))
    clock.after(250, () => stamps.push(clock.now()))

    await clock.advance(1_000)
    expect(stamps).toEqual([100, 250])
    expect(clock.now()).toBe(1_000)
  })

  it('fires timers armed from inside a callback within the same advance', async () => {
    const clock = createFakeClock({ start: 0 })
    const fired: number[] = []
    clock.after(10, () => {
      fired.push(clock.now())
      clock.after(10, () => fired.push(clock.now()))
    })

    await clock.advance(100)
    expect(fired).toEqual([10, 20])
  })

  it('resolves sleep and the await chain behind it', async () => {
    const clock = createFakeClock({ start: 0 })
    const steps: string[] = []

    const done = (async () => {
      await clock.sleep(1_000)
      steps.push('after-sleep')
      await clock.sleep(500)
      steps.push('after-second-sleep')
    })()

    await clock.advance(999)
    expect(steps).toEqual([])

    await clock.advance(1)
    expect(steps).toEqual(['after-sleep'])

    await clock.advance(500)
    await done
    expect(steps).toEqual(['after-sleep', 'after-second-sleep'])
  })

  it('at() arms on an absolute deadline, the shape the state machine stores', async () => {
    const clock = createFakeClock({ start: 1_000 })
    let fired = false
    clock.at(5_000, () => {
      fired = true
    })

    await clock.advanceTo(4_999)
    expect(fired).toBe(false)
    await clock.advanceTo(5_000)
    expect(fired).toBe(true)
  })

  it('fires a deadline already in the past on the next advance', async () => {
    const clock = createFakeClock({ start: 10_000 })
    let fired = false
    clock.at(1, () => {
      fired = true
    })

    expect(clock.nextDeadline()).toBe(10_000)
    await clock.advance(0)
    expect(fired).toBe(true)
  })

  it('cancels timers idempotently', async () => {
    const clock = createFakeClock()
    let fired = false
    const timer = clock.after(10, () => {
      fired = true
    })

    timer.cancel()
    timer.cancel()
    expect(clock.pending()).toBe(0)
    await clock.advance(1_000)
    expect(fired).toBe(false)
  })

  it('reports the next deadline and runs the timeline dry', async () => {
    const clock = createFakeClock({ start: 0 })
    const fired: number[] = []
    clock.after(5_000, () => fired.push(1))
    clock.after(60_000, () => fired.push(2))

    expect(clock.nextDeadline()).toBe(5_000)
    await clock.next()
    expect(fired).toEqual([1])
    expect(clock.now()).toBe(5_000)

    await clock.runAll()
    expect(fired).toEqual([1, 2])
    expect(clock.now()).toBe(60_000)
    expect(clock.nextDeadline()).toBeUndefined()

    await clock.next() // no-op on a quiet timeline
    expect(clock.now()).toBe(60_000)
  })

  it('compresses long timelines instantly', async () => {
    const clock = createFakeClock({ start: 0 })
    let fired = false
    clock.after(90 * 24 * 60 * 60 * 1000, () => {
      fired = true
    })

    await clock.runAll()
    expect(fired).toBe(true)
  })

  it('refuses to travel backwards or advance by a negative duration', async () => {
    const clock = createFakeClock({ start: 1_000 })
    await expect(clock.advance(-1)).rejects.toThrow(RangeError)
    await expect(clock.advanceTo(999)).rejects.toThrow(RangeError)
  })

  it('breaks out of a self-re-arming timer storm', async () => {
    const clock = createFakeClock({ start: 0 })
    const rearm = (): void => {
      clock.after(0, rearm)
    }
    rearm()

    await expect(clock.advance(1)).rejects.toThrow(/timer storm/)
  })
})
