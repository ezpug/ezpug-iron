import { createFakeClock } from '@ezpug/core'
import { describe, expect, it } from 'vitest'
import { IDEMPOTENCY_KEY_HEADER } from '../rpc'
import {
  CLIENT_MAX_ATTEMPTS,
  CLIENT_RETRY_AFTER_MAX_MS,
  CLIENT_RETRY_DELAYS_MS,
  clientRetryDelayMs,
  createRetryingFetch,
  isRetryableRequest,
  isRetryableStatus,
  type RetryInfo,
  retryAfterDelayMs,
  TransportError,
} from './retry'

const T0 = Date.parse('2026-09-05T18:00:00.000Z')

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** Run `call` while the fake clock fires whatever it sleeps on. */
async function drive<T>(clock: ReturnType<typeof createFakeClock>, call: Promise<T>): Promise<T> {
  let settled = false
  const tracked = call.then(
    value => {
      settled = true
      return value
    },
    error => {
      settled = true
      throw error
    },
  )
  tracked.catch(() => {})
  for (let round = 0; round < 100 && !settled; round += 1) {
    await clock.runAll()
    await Promise.resolve()
  }
  return tracked
}

describe('the retry policy', () => {
  it('is five attempts over about seventeen seconds', () => {
    expect(CLIENT_MAX_ATTEMPTS).toBe(5)
    expect(CLIENT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBe(17_000)
    expect(clientRetryDelayMs(1)).toBe(200)
    expect(clientRetryDelayMs(CLIENT_MAX_ATTEMPTS)).toBeNull()
    expect(() => clientRetryDelayMs(0)).toThrow(RangeError)
  })

  it('retries too-many-requests and the orchestrator’s own faults, nothing else', () => {
    expect(isRetryableStatus(429)).toBe(true)
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(503)).toBe(true)
    // Money, validation and refusals are verdicts, not weather.
    for (const status of [200, 201, 400, 401, 402, 403, 404, 409, 422]) {
      expect(isRetryableStatus(status)).toBe(false)
    }
  })

  it('repeats a GET always and anything else only with an idempotency key', () => {
    const bare = new Headers()
    const keyed = new Headers({ [IDEMPOTENCY_KEY_HEADER]: 'matches.create:platform-match-1' })
    expect(isRetryableRequest('GET', bare)).toBe(true)
    expect(isRetryableRequest('get', bare)).toBe(true)
    expect(isRetryableRequest('POST', bare)).toBe(false)
    expect(isRetryableRequest('POST', keyed)).toBe(true)
    expect(isRetryableRequest('DELETE', bare)).toBe(false)
  })

  it('reads Retry-After as seconds or a date, and refuses a silly one', () => {
    expect(retryAfterDelayMs('2', T0)).toBe(2_000)
    expect(retryAfterDelayMs(' 30 ', T0)).toBe(30_000)
    expect(retryAfterDelayMs(new Date(T0 + 4_000).toUTCString(), T0)).toBe(4_000)
    expect(retryAfterDelayMs(null, T0)).toBeNull()
    expect(retryAfterDelayMs('soon', T0)).toBeNull()
    expect(retryAfterDelayMs('-5', T0)).toBeNull()
    expect(retryAfterDelayMs(new Date(T0 - 10_000).toUTCString(), T0)).toBeNull()
    expect(retryAfterDelayMs(String(CLIENT_RETRY_AFTER_MAX_MS / 1000 + 1), T0)).toBeNull()
  })
})

describe('the retrying fetch', () => {
  it('rides out a 429 storm on the clock, honouring Retry-After', async () => {
    const clock = createFakeClock({ start: T0 })
    const seen: RetryInfo[] = []
    let attempts = 0
    const fetchImpl = createRetryingFetch({
      clock,
      onRetry: info => seen.push(info),
      fetch: () => {
        attempts += 1
        return Promise.resolve(
          attempts <= 3
            ? json(
                429,
                { error: { code: 'rate_limited', message: 'slow down' } },
                {
                  'retry-after': '2',
                },
              )
            : json(200, { ok: true }),
        )
      },
    })

    const response = await drive(clock, fetchImpl('https://gs.ezpug.example/v1/capacity'))
    expect(response.status).toBe(200)
    expect(attempts).toBe(4)
    expect(seen.map(info => info.delayMs)).toEqual([2_000, 2_000, 2_000])
    expect(seen.map(info => info.status)).toEqual([429, 429, 429])
    expect(clock.now()).toBe(T0 + 6_000)
  })

  it('falls back to the schedule when nothing was asked for, and gives the last answer back when it runs out', async () => {
    const clock = createFakeClock({ start: T0 })
    const delays: number[] = []
    let attempts = 0
    const fetchImpl = createRetryingFetch({
      clock,
      onRetry: info => delays.push(info.delayMs),
      fetch: () => {
        attempts += 1
        return Promise.resolve(json(503, { error: { code: 'internal', message: 'down' } }))
      },
    })

    const response = await drive(clock, fetchImpl('https://gs.ezpug.example/v1/capacity'))
    // The answer is handed back, not thrown: the caller's client turns it into
    // the typed `ApiError` the envelope names.
    expect(response.status).toBe(503)
    expect(attempts).toBe(CLIENT_MAX_ATTEMPTS)
    expect(delays).toEqual([...CLIENT_RETRY_DELAYS_MS])
  })

  it('does not repeat an unsafe request without an idempotency key', async () => {
    const clock = createFakeClock({ start: T0 })
    let attempts = 0
    const fetchImpl = createRetryingFetch({
      clock,
      fetch: () => {
        attempts += 1
        return Promise.resolve(json(503, { error: { code: 'internal', message: 'down' } }))
      },
    })
    const response = await drive(
      clock,
      fetchImpl('https://gs.ezpug.example/v1/matches/x/player-tokens', { method: 'POST' }),
    )
    expect(response.status).toBe(503)
    expect(attempts).toBe(1)

    const keyed = await drive(
      clock,
      fetchImpl('https://gs.ezpug.example/v1/matches', {
        method: 'POST',
        headers: { [IDEMPOTENCY_KEY_HEADER]: 'matches.create:platform-match-1' },
      }),
    )
    expect(keyed.status).toBe(503)
    expect(attempts).toBe(1 + CLIENT_MAX_ATTEMPTS)
  })

  it('throws a TransportError when no attempt produced an answer at all', async () => {
    const clock = createFakeClock({ start: T0 })
    let attempts = 0
    const fetchImpl = createRetryingFetch({
      clock,
      delaysMs: [10, 10],
      fetch: () => {
        attempts += 1
        return Promise.reject(new Error('ECONNREFUSED'))
      },
    })
    const error = await drive(
      clock,
      fetchImpl('https://gs.ezpug.example/v1/capacity').then(
        () => null,
        (thrown: unknown) => thrown,
      ),
    )
    expect(error).toBeInstanceOf(TransportError)
    expect((error as TransportError).attempts).toBe(3)
    expect((error as TransportError).cause).toBeInstanceOf(Error)
    expect(attempts).toBe(3)
  })
})
