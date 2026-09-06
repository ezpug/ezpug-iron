import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type GameserverEvent, gameserverEventSchema } from '@ezpug/match-api'
import { FIXTURE_MATCH_ID } from '@ezpug/match-api/fixtures'
import { describe, expect, it } from 'vitest'
import { matchzySerial } from '../match-config/matchzy'
import {
  initialMatchZyState,
  type MatchZyContext,
  type MatchZyState,
  scheduledSide,
  sideOf,
  teamOf,
  translateMatchZyEvent,
  winConditionOf,
} from './translate'

/**
 * **Every fixture under `fixtures/` plays through the translator in file
 * order** — the state (the last score seen) carries from one to the next,
 * which is how the round winner is found — and the rules the fixtures rest
 * on are pinned one by one below.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))

interface Fixture {
  name: string
  /** Where the payload came from — `fixtures.test.ts` holds the rule. */
  source: 'recorded' | 'derived' | 'upstream'
  /** The run, the recorded sibling, or the MatchZy file the shape was read off. */
  from: string
  note?: string
  /**
   * The score the translator starts this fixture from. The `recorded` files
   * omit it and carry state from one to the next — they are one real match in
   * order, and the round winner is a delta. A `derived` or `upstream` file
   * declares its own, because it is a case of its own and must not depend on
   * where the story happened to be.
   */
  state?: MatchZyState
  payload: unknown
  expect: { events?: GameserverEvent[]; dropped?: string; note?: boolean }
}

export function readFixtures(): Fixture[] {
  return readdirSync(FIXTURES)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => ({
      name,
      ...(JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8')) as Omit<Fixture, 'name'>),
    }))
}

const context: MatchZyContext = {
  matchId: FIXTURE_MATCH_ID,
  source: { provider: 'nodes', serverId: 'devbox-1' },
  serial: matchzySerial(FIXTURE_MATCH_ID),
  // The map the recorded match was played on (T13).
  maps: [{ map: 'de_dust2', sides: 'ct' }],
}

describe('the fixtures, in order', () => {
  const fixtures = readFixtures()

  it('exist, one per MatchZy event worth pinning', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10)
    for (const fixture of fixtures)
      expect(['recorded', 'derived', 'upstream']).toContain(fixture.source)
  })

  it('translate exactly as written, state carried from one to the next', () => {
    let state: MatchZyState = initialMatchZyState()
    for (const fixture of fixtures) {
      const result = translateMatchZyEvent(fixture.payload, context, fixture.state ?? state)
      state = result.state
      if (fixture.expect.dropped !== undefined) {
        expect(result.dropped, fixture.name).toBe(fixture.expect.dropped)
        expect(result.events, fixture.name).toEqual([])
      } else {
        expect(result.dropped, fixture.name).toBeUndefined()
        expect(result.events, fixture.name).toEqual(fixture.expect.events)
        for (const event of result.events) gameserverEventSchema.parse(event)
      }
      if (fixture.expect.note) expect(result.note, fixture.name).toBeDefined()
      else expect(result.note, fixture.name).toBeUndefined()
    }
  })
})

describe('the rules', () => {
  it('reads winner.side as the schema spells it and as the engine numbers it', () => {
    expect(sideOf('ct')).toBe('ct')
    expect(sideOf('3')).toBe('ct')
    expect(sideOf('CT')).toBe('ct')
    expect(sideOf('t')).toBe('t')
    expect(sideOf('2')).toBe('t')
    expect(sideOf('TERRORIST')).toBe('t')
    expect(sideOf('spec')).toBeNull()
    expect(sideOf(null)).toBeNull()
  })

  it('reads team1/team2 and nothing else', () => {
    expect(teamOf('team1')).toBe('team_a')
    expect(teamOf('team2')).toBe('team_b')
    expect(teamOf('none')).toBeNull()
    expect(teamOf(null)).toBeNull()
  })

  it('folds the engine reasons onto the five conditions, other for the rest', () => {
    expect(winConditionOf(1)).toBe('bomb_exploded')
    expect(winConditionOf(7)).toBe('bomb_defused')
    expect(winConditionOf(8)).toBe('elimination')
    expect(winConditionOf(9)).toBe('elimination')
    expect(winConditionOf(12)).toBe('time_expired')
    for (const exotic of [0, 10, 16, 17, 18, 99]) expect(winConditionOf(exotic)).toBe('other')
  })

  it('drops what it cannot read, never throws', () => {
    for (const payload of [null, 42, 'x', {}, { event: 5 }, { event: 'going_live' }]) {
      const result = translateMatchZyEvent(payload, context, initialMatchZyState())
      expect(result.events).toEqual([])
      expect(result.dropped).toBeDefined()
    }
    expect(
      translateMatchZyEvent(
        { event: 'going_live', matchid: context.serial, map_number: 3 },
        context,
        initialMatchZyState(),
      ).dropped,
    ).toMatch(/outside the plan/)
    expect(
      translateMatchZyEvent(
        { event: 'sleep_mode', matchid: context.serial },
        context,
        initialMatchZyState(),
      ).dropped,
    ).toBe('an event this translator does not know')
  })

  it('takes matchid as a number or a numeric string', () => {
    const asString = translateMatchZyEvent(
      { event: 'going_live', matchid: String(context.serial), map_number: 0 },
      context,
      initialMatchZyState(),
    )
    expect(asString.events).toHaveLength(1)
  })

  it('numbers rounds from the score, 1-based, whatever round_number says', () => {
    const roundEnd = (team1: number, team2: number, round_number: number) => ({
      event: 'round_end',
      matchid: context.serial,
      map_number: 0,
      round_number,
      round_time: 42_000,
      reason: 8,
      winner: { side: '3', team: 'team1' },
      team1: {
        id: '',
        name: 'A',
        series_score: 0,
        score: team1,
        score_ct: 0,
        score_t: 0,
        players: [],
      },
      team2: {
        id: '',
        name: 'B',
        series_score: 0,
        score: team2,
        score_ct: 0,
        score_t: 0,
        players: [],
      },
    })
    const first = translateMatchZyEvent(roundEnd(1, 0, 0), context, initialMatchZyState())
    expect(first.events[0]).toMatchObject({
      type: 'round_end',
      roundNumber: 1,
      roundTimeMs: 42_000,
    })
    expect(first.events[0]).not.toHaveProperty('players')
    const seventh = translateMatchZyEvent(roundEnd(4, 3, 99), context, {
      scores: { 1: { team1: 3, team2: 3 } },
    })
    expect(seventh.events[0]).toMatchObject({
      type: 'round_end',
      roundNumber: 7,
      winner: { team: 'team_a' },
    })
  })

  it('falls back to MatchZy’s own field on a knifed map when the delta is ambiguous, and says so', () => {
    const knifed: MatchZyContext = { ...context, maps: [{ map: 'de_mirage', sides: 'knife' }] }
    const result = translateMatchZyEvent(
      {
        event: 'round_end',
        matchid: context.serial,
        map_number: 0,
        round_number: 2,
        reason: 9,
        winner: { side: '2', team: 'team2' },
        team1: { id: '', name: 'A', score: 1, players: [] },
        team2: { id: '', name: 'B', score: 1, players: [] },
      },
      knifed,
      initialMatchZyState(),
    )
    expect(result.events[0]).toMatchObject({
      winner: { team: 'team_b', side: 't' },
      roundNumber: 2,
    })
    expect(result.note).toMatch(/knifed/)
  })

  it('schedules sides through halves and overtime for the fallback', () => {
    // Team A starts CT on MR2 with MR1 overtime: rounds 1–2 CT, 3–4 T; OT1 opens on T then CT; OT2 opens on CT then T.
    const expectations: [number, 'ct' | 't'][] = [
      [1, 'ct'],
      [2, 'ct'],
      [3, 't'],
      [4, 't'],
      [5, 't'],
      [6, 'ct'],
      [7, 'ct'],
      [8, 't'],
      [9, 't'],
      [10, 'ct'],
    ]
    for (const [round, side] of expectations) {
      expect(scheduledSide('ct', round, 4, 2), `round ${round}`).toBe(side)
      expect(scheduledSide('t', round, 4, 2), `round ${round}, started T`).toBe(
        side === 'ct' ? 't' : 'ct',
      )
    }
    // MR12 with MR3 overtime: round 13 is the first of the second half, round 25 opens overtime on it, round 28 swaps.
    expect(scheduledSide('ct', 12, 24, 6)).toBe('ct')
    expect(scheduledSide('ct', 13, 24, 6)).toBe('t')
    expect(scheduledSide('ct', 25, 24, 6)).toBe('t')
    expect(scheduledSide('ct', 28, 24, 6)).toBe('ct')
  })
})
