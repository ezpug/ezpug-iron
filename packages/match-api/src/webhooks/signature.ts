/**
 * **The webhook signature scheme.** Every webhook the orchestrator POSTs
 * carries
 *
 *     X-EZPug-Signature: t=<unix seconds>,kid=<secret id>,v1=<hex hmac-sha256>
 *
 * where the HMAC key is the secret registered on the API key under `kid`
 * (`PUT /v1/keys/:keyId/webhook-secrets`; the id the match request named in
 * `callbacks.webhookSecretId`) and the signed string is `t + "." + body`,
 * the body being the exact bytes on the wire — never a re-serialisation of
 * the parsed JSON, so key order cannot matter and no library is needed on
 * either side. `t` is the orchestrator's clock at send time; a verifier
 * refuses a signature older or newer than {@link WEBHOOK_SIGNATURE_TOLERANCE_MS}
 * against its own clock, which bounds how long a captured request can be
 * replayed. A retry is re-signed with a fresh `t`.
 *
 * `kid` is what makes rotation a non-event: the client registers a new id,
 * switches new match requests to it, and keeps verifying with both until
 * the last match that named the old one has ended. A header may carry more
 * than one `v1=` (the orchestrator signs with two secrets while an
 * orchestrator-side rotation is in flight); any one that verifies is enough.
 *
 * Web Crypto only (`crypto.subtle`), so the same verifier runs in Node, a
 * worker and a browser. The clock is injected; nothing here reads
 * `Date.now()`. Both halves are here — the orchestrator and the fake sign
 * with {@link signWebhook}, a consumer verifies with
 * {@link verifyWebhookSignature} — so a contract test can round-trip them.
 */

/** The header the signature travels in. Header names are case-insensitive; this is the canonical spelling. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-ezpug-signature'
/** The delivery id, repeated as a header so a consumer can dedupe before it parses a body. */
export const WEBHOOK_DELIVERY_HEADER = 'x-ezpug-delivery'
/** Which attempt this is, 1-based — the first delivery is `1`. */
export const WEBHOOK_ATTEMPT_HEADER = 'x-ezpug-attempt'
/** The signature version this package produces and accepts. */
export const WEBHOOK_SIGNATURE_VERSION = 'v1'
/** How far `t` may sit from the verifier's clock, either way: five minutes. */
export const WEBHOOK_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000
/** What a webhook body is. Bodies are UTF-8 JSON, one envelope each. */
export const WEBHOOK_CONTENT_TYPE = 'application/json'

/** The one thing a verifier needs from a clock. `Clock` from `@ezpug/core` and the platform's satisfy it. */
export interface SignatureClock {
  /** The current instant, epoch milliseconds. */
  now: () => number
}

/** The secrets a verifier knows, by id — the ids registered on the API key. */
export type WebhookSecrets = Readonly<Record<string, string>>

const encoder = new TextEncoder()

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** HMAC-SHA256 of `payload` under `secret`, lowercase hex. */
export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)))
}

/**
 * Constant-time equality of two strings of the same length. Two lengths that
 * differ are unequal without comparing — the length of a hex digest is not a
 * secret.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** The signed string: `t` in seconds, a dot, the body as sent. */
export function webhookSignedPayload(timestampSeconds: number, body: string): string {
  return `${timestampSeconds}.${body}`
}

export interface SignWebhookInput {
  /** The exact body that will be sent. */
  body: string
  /** The secret to sign with, and its id for the `kid` element. */
  secretId: string
  secret: string
  /** The sender's clock; `t` is derived from it. */
  clock: SignatureClock
}

/** Produce the `X-EZPug-Signature` value for one delivery. */
export async function signWebhook(input: SignWebhookInput): Promise<string> {
  const t = Math.floor(input.clock.now() / 1000)
  const digest = await hmacSha256Hex(input.secret, webhookSignedPayload(t, input.body))
  return `t=${t},kid=${input.secretId},${WEBHOOK_SIGNATURE_VERSION}=${digest}`
}

/** A parsed signature header. */
export interface ParsedWebhookSignature {
  /** `t`, unix seconds. */
  timestamp: number
  /** `kid`, the secret id — absent on a header that did not carry one. */
  secretId: string | null
  /** Every `v1=` digest, in order. */
  signatures: string[]
}

/**
 * Split the header into its elements. Returns null for anything that is not
 * `t=<digits>` plus at least one `v1=<hex>`; unknown elements are ignored
 * so a future `v2=` can ride beside `v1=`.
 */
export function parseWebhookSignature(header: string): ParsedWebhookSignature | null {
  let timestamp: number | null = null
  let secretId: string | null = null
  const signatures: string[] = []
  for (const element of header.split(',')) {
    const eq = element.indexOf('=')
    if (eq <= 0) return null
    const key = element.slice(0, eq).trim()
    const value = element.slice(eq + 1).trim()
    if (key === 't') {
      if (!/^\d{1,12}$/.test(value)) return null
      timestamp = Number(value)
    } else if (key === 'kid') {
      if (value.length === 0) return null
      secretId = value
    } else if (key === WEBHOOK_SIGNATURE_VERSION) {
      if (!/^[0-9a-f]{64}$/.test(value)) return null
      signatures.push(value)
    }
  }
  if (timestamp === null || signatures.length === 0) return null
  return { timestamp, secretId, signatures }
}

export interface VerifyWebhookSignatureInput {
  /** The `X-EZPug-Signature` value, or null/undefined when the header is missing. */
  header: string | null | undefined
  /** The body exactly as received. */
  body: string
  secrets: WebhookSecrets
  clock: SignatureClock
  /** Override the skew window (tests, a consumer with a known-bad clock). */
  toleranceMs?: number
}

/** Why a signature was refused. A consumer logs the reason and answers `401`; it never retries a refusal itself. */
export type WebhookSignatureFailure =
  | 'missing_header'
  | 'malformed_header'
  | 'stale_timestamp'
  | 'unknown_secret'
  | 'signature_mismatch'

export type WebhookSignatureResult =
  | { ok: true; secretId: string; timestamp: number }
  | { ok: false; reason: WebhookSignatureFailure }

/**
 * Verify one delivery. Checks, in order: the header parses; `t` is inside the
 * tolerance of the verifier's clock; the `kid` (when present) names a known
 * secret; and one of the digests matches under that secret — or, for a
 * header without a `kid`, under any known secret. The timestamp is checked
 * *before* any HMAC so a stale replay costs nothing.
 */
export async function verifyWebhookSignature(
  input: VerifyWebhookSignatureInput,
): Promise<WebhookSignatureResult> {
  if (input.header === null || input.header === undefined || input.header.length === 0)
    return { ok: false, reason: 'missing_header' }
  const parsed = parseWebhookSignature(input.header)
  if (!parsed) return { ok: false, reason: 'malformed_header' }

  const tolerance = input.toleranceMs ?? WEBHOOK_SIGNATURE_TOLERANCE_MS
  const skewMs = Math.abs(input.clock.now() - parsed.timestamp * 1000)
  if (skewMs > tolerance) return { ok: false, reason: 'stale_timestamp' }

  const candidates: [string, string][] =
    parsed.secretId === null
      ? Object.entries(input.secrets)
      : Object.hasOwn(input.secrets, parsed.secretId)
        ? [[parsed.secretId, input.secrets[parsed.secretId] as string]]
        : []
  if (candidates.length === 0) return { ok: false, reason: 'unknown_secret' }

  const payload = webhookSignedPayload(parsed.timestamp, input.body)
  for (const [secretId, secret] of candidates) {
    const expected = await hmacSha256Hex(secret, payload)
    if (parsed.signatures.some(signature => constantTimeEqual(signature, expected)))
      return { ok: true, secretId, timestamp: parsed.timestamp }
  }
  return { ok: false, reason: 'signature_mismatch' }
}
