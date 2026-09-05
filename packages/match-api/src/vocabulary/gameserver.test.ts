import { describe, expect, it } from 'vitest'
import { GAMESERVER_EVENT_FIXTURES } from '../fixtures'
import serverChat from '../fixtures/platform/server-chat.json'
import simulatedRecord from '../fixtures/platform/simulated-history.record.json'
import {
  EPHEMERAL_GAMESERVER_EVENT_TYPES,
  GAMESERVER_EVENT_CONTRACT_VERSION,
  GAMESERVER_EVENT_TYPES,
  gameserverEventSchema,
  isEphemeralGameserverEvent,
  parseServerChatLine,
  playerRoundSummarySchema,
} from './gameserver'

/**
 * The platform's `gameserver.test.ts` on 2026-09-05, run against the copy —
 * the proof that v1 of the vocabulary is the platform's file (decision 4).
 * Then the platform's recorded fixtures: everything eight rounds of its tests
 * parsed must still parse here, byte for byte.
 */

const fixtures = GAMESERVER_EVENT_FIXTURES
const base = { matchId: fixtures.heartbeat.matchId, source: fixtures.heartbeat.source }
const tk = fixtures.player_connected.player

describe('the normalized gameserver event union', () => {
  it('is v1 of the vocabulary', () => {
    expect(GAMESERVER_EVENT_CONTRACT_VERSION).toBe(1)
  })

  it.each(GAMESERVER_EVENT_TYPES)('parses a %s event', type => {
    const fixture = fixtures[type]
    expect(gameserverEventSchema.parse(fixture)).toEqual(fixture)
  })

  it('keeps the published type list and the union in lockstep, in Match.md §5 order', () => {
    expect(GAMESERVER_EVENT_TYPES).toHaveLength(22)
    expect(new Set(GAMESERVER_EVENT_TYPES).size).toBe(GAMESERVER_EVENT_TYPES.length)
    expect(gameserverEventSchema.options.map(option => option.shape.type.value)).toEqual([
      ...GAMESERVER_EVENT_TYPES,
    ])
  })

  it('rejects a type outside the closed set', () => {
    expect(() => gameserverEventSchema.parse({ type: 'knife_round_won', ...base })).toThrow()
  })

  it('rejects an event without its match id — a server only speaks about its own match', () => {
    const { matchId: _dropped, ...rest } = fixtures.heartbeat
    expect(() => gameserverEventSchema.parse(rest)).toThrow()
    expect(() => gameserverEventSchema.parse({ ...fixtures.heartbeat, matchId: '42' })).toThrow()
  })

  it('rejects an event without source identity', () => {
    const { source: _dropped, ...rest } = fixtures.round_end
    expect(() => gameserverEventSchema.parse(rest)).toThrow()
  })

  it('rejects a numeric SteamID64 — JSON rounds it into a different person', () => {
    expect(() =>
      gameserverEventSchema.parse({
        ...fixtures.player_connected,
        player: { steamId64: Number(tk.steamId64), name: 'tk' },
      }),
    ).toThrow()
  })

  it('counts rounds and maps from 1 — adapters translate 0-based providers', () => {
    expect(() => gameserverEventSchema.parse({ ...fixtures.going_live, mapNumber: 0 })).toThrow()
    expect(() => gameserverEventSchema.parse({ ...fixtures.round_start, roundNumber: 0 })).toThrow()
  })

  it('treats seq as a hint: optional, but never negative when present', () => {
    const { seq: _dropped, ...withoutSeq } = fixtures.heartbeat
    expect(gameserverEventSchema.parse(withoutSeq)).toEqual(withoutSeq)
    expect(() => gameserverEventSchema.parse({ ...fixtures.heartbeat, seq: -1 })).toThrow()
  })

  it('requires a winner with team and side on round_end — a round is never drawn', () => {
    const { winner: _dropped, ...rest } = fixtures.round_end
    expect(() => gameserverEventSchema.parse(rest)).toThrow()
    expect(() =>
      gameserverEventSchema.parse({
        ...fixtures.round_end,
        winner: { team: 'team_a', side: 'spec' },
      }),
    ).toThrow()
  })

  it('rejects a win condition outside the normalized vocabulary', () => {
    expect(() =>
      gameserverEventSchema.parse({ ...fixtures.round_end, winCondition: 'hostages_rescued' }),
    ).toThrow()
  })

  it('allows a drawn map but not an unnamed winner shape', () => {
    const drawn = { ...fixtures.map_end, winner: null, score: { teamA: 15, teamB: 15 } }
    expect(gameserverEventSchema.parse(drawn)).toEqual(drawn)
    expect(() => gameserverEventSchema.parse({ ...fixtures.map_end, winner: 'team1' })).toThrow()
  })

  it('lets the world be a killer (null), never an absent field', () => {
    const worldKill = { ...fixtures.player_death, killer: null, assists: [], weapon: 'world' }
    expect(gameserverEventSchema.parse(worldKill)).toEqual(worldKill)
    const { killer: _dropped, ...rest } = fixtures.player_death
    expect(() => gameserverEventSchema.parse(rest)).toThrow()
  })

  it('normalizes chat commands to the bare lowercase word — no chat prefix', () => {
    expect(() =>
      gameserverEventSchema.parse({ ...fixtures.chat_command, command: '.tech' }),
    ).toThrow()
  })

  it('keeps a chat line inside the reportable length and never empty', () => {
    expect(() => gameserverEventSchema.parse({ ...fixtures.chat_message, text: '' })).toThrow()
    expect(() =>
      gameserverEventSchema.parse({ ...fixtures.chat_message, text: 'x'.repeat(513) }),
    ).toThrow()
    expect(() => gameserverEventSchema.parse({ ...fixtures.chat_message, scope: 'ct' })).toThrow()
  })

  it('splits a raw server line into a command or a message, once, at the edge', () => {
    expect(parseServerChatLine('!Tech now please')).toEqual({
      kind: 'command',
      command: 'tech',
      args: 'now please',
    })
    expect(parseServerChatLine('.gg')).toEqual({ kind: 'command', command: 'gg' })
    expect(parseServerChatLine('/pause')).toEqual({ kind: 'command', command: 'pause' })
    expect(parseServerChatLine('  gg wp  ')).toEqual({ kind: 'message', text: 'gg wp' })
    expect(parseServerChatLine('...')).toEqual({ kind: 'message', text: '...' })
    expect(parseServerChatLine('!!!')).toEqual({ kind: 'message', text: '!!!' })
    expect(parseServerChatLine('.42% hp left')).toEqual({
      kind: 'message',
      text: '.42% hp left',
    })
    const said = parseServerChatLine('nice one @maex')
    expect(said.kind).toBe('message')
    expect(
      gameserverEventSchema.parse({
        ...fixtures.chat_message,
        text: said.kind === 'message' ? said.text : '',
      }),
    ).toMatchObject({ type: 'chat_message', text: 'nice one @maex' })
  })

  it('holds plugin_event names to the same snake_case grammar as the union', () => {
    expect(() =>
      gameserverEventSchema.parse({ ...fixtures.plugin_event, name: 'DropAnnounced' }),
    ).toThrow()
  })

  it('keeps the event-tier floor small: kills, deaths, assists, damage', () => {
    const minimal = {
      player: { steamId64: tk.steamId64, name: 'tk' },
      kills: 0,
      deaths: 0,
      assists: 0,
      damage: 0,
    }
    expect(playerRoundSummarySchema.parse(minimal)).toEqual(minimal)
  })
})

describe('the ephemeral tier', () => {
  it('marks position ticks ephemeral — live channel only, never event-sourced', () => {
    expect(EPHEMERAL_GAMESERVER_EVENT_TYPES).toEqual(['position_tick'])
    expect(isEphemeralGameserverEvent('position_tick')).toBe(true)
  })

  it('event-sources everything else', () => {
    for (const type of GAMESERVER_EVENT_TYPES) {
      if (type === 'position_tick') continue
      expect(isEphemeralGameserverEvent(type)).toBe(false)
    }
  })
})

describe("the platform's recorded fixtures still parse (byte-compatible v1)", () => {
  it('parses every expected event of the server-chat wire fixture', () => {
    expect(serverChat.vectors.length).toBeGreaterThan(0)
    for (const vector of serverChat.vectors) {
      expect(gameserverEventSchema.parse(vector.expected), vector.name).toEqual(vector.expected)
    }
  })

  it("parses every event of the simulator's recorded history, none ephemeral", () => {
    expect(simulatedRecord.events.length).toBeGreaterThan(0)
    for (const event of simulatedRecord.events) {
      const parsed = gameserverEventSchema.parse(event)
      expect(parsed).toEqual(event)
      expect(isEphemeralGameserverEvent(parsed.type)).toBe(false)
    }
  })
})
