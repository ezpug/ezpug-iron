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
   * **Nobody ever comes** (PRD-03 T9a). The server boots, says `server_ready`
   * and then waits on an empty map. What happens next is the *mode's* to
   * decide, exactly as it is on a real server: a mode whose manifest names an
   * `idleTimeoutSeconds` ends itself on it — a `series_end` with
   * `reason: "idle"` and no `going_live` before it — and a mode that names
   * none simply never ends, and the orchestrator's join deadline decides.
   *
   * Not the same as {@link absentPlayers}, which is a *partial* roster and
   * ends as `no_show`, nor {@link neverReady}, where the server never boots
   * at all.
   */
  idle?: boolean
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
  idle: { name: 'idle', idle: true },
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
  idle: boolean
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
    idle: scenario.idle ?? false,
    overtimes: scenario.overtimes ?? 0,
    comeback: scenario.comeback ?? false,
  }))
}

// --- what a real server's puppets can execute (PRD-03 T11) -----------------------------

/**
 * **One scenario language** (PRD-03, Attitude 3): the name a request sends is
 * the same whether the match lands on the simulator or on a real server with
 * puppets in every seat. What differs is who can *execute* each knob — a
 * story engine can decide a winner and a box full of bots cannot — and the
 * one thing this round forbids is a knob quietly doing nothing. So every knob
 * is classified here, once, beside the table it steers: the orchestrator's
 * door refuses a puppets request whose scenario a real server cannot play,
 * `docs/sdk.md` prints this table, and a test holds the doc to it.
 */
export type ScenarioKnob = keyof Omit<SimulatorScenarioInfo, 'name'>

/** Who executes one knob on a real server, and what the docs say about it. */
export interface ScenarioKnobReach {
  knob: ScenarioKnob
  /**
   * `sdk` — the SDK's puppeteer does it, for the flows it seats
   * ({@link SDK_SEATED_FLOWS}); `null` — nobody can, and {@link reason} is why.
   */
  puppets: 'sdk' | null
  /** One sentence: how a real server does it, or why it cannot. */
  reason: string
}

/**
 * The flows whose puppets are the SDK's. Under `matchzy` the bodies are
 * MatchZy-Enhanced's: its simulation mode spawns one bot per *configured*
 * player, re-readies whatever its reconcile pass finds and force-readies both
 * teams from its warmup watchdog (`src/SimulationMode.cs`), so neither an
 * absent puppet nor a silent one can be expressed without patching the fork.
 */
export const SDK_SEATED_FLOWS = ['plugin', 'none'] as const

export const SCENARIO_KNOB_REACH: readonly ScenarioKnobReach[] = [
  {
    knob: 'absentPlayers',
    puppets: 'sdk',
    reason:
      'a roster entry with no puppet: the puppeteer seats every entry but the last few, and the orchestrator’s join deadline is what gives up on them',
  },
  {
    knob: 'idle',
    puppets: 'sdk',
    reason:
      'nobody is seated at all, on a server that is otherwise a normal one: the mode’s `length.idleTimeoutSeconds` ends the match, or the join deadline does',
  },
  {
    knob: 'neverReady',
    puppets: null,
    reason:
      'it is the *server* that never boots, not a player who never readies — a provider failure, armed on the provider by the fault-injection suite rather than asked for by a match',
  },
  {
    knob: 'crashAfterRound',
    puppets: null,
    reason:
      'a request cannot ask a box to die: the recovery window it opens is driven from outside the match, by the fault suite on the simulator or by a hand on the container',
  },
  {
    knob: 'pauses',
    puppets: null,
    reason:
      'nothing pauses a stock server but an admin, and that admin is the Match API’s own `pause` command — the lane pauses a live match through the front door instead (PRD-03 T6)',
  },
  {
    knob: 'overtimes',
    puppets: null,
    reason:
      'two even sides of bots cannot be made to draw on demand — PRD-03 T6 counted an overtime in five of the matrix’s ten maps and could force none of them',
  },
  {
    knob: 'comeback',
    puppets: null,
    reason: 'nothing scripts a bot’s aim, so no real server can be told who trails at the half',
  },
]

/**
 * **What the puppets do beyond playing the match out** — the resolved script
 * an assignment carries to the server (`assign.puppets`), or `null` for a
 * scenario that asks for nothing a puppet must do differently. The plugin
 * never holds a second copy of this catalog: it is handed the knobs, not the
 * name.
 */
export interface PuppetScript {
  /** The scenario this came from, for the server's log line. */
  scenario: string
  /** How many roster entries get no puppet — the last ones, so a team keeps its shape. */
  absentPlayers: number
  /** Nobody is seated at all. */
  idle: boolean
}

export function puppetScriptFor(scenario: SimulatorScenario): PuppetScript | null {
  const absentPlayers = scenario.absentPlayers ?? 0
  const idle = scenario.idle ?? false
  if (absentPlayers === 0 && !idle) return null
  return { scenario: scenario.name, absentPlayers, idle }
}

/**
 * **Why a real server cannot play this scenario**, or `null` when it can
 * (PRD-03 T11). `flow` is the gamemode manifest's: under `matchzy` even the
 * knobs the SDK could execute are refused, because the bodies are the fork's.
 * The message is the door's — `validation_failed` on `simulation.scenario`,
 * so a knob that does nothing is a refusal a client reads rather than a
 * silence it has to notice.
 */
export function scenarioPuppetProblem(scenario: SimulatorScenario, flow: string): string | null {
  const asked = SCENARIO_KNOB_REACH.filter(reach => {
    const value = scenario[reach.knob]
    return typeof value === 'number' ? value > 0 : value === true
  })
  const impossible = asked.find(reach => reach.puppets === null)
  if (impossible) return `${scenario.name} asks for ${impossible.knob}, and ${impossible.reason}`
  const seated = (SDK_SEATED_FLOWS as readonly string[]).includes(flow)
  const sdkOnly = asked.find(reach => reach.puppets === 'sdk')
  if (sdkOnly && !seated)
    return (
      `${scenario.name} asks for ${sdkOnly.knob}, which a ${flow} match cannot do: ` +
      'MatchZy-Enhanced’s simulation mode seats one bot per configured player and force-readies them'
    )
  return null
}
