import {
  MATCH_COMMAND_TYPES,
  ORCHESTRATOR_COMMAND_TYPES,
  SIM_COMMAND_TYPES,
} from '@ezpug/match-api'
import { GAMESERVER_EVENT_FIXTURES } from '@ezpug/match-api/fixtures'
import { describe, expect, it } from 'vitest'
import { EVENTS_BATCH_MAX, PROTOCOL_VERSION } from './constants'
import {
  LINK_COMMAND_FIXTURES,
  ORCHESTRATOR_FRAME_FIXTURES,
  SERVER_FRAME_FIXTURES,
} from './fixtures'
import {
  LINK_COMMAND_TYPES,
  linkCommandSchema,
  ORCHESTRATOR_FRAME_TYPES,
  orchestratorFrameSchema,
  SERVER_FRAME_TYPES,
  serverFrameSchema,
} from './server-link'

describe('the server link', () => {
  it('parses one fixture per frame type, both directions', () => {
    for (const type of SERVER_FRAME_TYPES) {
      const parsed = serverFrameSchema.parse(SERVER_FRAME_FIXTURES[type])
      expect(parsed.type).toBe(type)
    }
    for (const type of ORCHESTRATOR_FRAME_TYPES) {
      const parsed = orchestratorFrameSchema.parse(ORCHESTRATOR_FRAME_FIXTURES[type])
      expect(parsed.type).toBe(type)
    }
  })

  it('speaks exactly this protocol version in hello and welcome', () => {
    expect(PROTOCOL_VERSION).toBe(1)
    expect(
      serverFrameSchema.safeParse({ ...SERVER_FRAME_FIXTURES.hello, protocol: 2 }).success,
    ).toBe(false)
    expect(
      orchestratorFrameSchema.safeParse({ ...ORCHESTRATOR_FRAME_FIXTURES.welcome, protocol: 0 })
        .success,
    ).toBe(false)
  })

  it('refuses a short token and never defaults one', () => {
    expect(
      serverFrameSchema.safeParse({ ...SERVER_FRAME_FIXTURES.hello, token: 'short' }).success,
    ).toBe(false)
    const { token: _token, ...noToken } = SERVER_FRAME_FIXTURES.hello
    expect(serverFrameSchema.safeParse(noToken).success).toBe(false)
  })

  it('carries every vocabulary event in an events batch, each with a link seq', () => {
    const frame = serverFrameSchema.parse(SERVER_FRAME_FIXTURES.events)
    if (frame.type !== 'events') throw new Error('not an events frame')
    expect(frame.events.map(entry => entry.event.type)).toEqual(
      Object.keys(GAMESERVER_EVENT_FIXTURES),
    )
    expect(frame.events.map(entry => entry.seq)).toEqual(frame.events.map((_, i) => i + 1))
  })

  it('bounds an events batch and refuses an empty one', () => {
    const one = { seq: 1, event: GAMESERVER_EVENT_FIXTURES.heartbeat }
    expect(serverFrameSchema.safeParse({ type: 'events', events: [] }).success).toBe(false)
    const tooMany = Array.from({ length: EVENTS_BATCH_MAX + 1 }, (_, i) => ({ ...one, seq: i + 1 }))
    expect(serverFrameSchema.safeParse({ type: 'events', events: tooMany }).success).toBe(false)
    expect(
      serverFrameSchema.safeParse({ type: 'events', events: tooMany.slice(0, EVENTS_BATCH_MAX) })
        .success,
    ).toBe(true)
  })

  it('relays every Match API command except the sim family and the orchestrator’s own, plus console', () => {
    const notRelayed: readonly string[] = [...SIM_COMMAND_TYPES, ...ORCHESTRATOR_COMMAND_TYPES]
    const relayed = MATCH_COMMAND_TYPES.filter(type => !notRelayed.includes(type))
    expect([...LINK_COMMAND_TYPES]).toEqual(['console', ...relayed])
    for (const type of LINK_COMMAND_TYPES) {
      expect(linkCommandSchema.parse(LINK_COMMAND_FIXTURES[type]).type).toBe(type)
    }
    for (const type of notRelayed) {
      expect(linkCommandSchema.safeParse({ type, correlationId: 'x' }).success).toBe(false)
    }
  })

  it('defaults the console tail and bounds it', () => {
    const parsed = linkCommandSchema.parse({ type: 'console', correlationId: 'c' })
    expect(parsed).toEqual({ type: 'console', correlationId: 'c', lines: 100 })
    expect(
      linkCommandSchema.safeParse({ type: 'console', correlationId: 'c', lines: 501 }).success,
    ).toBe(false)
  })

  it('fills the assignment defaults the plugin relies on', () => {
    const { warmupLines: _lines, branding: _branding, ...bare } = ORCHESTRATOR_FRAME_FIXTURES.assign
    const parsed = orchestratorFrameSchema.parse(bare)
    if (parsed.type !== 'assign') throw new Error('not an assign frame')
    expect(parsed.warmupLines).toEqual([])
    expect(parsed.branding).toEqual({})
    expect(parsed.teams.teamA.players[0]?.locale).toBe('de')
    // The resolved manifest carries neither the map allow-list nor the widget.
    expect(parsed.gamemode).not.toHaveProperty('maps')
    expect(parsed.gamemode).not.toHaveProperty('widget')
    expect(parsed.gamemode.plugins).toEqual(['MatchZy'])
  })

  it('refuses an assignment naming a protected cvar', () => {
    const assign = { ...ORCHESTRATOR_FRAME_FIXTURES.assign, cvars: { sv_password: 'x' } }
    expect(orchestratorFrameSchema.safeParse(assign).success).toBe(false)
  })

  it('acks per event with a closed status set', () => {
    const ack = orchestratorFrameSchema.parse(ORCHESTRATOR_FRAME_FIXTURES.ack)
    if (ack.type !== 'ack') throw new Error('not an ack')
    expect(ack.results.map(r => r.status)).toEqual([
      'accepted',
      'duplicate',
      'ephemeral',
      'rejected',
    ])
    expect(
      orchestratorFrameSchema.safeParse({ type: 'ack', results: [{ seq: 1, status: 'applied' }] })
        .success,
    ).toBe(false)
  })
})
