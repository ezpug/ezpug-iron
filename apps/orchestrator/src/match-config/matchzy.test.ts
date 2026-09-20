import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  type MatchRequest,
  type MatchRequestInput,
  matchRequestSchema,
  shippedGamemode,
} from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import {
  buildGet5Config,
  buildMatchConfig,
  buildMatchZyConfig,
  type MatchConfigInput,
  type MatchZyMatchConfig,
  matchZyReadyGate,
  matchzySerial,
} from './matchzy'

/**
 * **The wire format, pinned** (PRD-02 T9): the three golden files beside
 * this test are what a request becomes on the server — loadable MatchZy and
 * Get5 match files, byte for byte — and MatchZy's own validator, transcribed,
 * says each one would load.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const golden = (name: string): unknown =>
  JSON.parse(readFileSync(`${FIXTURES}${name}.json`, 'utf8'))

const TEAM_A = [
  { steamId64: '76561198070000101', name: 'hunzR' },
  { steamId64: '76561198070000103', name: 'Schmiddi' },
  { steamId64: '76561198070000106', name: 'flexxi' },
  { steamId64: '76561198070000109', name: 'maex' },
  { steamId64: '76561198070000111', name: 'nova' },
]
const TEAM_B = [
  { steamId64: '76561198070000102', name: 'Bommelmann' },
  { steamId64: '76561198070000107', name: 'SaarKrieger2003' },
  { steamId64: '76561198070000110', name: 'tobi' },
  { steamId64: '76561198070000112', name: 'kalle' },
  { steamId64: '76561198070000113', name: 'zwiebel' },
]

function request(overrides: Partial<MatchRequestInput> = {}): MatchRequest {
  return matchRequestSchema.parse({
    clientMatchId: 'platform-match-27',
    game: 'cs2',
    gamemode: 'pug',
    teams: {
      teamA: { name: 'Team hunzR', players: TEAM_A },
      teamB: { name: 'Team Bommelmann', players: TEAM_B },
    },
    maps: [{ map: 'de_mirage', sides: 'ct' }],
    rules: {
      regulationRounds: 24,
      overtime: { enabled: true, maxRounds: 6, startMoney: 10_000 },
      warmup: { minPlayersToReady: 10, minSpectatorsToReady: 0 },
    },
    callbacks: { webhookUrl: 'https://platform.invalid/hooks', webhookSecretId: 'whsec-1' },
    ttlMinutes: 180,
    ...overrides,
  })
}

/** The queue's pug: ranked Bo1, sides already picked. */
function pugBo1(): MatchConfigInput {
  return {
    matchId: '7f3a1c22-2b64-4a5f-9c31-0d5e6f8a1b20',
    request: request(),
    manifest: shippedGamemode('pug'),
  }
}

/** A custom room: unranked Bo3, knife rounds, a preset's cvars riding along. */
function knifeBo3(): MatchConfigInput {
  return {
    matchId: 'b81d4e07-6c3a-4f19-8e52-9a7b0c1d2e3f',
    request: request({
      clientMatchId: 'platform-match-128',
      maps: [
        { map: 'de_ancient', sides: 'knife' },
        { map: 'de_nuke', sides: 'knife' },
        { map: 'workshop/3070288000/de_cache', sides: 'knife' },
      ],
      rules: {
        regulationRounds: 24,
        overtime: { enabled: false, maxRounds: 6, startMoney: 10_000 },
        warmup: { minPlayersToReady: 10, minSpectatorsToReady: 0 },
        cvars: { mp_friendlyfire: '0', sv_cheats: '0' },
      },
      branding: { hostname: 'EZPug Custom — Bo3' },
    }),
    manifest: shippedGamemode('pug'),
  }
}

/** The CS:GO nostalgia queue: same machinery, Get5 on the far end, MR15. */
function csgoBo1(): MatchConfigInput {
  return {
    matchId: '3c9e5a71-8d42-4b06-a1f7-5e2c8b9d0a34',
    request: request({
      clientMatchId: 'platform-match-41',
      game: 'csgo',
      maps: [{ map: 'de_train', sides: 't' }],
      rules: {
        regulationRounds: 30,
        overtime: { enabled: true, maxRounds: 6, startMoney: 10_000 },
        warmup: { minPlayersToReady: 10, minSpectatorsToReady: 0 },
      },
    }),
    manifest: shippedGamemode('pug'),
  }
}

/**
 * **The 2v2 the rooms default to** (PRD-03 T3b): `rules.format: 'wingman'`,
 * knife for sides, MR8 — the platform's own `wingman` preset, on a full map,
 * which is what a person picking "wingman" on ezpug.com builds today.
 */
function wingmanBo1(): MatchConfigInput {
  return {
    matchId: 'e4c1a9b8-3d27-4f65-9a08-1b2c3d4e5f60',
    request: request({
      clientMatchId: 'platform-match-212',
      teams: {
        teamA: { name: 'Team hunzR', players: TEAM_A.slice(0, 2) },
        teamB: { name: 'Team Bommelmann', players: TEAM_B.slice(0, 2) },
      },
      maps: [{ map: 'de_mirage', sides: 'knife' }],
      rules: {
        format: 'wingman',
        regulationRounds: 16,
        overtime: { enabled: true, maxRounds: 6, startMoney: 10_000 },
        warmup: { minPlayersToReady: 4, minSpectatorsToReady: 0 },
      },
    }),
    manifest: shippedGamemode('pug'),
  }
}

/**
 * MatchZy's own `ValidateMatchJsonStructure`
 * (`references/MatchZy/MatchManagement.cs`), transcribed. A config we emit
 * has to survive the parser that will load it — the goldens pin the *shape*,
 * this pins that the shape is legal.
 */
function matchZyValidationError(config: MatchZyMatchConfig): string {
  const json = JSON.parse(JSON.stringify(config)) as Record<string, unknown>
  for (const field of ['maplist', 'team1', 'team2', 'num_maps']) {
    if (json[field] === undefined) return `Missing mandatory field: ${field}`
  }
  for (const field of [
    'matchid',
    'players_per_team',
    'min_players_to_ready',
    'min_spectators_to_ready',
    'num_maps',
  ]) {
    const value = json[field]
    if (value !== undefined && !Number.isInteger(value)) return `${field} should be an integer!`
  }
  if (config.num_maps > config.maplist.length) {
    return 'num_maps should be equal to or greater than maplist!'
  }
  for (const field of ['cvars', 'team1', 'team2', 'spectators']) {
    const value = json[field]
    if (value === undefined) continue
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return `${field} should be a JSON structure!`
    }
    if (
      (field === 'team1' || field === 'team2') &&
      typeof (value as { players?: unknown }).players !== 'object'
    ) {
      return `${field} should have 'players' JSON!`
    }
  }
  if (config.maplist.length === 0) return 'maplist should contain atleast 1 map!'
  const allowed = ['team1_ct', 'team1_t', 'team2_ct', 'team2_t', 'knife']
  if (config.map_sides.some(side => !allowed.includes(side))) {
    return 'map_sides should be "team1_ct", "team1_t", or "knife"!'
  }
  if (config.map_sides.length < config.num_maps) {
    return 'map_sides should be equal to or greater than num_maps!'
  }
  return ''
}

describe('golden fixtures — the wire format', () => {
  it('builds the pug Bo1 MatchZy file byte for byte', () => {
    expect(buildMatchZyConfig(pugBo1())).toEqual(golden('matchzy-pug-bo1'))
  })

  it('builds the knife Bo3 MatchZy file byte for byte', () => {
    expect(buildMatchZyConfig(knifeBo3())).toEqual(golden('matchzy-knife-bo3'))
  })

  it('builds the wingman Bo1 MatchZy file byte for byte', () => {
    expect(buildMatchZyConfig(wingmanBo1())).toEqual(golden('matchzy-wingman-bo1'))
  })

  it('builds the CS:GO Bo1 Get5 file byte for byte', () => {
    expect(buildGet5Config(csgoBo1())).toEqual(golden('get5-bo1'))
  })

  it('emits configs MatchZy own validator accepts', () => {
    expect(matchZyValidationError(buildMatchZyConfig(pugBo1()))).toBe('')
    expect(matchZyValidationError(buildMatchZyConfig(knifeBo3()))).toBe('')
    expect(matchZyValidationError(buildMatchZyConfig(wingmanBo1()))).toBe('')
  })

  it('round-trips through JSON — nothing on the wire is undefined or a Map', () => {
    const config = buildMatchZyConfig(pugBo1())
    expect(JSON.parse(JSON.stringify(config))).toEqual(config)
  })
})

describe('the game dimension picks the plugin', () => {
  it('dispatches cs2 to MatchZy and csgo to Get5', () => {
    expect(buildMatchConfig(pugBo1())).toEqual(buildMatchZyConfig(pugBo1()))
    expect(buildMatchConfig(csgoBo1())).toEqual(buildGet5Config(csgoBo1()))
  })
})

describe('two id spaces', () => {
  it('gives MatchZy a positive 31-bit serial of the uuid and Get5 the uuid itself', () => {
    const serial = buildMatchZyConfig(pugBo1()).matchid
    expect(serial).toBe(matchzySerial('7f3a1c22-2b64-4a5f-9c31-0d5e6f8a1b20'))
    expect(Number.isInteger(serial) && serial > 0 && serial <= 0x7fff_ffff).toBe(true)
    expect(buildGet5Config(csgoBo1()).matchid).toBe('3c9e5a71-8d42-4b06-a1f7-5e2c8b9d0a34')
  })

  it('derives the same serial every time and different ones for different matches', () => {
    expect(matchzySerial('a')).toBe(matchzySerial('a'))
    expect(matchzySerial('a')).not.toBe(matchzySerial('b'))
    for (const id of ['', 'x', '00000000-0000-0000-0000-000000000000']) {
      const serial = matchzySerial(id)
      expect(serial).toBeGreaterThan(0)
      expect(serial).toBeLessThanOrEqual(0x7fff_ffff)
    }
  })
})

/**
 * MatchZy's ready gate for one team (`references/MatchZy/ReadySystem.cs`
 * `IsTeamReady`), transcribed like its validator above. `readyAvailable` is
 * true for the whole warmup a loaded config sits in, so the `playerCount == 0`
 * refusal always applies.
 */
function matchZyTeamReady(
  config: Pick<MatchZyMatchConfig, 'players_per_team' | 'min_players_to_ready'>,
  team: { playerCount: number; readyCount: number; forced?: boolean },
): boolean {
  const { playerCount, readyCount, forced = false } = team
  if (playerCount === 0) return false
  if (playerCount === readyCount && playerCount >= config.players_per_team) return true
  if (forced && readyCount >= config.min_players_to_ready) return true
  return false
}

/**
 * **MatchZy-Enhanced's gate, which is not stock's** (`ReadySystem.cs`
 * `IsTeamReady` in the pinned fork, transcribed beside stock's above —
 * PRD-03 T5a). Two differences the door has to live with:
 *
 * - `min_players_to_ready` is **the ordinary gate**, not a force-ready floor.
 *   At `0` everybody connected must ready, as stock did; above `0` a team
 *   passes at `readyCount >= minReady`, with nobody typing `.forceready`.
 * - The roster requirement did not move: a side still needs
 *   `players_per_team` **bodies connected** before any of this is read. So a
 *   player who never connects never reaches the floor — the floor is only
 *   ever crossed by somebody who is there and silent.
 */
function enhancedTeamReady(
  config: Pick<MatchZyMatchConfig, 'players_per_team' | 'min_players_to_ready'>,
  team: { playerCount: number; readyCount: number; forced?: boolean },
): boolean {
  const { playerCount, readyCount, forced = false } = team
  if (playerCount === 0) return false
  if (playerCount < config.players_per_team) return false
  if (config.min_players_to_ready <= 0) {
    if (playerCount === readyCount) return true
  } else if (readyCount >= config.min_players_to_ready) {
    return true
  }
  return forced
}

/** Every rostered player is on the server and has typed `!ready`. Does MatchZy go live? */
function goesLiveOnceEverybodyReadies(config: MatchZyMatchConfig): boolean {
  return [config.team1, config.team2].every(team => {
    const size = Object.keys(team.players).length
    return matchZyTeamReady(config, { playerCount: size, readyCount: size })
  })
}

/**
 * **The 2026-09-18 stall, and the rule that ends it** (PRD-03 T1). Two people
 * in a 1v1 pug typed `!ready` twice each and nothing went live, because the
 * config said `players_per_team: 5` — the manifest's — and MatchZy passes a
 * team only at `playerCount >= players_per_team`. These cases are replayed
 * through MatchZy's own gate above, so a regression here reads as the plugin
 * refusing to start a match, which is what the owner saw, rather than as a
 * number in a fixture moving.
 */
describe('a team of one can ready up', () => {
  /** A pug rostered `a` against `b`, with the wire's whole-match ready gate. */
  function pug(a: number, b: number, total = a + b): MatchConfigInput {
    return {
      ...pugBo1(),
      request: request({
        teams: {
          teamA: { name: 'Team hunzR', players: TEAM_A.slice(0, a) },
          teamB: { name: 'Team Bommelmann', players: TEAM_B.slice(0, b) },
        },
        rules: {
          regulationRounds: 24,
          overtime: { enabled: true, maxRounds: 6, startMoney: 10_000 },
          warmup: { minPlayersToReady: total, minSpectatorsToReady: 0 },
        },
      }),
    }
  }

  // **Every size from one to five a side** (PRD-03 T6), because the stall was
  // a size: each of these is a different `players_per_team` in the match file
  // and so a different answer from `IsTeamReady`. The same list is played on
  // real hardware by the lane's matrix (`cs2.extended.test.ts`).
  it.each([
    [1, 1, 1],
    [2, 1, 1],
    [2, 2, 2],
    [3, 3, 3],
    [4, 4, 4],
    [5, 5, 5],
  ])('goes live on a %ivs%i roster, at %i a side', (a, b, perTeam) => {
    const config = buildMatchZyConfig(pug(a, b))
    expect(config.players_per_team).toBe(perTeam)
    expect(goesLiveOnceEverybodyReadies(config)).toBe(true)
    expect(matchZyValidationError(config)).toBe('')
  })

  it("is the stall itself when the manifest's five is sent for a 1v1", () => {
    const stalled = { ...buildMatchZyConfig(pug(1, 1)), players_per_team: 5 }
    expect(goesLiveOnceEverybodyReadies(stalled)).toBe(false)
    expect(goesLiveOnceEverybodyReadies(buildMatchZyConfig(pug(1, 1)))).toBe(true)
  })

  it('takes the smaller team, because one number has to let both through', () => {
    // Two would refuse the single player for ever; `playerCount == readyCount`
    // is what still makes both of the pair say `!ready`.
    const config = buildMatchZyConfig(pug(2, 1))
    expect(config.players_per_team).toBe(1)
    expect(matchZyTeamReady(config, { playerCount: 2, readyCount: 1 })).toBe(false)
    expect(matchZyTeamReady(config, { playerCount: 2, readyCount: 2 })).toBe(true)
  })

  it('never lets a roster outgrow the mode it plays', () => {
    const config = buildMatchZyConfig({
      ...pug(5, 5),
      manifest: {
        ...shippedGamemode('pug'),
        slots: { ...shippedGamemode('pug').slots, teamSize: 2 },
      },
    })
    expect(config.players_per_team).toBe(2)
  })

  it("keeps the manifest's house when the request rosters nobody", () => {
    expect(buildMatchZyConfig(pug(0, 0, 0)).players_per_team).toBe(5)
  })

  it("reads the wire's ready gate as the whole match and halves it for MatchZy", () => {
    // The platform sends `min(players, seats, preset)` across both teams;
    // MatchZy counts per team (`GetTeamMinReady`), so ten become five.
    expect(buildMatchZyConfig(pug(5, 5, 10)).min_players_to_ready).toBe(5)
    expect(buildMatchZyConfig(pug(1, 1, 2)).min_players_to_ready).toBe(1)
    // An odd total rounds up, then stops at the team a force-ready must pass.
    expect(buildMatchZyConfig(pug(2, 1, 3)).min_players_to_ready).toBe(1)
    expect(buildMatchZyConfig(pug(1, 1, 0)).min_players_to_ready).toBe(0)
  })

  it('hands the door the very number it wrote into the match file', () => {
    // The door holds a `team_ready` against `min_players_to_ready` (PRD-03
    // T5a) and reads it back through this function rather than halving the
    // request a second time. Two copies of one threshold disagreeing is the
    // 2026-09-18 stall's shape, and this is what makes a second copy
    // impossible.
    for (const input of [pug(5, 5, 10), pug(5, 5, 8), pug(2, 1, 3), pug(1, 1, 0), pug(0, 0, 0)]) {
      const config = buildMatchZyConfig(input)
      expect(matchZyReadyGate(input)).toEqual({
        playersPerTeam: config.players_per_team,
        minPlayersToReady: config.min_players_to_ready,
      })
    }
  })

  it('passes a five whose gate is four with its fifth silent, and never one who is absent', () => {
    // The case PRD-03 T5a plays: `minPlayersToReady: 8` across both teams is
    // four a side, and the fork's own gate lets the team through at four of
    // five ready. The door must forward that `team_ready`; T5's roster rule
    // dropped it.
    const config = buildMatchZyConfig(pug(5, 5, 8))
    expect(config.players_per_team).toBe(5)
    expect(config.min_players_to_ready).toBe(4)
    expect(enhancedTeamReady(config, { playerCount: 5, readyCount: 4 })).toBe(true)
    expect(enhancedTeamReady(config, { playerCount: 5, readyCount: 3 })).toBe(false)
    // **And the floor is never what a missing player crosses.** A side four
    // bodies deep is refused before the floor is read at all, so the PRD's
    // "one player never connecting" cannot be a team through the gate on
    // this build — the platform's join deadline stays the only thing that
    // gives up on them (T3a), and `AreAllConfiguredPlayersConnectedAndOnCorrectTeams`
    // holds the whole match in warmup meanwhile.
    expect(enhancedTeamReady(config, { playerCount: 4, readyCount: 4 })).toBe(false)
    // Stock 0.8.15 would have refused the four-of-five too: there the number
    // only ever applied to `.forceready`.
    expect(matchZyTeamReady(config, { playerCount: 5, readyCount: 4 })).toBe(false)
    expect(matchZyTeamReady(config, { playerCount: 5, readyCount: 4, forced: true })).toBe(true)
  })

  it('says the same number to Get5, which counts per team too', () => {
    const config = buildGet5Config({
      ...pug(1, 1),
      request: request({
        game: 'csgo',
        teams: {
          teamA: { name: 'Team hunzR', players: TEAM_A.slice(0, 1) },
          teamB: { name: 'Team Bommelmann', players: TEAM_B.slice(0, 1) },
        },
        rules: {
          regulationRounds: 30,
          overtime: { enabled: true, maxRounds: 6, startMoney: 10_000 },
          warmup: { minPlayersToReady: 2, minSpectatorsToReady: 0 },
        },
      }),
    })
    expect(config.players_per_team).toBe(1)
    expect(config.min_players_to_ready).toBe(1)
  })
})

/**
 * **Wingman on the wire** (PRD-03 T3b, owner decision 2026-09-19). One field
 * in the request, `rules.format`, and three things on the server: `game_mode
 * 2`, `live_wingman.cfg` instead of `live.cfg`, and a map loaded again when
 * the box was not already in that mode (`Utility.cs` `SetCorrectGameMode`,
 * `IsMapReloadRequiredForGameMode`). The builder's whole share of it is the
 * `wingman` boolean and a seat count of two; the refusals for a format a
 * gamemode cannot play live at the door (`match/machine.ts`).
 */
describe('wingman is a format, not a gamemode', () => {
  it('sets MatchZy’s wingman flag only when the request asks for it', () => {
    expect(buildMatchZyConfig(wingmanBo1()).wingman).toBe(true)
    expect(buildMatchZyConfig(pugBo1()).wingman).toBe(false)
    expect(buildMatchZyConfig(knifeBo3()).wingman).toBe(false)
  })

  it('plays the five-a-side game for a request that says nothing', () => {
    // Additive: a request written before the field existed parses and is
    // competitive, which is the only thing it could ever have meant.
    expect(request().rules?.format).toBe('competitive')
    expect(
      buildMatchZyConfig({ ...pugBo1(), request: request({ rules: undefined }) }).wingman,
    ).toBe(false)
  })

  it('seats two a side however many the mode’s manifest holds', () => {
    // The pug manifest says five; wingman says two, and MatchZy reads one
    // number for both teams. An unrostered wingman match waits for two.
    const unrostered = buildMatchZyConfig({
      ...wingmanBo1(),
      request: request({
        teams: { teamA: { name: 'CT', players: [] }, teamB: { name: 'T', players: [] } },
        rules: {
          format: 'wingman',
          regulationRounds: 16,
          overtime: { enabled: true, maxRounds: 6, startMoney: 10_000 },
          warmup: { minPlayersToReady: 4, minSpectatorsToReady: 0 },
        },
      }),
    })
    expect(unrostered.players_per_team).toBe(2)
    expect(buildMatchZyConfig(wingmanBo1()).players_per_team).toBe(2)
  })

  it('goes live once a 2v2 readies, and once a 1v1 wingman pair does', () => {
    const duo = buildMatchZyConfig(wingmanBo1())
    expect(goesLiveOnceEverybodyReadies(duo)).toBe(true)
    expect(duo.min_players_to_ready).toBe(2)
    const solo = buildMatchZyConfig({
      ...wingmanBo1(),
      request: request({
        teams: {
          teamA: { name: 'Team hunzR', players: TEAM_A.slice(0, 1) },
          teamB: { name: 'Team Bommelmann', players: TEAM_B.slice(0, 1) },
        },
        rules: {
          format: 'wingman',
          regulationRounds: 16,
          overtime: { enabled: true, maxRounds: 6, startMoney: 10_000 },
          warmup: { minPlayersToReady: 2, minSpectatorsToReady: 0 },
        },
      }),
    })
    expect(solo.players_per_team).toBe(1)
    expect(goesLiveOnceEverybodyReadies(solo)).toBe(true)
  })

  it('loads the map the request named — there is no wingman catalog here', () => {
    // Valve's short maps are named like any other; a full map under
    // `game_mode 2` is the client's choice and is passed through unchanged.
    expect(buildMatchZyConfig(wingmanBo1()).maplist).toEqual(['de_mirage'])
    expect(
      buildMatchZyConfig({
        ...wingmanBo1(),
        request: request({
          maps: [{ map: 'de_lake', sides: 'knife' }],
          rules: {
            format: 'wingman',
            regulationRounds: 16,
            overtime: { enabled: true, maxRounds: 6, startMoney: 10_000 },
            warmup: { minPlayersToReady: 4, minSpectatorsToReady: 0 },
          },
        }),
      }).maplist,
    ).toEqual(['de_lake'])
  })

  it('carries the request’s MR8 over the wingman live cfg’s own MR8', () => {
    // `live_wingman.cfg` says `mp_maxrounds 16` and MatchZy re-applies the
    // config's cvars after it; the rules are still what decide the format.
    expect(buildMatchZyConfig(wingmanBo1()).cvars.mp_maxrounds).toBe('16')
  })

  it('never says wingman to Get5, which has no such field', () => {
    expect(buildGet5Config(csgoBo1())).not.toHaveProperty('wingman')
  })
})

/**
 * **Puppets are a per-match switch in the match file** (PRD-03 T4, decision
 * 19): MatchZy-Enhanced reads `simulation` and `simulation_timescale` from
 * the JSON it loads (`src/MatchManagement.cs`), so the one build production
 * runs plays a simulated match when asked and a real one otherwise — and a
 * real match's file is byte for byte what it was before the field existed.
 */
describe('the simulation switch', () => {
  const puppets = (simulation: MatchRequestInput['simulation']): MatchConfigInput => ({
    ...pugBo1(),
    request: request({ simulation }),
  })

  it('is absent from a real match’s file, so the golden did not move', () => {
    const file = buildMatchZyConfig(pugBo1())
    expect(file).not.toHaveProperty('simulation')
    expect(file).not.toHaveProperty('simulation_timescale')
    expect(JSON.stringify(file)).not.toContain('simulation')
  })

  it('turns the fork’s simulation mode on when the request asks, at the engine’s own speed', () => {
    const file = buildMatchZyConfig(puppets({}))
    expect(file.simulation).toBe(true)
    // The fork's default, and the only honest speed for a server nobody watches slowly.
    expect(file.simulation_timescale).toBe(1)
    expect(buildMatchZyConfig(puppets({ timeScale: 4 })).simulation_timescale).toBe(4)
    expect(matchZyValidationError(file)).toBe('')
  })

  it('leaves the roster and the gate alone — a puppet sits in a rostered seat', () => {
    const real = buildMatchZyConfig(pugBo1())
    const simulated = buildMatchZyConfig(puppets({ timeScale: 2 }))
    expect(simulated.team1).toEqual(real.team1)
    expect(simulated.team2).toEqual(real.team2)
    expect(simulated.players_per_team).toBe(real.players_per_team)
    expect(simulated.min_players_to_ready).toBe(real.min_players_to_ready)
  })

  it('never says simulation to Get5, which has no such mode', () => {
    const file = buildGet5Config({
      ...csgoBo1(),
      request: request({ game: 'csgo', simulation: {} }),
    })
    expect(file).not.toHaveProperty('simulation')
    expect(file).not.toHaveProperty('simulation_timescale')
  })
})

describe('the platform ran the veto', () => {
  it('always skips the server-side veto and pins every side from the plan', () => {
    const config = buildMatchZyConfig(pugBo1())
    expect(config.skip_veto).toBe(true)
    expect(config.map_sides).toEqual(['team1_ct'])
    expect(
      buildMatchZyConfig({
        ...pugBo1(),
        request: request({ maps: [{ map: 'de_nuke', sides: 't' }] }),
      }).map_sides,
    ).toEqual(['team1_t'])
    expect(buildMatchZyConfig(knifeBo3()).map_sides).toEqual(['knife', 'knife', 'knife'])
  })

  it('tells Get5 whether to knife at all — map_sides alone is not enough there', () => {
    expect(buildGet5Config(csgoBo1()).side_type).toBe('never_knife')
    expect(
      buildGet5Config({
        ...csgoBo1(),
        request: request({ game: 'csgo', maps: [{ map: 'de_train', sides: 'knife' }] }),
      }).side_type,
    ).toBe('always_knife')
    expect(
      buildGet5Config({
        ...csgoBo1(),
        request: request({
          game: 'csgo',
          maps: [
            { map: 'de_train', sides: 'ct' },
            { map: 'de_cbble', sides: 'knife' },
          ],
        }),
      }).side_type,
    ).toBe('standard')
  })
})

describe('the round format rides in the config', () => {
  it('carries the same flat cvars the assignment does: request under mode under rules', () => {
    const { cvars } = buildMatchZyConfig(knifeBo3())
    expect(cvars.mp_maxrounds).toBe('24')
    expect(cvars.mp_overtime_enable).toBe('0')
    expect(cvars.matchzy_demo_recording_enabled).toBe('true')
    // The preset's own cvars come through where nothing above claims them.
    expect(cvars.mp_friendlyfire).toBe('0')
  })

  it('cannot be redirected by a preset — the rules win', () => {
    const { cvars } = buildMatchZyConfig({
      ...pugBo1(),
      request: request({
        rules: {
          regulationRounds: 24,
          overtime: { enabled: true, maxRounds: 6, startMoney: 10_000 },
          warmup: { minPlayersToReady: 10, minSpectatorsToReady: 0 },
          cvars: { mp_maxrounds: '4', matchzy_demo_recording_enabled: 'false' },
        },
      }),
    })
    expect(cvars.mp_maxrounds).toBe('24')
    expect(cvars.matchzy_demo_recording_enabled).toBe('true')
  })

  it('leaves the round format to the mode when the request has no rules', () => {
    const config = buildMatchZyConfig({
      ...pugBo1(),
      request: request({ rules: undefined }),
    })
    expect(config.cvars.mp_maxrounds).toBeUndefined()
    // No rules: the manifest's full house must ready up — ten across the
    // match, which is MatchZy's five a side. Casters never gate.
    expect(config.min_players_to_ready).toBe(5)
    expect(config.min_spectators_to_ready).toBe(0)
  })

  it('never carries the event sink or a hostname — those are the server plugin’s, from its sidecar', () => {
    for (const config of [buildMatchZyConfig(pugBo1()), buildMatchZyConfig(knifeBo3())]) {
      for (const name of Object.keys(config.cvars)) {
        expect(name).not.toMatch(/remote_log|hostname|password|token/)
      }
    }
  })
})

describe('rosters', () => {
  it('renders players as steamid → name, sizes teams from the roster, spectates nobody', () => {
    const config = buildMatchZyConfig(pugBo1())
    expect(config.players_per_team).toBe(5)
    expect(config.team1.name).toBe('Team hunzR')
    expect(config.team1.players['76561198070000101']).toBe('hunzR')
    expect(config.team2.players['76561198070000113']).toBe('zwiebel')
    expect(config.spectators).toEqual({ players: {} })
  })

  it('still plays five a side for an unrostered match (bots, PRD-02 T13)', () => {
    const config = buildMatchZyConfig({
      ...pugBo1(),
      request: request({
        teams: { teamA: { name: 'CT', players: [] }, teamB: { name: 'T', players: [] } },
        rules: {
          regulationRounds: 4,
          overtime: { enabled: false, maxRounds: 2, startMoney: 10_000 },
          warmup: { minPlayersToReady: 0, minSpectatorsToReady: 0 },
          cvars: { bot_quota: '10' },
        },
      }),
    })
    expect(config.players_per_team).toBe(5)
    expect(config.min_players_to_ready).toBe(0)
    expect(config.team1.players).toEqual({})
    expect(config.cvars.bot_quota).toBe('10')
    expect(config.cvars.mp_maxrounds).toBe('4')
    expect(matchZyValidationError(config)).toBe('')
  })
})

/**
 * **What a real match turns on** (PRD-03 T3a, owner decision 2026-09-19).
 * Auto-ready is the request's, because a LAN admin may well want the room to
 * type `.ready`; the side-pick timer and the two early-end commands are the
 * server's, because no request may build a match that can hold a box for ever
 * or end in a way the platform has no result for. So exactly one of the four
 * is in a config, and the other three are read off the image's cfg here.
 */
describe('what a real match turns on', () => {
  const cfg = readFileSync(
    fileURLToPath(new URL('../../../../docker/cs2/cfg/MatchZy/ezpug.cfg', import.meta.url)),
    'utf8',
  )

  it('writes the request’s auto-ready into every MatchZy config', () => {
    expect(buildMatchZyConfig(pugBo1()).cvars.matchzy_autoready_enabled).toBe('true')
    expect(
      buildMatchZyConfig({
        ...pugBo1(),
        request: request({
          rules: {
            regulationRounds: 24,
            overtime: { enabled: true, maxRounds: 6, startMoney: 10_000 },
            warmup: { minPlayersToReady: 10, minSpectatorsToReady: 0, autoReady: false },
          },
        }),
      }).cvars.matchzy_autoready_enabled,
    ).toBe('false')
  })

  it('readies automatically when the request says nothing at all', () => {
    // Additive means a request written before this field existed still parses,
    // and the owner decision is that such a match auto-readies.
    expect(
      buildMatchZyConfig({ ...pugBo1(), request: request({ rules: undefined }) }).cvars
        .matchzy_autoready_enabled,
    ).toBe('true')
    const noField = request({
      rules: {
        regulationRounds: 24,
        overtime: { enabled: true, maxRounds: 6, startMoney: 10_000 },
        warmup: { minPlayersToReady: 10, minSpectatorsToReady: 0 },
      },
    })
    expect(noField.rules?.warmup.autoReady).toBe(true)
  })

  it('cannot be turned off by a preset’s cvars — the switch sits above them', () => {
    const { cvars } = buildMatchZyConfig({
      ...pugBo1(),
      request: request({
        rules: {
          regulationRounds: 24,
          overtime: { enabled: true, maxRounds: 6, startMoney: 10_000 },
          warmup: { minPlayersToReady: 10, minSpectatorsToReady: 0 },
          cvars: { matchzy_autoready_enabled: 'false' },
        },
      }),
    })
    expect(cvars.matchzy_autoready_enabled).toBe('true')
  })

  it('never puts the side-pick timer or an early end in a config — those are the server’s', () => {
    for (const config of [buildMatchZyConfig(pugBo1()), buildMatchZyConfig(knifeBo3())])
      for (const name of Object.keys(config.cvars))
        expect(name).not.toMatch(/side_selection|_gg_|_ffw_/)
    // And the image's cfg is where they are decided, once, for every match.
    expect(cfg).toMatch(/^matchzy_side_selection_enabled true$/m)
    expect(cfg).toMatch(/^matchzy_side_selection_time 60$/m)
    expect(cfg).toMatch(/^matchzy_gg_enabled false$/m)
    expect(cfg).toMatch(/^matchzy_ffw_enabled false$/m)
    // Auto-ready's baseline there is off: a server between matches readies nobody.
    expect(cfg).toMatch(/^matchzy_autoready_enabled false$/m)
  })

  it('leaves auto-ready nothing to say to Get5, which has never had one', () => {
    for (const name of Object.keys(buildGet5Config(csgoBo1()).cvars))
      expect(name).not.toMatch(/autoready/)
  })
})
