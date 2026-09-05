import type { Clock } from '@ezpug/core'
import { IDEMPOTENCY_KEY_HEADER } from '../rpc'

/**
 * **What the client does about a bad minute.** The orchestrator is one
 * process in front of a provider; a `503` while a node reconnects, a `429`
 * under a burst, a `502` from the reverse proxy mid-deploy are all things
 * that are over in seconds. The client rides them out on the injected clock
 * instead of handing the caller an error it would only have retried itself —
 * and never reads a wall clock doing it, so a test drives a whole retry
 * schedule in microseconds.
 *
 * Two rules decide whether an attempt is repeated at all:
 *
 * - **Only a safe or idempotent request.** A `GET` always; anything else only
 *   when the client could set an `Idempotency-Key` for it ({@link IDEMPOTENCY_KEY_HEADER}
 *   — `clientMatchId` on a create, `correlationId` on a command). Minting a
 *   player token twice is not the client's decision to make.
 * - **Only a retryable answer.** No answer at all (a connection error), a
 *   `429`, or any `5xx` ({@link isRetryableStatus}). Everything else is the
 *   orchestrator's verdict and stands — a `402 budget_exceeded` is money, not
 *   weather, and repeating it only wastes the ceiling it just refused.
 *
 * A `Retry-After` on the answer wins over the schedule, capped
 * ({@link CLIENT_RETRY_AFTER_MAX_MS}) so a confused proxy cannot park a
 * caller for an hour.
 */

/**
 * The wait before each retry: four retries, five attempts in all, about
 * seventeen seconds end to end — long enough to cross a restart, short
 * enough that a match request still fails inside a human's patience.
 */
export const CLIENT_RETRY_DELAYS_MS = [200, 800, 3_200, 12_800] as const

/** The first attempt plus every retry. */
export const CLIENT_MAX_ATTEMPTS = CLIENT_RETRY_DELAYS_MS.length + 1

/** The longest `Retry-After` the client honours before falling back to the schedule. */
export const CLIENT_RETRY_AFTER_MAX_MS = 60_000

/** The header a `429` (or a `503`) asks with: seconds, or an HTTP date. */
export const RETRY_AFTER_HEADER = 'retry-after'

/** An answer worth attempting again: too many requests, or the orchestrator's own fault. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * How long to wait after `attempt` (1-based, the attempt that just failed)
 * before the next one, or null when the schedule is exhausted.
 */
export function clientRetryDelayMs(
  attempt: number,
  delays: readonly number[] = CLIENT_RETRY_DELAYS_MS,
): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('attempt is 1-based')
  return delays[attempt - 1] ?? null
}

/**
 * The wait a `Retry-After` asks for, in milliseconds, or null when the header
 * is absent, unparseable, in the past or beyond
 * {@link CLIENT_RETRY_AFTER_MAX_MS}. `now` comes from the injected clock, so
 * the date form is measured against the same timeline as everything else.
 */
export function retryAfterDelayMs(
  header: string | null | undefined,
  now: number,
  maxMs: number = CLIENT_RETRY_AFTER_MAX_MS,
): number | null {
  if (!header) return null
  const trimmed = header.trim()
  const seconds = /^\d+$/.test(trimmed) ? Number(trimmed) : null
  const delayMs = seconds === null ? new Date(trimmed).getTime() - now : seconds * 1000
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > maxMs) return null
  return delayMs
}

/** The knobs a caller may turn; the defaults are the published policy. */
export interface RetryPolicy {
  /** The wait before attempt 2, 3, … An empty array attempts once and gives up. */
  delaysMs?: readonly number[]
  /** Cap on an honoured `Retry-After`. Default {@link CLIENT_RETRY_AFTER_MAX_MS}. */
  retryAfterMaxMs?: number
  /** Called before each wait — a caller's log line, and what a test counts. */
  onRetry?: (info: RetryInfo) => void
}

export interface RetryInfo {
  /** The attempt that just failed, 1-based. */
  attempt: number
  /** How long the client is about to wait. */
  delayMs: number
  /** The status that provoked it, or null for a connection error. */
  status: number | null
  /** The connection error, when there was one. */
  cause?: unknown
  url: string
  method: string
}

/**
 * What the client throws when every attempt failed to produce an answer at
 * all — DNS, a refused connection, a socket cut mid-body. There is no status
 * and no error code to branch on, only the last cause; a caller that wants to
 * tell "the orchestrator refused" from "the orchestrator was not there"
 * catches this before `ApiError`.
 */
export class TransportError extends Error {
  override readonly name = 'TransportError'
  constructor(
    message: string,
    readonly attempts: number,
    override readonly cause: unknown,
  ) {
    super(message)
  }
}

/** True for a request the client may repeat: `GET`/`HEAD`, or one carrying an idempotency key. */
export function isRetryableRequest(method: string, headers: Headers): boolean {
  const verb = method.toUpperCase()
  if (verb === 'GET' || verb === 'HEAD') return true
  return headers.has(IDEMPOTENCY_KEY_HEADER)
}

export interface RetryingFetchOptions extends RetryPolicy {
  /** The fetch that actually goes out. Default `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch
  /** Every wait sleeps here; nothing reads the wall clock. */
  clock: Clock
}

/**
 * A `fetch` with the policy above wrapped around it — used by
 * `createMatchApiClient`, exported so an orchestrator-to-orchestrator call or
 * a demo upload can borrow the same behaviour.
 */
export function createRetryingFetch(options: RetryingFetchOptions): typeof globalThis.fetch {
  const delays = options.delaysMs ?? CLIENT_RETRY_DELAYS_MS
  const send = options.fetch ?? globalThis.fetch
  return async (input, init) => {
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const retryable = isRetryableRequest(method, headers)
    for (let attempt = 1; ; attempt += 1) {
      let response: Response | null = null
      let cause: unknown
      try {
        response = await send(input, init)
      } catch (error) {
        cause = error
      }
      const status = response ? response.status : null
      if (response && !isRetryableStatus(response.status)) return response
      const scheduled = retryable ? clientRetryDelayMs(attempt, delays) : null
      if (scheduled === null) {
        if (response) return response
        throw new TransportError(
          `${method.toUpperCase()} ${url}: no answer after ${attempt} attempt(s)`,
          attempt,
          cause,
        )
      }
      const asked = response
        ? retryAfterDelayMs(
            response.headers.get(RETRY_AFTER_HEADER),
            options.clock.now(),
            options.retryAfterMaxMs,
          )
        : null
      const delayMs = asked ?? scheduled
      // The body of a refused answer is never read; release it before the wait.
      await response?.body?.cancel().catch(() => {})
      options.onRetry?.({ attempt, delayMs, status, cause, url, method: method.toUpperCase() })
      await options.clock.sleep(delayMs)
    }
  }
}
