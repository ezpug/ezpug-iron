import { createFakeClock } from '@ezpug/core'
import { describe, expect, it } from 'vitest'
import { envelopeFixture, ORCHESTRATION_FACT_FIXTURES } from '../fixtures'
import {
  constantTimeEqual,
  hmacSha256Hex,
  parseWebhookSignature,
  signWebhook,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_TOLERANCE_MS,
  webhookSignedPayload,
} from './signature'

const T0 = Date.parse('2026-09-05T18:30:00.000Z')
const secrets = {
  'whsec-2026-09': 'fixture-webhook-secret-2026-09-not-a-real-one-0123456789',
  'whsec-2026-10': 'fixture-webhook-secret-2026-10-not-a-real-one-9876543210',
}
const body = JSON.stringify(envelopeFixture(ORCHESTRATION_FACT_FIXTURES['match.server_ready'], 2))

async function signed(secretId: keyof typeof secrets = 'whsec-2026-09', at = T0) {
  return signWebhook({
    body,
    secretId,
    secret: secrets[secretId],
    clock: createFakeClock({ start: at }),
  })
}

describe('the webhook signature', () => {
  it('round-trips: what the orchestrator signs, the consumer verifies', async () => {
    const header = await signed()
    expect(header).toMatch(/^t=\d+,kid=whsec-2026-09,v1=[0-9a-f]{64}$/)
    const result = await verifyWebhookSignature({
      header,
      body,
      secrets,
      clock: createFakeClock({ start: T0 + 1_000 }),
    })
    expect(result).toEqual({
      ok: true,
      secretId: 'whsec-2026-09',
      timestamp: Math.floor(T0 / 1000),
    })
  })

  it('signs `t + "." + body` with hmac-sha256, hex — reproducible by any library', async () => {
    const header = await signed()
    const parsed = parseWebhookSignature(header)!
    const expected = await hmacSha256Hex(
      secrets['whsec-2026-09'],
      webhookSignedPayload(parsed.timestamp, body),
    )
    expect(parsed.signatures).toEqual([expected])
    // The known-answer for HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog").
    expect(await hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    )
  })

  it('refuses a signature outside the five-minute skew window, either way', async () => {
    const header = await signed()
    const verify = (now: number) =>
      verifyWebhookSignature({ header, body, secrets, clock: createFakeClock({ start: now }) })
    // `t` is whole seconds, so the sender's own sub-second part is inside the window.
    expect((await verify(T0 + WEBHOOK_SIGNATURE_TOLERANCE_MS)).ok).toBe(true)
    expect(await verify(T0 + WEBHOOK_SIGNATURE_TOLERANCE_MS + 1_000)).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    })
    expect(await verify(T0 - WEBHOOK_SIGNATURE_TOLERANCE_MS - 1_000)).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    })
  })

  it('refuses a tampered body and a wrong secret, and says which', async () => {
    const header = await signed()
    const clock = createFakeClock({ start: T0 })
    expect(await verifyWebhookSignature({ header, body: `${body} `, secrets, clock })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    })
    expect(
      await verifyWebhookSignature({
        header,
        body,
        secrets: { 'whsec-2026-09': 'a-different-secret-entirely-0123456789abcdef' },
        clock,
      }),
    ).toEqual({ ok: false, reason: 'signature_mismatch' })
    expect(
      await verifyWebhookSignature({
        header,
        body,
        secrets: { 'whsec-2026-10': secrets['whsec-2026-10'] },
        clock,
      }),
    ).toEqual({ ok: false, reason: 'unknown_secret' })
  })

  it('names the header problems', async () => {
    const clock = createFakeClock({ start: T0 })
    expect(await verifyWebhookSignature({ header: null, body, secrets, clock })).toEqual({
      ok: false,
      reason: 'missing_header',
    })
    expect(await verifyWebhookSignature({ header: '', body, secrets, clock })).toEqual({
      ok: false,
      reason: 'missing_header',
    })
    for (const header of ['garbage', 't=abc,v1=00', 't=1,kid=', 'v1=00', `t=${T0}`]) {
      expect(await verifyWebhookSignature({ header, body, secrets, clock }), header).toEqual({
        ok: false,
        reason: 'malformed_header',
      })
    }
  })

  it('rotates: a header without a kid is tried against every secret, with more than one v1 any may match', async () => {
    const header = await signed('whsec-2026-10')
    const parsed = parseWebhookSignature(header)!
    const noKid = `t=${parsed.timestamp},v1=${parsed.signatures[0]}`
    const clock = createFakeClock({ start: T0 })
    expect(await verifyWebhookSignature({ header: noKid, body, secrets, clock })).toEqual({
      ok: true,
      secretId: 'whsec-2026-10',
      timestamp: parsed.timestamp,
    })
    const stale = await hmacSha256Hex(
      'some-old-secret',
      webhookSignedPayload(parsed.timestamp, body),
    )
    const two = `t=${parsed.timestamp},kid=whsec-2026-10,v1=${stale},v1=${parsed.signatures[0]}`
    expect((await verifyWebhookSignature({ header: two, body, secrets, clock })).ok).toBe(true)
    // Unknown elements ride along for a future version.
    const future = `${header},v2=deadbeef`
    expect((await verifyWebhookSignature({ header: future, body, secrets, clock })).ok).toBe(true)
  })

  it('checks the timestamp before it computes anything', async () => {
    // A stale header with a garbage digest is refused as stale, not as a mismatch.
    const header = `t=${Math.floor(T0 / 1000) - 3600},kid=whsec-2026-09,v1=${'0'.repeat(64)}`
    expect(
      await verifyWebhookSignature({
        header,
        body,
        secrets,
        clock: createFakeClock({ start: T0 }),
      }),
    ).toEqual({ ok: false, reason: 'stale_timestamp' })
  })

  it('compares digests in constant time and never equates different lengths', () => {
    expect(constantTimeEqual('abcd', 'abcd')).toBe(true)
    expect(constantTimeEqual('abcd', 'abce')).toBe(false)
    expect(constantTimeEqual('abcd', 'abc')).toBe(false)
  })
})
