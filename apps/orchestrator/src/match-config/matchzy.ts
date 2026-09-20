import { createHash } from 'node:crypto'
import {
  type GamemodeManifest,
  type MapPlan,
  type MatchRequest,
  type Roster,
  WINGMAN_TEAM_SIZE,
} from '@ezpug/match-api'
import { mergeCvars } from './cvars'

/**
 * **The match config builders** (PRD-02 T9): pure functions turning a Match
 * API request into the JSON a match plugin loads — MatchZy's for `cs2`, its
 * ancestor Get5's for `csgo`. Ported from the platform's `match-config.ts`
 * (the platform deletes its copy: the server side is this repo's now), with
 * the platform's own input replaced by the one thing the orchestrator has,
 * the request itself. No I/O, no clock, no randomness: the golden fixtures
 * beside this file are literally loadable match files.
 *
 * What the builders decide, and why:
 *
 * - **The platform ran the veto, so the server never does.** `skip_veto` is
 *   `true` and `map_sides` is fully specified from the request's map plan;
 *   `knife` hands the choice to a knife round, which is still MatchZy's, not
 *   a veto.
 * - **The round format travels in the config, not only in the flat cvars.**
 *   MatchZy execs its own `live.cfg` on going live (`mp_maxrounds 24`,
 *   overtime on) and then re-applies the config's `cvars` a second later
 *   (`Utility.cs` `SetupLiveFlagsAndCfg`); a cvar the loader set before the
 *   match loaded would be undone by that cfg. So the config carries the same
 *   flat map the assignment does — the request's under the mode's under what
 *   the rules derive (`mergeCvars`, one precedence rule, decided once) — and
 *   MatchZy is what keeps it in force.
 * - **No secret and no server-local fact in here.** The remote-log cvars
 *   (`matchzy_remote_log_url`, the header with the server token) and
 *   `matchzy_hostname_format` are the core plugin's to set on the server,
 *   from its own sidecar: the orchestrator holds only the token's hash, and a
 *   config that carried the token would land in every MatchZy round backup
 *   (`GetMatchConfig()` serialises the whole config into them). The platform's
 *   builder wrote them; this one deliberately does not.
 * - **`matchid` is a serial, derived.** MatchZy reads `matchid` with
 *   `int.TryParse` and stores a `long`; a uuid is neither. {@link matchzySerial}
 *   folds the match id into a positive signed-31-bit integer, the same number
 *   every time, and the door (`matchzy/door.ts`) checks the events MatchZy
 *   sends carry it — a stale plugin talking about an earlier match is dropped.
 *   Get5 takes a string and gets the uuid itself.
 * - **`players_per_team` is the roster's, not the manifest's** (PRD-03 T1).
 *   MatchZy passes a team when `playerCount == readyCount && playerCount >=
 *   players_per_team` (`references/MatchZy/ReadySystem.cs:48`), so a 1v1 sent
 *   with the pug manifest's five could never go live however often the two
 *   typed `!ready` — the 2026-09-18 stall. The number is the roster's now,
 *   and the manifest's stands only where there is no roster.
 * - **`min_players_to_ready` is per team on the plugin and per match on the
 *   wire**, so the builder converts. {@link warmup} says which way round and
 *   why the wire's is the total.
 * - **`wingman` is the request's `rules.format`** (PRD-03 T3b). MatchZy sets
 *   `game_mode 2` from it and execs `live_wingman.cfg` instead of `live.cfg`,
 *   reloading the map when the server is not already in that mode
 *   (`Utility.cs` `SetCorrectGameMode`, `IsMapReloadRequiredForGameMode`).
 *   Get5 has no such field, and a `csgo` wingman request is refused at the
 *   door rather than silently played straight (`match/machine.ts`).
 * - **The fork's own switches ride in `cvars`, above everything else**
 *   (PRD-03 T3a). {@link matchzyCvars} is the layer: what a *match* decides
 *   about MatchZy-Enhanced, as against what the image's cfg decides about the
 *   server. Only MatchZy reads them, so Get5 never sees them.
 */

/** A team as MatchZy and Get5 both read one: `{ "<steamid64>": "<name>" }`. */
export interface PluginTeamConfig {
  name: string
  players: Record<string, string>
}

/**
 * The MatchZy match file (`matchzy_loadmatch`). Field names and types are
 * MatchZy's — `references/MatchZy/MatchManagement.cs` (`ValidateMatchJsonStructure`,
 * `GetOptionalMatchValues`) is the parser this shape is written against.
 */
export interface MatchZyMatchConfig {
  /** Positive signed-31-bit; MatchZy reads it with `int.TryParse`. */
  matchid: number
  num_maps: number
  maplist: string[]
  /** `team1_ct` | `team1_t` | `knife`, one per map. */
  map_sides: string[]
  skip_veto: boolean
  clinch_series: boolean
  wingman: boolean
  /**
   * **Puppets** (PRD-03 T4): MatchZy-Enhanced spawns one bot per roster
   * entry, maps it to that entry's SteamID, readies it through its own ready
   * system and rewrites every event's stats to the configured id
   * (`references/MatchZy-Enhanced/src/SimulationMode.cs`). Present only when
   * the request asked — absent reads as `false` in `MatchConfig.cs`, and a
   * real match's file is byte for byte what it was before the field existed.
   */
  simulation?: true
  /** The engine's `host_timescale` for a simulated match, clamped by the fork to 0.1–10. */
  simulation_timescale?: number
  players_per_team: number
  min_players_to_ready: number
  min_spectators_to_ready: number
  team1: PluginTeamConfig
  team2: PluginTeamConfig
  spectators: { players: Record<string, string> }
  cvars: Record<string, string>
}

/**
 * `never_knife` when every map's sides are decided, `always_knife` when none
 * are, `standard` for a mixed series (Get5 then knifes only the maps whose
 * `map_sides` entry says so).
 */
export type Get5SideType = 'standard' | 'never_knife' | 'always_knife'

/**
 * The Get5 match config (CS:GO). Get5 predates MatchZy and MatchZy aliases
 * its console variables, which is what keeps the two builders this close.
 * `matchid` is a string, and `side_type` — not `map_sides` alone — is what
 * tells Get5 whether to knife. Kept for the round that brings CS:GO back
 * (decision 18); nothing serves it yet.
 */
export interface Get5MatchConfig {
  matchid: string
  match_title: string
  num_maps: number
  maplist: string[]
  map_sides: string[]
  skip_veto: boolean
  side_type: Get5SideType
  players_per_team: number
  min_players_to_ready: number
  min_spectators_to_ready: number
  team1: PluginTeamConfig
  team2: PluginTeamConfig
  spectators: { players: Record<string, string> }
  cvars: Record<string, string>
}

export type PluginMatchConfig = MatchZyMatchConfig | Get5MatchConfig

export interface MatchConfigInput {
  /** The Match API match id (uuid). */
  matchId: string
  request: MatchRequest
  manifest: GamemodeManifest
}

/** The largest `matchid` MatchZy's `int.TryParse` accepts. */
const SERIAL_MAX = 0x7fff_ffff

/**
 * The integer MatchZy knows a match by: the first four bytes of the match
 * id's SHA-256, masked to 31 bits, never zero. Deterministic, so the door
 * can recompute it from the row and match it against what MatchZy sends;
 * a collision between two matches on one server is what the server token
 * already rules out.
 */
export function matchzySerial(matchId: string): number {
  const digest = createHash('sha256').update(matchId).digest()
  const serial = digest.readUInt32BE(0) & SERIAL_MAX
  return serial === 0 ? 1 : serial
}

/**
 * Whether this match is CS2's two-a-side game. The wire says it once, in
 * `rules.format`; a request with no rules at all plays the five-a-side game,
 * which is what every request before the field existed meant.
 */
function isWingman(request: MatchRequest): boolean {
  return request.rules?.format === 'wingman'
}

/** MatchZy / Get5 `map_sides` vocabulary. Team A is `team1`. */
function mapSide(plan: MapPlan): string {
  return plan.sides === 'knife' ? 'knife' : `team1_${plan.sides}`
}

function playerMap(roster: Roster): Record<string, string> {
  const map: Record<string, string> = {}
  for (const player of roster.players) map[player.steamId64] = player.name
  return map
}

function team(roster: Roster): PluginTeamConfig {
  return { name: roster.name, players: playerMap(roster) }
}

/**
 * **How many bodies a team must hold before it can be ready.** MatchZy reads
 * this one number for both teams (`ReadySystem.cs` `GetPlayersPerTeam`) and
 * refuses a team with fewer than it, so the only value every team on an
 * uneven roster can reach is the **smaller** roster's length: a 2v1 with two
 * would leave the single player refused for ever, which is the bug this
 * function exists to end. `playerCount == readyCount` is what still makes
 * everyone who *is* there say `!ready`.
 *
 * A match the request rosters nobody for (bots, an open room) keeps the
 * manifest's house: there is no roster to read, and five a side is what the
 * mode says it plays. The manifest is also the ceiling — a roster longer than
 * the mode's seats is the request's mistake, not a gate we widen.
 */
function playersPerTeam({ request, manifest }: MatchConfigInput): number {
  // Wingman is two a side whatever the mode's seats say, so an unrostered
  // wingman match waits for two rather than the pug manifest's five.
  const seats =
    request.rules?.format === 'wingman'
      ? Math.min(manifest.slots.teamSize, WINGMAN_TEAM_SIZE)
      : manifest.slots.teamSize
  const rostered = [request.teams.teamA.players.length, request.teams.teamB.players.length].filter(
    size => size > 0,
  )
  if (rostered.length === 0) return seats
  return Math.min(...rostered, seats)
}

/** MatchZy and Get5 both count one team's ready players; team1 and team2 are all they know. */
const PLUGIN_TEAMS = 2

/**
 * **The ready thresholds, converted.** `warmup.minPlayersToReady` on the wire
 * is the **whole match's** count — how many rostered people must say they are
 * ready before it goes live — because that is the number a client can compute
 * without knowing which plugin runs the match (the platform's
 * `gamemodeReadyGate` already computes exactly it: `min(players, seats,
 * preset)`). MatchZy's `min_players_to_ready` is **per team**
 * (`GetTeamMinReady`), so the builder halves the wire's, rounding up, and
 * never lets it exceed {@link playersPerTeam} — a force-ready floor above the
 * ordinary gate would refuse the very team it exists to let through.
 *
 * With no rules at all the manifest's full house is the total, as it always
 * was. `min_spectators_to_ready` needs no conversion: spectators are one team.
 */
function warmup(input: MatchConfigInput): { players: number; spectators: number } {
  const { request, manifest } = input
  const total = request.rules
    ? request.rules.warmup.minPlayersToReady
    : manifest.slots.teamSize * manifest.slots.teams
  return {
    players: Math.min(Math.ceil(total / PLUGIN_TEAMS), playersPerTeam(input)),
    spectators: request.rules ? request.rules.warmup.minSpectatorsToReady : 0,
  }
}

/**
 * **What a match decides about MatchZy-Enhanced itself**, on top of every
 * other cvar layer (PRD-03 T3a). The fork is applied by `ExecuteChangedConvars`
 * *before* warmup starts (`MatchManagement.cs` `LoadMatch`) and put back on
 * series end, so a per-match value is in force for exactly the match that
 * asked for it — which is why these belong here and not in the image's cfg,
 * where they would be one setting for every match a server ever plays.
 *
 * Today that is auto-ready and nothing else. The **side-pick timer** is not
 * here on purpose: a knife round nobody answers must not be able to hold a
 * server for ever, whoever built the request, so the timer is the server's and
 * `docker/cs2/cfg/MatchZy/ezpug.cfg` owns it. `.gg` and the forfeit clock are
 * off in that same file: a server must not end a match in a way the platform
 * has no result for.
 */
function matchzyCvars(input: MatchConfigInput): Record<string, string> {
  return {
    matchzy_autoready_enabled: String(input.request.rules?.warmup.autoReady ?? true),
  }
}

function common(input: MatchConfigInput) {
  const { request, manifest } = input
  const ready = warmup(input)
  return {
    num_maps: request.maps.length,
    maplist: request.maps.map(plan => plan.map),
    map_sides: request.maps.map(mapSide),
    // The platform already vetoed; the server must not offer to do it again.
    skip_veto: true,
    players_per_team: playersPerTeam(input),
    min_players_to_ready: ready.players,
    min_spectators_to_ready: ready.spectators,
    team1: team(request.teams.teamA),
    team2: team(request.teams.teamB),
    // The request has no casters; an empty object is what MatchZy expects, never an absent key.
    spectators: { players: {} },
    cvars: mergeCvars(request, manifest),
  }
}

/**
 * The puppets switch, only when the request asked (PRD-03 T4): `simulation`
 * turns the fork's simulation mode on for this match and this match alone —
 * the per-match switch decision 19 wants, never a second binary — and
 * `simulation_timescale` is the engine clock it plays at, `1` when unsaid
 * because that is the fork's own default and a real server's only honest
 * speed.
 */
function simulation(
  request: MatchRequest,
): Pick<MatchZyMatchConfig, 'simulation' | 'simulation_timescale'> {
  if (request.simulation === undefined) return {}
  return { simulation: true, simulation_timescale: request.simulation.timeScale ?? 1 }
}

/** Build the CS2 (MatchZy) match file. */
export function buildMatchZyConfig(input: MatchConfigInput): MatchZyMatchConfig {
  const shared = common(input)
  return {
    matchid: matchzySerial(input.matchId),
    num_maps: shared.num_maps,
    maplist: shared.maplist,
    map_sides: shared.map_sides,
    skip_veto: shared.skip_veto,
    // Bo1 makes this moot; a Bo3 ends at 2–0 rather than playing a dead map.
    clinch_series: true,
    wingman: isWingman(input.request),
    ...simulation(input.request),
    players_per_team: shared.players_per_team,
    min_players_to_ready: shared.min_players_to_ready,
    min_spectators_to_ready: shared.min_spectators_to_ready,
    team1: shared.team1,
    team2: shared.team2,
    spectators: shared.spectators,
    cvars: { ...shared.cvars, ...matchzyCvars(input) },
  }
}

function get5SideType(maps: readonly MapPlan[]): Get5SideType {
  const knives = maps.filter(plan => plan.sides === 'knife').length
  if (knives === 0) return 'never_knife'
  if (knives === maps.length) return 'always_knife'
  return 'standard'
}

/** The title Get5 shows: the request's hostname, or the teams. */
function matchTitle(request: MatchRequest): string {
  return (
    request.branding?.hostname ??
    `EZPug — ${request.teams.teamA.name} vs ${request.teams.teamB.name}`
  )
}

/** Build the CS:GO (Get5) match config. */
export function buildGet5Config(input: MatchConfigInput): Get5MatchConfig {
  const shared = common(input)
  return {
    matchid: input.matchId,
    match_title: matchTitle(input.request),
    num_maps: shared.num_maps,
    maplist: shared.maplist,
    map_sides: shared.map_sides,
    skip_veto: shared.skip_veto,
    side_type: get5SideType(input.request.maps),
    players_per_team: shared.players_per_team,
    min_players_to_ready: shared.min_players_to_ready,
    min_spectators_to_ready: shared.min_spectators_to_ready,
    team1: shared.team1,
    team2: shared.team2,
    spectators: shared.spectators,
    cvars: shared.cvars,
  }
}

/** The game dimension picks the plugin, exactly as it picks the capability filter. */
export function buildMatchConfig(input: MatchConfigInput): PluginMatchConfig {
  return input.request.game === 'cs2' ? buildMatchZyConfig(input) : buildGet5Config(input)
}
