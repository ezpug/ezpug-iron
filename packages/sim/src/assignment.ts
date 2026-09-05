/**
 * **What a simulated server is told to play.** Two doors, one shape:
 *
 * - {@link readMatchAssignment} reads the *real* match config — the same JSON a
 *   MatchZy or Get5 server loads, the one the orchestrator writes for a plugin
 *   -tier gamemode. That is the honesty rule the platform's simulator lived
 *   by: rosters come from `team1`/`team2`, the round format from
 *   `mp_maxrounds`/`mp_overtime_*`, exactly the fields a real plugin parses.
 *   If the orchestrator stopped wiring them, the simulator would break the
 *   same way a real server would.
 * - {@link assignmentFromMatchRequest} derives the same shape straight from the
 *   Match API's request (teams, maps, rules) — for a gamemode that has no
 *   MatchZy config to read (a config-only mode, an open-join mode whose roster
 *   the fake invents) and for the published fake, which never writes one.
 *
 * What the platform's version also carried, and this one does not: the event
 * sink. A simulated server here does not POST to a URL — it *is* the server
 * side of the plugin↔orchestrator link, and its events reach whoever
 * subscribed (`SimulatedServer.events`). Delivery is the orchestrator's.
 */
import type { Game, MapPlan, MatchRules, MatchTeams, TeamSide } from '@ezpug/match-api'

/** `mp_maxrounds` per game when nothing says otherwise — the platform's `REGULATION_ROUNDS`. */
export const REGULATION_ROUNDS: Readonly<Record<Game, number>> = Object.freeze({
  cs2: 24,
  csgo: 30,
})

/** MR3: the full pair count one overtime adds — the platform's `RANKED_OVERTIME_ROUNDS`. */
export const DEFAULT_OVERTIME_ROUNDS = 6

export class SimulatorConfigError extends Error {
  constructor(detail: string) {
    super(`simulator: ${detail}`)
    this.name = 'SimulatorConfigError'
  }
}

export interface SimulatedPlayer {
  steamId64: string
  name: string
}

export interface SimulatedTeam {
  name: string
  players: SimulatedPlayer[]
}

/** One decided map as the config states it — the side is **team A's**. */
export interface AssignedMap {
  map: string
  teamASide: TeamSide | 'knife'
}

/** Everything the story builder needs, normalized from either door. */
export interface MatchAssignment {
  matchId: string
  game: Game
  teamA: SimulatedTeam
  teamB: SimulatedTeam
  maps: AssignedMap[]
  regulationRounds: number
  overtime: { enabled: boolean; maxRounds: number }
}

/**
 * The provider-layer handoff a plugin-tier server gets: which match, which
 * game (decides the dialect — MatchZy for cs2, Get5 for csgo, the same
 * dispatch a server image performs by having one plugin installed) and the
 * match config JSON itself.
 */
export interface MatchConfigHandoff {
  matchId: string
  game: Game
  matchConfig: unknown
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SimulatorConfigError(`${what} is not an object`)
  }
  return value as Record<string, unknown>
}

function readTeam(config: Record<string, unknown>, key: 'team1' | 'team2'): SimulatedTeam {
  const team = asRecord(config[key], key)
  const name = typeof team.name === 'string' && team.name !== '' ? team.name : key
  const players = Object.entries(asRecord(team.players, `${key}.players`)).map(
    ([steamId64, playerName]) => ({
      steamId64,
      name: typeof playerName === 'string' && playerName !== '' ? playerName : steamId64,
    }),
  )
  if (players.length === 0) throw new SimulatorConfigError(`${key} has no players`)
  return { name, players }
}

/** `team1_ct` → team A starts CT; `team2_ct` → team A starts T (team A is team1). */
function readSide(entry: unknown): TeamSide | 'knife' {
  // A missing entry knifes, which is what Get5 does with a short map_sides.
  if (entry === undefined || entry === 'knife') return 'knife'
  if (entry === 'team1_ct' || entry === 'team2_t') return 'ct'
  if (entry === 'team1_t' || entry === 'team2_ct') return 't'
  throw new SimulatorConfigError(`unknown map_sides entry "${String(entry)}"`)
}

function readInt(cvars: Record<string, unknown>, key: string, fallback: number): number {
  const raw = cvars[key]
  if (raw === undefined) return fallback
  const value = Number.parseInt(String(raw), 10)
  if (!Number.isFinite(value)) throw new SimulatorConfigError(`cvar ${key} is not a number`)
  return value
}

function checkFormat(assignment: MatchAssignment): MatchAssignment {
  const { regulationRounds, overtime } = assignment
  if (regulationRounds <= 0 || regulationRounds % 2 !== 0) {
    throw new SimulatorConfigError(`mp_maxrounds ${regulationRounds} is not even and positive`)
  }
  if (overtime.enabled && (overtime.maxRounds <= 0 || overtime.maxRounds % 2 !== 0)) {
    throw new SimulatorConfigError(
      `mp_overtime_maxrounds ${overtime.maxRounds} is not even and positive`,
    )
  }
  if (assignment.maps.length === 0) throw new SimulatorConfigError('maplist is empty')
  if (assignment.teamA.players.length === 0) throw new SimulatorConfigError('team1 has no players')
  if (assignment.teamB.players.length === 0) throw new SimulatorConfigError('team2 has no players')
  return assignment
}

/**
 * Parse the plugin config the orchestrator wrote, as the plugin itself would.
 * `handoff.game` decides the dialect (MatchZy for cs2, Get5 for csgo); both
 * share the fields this reads.
 */
export function readMatchAssignment(handoff: MatchConfigHandoff): MatchAssignment {
  const { game } = handoff
  const config = asRecord(handoff.matchConfig, 'match config')

  const maplist = config.maplist
  if (!Array.isArray(maplist) || maplist.length === 0) {
    throw new SimulatorConfigError('maplist is empty')
  }
  const sides = Array.isArray(config.map_sides) ? config.map_sides : []
  const maps: AssignedMap[] = maplist.map((map, index) => {
    if (typeof map !== 'string' || map === '') {
      throw new SimulatorConfigError(`maplist[${index}] is not a map name`)
    }
    return { map, teamASide: readSide(sides[index]) }
  })

  const cvars = asRecord(config.cvars ?? {}, 'cvars')
  const regulationRounds = readInt(cvars, 'mp_maxrounds', REGULATION_ROUNDS[game])
  const overtime = {
    enabled: readInt(cvars, 'mp_overtime_enable', 0) === 1,
    maxRounds: readInt(cvars, 'mp_overtime_maxrounds', DEFAULT_OVERTIME_ROUNDS),
  }

  return checkFormat({
    matchId: handoff.matchId,
    game,
    teamA: readTeam(config, 'team1'),
    teamB: readTeam(config, 'team2'),
    maps,
    regulationRounds,
    overtime,
  })
}

/** The Match API's request, already parsed, plus the match id the orchestrator minted. */
export interface MatchRequestHandoff {
  matchId: string
  game: Game
  teams: MatchTeams
  maps: readonly MapPlan[]
  /** Absent = the platform's ranked defaults: MR12 (MR15 on csgo), MR3 overtime. */
  rules?: Pick<MatchRules, 'regulationRounds' | 'overtime'>
}

/**
 * The same assignment straight from a match request. Rosters are the request's
 * (names as the platform shows them, never Steam's persona); `sides` is team
 * A's, as the platform's map plan states it.
 */
export function assignmentFromMatchRequest(handoff: MatchRequestHandoff): MatchAssignment {
  const toTeam = (team: MatchTeams['teamA']): SimulatedTeam => ({
    name: team.name,
    players: team.players.map(({ steamId64, name }) => ({ steamId64, name })),
  })
  return checkFormat({
    matchId: handoff.matchId,
    game: handoff.game,
    teamA: toTeam(handoff.teams.teamA),
    teamB: toTeam(handoff.teams.teamB),
    maps: handoff.maps.map(plan => ({ map: plan.map, teamASide: plan.sides })),
    regulationRounds: handoff.rules?.regulationRounds ?? REGULATION_ROUNDS[handoff.game],
    overtime: handoff.rules
      ? { enabled: handoff.rules.overtime.enabled, maxRounds: handoff.rules.overtime.maxRounds }
      : { enabled: true, maxRounds: DEFAULT_OVERTIME_ROUNDS },
  })
}
