import { useFakeClock } from '@ezpug/core/testing'
import { describe, expect, it } from 'vitest'
import { createRateLimiter } from './rate-limit'

const clock = useFakeClock()

describe('createRateLimiter', () => {
  it('lets a burst through and then refuses with a wait', () => {
    const limiter = createRateLimiter({ clock, burst: 3, perSecond: 1 })
    expect(limiter.take('a')).toEqual({ ok: true })
    expect(limiter.take('a')).toEqual({ ok: true })
    expect(limiter.take('a')).toEqual({ ok: true })
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterMs: 1000 })
  })

  it('refills on the clock, never above the burst', async () => {
    const limiter = createRateLimiter({ clock, burst: 2, perSecond: 2 })
    limiter.take('a')
    limiter.take('a')
    expect(limiter.take('a').ok).toBe(false)
    await clock.advance(500)
    expect(limiter.take('a')).toEqual({ ok: true })
    expect(limiter.take('a').ok).toBe(false)
    await clock.advance(60_000)
    expect(limiter.take('a').ok).toBe(true)
    expect(limiter.take('a').ok).toBe(true)
    expect(limiter.take('a').ok).toBe(false)
  })

  it('keeps callers apart', () => {
    const limiter = createRateLimiter({ clock, burst: 1, perSecond: 1 })
    expect(limiter.take('a').ok).toBe(true)
    expect(limiter.take('b').ok).toBe(true)
    expect(limiter.take('a').ok).toBe(false)
  })

  it('forgets a caller once its bucket is full again', async () => {
    const limiter = createRateLimiter({ clock, burst: 2, perSecond: 1 })
    limiter.take('a')
    limiter.take('b')
    expect(limiter.size()).toBe(2)
    await clock.advance(5_000)
    limiter.take('c')
    expect(limiter.size()).toBe(1)
  })

  it('refuses a nonsense configuration', () => {
    expect(() => createRateLimiter({ clock, burst: 0, perSecond: 1 })).toThrow(RangeError)
  })
})
