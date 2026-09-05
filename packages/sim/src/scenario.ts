/**
 * Scripted scenarios: the shapes a simulated match can take, as data. A
 * scenario never invents events — it only steers the story builder
 * (`story.ts`): which team wins, whether regulation ties into overtime,
 * whether the server dies mid-match or never comes up at all. The ugly paths
 * are exactly what loops must be able to reproduce, so every failure branch
 * the orchestrator's match machine has (PRD-02) has a named scenario here.
 *
 * The platform's `scenario.ts` on 2026-09-05, verbatim: the names are what
 * the platform's console dropdown sends as `MatchRequest.sim.scenario`.
 */
import type { MatchTeam } from '@ezpug/match-api'

export interface SimulatorScenario {
  /** kebab-case, so a console dropdown and a test name read the same. */
  name: string
  /**
   * The server never finishes booting: no `server_ready`, no heartbeats,
   * nothing. The orchestrator's provisioning timeout is what ends this.
   */
  neverReady?: boolean
  /**
   * This many rostered players never connect. The match never goes live; the
   * orchestrator's join deadline computes `no_show` from the connected set.
   */
  absentPlayers?: number
  /**
   * The server goes silent right after this round's `round_end` on map 1 —
   * heartbeats stop, status answers `gone`, the recovery window opens. The
   * backups written up to that round are what a `restore` resumes from.
   */
  crashAfterRound?: number
  /** Tactical pauses sprinkled into map 1. */
  pauses?: number
  /**
   * Force this many overtimes on map 1 (regulation ends tied). Ignored when
   * the assignment has overtime disabled — the simulator plays the config
   * it was handed, like a real server would.
   */
  overtimes?: number
  /** The winner trails badly at the half, then runs the table. */
  comeback?: boolean
  /** Fix the match winner; omitted, the seeded PRNG decides. */
  winner?: MatchTeam
}

/** The named scenarios, one per failure branch worth reproducing. */
export const SIMULATOR_SCENARIOS = {
  'happy-path': { name: 'happy-path' },
  overtime: { name: 'overtime', overtimes: 1 },
  pauses: { name: 'pauses', pauses: 2 },
  comeback: { name: 'comeback', comeback: true },
  'no-show': { name: 'no-show', absentPlayers: 2 },
  'server-crash': { name: 'server-crash', crashAfterRound: 9 },
  'never-ready': { name: 'never-ready', neverReady: true },
} as const satisfies Record<string, SimulatorScenario>

export type SimulatorScenarioName = keyof typeof SIMULATOR_SCENARIOS

/** The default when a request says nothing. */
export const DEFAULT_SCENARIO: SimulatorScenarioName = 'happy-path'

/**
 * A scenario by name off a wire, or `null`. This is the request's door: a
 * dropdown sends a string, and an unknown one is the caller's mistake — a
 * refusal to render, not an exception to throw.
 */
export function findScenario(name: string): SimulatorScenario | null {
  // `Object.hasOwn`, not a bare index: `toString` off a wire is not a scenario.
  if (!Object.hasOwn(SIMULATOR_SCENARIOS, name)) return null
  return (SIMULATOR_SCENARIOS as Record<string, SimulatorScenario>)[name] ?? null
}

/** Accepts a name or a hand-built scenario; throws on a name nobody defined. */
export function resolveScenario(
  scenario: SimulatorScenarioName | SimulatorScenario | undefined,
): SimulatorScenario {
  if (scenario === undefined) return SIMULATOR_SCENARIOS[DEFAULT_SCENARIO]
  if (typeof scenario === 'string') {
    const named = findScenario(scenario)
    if (!named) throw new Error(`simulator: unknown scenario "${scenario}"`)
    return named
  }
  return scenario
}

/** A scenario as data, every knob spelled out — what a console renders as facts. */
export interface SimulatorScenarioInfo {
  name: string
  neverReady: boolean
  absentPlayers: number
  crashAfterRound: number | null
  pauses: number
  overtimes: number
  comeback: boolean
}

/**
 * The table as data, for a console's dropdown. It reads the same object the
 * story builder does, so a scenario added here shows up with its knobs
 * spelled out and nobody maintains a second list.
 */
export function listScenarios(): SimulatorScenarioInfo[] {
  const table: readonly SimulatorScenario[] = Object.values(SIMULATOR_SCENARIOS)
  return table.map(scenario => ({
    name: scenario.name,
    neverReady: scenario.neverReady ?? false,
    absentPlayers: scenario.absentPlayers ?? 0,
    crashAfterRound: scenario.crashAfterRound ?? null,
    pauses: scenario.pauses ?? 0,
    overtimes: scenario.overtimes ?? 0,
    comeback: scenario.comeback ?? false,
  }))
}
