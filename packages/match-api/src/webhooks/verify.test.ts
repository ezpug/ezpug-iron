import { createFakeClock } from '@ezpug/core'
import { describe, expect, it } from 'vitest'
import {
  envelopeFixture,
  GAMESERVER_EVENT_FIXTURES,
  ORCHESTRATION_FACT_FIXTURES,
} from '../fixtures'
import {
  signWebhook,
  WEBHOOK_ATTEMPT_HEADER,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_TOLERANCE_MS,
} from './signature'
import { parseEnvelope, verifyWebhook, webhookHeader } from './verify'

const T0 = Date.parse('2026-09-05T18:00:00.000Z')
const SECRET_ID = 'whsec-fake-2026-09'
const SECRET = 'fixture-webhook-secret-2026-09-not-a-real-one-0123456789'
const secrets = { [SECRET_ID]: SECRET }

async function delivery(
  clock: { now: () => number },
  envelope = envelopeFixture(GAMESERVER_EVENT_FIXTURES.going_live),
) {
  const body = JSON.stringify(envelope)
  return {
    envelope,
    body,
    headers: {
      'content-type': 'application/json',
      [WEBHOOK_SIGNATURE_HEADER]: await signWebhook({
        body,
        secretId: SECRET_ID,
        secret: SECRET,
        clock,
      }),
      [WEBHOOK_DELIVERY_HEADER]: envelope.deliveryId,
      [WEBHOOK_ATTEMPT_HEADER]: '2',
    },
  }
}

describe('webhookHeader', () => {
  it('reads a header case-insensitively out of every shape a runtime hands over', () => {
    const value = 't=1,v1=x'
    expect(webhookHeader(new Headers({ 'X-EZPug-Signature': value }), 'x-ezpug-signature')).toBe(
      value,
    )
    expect(webhookHeader({ 'X-EZPug-Signature': value }, 'X-EZPug-Signature')).toBe(value)
    // Node's `req.headers`: lowercase, and a repeated header is an array.
    expect(webhookHeader({ 'x-ezpug-signature': [value, 'other'] }, 'x-ezpug-signature')).toBe(
      value,
    )
    expect(webhookHeader([['x-ezpug-signature', value]], 'X-EZPug-Signature')).toBe(value)
    expect(webhookHeader({ 'x-ezpug-signature': undefined }, 'x-ezpug-signature')).toBeNull()
    expect(webhookHeader(new Headers(), 'x-ezpug-signature')).toBeNull()
  })
})

describe('verifyWebhook', () => {
  it('verifies the bytes that arrived and hands back the envelope and the delivery facts', async () => {
    const clock = createFakeClock({ start: T0 })
    const sent = await delivery(clock)
    const result = await verifyWebhook({ ...sent, secrets, clock })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.envelope).toEqual(sent.envelope)
    expect(result.secretId).toBe(SECRET_ID)
    expect(result.deliveryId).toBe(sent.envelope.deliveryId)
    expect(result.attempt).toBe(2)
    expect(result.timestamp).toBe(Math.floor(T0 / 1000))
  })

  it('refuses a stale signature with a 401 and never looks at the body', async () => {
    const clock = createFakeClock({ start: T0 })
    const sent = await delivery(clock)
    await clock.advance(WEBHOOK_SIGNATURE_TOLERANCE_MS + 1_000)
    const result = await verifyWebhook({ ...sent, secrets, clock })
    expect(result).toMatchObject({ ok: false, reason: 'stale_timestamp', status: 401 })

    // Inside the window it still verifies — the window is the only clock rule.
    const fresh = createFakeClock({ start: T0 + WEBHOOK_SIGNATURE_TOLERANCE_MS - 1_000 })
    expect((await verifyWebhook({ ...sent, secrets, clock: fresh })).ok).toBe(true)
  })

  it('refuses a missing header, an unknown secret and a tampered body', async () => {
    const clock = createFakeClock({ start: T0 })
    const sent = await delivery(clock)

    expect(await verifyWebhook({ ...sent, headers: {}, secrets, clock })).toMatchObject({
      ok: false,
      reason: 'missing_header',
      status: 401,
    })
    expect(
      await verifyWebhook({ ...sent, secrets: { 'whsec-other': SECRET }, clock }),
    ).toMatchObject({ ok: false, reason: 'unknown_secret' })
    expect(
      await verifyWebhook({ ...sent, body: `${sent.body.slice(0, -1)} }`, secrets, clock }),
    ).toMatchObject({ ok: false, reason: 'signature_mismatch' })
  })

  it('refuses a correctly signed body that is not an envelope with a 400', async () => {
    const clock = createFakeClock({ start: T0 })
    const body = JSON.stringify({ hello: 'not an envelope' })
    const result = await verifyWebhook({
      headers: {
        [WEBHOOK_SIGNATURE_HEADER]: await signWebhook({
          body,
          secretId: SECRET_ID,
          secret: SECRET,
          clock,
        }),
      },
      body,
      secrets,
      clock,
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid_body', status: 400 })

    const notJson = await verifyWebhook({
      headers: {
        [WEBHOOK_SIGNATURE_HEADER]: await signWebhook({
          body: 'nope',
          secretId: SECRET_ID,
          secret: SECRET,
          clock,
        }),
      },
      body: 'nope',
      secrets,
      clock,
    })
    expect(notJson).toMatchObject({ ok: false, reason: 'invalid_body' })
  })

  it('falls back to the envelope’s own delivery id and attempt 1 without the headers', async () => {
    const clock = createFakeClock({ start: T0 })
    const sent = await delivery(clock)
    const result = await verifyWebhook({
      ...sent,
      headers: { [WEBHOOK_SIGNATURE_HEADER]: sent.headers[WEBHOOK_SIGNATURE_HEADER] as string },
      secrets,
      clock,
    })
    expect(result).toMatchObject({ ok: true, deliveryId: sent.envelope.deliveryId, attempt: 1 })
  })
})

describe('parseEnvelope', () => {
  it('takes the raw text or a parsed value and refuses anything else', () => {
    const envelope = envelopeFixture(ORCHESTRATION_FACT_FIXTURES['match.ended'])
    expect(parseEnvelope(JSON.stringify(envelope))).toEqual(envelope)
    expect(parseEnvelope(envelope)).toEqual(envelope)
    expect(() => parseEnvelope('{')).toThrow()
    expect(() => parseEnvelope({ ...envelope, seq: 0 })).toThrow()
  })
})
