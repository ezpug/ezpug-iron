/**
 * **The delivery and retry policy**, as constants a client can plan around
 * and the orchestrator and the fake both obey (a test drives the fake through
 * the whole schedule on a fake clock).
 *
 * One envelope, one POST, `Content-Type: application/json`, the signature and
 * delivery headers from `signature.ts`. The endpoint answers any `2xx` within
 * {@link WEBHOOK_ATTEMPT_TIMEOUT_MS} and the delivery is done; the body of
 * the answer is ignored. Anything else — a timeout, a connection error, a
 * `5xx`, a `429`, a `4xx` the endpoint should not have sent — is retried on
 * {@link WEBHOOK_RETRY_DELAYS_MS}, each attempt re-signed with a fresh `t`,
 * the same `deliveryId` and an incremented attempt header, until the
 * schedule is exhausted. A delivery given up on is still in the events
 * route; nothing is lost, only late.
 *
 * The one answer that stops retries early is {@link WEBHOOK_STOP_STATUS},
 * `410 Gone`: the endpoint says it no longer wants this match's webhooks. The
 * orchestrator marks the delivery stopped and sends nothing more for the
 * match; the events route and the stream keep working, so a client that
 * lost interest and regains it replays from there.
 *
 * Deliveries of one match are attempted in `seq` order, but a delivery in
 * its retry wait does not hold later ones back — see the envelope's note on
 * ordering.
 */

/**
 * The wait before each retry, in order: the first retry five seconds after
 * the first failure, the last eight hours after the ninth. Roughly sixteen
 * hours in all — longer than any match lives, shorter than the day after
 * which an operator has read the log anyway.
 */
export const WEBHOOK_RETRY_DELAYS_MS = [
  5_000,
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  4 * 60 * 60_000,
  8 * 60 * 60_000,
] as const

/** The first attempt plus every retry. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1

/** How long one POST may take before it counts as failed. */
export const WEBHOOK_ATTEMPT_TIMEOUT_MS = 10_000

/** The status that stops retries for the delivery and every later one of its match. */
export const WEBHOOK_STOP_STATUS = 410

/** What one attempt's answer means. `null` is no answer at all: a timeout or a connection error. */
export type WebhookAttemptOutcome = 'delivered' | 'retry' | 'stopped'

export function webhookAttemptOutcome(status: number | null): WebhookAttemptOutcome {
  if (status === null) return 'retry'
  if (status >= 200 && status < 300) return 'delivered'
  if (status === WEBHOOK_STOP_STATUS) return 'stopped'
  return 'retry'
}

/**
 * How long to wait after `attempt` (1-based, the attempt that just failed)
 * before the next one, or null when the schedule is exhausted and the
 * delivery is given up on.
 */
export function webhookRetryDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('attempt is 1-based')
  return WEBHOOK_RETRY_DELAYS_MS[attempt - 1] ?? null
}
