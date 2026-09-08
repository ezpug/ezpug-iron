import { createFakeClock, type FakeClock } from '@ezpug/core'
import type { ConformanceTarget } from '../fixtures'
import type { ApiKeyCreated, WebhookEnvelope } from '../index'
import {
  constantTimeEqual,
  parseWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_TOLERANCE_MS,
  webhookEnvelopeSchema,
  webhookSignedPayload,
} from '../webhooks'
import { createFakeOrchestrator } from './orchestrator'
import { hmacSha256HexSync } from './sha256'
import type { FakeOrchestrator, FakeOrchestratorOptions } from './types'

/**
 * **The fake, wired as a conformance target** (PRD-01 T8) — the one line the
 * suite needs to run against it:
 *
 * ```ts
 * const report = await runMatchApiConformance({ target: () => createFakeConformanceTarget() })
 * ```
 *
 * A fresh instance per flow, on a fake clock at a fixed instant with the
 * seeded PRNG: two runs play the same match, mint the same ids and produce
 * the same recorded fixtures. Every delivery is **verified before it is
 * handed on** — the target is a consumer, so it does what a consumer does,
 * and a body that did not verify never reaches the suite, which then fails
 * the flow for a missing delivery rather than passing it quietly.
 */

/** Where the conformance clock starts. Fixed, so every timestamp in a golden file is. */
export const FAKE_CONFORMANCE_START = Date.parse('2026-09-05T18:00:00.000Z')
export const FAKE_CONFORMANCE_WEBHOOK_URL = 'https://platform.invalid/hooks/ezpug'
export const FAKE_CONFORMANCE_DEMO_URL = 'https://bucket.invalid/demos/conformance.dem?signed=1'
export const FAKE_CONFORMANCE_SECRET_ID = 'whsec-conformance'
/** Obviously not a secret. A test greps the recorded fixtures for it. */
export const FAKE_CONFORMANCE_SECRET = 'fake-webhook-secret-for-the-conformance-suite-0123456789'
/** The key's lifetime ceiling; the budget flow asks for one minute more than the thrifty key's. */
export const FAKE_CONFORMANCE_LIFETIME_MINUTES = 240
export const FAKE_CONFORMANCE_THRIFTY_MINUTES = 60

export interface FakeConformanceOptions
  extends Omit<FakeOrchestratorOptions, 'clock' | 'webhooks' | 'fetch'> {
  /** Where the fake clock starts. Default {@link FAKE_CONFORMANCE_START}. */
  start?: number
  /** `null` leaves the demo upload url out, and the suite skips the demo checks. */
  demoUploadUrl?: string | null
}

/** The target, plus the fake behind it for a caller that wants to look. */
export interface FakeConformanceTarget extends ConformanceTarget {
  fake: FakeOrchestrator
  clock: FakeClock
  /** The `matches` key every flow calls with. */
  platform: ApiKeyCreated
  /** The second `matches` key, with a lower lifetime ceiling — the budget flow's. */
  thrifty: ApiKeyCreated
  /** Every demo `PUT` the fake made. */
  uploads: { url: string; bytes: number }[]
  /** Deliveries whose signature or body did not verify. Always empty, or the fake is broken. */
  unverified: string[]
}

export function createFakeConformanceTarget(
  options: FakeConformanceOptions = {},
): FakeConformanceTarget {
  const { start, demoUploadUrl, ...rest } = options
  const clock = createFakeClock({ start: start ?? FAKE_CONFORMANCE_START })
  const secrets = { [FAKE_CONFORMANCE_SECRET_ID]: FAKE_CONFORMANCE_SECRET }
  const handlers = new Set<(envelope: WebhookEnvelope) => void>()
  const uploads: FakeConformanceTarget['uploads'] = []
  const unverified: string[] = []

  const fake = createFakeOrchestrator({
    clock,
    webhooks: {
      deliver: request => {
        // A consumer's own door: verify, then act. The published
        // `verifyWebhook` hashes on Web Crypto, whose promise resolves on a
        // macrotask the fake clock does not fire, so an endpoint that awaited
        // it would time out every attempt; this walks the same published
        // rules with the fake's synchronous HMAC instead (`sha256.ts`, proven
        // equal to Web Crypto beside it). A consumer with a real clock uses
        // `verifyWebhook`, and the client's own suite proves the fake's
        // signatures against it.
        const verdict = verifyDelivery(request.headers, request.body, secrets, clock.now())
        if (!verdict.ok) {
          unverified.push(`${request.envelope.payload.type}: ${verdict.reason}`)
          return 400
        }
        for (const handler of handlers) handler(verdict.envelope)
        return 200
      },
    },
    fetch: ((url: string | URL | Request, init?: RequestInit) => {
      uploads.push({
        url: String(url),
        bytes: (init?.body as Uint8Array | undefined)?.byteLength ?? 0,
      })
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as typeof globalThis.fetch,
    ...rest,
  })

  const budget = {
    maxConcurrentServers: 4,
    maxServerLifetimeMinutes: FAKE_CONFORMANCE_LIFETIME_MINUTES,
    monthlyCents: 0,
  }
  const webhookSecrets = [{ id: FAKE_CONFORMANCE_SECRET_ID, secret: FAKE_CONFORMANCE_SECRET }]
  const platform = fake.mintKey({
    name: 'conformance',
    scopes: ['matches'],
    budget,
    webhookSecrets,
  })
  const thrifty = fake.mintKey({
    name: 'conformance-thrifty',
    scopes: ['matches'],
    budget: { ...budget, maxServerLifetimeMinutes: FAKE_CONFORMANCE_THRIFTY_MINUTES },
    webhookSecrets,
  })

  return {
    fake,
    clock,
    platform,
    thrifty,
    uploads,
    unverified,
    client: fake.client(platform.secret),
    webhooks: handler => {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    callbacks: {
      webhookUrl: FAKE_CONFORMANCE_WEBHOOK_URL,
      webhookSecretId: FAKE_CONFORMANCE_SECRET_ID,
      ...(demoUploadUrl === null
        ? {}
        : { demoUploadUrl: demoUploadUrl ?? FAKE_CONFORMANCE_DEMO_URL }),
    },
    // One presigned url per map for the series flow — a fake signature on a
    // fake bucket, the shape a real client draws from its own storage.
    demoUploadUrls: count =>
      Array.from({ length: count }, (_unused, index) => ({
        mapNumber: index + 1,
        url: `https://bucket.invalid/demos/conformance/map-${index + 1}.dem?signed=${index + 1}`,
      })),
    advance: ms => clock.advance(ms),
    settle: () => fake.playOut(),
    faults: faults => fake.setFaults(faults.crash === undefined ? {} : { crash: faults.crash }),
    playerCommand: command => fake.playerCommand(command),
    stream: (subscription, onFrame) =>
      fake.stream(
        subscription.token === undefined
          ? { matchId: subscription.matchId, apiKey: platform.secret }
          : { matchId: subscription.matchId, token: subscription.token },
        onFrame,
      ),
    budget: {
      client: fake.client(thrifty.secret),
      maxServerLifetimeMinutes: FAKE_CONFORMANCE_THRIFTY_MINUTES,
    },
    close: () => {
      fake.close()
    },
  }
}

/**
 * The published verification rules — the header grammar, the five-minute
 * window, the constant-time comparison — run synchronously. Everything but
 * the hash is imported from `../webhooks`, so this cannot drift from what a
 * consumer does.
 */
function verifyDelivery(
  headers: Record<string, string>,
  body: string,
  secrets: Record<string, string>,
  now: number,
): { ok: true; envelope: WebhookEnvelope } | { ok: false; reason: string } {
  const header = headers[WEBHOOK_SIGNATURE_HEADER]
  if (header === undefined) return { ok: false, reason: 'missing_signature' }
  const parsed = parseWebhookSignature(header)
  if (!parsed) return { ok: false, reason: 'malformed_signature' }
  if (Math.abs(now - parsed.timestamp * 1_000) > WEBHOOK_SIGNATURE_TOLERANCE_MS)
    return { ok: false, reason: 'stale_timestamp' }
  const candidates =
    parsed.secretId === null
      ? Object.values(secrets)
      : [secrets[parsed.secretId]].filter((secret): secret is string => secret !== undefined)
  if (candidates.length === 0) return { ok: false, reason: 'unknown_secret' }
  const payload = webhookSignedPayload(parsed.timestamp, body)
  const matched = candidates.some(secret => {
    const expected = hmacSha256HexSync(secret, payload)
    return parsed.signatures.some(signature => constantTimeEqual(signature, expected))
  })
  if (!matched) return { ok: false, reason: 'no_signature_matched' }
  const envelope = webhookEnvelopeSchema.safeParse(JSON.parse(body))
  if (!envelope.success) return { ok: false, reason: 'invalid_body' }
  return { ok: true, envelope: envelope.data }
}
