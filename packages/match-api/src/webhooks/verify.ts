import { type WebhookEnvelope, webhookEnvelopeSchema } from './envelope'
import {
  type SignatureClock,
  verifyWebhookSignature,
  WEBHOOK_ATTEMPT_HEADER,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookSecrets,
  type WebhookSignatureFailure,
} from './signature'

/**
 * **The consumer's half of a webhook, in one call.** A handler receives the
 * request's headers and the *raw* body, hands them here with the secrets it
 * knows and its clock, and gets back either the parsed envelope or the reason
 * to refuse and the status to answer with:
 *
 * ```ts
 * const raw = await request.text()
 * const result = await verifyWebhook({ headers: request.headers, body: raw, secrets, clock })
 * if (!result.ok) return new Response(null, { status: result.status })
 * if (await deduper.check(result.envelope)) return new Response(null, { status: 200 })
 * await handle(result.envelope)
 * return new Response(null, { status: 200 })
 * ```
 *
 * Two rules a consumer must not talk itself out of:
 *
 * - **Verify the bytes that arrived**, never a re-serialisation of the parsed
 *   JSON. Key order and whitespace are not preserved by a round trip, and the
 *   HMAC is over the bytes. Read the body as text once, verify it, then parse
 *   it — which is the order this function does it in.
 * - **Answer fast.** A `2xx` inside ten seconds ends the delivery
 *   (`./retry`); anything slower is retried and your handler runs twice. Do
 *   the work after the answer, keyed by `(matchId, seq)` so the second run is
 *   a no-op ({@link ./deduper}).
 *
 * Refusing is not a retry request: a `401` here means the sender is not us,
 * and the orchestrator will still retry it on the published schedule, so a
 * consumer whose secret was wrong for a minute loses nothing.
 */

/** What headers may arrive as: `Headers`, Node's `req.headers`, or a plain record. */
export type WebhookHeaders =
  | Headers
  | Readonly<Record<string, string | string[] | undefined>>
  | ReadonlyArray<readonly [string, string]>

/** One header, case-insensitively, from any of those shapes. A repeated header takes the first. */
export function webhookHeader(headers: WebhookHeaders, name: string): string | null {
  const wanted = name.toLowerCase()
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(wanted)
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers as ReadonlyArray<readonly [string, string]>)
      if (key.toLowerCase() === wanted) return value
    return null
  }
  for (const [key, value] of Object.entries(
    headers as Record<string, string | string[] | undefined>,
  )) {
    if (key.toLowerCase() !== wanted) continue
    if (value === undefined) return null
    return Array.isArray(value) ? (value[0] ?? null) : value
  }
  return null
}

export interface VerifyWebhookInput {
  headers: WebhookHeaders
  /** The body exactly as received, as text. */
  body: string
  /** The secrets registered on the API key, by id. */
  secrets: WebhookSecrets
  clock: SignatureClock
  /** Override the five-minute skew window (a consumer with a known-bad clock). */
  toleranceMs?: number
}

/** Why a delivery was refused: the signature failures, plus a body that was not an envelope. */
export type WebhookVerificationFailure = WebhookSignatureFailure | 'invalid_body'

export type VerifyWebhookResult =
  | {
      ok: true
      envelope: WebhookEnvelope
      /** Which registered secret verified it. */
      secretId: string
      /** `X-EZPug-Delivery`, or the envelope's own id when the header was missing. */
      deliveryId: string
      /** `X-EZPug-Attempt`, 1-based; 1 when the header was missing or unreadable. */
      attempt: number
      /** The `t` that was signed, unix seconds. */
      timestamp: number
    }
  | {
      ok: false
      reason: WebhookVerificationFailure
      /** What to answer: `401` for a signature the consumer does not trust, `400` for a body it cannot read. */
      status: 400 | 401
      /** For a log line. Never the secret, never the body. */
      message: string
    }

/**
 * Parse a webhook body into an envelope. Takes the raw text (or an
 * already-parsed value) and throws on anything that is not an envelope —
 * `verifyWebhook` uses the non-throwing path internally, so this is for a
 * consumer replaying its own store or reading the events route.
 */
export function parseEnvelope(raw: string | unknown): WebhookEnvelope {
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
  return webhookEnvelopeSchema.parse(value)
}

/** Verify one delivery and parse it: the signature first, the envelope second. */
export async function verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
  const signature = await verifyWebhookSignature({
    header: webhookHeader(input.headers, WEBHOOK_SIGNATURE_HEADER),
    body: input.body,
    secrets: input.secrets,
    clock: input.clock,
    ...(input.toleranceMs !== undefined && { toleranceMs: input.toleranceMs }),
  })
  if (!signature.ok)
    return {
      ok: false,
      reason: signature.reason,
      status: 401,
      message: `webhook signature refused: ${signature.reason}`,
    }

  let envelope: WebhookEnvelope
  try {
    envelope = parseEnvelope(input.body)
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid_body',
      status: 400,
      message: `webhook body is not an envelope: ${error instanceof Error ? error.message : 'unparseable'}`,
    }
  }

  const attemptHeader = webhookHeader(input.headers, WEBHOOK_ATTEMPT_HEADER)
  const attempt = attemptHeader !== null && /^\d+$/.test(attemptHeader) ? Number(attemptHeader) : 1
  return {
    ok: true,
    envelope,
    secretId: signature.secretId,
    deliveryId: webhookHeader(input.headers, WEBHOOK_DELIVERY_HEADER) ?? envelope.deliveryId,
    attempt: attempt > 0 ? attempt : 1,
    timestamp: signature.timestamp,
  }
}
