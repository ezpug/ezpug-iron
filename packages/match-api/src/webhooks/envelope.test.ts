import { describe, expect, it } from 'vitest'
import {
  envelopeFixture,
  GAMESERVER_EVENT_FIXTURES,
  ORCHESTRATION_FACT_FIXTURES,
} from '../fixtures'
import { matchApiJsonSchemas } from '../schemas'
import { GAMESERVER_EVENT_TYPES } from '../vocabulary/gameserver'
import { domainEventNameSchema } from '../vocabulary/naming'
import {
  DURABLE_GAMESERVER_EVENT_TYPES,
  isOrchestrationFact,
  ORCHESTRATION_FACT_TYPES,
  orchestrationFactSchema,
  WEBHOOK_PAYLOAD_TYPES,
  webhookEnvelopeSchema,
  webhookPayloadSchema,
} from './envelope'

describe('the webhook envelope', () => {
  it('carries every durable gameserver event fixture unchanged', () => {
    for (const type of DURABLE_GAMESERVER_EVENT_TYPES) {
      const envelope = envelopeFixture(GAMESERVER_EVENT_FIXTURES[type])
      const parsed = webhookEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)))
      expect(parsed, type).toEqual(envelope)
      expect(isOrchestrationFact(parsed.payload), type).toBe(false)
    }
  })

  it('carries every orchestration fact fixture unchanged', () => {
    for (const type of ORCHESTRATION_FACT_TYPES) {
      const envelope = envelopeFixture(ORCHESTRATION_FACT_FIXTURES[type], 7)
      const parsed = webhookEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)))
      expect(parsed, type).toEqual(envelope)
      expect(isOrchestrationFact(parsed.payload), type).toBe(true)
    }
  })

  it('refuses the ephemeral tier — a position tick is never a webhook', () => {
    const tick = GAMESERVER_EVENT_FIXTURES.position_tick
    expect(webhookPayloadSchema.safeParse(tick).success).toBe(false)
    expect(webhookEnvelopeSchema.safeParse(envelopeFixture(tick as never)).success).toBe(false)
    expect(DURABLE_GAMESERVER_EVENT_TYPES).toHaveLength(GAMESERVER_EVENT_TYPES.length - 1)
    expect(DURABLE_GAMESERVER_EVENT_TYPES).not.toContain('position_tick')
  })

  it('keeps the two branches disjoint under one discriminator', () => {
    for (const type of ORCHESTRATION_FACT_TYPES) {
      expect(domainEventNameSchema.safeParse(type).success, type).toBe(true)
      expect(GAMESERVER_EVENT_TYPES as readonly string[]).not.toContain(type)
    }
    expect(WEBHOOK_PAYLOAD_TYPES).toEqual([
      ...DURABLE_GAMESERVER_EVENT_TYPES,
      ...ORCHESTRATION_FACT_TYPES,
    ])
    expect(new Set(WEBHOOK_PAYLOAD_TYPES).size).toBe(WEBHOOK_PAYLOAD_TYPES.length)
  })

  it('demands a positive seq, a uuid delivery id and an offset timestamp', () => {
    const good = envelopeFixture(ORCHESTRATION_FACT_FIXTURES['match.ended'], 3)
    expect(webhookEnvelopeSchema.safeParse({ ...good, seq: 0 }).success).toBe(false)
    expect(webhookEnvelopeSchema.safeParse({ ...good, deliveryId: 'd-1' }).success).toBe(false)
    expect(
      webhookEnvelopeSchema.safeParse({ ...good, occurredAt: '2026-09-05T18:30:00' }).success,
    ).toBe(false)
  })

  it('types the terminal facts by the state they land in', () => {
    expect(
      orchestrationFactSchema.safeParse({
        ...ORCHESTRATION_FACT_FIXTURES['match.ended'],
        state: 'failed',
      }).success,
    ).toBe(false)
    expect(
      orchestrationFactSchema.safeParse({
        ...ORCHESTRATION_FACT_FIXTURES['match.failed'],
        state: 'ended',
      }).success,
    ).toBe(false)
    expect(
      orchestrationFactSchema.safeParse({
        ...ORCHESTRATION_FACT_FIXTURES['match.ended'],
        state: 'cancelled',
      }).success,
    ).toBe(true)
  })

  it('insists on a lowercase hex sha256 for a demo', () => {
    const demo = ORCHESTRATION_FACT_FIXTURES['demo.uploaded']
    expect(
      orchestrationFactSchema.safeParse({ ...demo, sha256: demo.sha256.toUpperCase() }).success,
    ).toBe(false)
    expect(
      orchestrationFactSchema.safeParse({ ...demo, sha256: demo.sha256.slice(1) }).success,
    ).toBe(false)
  })

  it('exports the envelope, the facts and the stream frames as JSON Schema', () => {
    const documents = matchApiJsonSchemas()
    expect(documents.WebhookEnvelope).toHaveProperty('properties.payload')
    expect(documents.OrchestrationFact).toHaveProperty('oneOf')
    expect(documents.StreamFrame).toHaveProperty('oneOf')
  })
})
