import type { Clock } from '@ezpug/core'

/**
 * **A token bucket per caller, on the clock.** `burst` tokens deep, refilled
 * at `perSecond`; a request takes one, and a caller with none waits
 * `retryAfterMs`. Per process and in memory: the ceiling exists to stop a
 * runaway client, not to meter one, so a second replica doubling it is
 * fine and a Redis round trip per request is not worth it.
 *
 * Buckets are keyed by the caller's *presented* credential's hash (or
 * `anonymous`), decided before any database lookup — so a stranger hammering
 * the door is refused from memory, and cannot spend a real key's budget
 * without holding it. Idle buckets are forgotten after they refill, so the
 * map does not grow with every key ever seen.
 */
export interface RateLimiter {
  /** Take one token for `key`. `ok: false` carries how long to wait. */
  take: (key: string) => { ok: true } | { ok: false; retryAfterMs: number }
  /** Buckets currently held — a leak check for tests. */
  size: () => number
}

export interface RateLimiterOptions {
  clock: Clock
  burst: number
  perSecond: number
}

interface Bucket {
  tokens: number
  updatedAt: number
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { clock, burst, perSecond } = options
  if (burst < 1 || perSecond <= 0) throw new RangeError('rate limit: burst ≥ 1 and perSecond > 0')
  const buckets = new Map<string, Bucket>()

  const refill = (bucket: Bucket, now: number): void => {
    const elapsed = Math.max(0, now - bucket.updatedAt)
    bucket.tokens = Math.min(burst, bucket.tokens + (elapsed / 1000) * perSecond)
    bucket.updatedAt = now
  }

  return {
    take(key) {
      const now = clock.now()
      // Forget every bucket that is full again: a caller that has been quiet
      // for `burst / perSecond` seconds is indistinguishable from a new one.
      for (const [other, bucket] of buckets) {
        if (other === key) continue
        refill(bucket, now)
        if (bucket.tokens >= burst) buckets.delete(other)
      }
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = { tokens: burst, updatedAt: now }
        buckets.set(key, bucket)
      } else refill(bucket, now)
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1
        return { ok: true }
      }
      const retryAfterMs = Math.ceil(((1 - bucket.tokens) / perSecond) * 1000)
      return { ok: false, retryAfterMs }
    },
    size: () => buckets.size,
  }
}
