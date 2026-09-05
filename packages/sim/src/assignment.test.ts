import { describe, expect, it } from 'vitest'
import get5Bo1 from '../fixtures/configs/get5-ranked-bo1.json'
import matchzyKnifeBo3 from '../fixtures/configs/matchzy-knife-bo3.json'
import matchzyBo1 from '../fixtures/configs/matchzy-ranked-bo1.json'
import { assignmentFromMatchRequest, readMatchAssignment, SimulatorConfigError } from './assignment'
import { FIXTURE_MATCH_ID, fixtureAssignment } from './testing'

const handoff = (matchConfig: unknown, game: 'cs2' | 'csgo' = 'cs2') => ({
  matchId: FIXTURE_MATCH_ID,
  game,
  matchConfig,
})

describe('readMatchAssignment', () => {
  it('reads a MatchZy config the way the plugin would: rosters, sides, format', () => {
    const assignment = readMatchAssignment(handoff(matchzyBo1))
    expect(assignment.matchId).toBe(FIXTURE_MATCH_ID)
    expect(assignment.game).toBe('cs2')
    expect(assignment.teamA.name).toBe('Team hunzR')
    expect(assignment.teamA.players).toHaveLength(5)
    expect(assignment.teamA.players[0]).toEqual({ steamId64: '76561198070000101', name: 'hunzR' })
    expect(assignment.teamB.players.map(player => player.name)).toContain('Bommelmann')
    expect(assignment.maps).toEqual([{ map: 'de_mirage', teamASide: 'ct' }])
    expect(assignment.regulationRounds).toBe(24)
    expect(assignment.overtime).toEqual({ enabled: true, maxRounds: 6 })
  })

  it('reads a Get5 config the same way (the csgo dialect)', () => {
    const assignment = readMatchAssignment(handoff(get5Bo1, 'csgo'))
    expect(assignment.game).toBe('csgo')
    expect(assignment.maps).toEqual([{ map: 'de_train', teamASide: 't' }])
    expect(assignment.regulationRounds).toBe(30)
  })

  it('knifes for sides where the config says so, and plays a workshop map', () => {
    const assignment = readMatchAssignment(handoff(matchzyKnifeBo3))
    expect(assignment.maps.map(entry => entry.map)).toEqual([
      'de_ancient',
      'de_nuke',
      'workshop/3070288000/de_cache',
    ])
    expect(assignment.maps.every(entry => entry.teamASide === 'knife')).toBe(true)
    expect(assignment.overtime.enabled).toBe(false)
  })

  it('falls back to the game defaults when the cvars say nothing', () => {
    const { cvars: _cvars, ...noCvars } = matchzyBo1
    expect(readMatchAssignment(handoff(noCvars)).regulationRounds).toBe(24)
    expect(readMatchAssignment(handoff(noCvars, 'csgo')).regulationRounds).toBe(30)
    // A short map_sides knifes the rest, as Get5 does.
    const short = { ...matchzyKnifeBo3, map_sides: ['team1_ct'] }
    expect(readMatchAssignment(handoff(short)).maps.map(entry => entry.teamASide)).toEqual([
      'ct',
      'knife',
      'knife',
    ])
  })

  it('refuses what a plugin would refuse', () => {
    const attempt = (config: unknown) => () => readMatchAssignment(handoff(config))
    expect(attempt(null)).toThrow(SimulatorConfigError)
    expect(attempt({ ...matchzyBo1, maplist: [] })).toThrow(/maplist is empty/)
    expect(attempt({ ...matchzyBo1, map_sides: ['team3_ct'] })).toThrow(/map_sides/)
    expect(attempt({ ...matchzyBo1, team1: { name: 'x', players: {} } })).toThrow(/no players/)
    expect(attempt({ ...matchzyBo1, cvars: { mp_maxrounds: '25' } })).toThrow(/not even/)
    expect(attempt({ ...matchzyBo1, cvars: { mp_maxrounds: 'many' } })).toThrow(/not a number/)
    expect(
      attempt({
        ...matchzyBo1,
        cvars: { mp_overtime_enable: '1', mp_overtime_maxrounds: '5' },
      }),
    ).toThrow(/mp_overtime_maxrounds/)
  })
})

describe('assignmentFromMatchRequest', () => {
  const teams = {
    teamA: {
      name: 'Team hunzR',
      players: [
        { steamId64: '76561198070000101', name: 'hunzR', locale: 'de' as const, rating: 1500 },
      ],
    },
    teamB: {
      name: 'Team wickeD',
      players: [{ steamId64: '76561198070000102', name: 'wickeD', locale: 'en' as const }],
    },
  }

  it('derives the same shape from a request, keeping only what a server shows', () => {
    const assignment = assignmentFromMatchRequest({
      matchId: FIXTURE_MATCH_ID,
      game: 'cs2',
      teams,
      maps: [{ map: 'de_nuke', sides: 't' }],
      rules: {
        regulationRounds: 16,
        overtime: { enabled: false, maxRounds: 6, startMoney: 10_000 },
      },
    })
    expect(assignment.teamA.players).toEqual([{ steamId64: '76561198070000101', name: 'hunzR' }])
    expect(assignment.maps).toEqual([{ map: 'de_nuke', teamASide: 't' }])
    expect(assignment.regulationRounds).toBe(16)
    expect(assignment.overtime).toEqual({ enabled: false, maxRounds: 6 })
  })

  it('takes the ranked defaults when the request has no rules', () => {
    const assignment = assignmentFromMatchRequest({
      matchId: FIXTURE_MATCH_ID,
      game: 'csgo',
      teams,
      maps: [{ map: 'de_dust2', sides: 'knife' }],
    })
    expect(assignment.regulationRounds).toBe(30)
    expect(assignment.overtime).toEqual({ enabled: true, maxRounds: 6 })
    expect(assignment).toMatchObject(fixtureAssignment({ ...assignment }))
  })

  it('refuses an empty roster: an open-join mode must invent one first', () => {
    expect(() =>
      assignmentFromMatchRequest({
        matchId: FIXTURE_MATCH_ID,
        game: 'cs2',
        teams: { teamA: teams.teamA, teamB: { name: 'nobody', players: [] } },
        maps: [{ map: 'de_nuke', sides: 't' }],
      }),
    ).toThrow(/team2 has no players/)
  })
})
