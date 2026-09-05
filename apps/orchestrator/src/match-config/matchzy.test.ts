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

  it('builds the CS:GO Bo1 Get5 file byte for byte', () => {
    expect(buildGet5Config(csgoBo1())).toEqual(golden('get5-bo1'))
  })

  it('emits configs MatchZy own validator accepts', () => {
    expect(matchZyValidationError(buildMatchZyConfig(pugBo1()))).toBe('')
    expect(matchZyValidationError(buildMatchZyConfig(knifeBo3()))).toBe('')
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
    // No rules: the manifest's full house must ready up, casters never gate.
    expect(config.min_players_to_ready).toBe(10)
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
  it('renders players as steamid → name, sizes teams from the manifest, spectates nobody', () => {
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
