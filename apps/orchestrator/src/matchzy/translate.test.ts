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
  /**
   * The per-team ready floor this payload's match config carried
   * (`min_players_to_ready`, PRD-03 T5a). Absent is the recorded run's own
   * `0` — the fork's "everybody connected must ready" — and a file that
   * declares one is a match whose request asked for a gate below its roster.
   */
  readyFloor?: number
  /**
   * The roster this payload's match had, when it was not the recorded run's
   * ten (PRD-03 T6). An **uneven** one is the only way to make the case where
   * the fork's one number for two teams disagrees with the sides.
   */
  teams?: MatchZyContext['teams']
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

/** A puppet's SteamID64 by its last three digits: they only differ there. */
function puppet(tail: string): string {
  return `76561198279375${tail}`
}

const context: MatchZyContext = {
  matchId: FIXTURE_MATCH_ID,
  source: { provider: 'nodes', serverId: 'devbox-1' },
  serial: matchzySerial(FIXTURE_MATCH_ID),
  // The map the recorded match was played on (T13).
  maps: [{ map: 'de_dust2', sides: 'ct' }],
  // The recorded run's team names and its ten puppets — tk and maex among
  // them, one a side — so a ready event resolves through the roster rather
  // than through those names, and a `team_ready` has a number to be held
  // against (`scripts/iron-match.mjs`, PRD-03 T5).
  teams: {
    teamA: { name: 'EZPug A', players: ['306', '308', '310', '312', '314'].map(puppet) },
    teamB: { name: 'EZPug B', players: ['307', '309', '311', '313', '315'].map(puppet) },
  },
  // The recorded run asked for `minPlayersToReady: 0`, which is the fork's
  // "everybody connected must ready" and leaves the roster as the door's only
  // expectation (PRD-03 T5a). The floor's own cases are below.
  readyFloor: 0,
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
      const result = translateMatchZyEvent(
        fixture.payload,
        {
          ...context,
          ...(fixture.readyFloor !== undefined && { readyFloor: fixture.readyFloor }),
          ...(fixture.teams !== undefined && { teams: fixture.teams }),
        },
        fixture.state ?? state,
      )
      // **A fixture that declares its own state does not leak into the
      // story.** It is a case of its own — that is what declaring one means —
      // and the recorded run either side of it is one match in order. The
      // generator carries state by exactly this rule; when the two disagreed,
      // the recorded ready gate's own memory was wiped by the upstream
      // fixtures sitting between its files (PRD-03 T5).
      if (fixture.state === undefined) state = result.state
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
      ready: {},
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

  it('says a team is through the gate once, and again after an unready', () => {
    // MatchZy-Enhanced re-checks the gate after every single ready and POSTs a
    // team_ready for each team still through it, twice over from two call
    // sites and with a fresh total every time: the first pug of ten puppets
    // sent 42 of them and two all_players_ready, for two teams that passed
    // the gate once each (PRD-03 T5, measured on the dev node). A durable log
    // holds facts; the counts as they move are player_ready's.
    const teamReady = (count: number, total: number) => ({
      event: 'team_ready',
      matchid: context.serial,
      team: 'team1',
      ready_count: count,
      total_ready: total,
      expected_total: 10,
    })
    const everybody = {
      event: 'all_players_ready',
      matchid: context.serial,
      ready_count_team1: 5,
      ready_count_team2: 5,
      total_ready: 10,
      countdown_started: true,
    }
    let state = initialMatchZyState()
    const said = translateMatchZyEvent(teamReady(5, 7), context, state)
    state = said.state
    expect(said.events[0]).toMatchObject({ type: 'team_ready', team: 'team_a' })
    const again = translateMatchZyEvent(teamReady(5, 7), context, state)
    state = again.state
    expect(again.events).toEqual([])
    expect(again.dropped).toMatch(/already through the gate/)
    // The other team readying up moves the total and changes nothing about
    // this team: it is through, and it was through before.
    const moved = translateMatchZyEvent(teamReady(5, 9), context, state)
    state = moved.state
    expect(moved.events).toEqual([])

    const all = translateMatchZyEvent(everybody, context, state)
    state = all.state
    expect(all.events[0]).toMatchObject({ type: 'all_ready', countdown: true })
    const allAgain = translateMatchZyEvent(everybody, context, state)
    state = allAgain.state
    expect(allAgain.events).toEqual([])
    expect(allAgain.dropped).toMatch(/already ready/)

    // An unready takes its own team back out of the gate — tk is rostered on
    // team A — and the room with it. Coming back through is news, and a lobby
    // has to see it.
    const unready = translateMatchZyEvent(
      {
        event: 'player_unready',
        matchid: context.serial,
        player: { steamid: '76561198279375306', name: 'tk', team: 'EZPug A' },
        team: 'EZPug A',
        ready_count_team1: 4,
        ready_count_team2: 5,
        total_ready: 9,
        expected_total: 10,
      },
      context,
      state,
    )
    expect(unready.events[0]).toMatchObject({ type: 'player_unready' })
    state = unready.state
    expect(translateMatchZyEvent(teamReady(5, 7), context, state).events).toHaveLength(1)
    expect(translateMatchZyEvent(everybody, context, state).events).toHaveLength(1)
  })

  /**
   * **The floor the door has to know** (PRD-03 T5a). MatchZy-Enhanced's
   * `IsTeamReady` wants `players_per_team` bodies on the side and then passes
   * the team at `readyCount >= min_players_to_ready` — so a five whose match
   * config asks four is genuinely through with its fifth still silent. T5
   * held every `team_ready` against the whole roster, which filtered the
   * fork's transients and this real passage with them; the floor is the same
   * number the builder wrote into the match file
   * ({@link matchZyReadyGate}), never a second opinion.
   */
  describe('the ready floor its match config set', () => {
    const teamReady = (count: number, total = count, team = 'team1') => ({
      event: 'team_ready',
      matchid: context.serial,
      team,
      ready_count: count,
      total_ready: total,
      expected_total: 10,
    })
    const withFloor = (readyFloor: number, teams = context.teams): MatchZyContext => ({
      ...context,
      teams,
      readyFloor,
    })

    it('lets a five whose gate is four through with its fifth still silent', () => {
      const result = translateMatchZyEvent(teamReady(4), withFloor(4), initialMatchZyState())
      expect(result.dropped).toBeUndefined()
      expect(result.events[0]).toMatchObject({
        type: 'team_ready',
        team: 'team_a',
        tally: { ready: { teamA: 4, teamB: 0 }, expected: 10 },
      })
      // The same payload against a match that asked everybody to ready: the
      // roster is the expectation there, and four of five is the sides still
      // being filled. This is T5's rule, and it is why the floor exists —
      // without it the line above is a drop.
      expect(translateMatchZyEvent(teamReady(4), context, initialMatchZyState()).dropped).toMatch(
        /4 ready, under its 5 rostered/,
      )
    })

    it('still drops the fork’s transients, which sit under any real floor', () => {
      // Every recorded puppet pug opens with a team_ready at none of five,
      // and announces a team again at one of five while its bots are being
      // mapped (T5): the side count and the logical count disagree until the
      // mapping is done.
      for (const count of [0, 1, 3]) {
        const result = translateMatchZyEvent(teamReady(count), withFloor(4), initialMatchZyState())
        expect(result.events).toEqual([])
        expect(result.dropped).toMatch(new RegExp(`${count} ready, under the 4`))
      }
    })

    it('never asks a side for more than its roster holds', () => {
      // A 2v1: `players_per_team` is the smaller roster's one (T1), so the
      // floor is one, and MatchZy calls the pair through with one of the two
      // ready. That is the case the PRD names — a team let through on
      // min_players_to_ready with somebody still silent — and it is a fact.
      const uneven = {
        teamA: { name: 'EZPug A', players: ['306', '308'].map(puppet) },
        teamB: { name: 'EZPug B', players: [puppet('307')] },
      }
      expect(
        translateMatchZyEvent(teamReady(1, 1), withFloor(1, uneven), initialMatchZyState())
          .events[0],
      ).toMatchObject({ team: 'team_a', tally: { ready: { teamA: 1, teamB: 0 } } })
      // And a floor the roster cannot reach is the stall wearing the other
      // shoe: the single player on team B is through at one, whatever number
      // a config carried.
      expect(
        translateMatchZyEvent(teamReady(1, 1, 'team2'), withFloor(5, uneven), initialMatchZyState())
          .events[0],
      ).toMatchObject({ team: 'team_b' })
    })

    /**
     * **And the same floor decides when the *room* is ready** (PRD-03 T6).
     * `IsLiveRequirementSatisfied` is per team; `all_players_ready` is not —
     * the fork sends it on `total_ready >= players_per_team × 2`, one number
     * for two teams, which is the 2026-09-18 stall's arithmetic pointed the
     * other way. An uneven roster is where it shows: the 2v1 on the dev node
     * carries `players_per_team: 1`, so the fork called a room of three all
     * ready at two while team A still held somebody silent — and said it
     * again, with different counts, once they had spoken. Two `all_ready` for
     * one room, the first of them a player early, in a durable log.
     */
    it('does not call a room of three ready at two', () => {
      const uneven = {
        teamA: { name: 'EZPug A', players: ['306', '308'].map(puppet) },
        teamB: { name: 'EZPug B', players: [puppet('307')] },
      }
      const room = (team1: number, team2: number) => ({
        event: 'all_players_ready',
        matchid: context.serial,
        ready_count_team1: team1,
        ready_count_team2: team2,
        total_ready: team1 + team2,
        countdown_started: true,
      })
      // Byte for byte what the matrix's 2v1 sent, in order.
      const early = translateMatchZyEvent(room(1, 1), withFloor(0, uneven), initialMatchZyState())
      expect(early.events).toEqual([])
      expect(early.dropped).toMatch(/team_a is under its 2 rostered/)
      const whole = translateMatchZyEvent(room(2, 1), withFloor(0, uneven), initialMatchZyState())
      expect(whole.dropped).toBeUndefined()
      expect(whole.events[0]).toMatchObject({
        type: 'all_ready',
        ready: { teamA: 2, teamB: 1 },
        countdown: true,
      })
      // A gate below the roster is a real gate here too, exactly as it is for
      // a `team_ready`: a 5v5 whose config asks four a side is a whole room
      // at four and four (T5a).
      expect(
        translateMatchZyEvent(room(4, 4), withFloor(4), initialMatchZyState()).events[0],
      ).toMatchObject({ type: 'all_ready', ready: { teamA: 4, teamB: 4 } })
    })

    it('holds an unrostered team against nothing at all', () => {
      // The `--force-start` lane's match rosters nobody, and a floor built
      // from a manifest is no expectation about bodies nobody named.
      const anonymous = {
        teamA: { name: 'EZPug A', players: [] },
        teamB: { name: 'EZPug B', players: [] },
      }
      expect(
        translateMatchZyEvent(teamReady(0, 0), withFloor(0, anonymous), initialMatchZyState())
          .events[0],
      ).toMatchObject({ type: 'team_ready', team: 'team_a' })
    })
  })

  it('says where one player stands once — the reconcile pass readies a slot twice', () => {
    // The second puppet pug sent eleven player_ready for ten puppets: the
    // fork's reconcile pass re-readied puppet-9 after its bot was remapped,
    // with the tally unmoved (PRD-03 T5, measured on the dev node).
    const ready = (event: 'player_ready' | 'player_unready', total: number) => ({
      event,
      matchid: context.serial,
      player: { steamid: '76561198279375306', name: 'tk', team: 'EZPug A' },
      team: 'EZPug A',
      ready_count_team1: total > 5 ? 5 : total,
      ready_count_team2: total > 5 ? total - 5 : 0,
      total_ready: total,
      expected_total: 10,
    })
    let state = initialMatchZyState()
    const first = translateMatchZyEvent(ready('player_ready', 1), context, state)
    state = first.state
    expect(first.events[0]).toMatchObject({ type: 'player_ready' })
    const again = translateMatchZyEvent(ready('player_ready', 7), context, state)
    state = again.state
    expect(again.events).toEqual([])
    expect(again.dropped).toMatch(/already ready/)
    // Taking it back is a fact, and so is readying up after that.
    const back = translateMatchZyEvent(ready('player_unready', 6), context, state)
    state = back.state
    expect(back.events[0]).toMatchObject({ type: 'player_unready' })
    expect(translateMatchZyEvent(ready('player_unready', 6), context, state).dropped).toMatch(
      /already unready/,
    )
    expect(translateMatchZyEvent(ready('player_ready', 7), context, state).events).toHaveLength(1)
  })

  it('spends the gate when the map goes live, so a second map readies up again', () => {
    const ready = {
      event: 'player_ready',
      matchid: context.serial,
      player: { steamid: '76561198279375306', name: 'tk', team: 'EZPug A' },
      team: 'EZPug A',
      ready_count_team1: 1,
      ready_count_team2: 0,
      total_ready: 1,
      expected_total: 2,
    }
    let state = translateMatchZyEvent(ready, context, initialMatchZyState()).state
    expect(translateMatchZyEvent(ready, context, state).events).toEqual([])
    state = translateMatchZyEvent(
      { event: 'going_live', matchid: context.serial, map_number: 0 },
      context,
      state,
    ).state
    expect(translateMatchZyEvent(ready, context, state).events).toHaveLength(1)
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
