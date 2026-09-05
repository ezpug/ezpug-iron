import { useFakeClock } from '@ezpug/core/testing'
import { describe, expect, it } from 'vitest'
import { createHealth, HEALTH_CHECK_TIMEOUT_MS } from './health'

const clock = useFakeClock()

describe('createHealth', () => {
  it('is ok when every rail answers', async () => {
    const health = createHealth({
      clock,
      database: () => Promise.resolve(),
      redis: () => Promise.resolve(),
      providers: { sim: () => Promise.resolve() },
    })
    expect(await health()).toEqual({
      ok: true,
      checks: {
        database: { ok: true, latencyMs: 0 },
        redis: { ok: true, latencyMs: 0 },
        providers: { sim: { ok: true, latencyMs: 0 } },
      },
    })
  })

  it('reports the rail that failed, with its message, and stays ok: false', async () => {
    const health = createHealth({
      clock,
      database: () => Promise.reject(new Error('cannot reach EZPUG_IRON_DATABASE_URL=…')),
      redis: () => Promise.resolve(),
    })
    const report = await health()
    expect(report.ok).toBe(false)
    expect(report.checks.database).toEqual({
      ok: false,
      latencyMs: 0,
      error: 'cannot reach EZPUG_IRON_DATABASE_URL=…',
    })
    expect(report.checks.redis.ok).toBe(true)
  })

  it('bounds a rail that never answers on the clock', async () => {
    const health = createHealth({
      clock,
      database: () => new Promise(() => {}),
      redis: () => Promise.resolve(),
    })
    const pending = health()
    await clock.advance(HEALTH_CHECK_TIMEOUT_MS)
    const report = await pending
    expect(report.checks.database).toEqual({
      ok: false,
      latencyMs: HEALTH_CHECK_TIMEOUT_MS,
      error: `no answer within ${HEALTH_CHECK_TIMEOUT_MS}ms`,
    })
    expect(clock.pending()).toBe(0)
  })
})
