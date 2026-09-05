import { describe, expect, it } from 'vitest'
import {
  envelopeFixture,
  FIXTURE_MATCH_ID,
  GAMESERVER_EVENT_FIXTURES,
  ORCHESTRATION_FACT_FIXTURES,
} from '../fixtures'
import { DURABLE_GAMESERVER_EVENT_TYPES, ORCHESTRATION_FACT_TYPES } from '../webhooks/envelope'
import {
  STREAM_CLOSE_CODES,
  STREAM_FRAME_TYPES,
  STREAM_TICK_BATCH_MAX,
  type StreamFrame,
  streamFrameSchema,
  streamQuerySchema,
} from './frames'

describe('the stream frames', () => {
  it('has one frame per type, and every one parses', () => {
    const frames: { [T in StreamFrame['type']]: StreamFrame & { type: T } } = {
      hello: { type: 'hello', matchId: FIXTURE_MATCH_ID, seq: 12, state: 'live' },
      event: { type: 'event', envelope: envelopeFixture(GAMESERVER_EVENT_FIXTURES.round_end, 12) },
      tick: { type: 'tick', ticks: [GAMESERVER_EVENT_FIXTURES.position_tick] },
      command_result: {
        type: 'command_result',
        result: { correlationId: 'c-1', type: 'pause', status: 'applied' },
      },
      presence: {
        type: 'presence',
        players: [{ steamId64: '76561198279375306', name: 'tk', team: 'team_a' }],
      },
    }
    expect(Object.keys(frames)).toEqual([...STREAM_FRAME_TYPES])
    for (const [type, frame] of Object.entries(frames)) {
      expect(streamFrameSchema.parse(JSON.parse(JSON.stringify(frame))), type).toEqual(frame)
    }
  })

  it('mirrors every durable event and every fact as an event frame', () => {
    const payloads = [
      ...DURABLE_GAMESERVER_EVENT_TYPES.map(type => GAMESERVER_EVENT_FIXTURES[type]),
      ...ORCHESTRATION_FACT_TYPES.map(type => ORCHESTRATION_FACT_FIXTURES[type]),
    ]
    payloads.forEach((payload, index) => {
      const frame = { type: 'event', envelope: envelopeFixture(payload, index + 1) }
      expect(streamFrameSchema.safeParse(frame).success, payload.type).toBe(true)
    })
  })

  it('carries position ticks only in tick frames, batched and bounded', () => {
    const tick = GAMESERVER_EVENT_FIXTURES.position_tick
    expect(
      streamFrameSchema.safeParse({ type: 'event', envelope: envelopeFixture(tick as never) })
        .success,
    ).toBe(false)
    expect(streamFrameSchema.safeParse({ type: 'tick', ticks: [] }).success).toBe(false)
    expect(
      streamFrameSchema.safeParse({ type: 'tick', ticks: Array(STREAM_TICK_BATCH_MAX).fill(tick) })
        .success,
    ).toBe(true)
    expect(
      streamFrameSchema.safeParse({
        type: 'tick',
        ticks: Array(STREAM_TICK_BATCH_MAX + 1).fill(tick),
      }).success,
    ).toBe(false)
    expect(
      streamFrameSchema.safeParse({ type: 'tick', ticks: [GAMESERVER_EVENT_FIXTURES.round_end] })
        .success,
    ).toBe(false)
  })

  it('accepts a player token in the query and nothing else', () => {
    expect(streamQuerySchema.parse({})).toEqual({})
    expect(streamQuerySchema.parse({ token: 'ezpt_fixture_player_token_0001' }).token).toBeDefined()
    expect(streamQuerySchema.safeParse({ token: 'short' }).success).toBe(false)
  })

  it('closes with application-range codes, each distinct', () => {
    const codes = Object.values(STREAM_CLOSE_CODES)
    expect(new Set(codes).size).toBe(codes.length)
    for (const code of codes) expect(code).toBeGreaterThanOrEqual(4000)
    for (const code of codes) expect(code).toBeLessThan(5000)
  })
})
