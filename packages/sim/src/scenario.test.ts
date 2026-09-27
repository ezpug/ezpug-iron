import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SCENARIO,
  findScenario,
  listScenarios,
  puppetScriptFor,
  resolveScenario,
  SCENARIO_KNOB_REACH,
  SIMULATOR_SCENARIOS,
  type SimulatorScenarioName,
  scenarioPuppetProblem,
} from './scenario'

describe('the scenario table', () => {
  it('answers a name off a wire with the scenario or null', () => {
    expect(findScenario('server-crash')).toEqual({ name: 'server-crash', crashAfterRound: 9 })
    expect(findScenario('nope')).toBeNull()
    expect(findScenario('toString')).toBeNull()
  })

  it('resolves a name, a hand-built scenario, or the default', () => {
    expect(resolveScenario(undefined)).toBe(SIMULATOR_SCENARIOS[DEFAULT_SCENARIO])
    expect(resolveScenario('overtime').overtimes).toBe(1)
    expect(resolveScenario({ name: 'custom', winner: 'team_b' }).winner).toBe('team_b')
    expect(() => resolveScenario('nope' as SimulatorScenarioName)).toThrow(/unknown scenario/)
  })

  it('lists every scenario with its knobs spelled out, from the one table', () => {
    const listed = listScenarios()
    expect(listed.map(entry => entry.name)).toEqual(Object.keys(SIMULATOR_SCENARIOS))
    expect(listed.find(entry => entry.name === 'no-show')).toEqual({
      name: 'no-show',
      idle: false,
      neverReady: false,
      absentPlayers: 2,
      crashAfterRound: null,
      pauses: 0,
      overtimes: 0,
      comeback: false,
      towerEnding: null,
    })
    expect(listed.find(entry => entry.name === 'rush-convoy')?.towerEnding).toBe('convoy')
  })
})

describe('what a real server’s puppets can execute (T11)', () => {
  it('classifies every knob the catalog spells out, and no other', () => {
    const knobs = Object.keys(listScenarios()[0] ?? {}).filter(key => key !== 'name')
    expect(SCENARIO_KNOB_REACH.map(reach => reach.knob).sort()).toEqual(knobs.sort())
    for (const reach of SCENARIO_KNOB_REACH)
      expect(reach.reason.length, `${reach.knob} has no sentence`).toBeGreaterThan(20)
  })

  it('resolves the two knobs a puppet does into the script an assignment carries', () => {
    expect(puppetScriptFor(SIMULATOR_SCENARIOS['happy-path'])).toBeNull()
    expect(puppetScriptFor(SIMULATOR_SCENARIOS['no-show'])).toEqual({
      scenario: 'no-show',
      absentPlayers: 2,
      idle: false,
    })
    expect(puppetScriptFor(SIMULATOR_SCENARIOS.idle)).toEqual({
      scenario: 'idle',
      absentPlayers: 0,
      idle: true,
    })
  })

  it('refuses a scenario a real server cannot play, and names the knob', () => {
    expect(scenarioPuppetProblem(SIMULATOR_SCENARIOS['happy-path'], 'plugin')).toBeNull()
    expect(scenarioPuppetProblem(SIMULATOR_SCENARIOS['happy-path'], 'matchzy')).toBeNull()
    expect(scenarioPuppetProblem(SIMULATOR_SCENARIOS.idle, 'plugin')).toBeNull()
    expect(scenarioPuppetProblem(SIMULATOR_SCENARIOS['no-show'], 'none')).toBeNull()
    // The knobs the SDK seats for, asked of a match whose bodies are the fork's.
    expect(scenarioPuppetProblem(SIMULATOR_SCENARIOS['no-show'], 'matchzy')).toMatch(
      /no-show asks for absentPlayers, which a matchzy match cannot do/,
    )
    expect(scenarioPuppetProblem(SIMULATOR_SCENARIOS.idle, 'matchzy')).toMatch(/idle asks for idle/)
    // And the ones nobody can execute, whatever the flow.
    for (const flow of ['plugin', 'matchzy']) {
      expect(scenarioPuppetProblem(SIMULATOR_SCENARIOS.overtime, flow)).toMatch(
        /overtime asks for overtimes/,
      )
      expect(scenarioPuppetProblem(SIMULATOR_SCENARIOS.pauses, flow)).toMatch(/asks for pauses/)
      expect(scenarioPuppetProblem(SIMULATOR_SCENARIOS['server-crash'], flow)).toMatch(
        /asks for crashAfterRound/,
      )
      expect(scenarioPuppetProblem(SIMULATOR_SCENARIOS['never-ready'], flow)).toMatch(
        /asks for neverReady/,
      )
      expect(scenarioPuppetProblem(SIMULATOR_SCENARIOS.comeback, flow)).toMatch(/asks for comeback/)
      expect(scenarioPuppetProblem(SIMULATOR_SCENARIOS['rush-castle'], flow)).toMatch(
        /rush-castle asks for towerEnding/,
      )
    }
  })
})
