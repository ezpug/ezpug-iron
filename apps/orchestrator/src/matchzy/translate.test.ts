import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type GameserverEvent, gameserverEventSchema } from '@ezpug/match-api'
import { FIXTURE_MATCH_ID } from '@ezpug/match-api/fixtures'
import { describe, expect, it } from 'vitest'
import { matchzySerial } from '../match-config/matchzy'
import {
  initialMatchZyState,
  MATCHZY_KNOWN_EVENTS,
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
  // The recorded run's team names, with one rostered SteamID a side so a
  // ready event resolves through the roster rather than through those names.
  teams: {
    teamA: { name: 'EZPug A', players: ['76561198279375306'] },
    teamB: { name: 'EZPug B', players: ['76561198279375307'] },
  },
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
      starts: {},
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

/**
 * **The fork's own events** (PRD-03 T3). MatchZy-Enhanced 1.4.32 sends
 * twenty-six names stock 0.8.15 never had; the rules that decide what each
 * one becomes are pinned here, and the fixtures beside this file play the
 * shapes.
 */
describe('MatchZy-Enhanced, event by event', () => {
  const ready = (over: Record<string, unknown> = {}) => ({
    event: 'player_ready',
    matchid: context.serial,
    player: { steamid: '76561198279375307', name: 'maex', team: 'EZPug A' },
    team: 'EZPug A',
    ready_count_team1: 1,
    ready_count_team2: 1,
    total_ready: 2,
    expected_total: 2,
    ...over,
  })

  it('takes a ready player’s team from the roster, not from the team name beside it', () => {
    // The payload says team A twice over; maex is rostered on team B, and the
    // SteamID the request named is the one thing MatchZy cannot get wrong.
    const result = translateMatchZyEvent(ready(), context, initialMatchZyState())
    expect(result.events[0]).toMatchObject({
      type: 'player_ready',
      player: { steamId64: '76561198279375307', team: 'team_b' },
      tally: { ready: { teamA: 1, teamB: 1 }, expected: 2 },
    })
  })

  it('falls back to the team name for a body the roster never named, and to nobody when it is ambiguous', () => {
    const stranger = { steamid: '76561198000000001', name: 'gast', team: 'EZPug B' }
    expect(
      translateMatchZyEvent(
        ready({ player: stranger, team: 'EZPug B' }),
        context,
        initialMatchZyState(),
      ).events[0],
    ).toMatchObject({ player: { team: 'team_b' } })
    // Two teams that chose the same name resolve to nobody rather than a guess.
    const twins: MatchZyContext = {
      ...context,
      teams: {
        teamA: { name: 'EZPug', players: [] },
        teamB: { name: 'EZPug', players: [] },
      },
    }
    const result = translateMatchZyEvent(
      ready({ player: stranger, team: 'EZPug' }),
      twins,
      initialMatchZyState(),
    )
    expect(result.events[0]).toMatchObject({ player: { steamId64: '76561198000000001' } })
    expect(result.events[0]).not.toHaveProperty('player.team')
  })

  it('drops a ready MatchZy cannot attribute — a bot outside simulation mode has SteamID "0"', () => {
    const result = translateMatchZyEvent(
      ready({ player: { steamid: '0', name: 'Romanov', team: 'EZPug B' } }),
      context,
      initialMatchZyState(),
    )
    expect(result.events).toEqual([])
    expect(result.dropped).toMatch(/no SteamID64/)
  })

  it('reads the other team’s ready count off team_ready’s total', () => {
    const teamReady = (team: string, count: number, total: number) =>
      translateMatchZyEvent(
        {
          event: 'team_ready',
          matchid: context.serial,
          team,
          ready_count: count,
          total_ready: total,
          expected_total: 10,
        },
        context,
        initialMatchZyState(),
      ).events[0]
    expect(teamReady('team1', 5, 7)).toMatchObject({
      type: 'team_ready',
      team: 'team_a',
      tally: { ready: { teamA: 5, teamB: 2 }, expected: 10 },
    })
    expect(teamReady('team2', 5, 7)).toMatchObject({
      team: 'team_b',
      tally: { ready: { teamA: 2, teamB: 5 } },
    })
    // A total below this team's own count cannot mean a negative other team.
    expect(teamReady('team1', 5, 3)).toMatchObject({ tally: { ready: { teamA: 5, teamB: 0 } } })
  })

  it('drops the go-live round restarts but not a round the backup moved back to', () => {
    const started = (roundNumber: number, team1: number, team2: number) => ({
      event: 'round_started',
      matchid: context.serial,
      map_number: 0,
      round_number: roundNumber,
      team1_score: team1,
      team2_score: team2,
    })
    // The recorded run opens with three identical round 1 payloads.
    let state = initialMatchZyState()
    const first = translateMatchZyEvent(started(1, 0, 0), context, state)
    state = first.state
    expect(first.events[0]).toMatchObject({ type: 'round_start', roundNumber: 1 })
    for (const _ of [0, 1]) {
      const again = translateMatchZyEvent(started(1, 0, 0), context, state)
      state = again.state
      expect(again.events).toEqual([])
      expect(again.dropped).toMatch(/already started/)
    }
    // A restore comes back to a round number already seen, at another score.
    const restored = translateMatchZyEvent(started(1, 3, 4), context, state)
    expect(restored.events[0]).toMatchObject({
      type: 'round_start',
      roundNumber: 1,
      score: { teamA: 3, teamB: 4 },
    })
  })

  it('names a knife winner, and credits nobody when MatchZy says "none"', () => {
    const knife = (winner: string) =>
      translateMatchZyEvent(
        { event: 'knife_round_ended', matchid: context.serial, map_number: 0, winner },
        context,
        initialMatchZyState(),
      )
    expect(knife('team2').events[0]).toMatchObject({ type: 'knife_end', winner: 'team_b' })
    expect(knife('team2').note).toBeUndefined()
    const none = knife('none')
    expect(none.events[0]).toMatchObject({ type: 'knife_end', winner: null })
    expect(none.note).toMatch(/unreadable/)
  })

  it('reads a server-level event for the log and makes no fact of it', () => {
    const health = (over: Record<string, unknown>) =>
      translateMatchZyEvent(
        {
          event: 'server_health',
          server_id: 'devbox-1',
          plugin_version: '1.4.32',
          timestamp: 1,
          db_ok: true,
          db_type: 'sqlite',
          reason: 'startup',
          ...over,
        },
        context,
        initialMatchZyState(),
      )
    expect(health({}).events).toEqual([])
    expect(health({}).dropped).toMatch(/database sqlite ok/)
    // T2's cfg check exists to make this impossible; if it ever arrives, the
    // log is where an operator meets it.
    expect(health({ db_ok: false, db_type: 'mysql', db_error: 'refused' }).dropped).toMatch(
      /mysql failing — refused/,
    )
  })

  it('knows every event the pinned fork can send, when the reference clone is here', () => {
    // `references/MatchZy-Enhanced` is a gitignored clone at the pinned tag
    // (`references/README.md`), and verify never needs the network — so without
    // it this is not a red. With it, a fork release that adds an event name
    // nobody classified fails here rather than landing in the log as "an event
    // this translator does not know".
    const src = fileURLToPath(
      new URL('../../../../references/MatchZy-Enhanced/src/', import.meta.url),
    )
    if (!existsSync(src)) return
    const emitted = new Set<string>()
    for (const file of readdirSync(src).filter(name => name.endsWith('.cs'))) {
      for (const match of readFileSync(`${src}${file}`, 'utf8').matchAll(
        /: base\("([a-z0-9_]+)"\)/g,
      ))
        emitted.add(match[1] as string)
    }
    expect(emitted.size, 'the clone holds no event serialisers').toBeGreaterThan(20)
    const known = new Set<string>(MATCHZY_KNOWN_EVENTS)
    expect([...emitted].filter(name => !known.has(name)).sort()).toEqual([])
  })
})
