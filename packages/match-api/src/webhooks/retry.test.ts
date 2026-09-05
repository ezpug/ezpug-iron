import { describe, expect, it } from 'vitest'
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_STOP_STATUS,
  webhookAttemptOutcome,
  webhookRetryDelayMs,
} from './retry'

describe('the retry policy', () => {
  it('publishes an increasing schedule that gives up inside a day', () => {
    for (let i = 1; i < WEBHOOK_RETRY_DELAYS_MS.length; i += 1)
      expect(WEBHOOK_RETRY_DELAYS_MS[i]).toBeGreaterThan(WEBHOOK_RETRY_DELAYS_MS[i - 1]!)
    const total = WEBHOOK_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)
    expect(total).toBeLessThan(24 * 60 * 60_000)
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(10)
  })

  it('waits the published delay after each failed attempt, then gives up', () => {
    expect(webhookRetryDelayMs(1)).toBe(5_000)
    expect(webhookRetryDelayMs(WEBHOOK_MAX_ATTEMPTS - 1)).toBe(8 * 60 * 60_000)
    expect(webhookRetryDelayMs(WEBHOOK_MAX_ATTEMPTS)).toBeNull()
    expect(() => webhookRetryDelayMs(0)).toThrow(RangeError)
  })

  it('reads an answer: any 2xx is done, 410 stops, everything else retries', () => {
    expect(webhookAttemptOutcome(200)).toBe('delivered')
    expect(webhookAttemptOutcome(204)).toBe('delivered')
    expect(webhookAttemptOutcome(WEBHOOK_STOP_STATUS)).toBe('stopped')
    for (const status of [null, 400, 401, 404, 408, 429, 500, 502, 503])
      expect(webhookAttemptOutcome(status), String(status)).toBe('retry')
  })
})
