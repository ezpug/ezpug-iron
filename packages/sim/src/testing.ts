/**
 * The shared simulator test fixture: one decided Bo1 with ten rostered
 * players on Mirage, team A starting CT, the platform's ranked format (MR12,
 * MR3 overtime). Exported under `@ezpug/sim/testing` for the suites beside
 * the engine, the published fake's tests and the orchestrator's.
 */
import type { MatchAssignment } from './assignment'

export const FIXTURE_MATCH_ID = '7f3a1c22-2b64-4a5f-9c31-0d5e6f8a1b20'

const TEAM_A = ['hunzR', 'maex', 'Zerberus', 'flippo', 'Kessi'] as const
const TEAM_B = ['wickeD', 'Jörg', 'schnitzL', 'BastiGHG', 'moepL'] as const

function rosterOf(names: readonly string[], offset: number) {
  return names.map((name, index) => ({
    steamId64: `7656119800000${String(offset + index).padStart(4, '0')}`,
    name,
  }))
}

export function fixtureAssignment(overrides: Partial<MatchAssignment> = {}): MatchAssignment {
  return {
    matchId: FIXTURE_MATCH_ID,
    game: 'cs2',
    teamA: { name: 'Team hunzR', players: rosterOf(TEAM_A, 0) },
    teamB: { name: 'Team wickeD', players: rosterOf(TEAM_B, 100) },
    maps: [{ map: 'de_mirage', teamASide: 'ct' }],
    regulationRounds: 24,
    overtime: { enabled: true, maxRounds: 6 },
    ...overrides,
  }
}
