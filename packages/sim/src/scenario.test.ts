import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SCENARIO,
  findScenario,
  listScenarios,
  resolveScenario,
  SIMULATOR_SCENARIOS,
  type SimulatorScenarioName,
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
      neverReady: false,
      absentPlayers: 2,
      crashAfterRound: null,
      pauses: 0,
      overtimes: 0,
      comeback: false,
    })
  })
})
