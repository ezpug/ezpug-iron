import { createHash } from 'node:crypto'
import type { GamemodeManifest, MapPlan, MatchRequest, Roster } from '@ezpug/match-api'
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
 * - **`players_per_team` is the manifest's `teamSize`**, not the roster's
 *   length: an unrostered match (bots, an open room) still plays five a side.
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

/** The ready thresholds: the request's rules, or the manifest's full house and no caster. */
function warmup(input: MatchConfigInput): { players: number; spectators: number } {
  const { request, manifest } = input
  if (request.rules) {
    return {
      players: request.rules.warmup.minPlayersToReady,
      spectators: request.rules.warmup.minSpectatorsToReady,
    }
  }
  return { players: manifest.slots.teamSize * manifest.slots.teams, spectators: 0 }
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
    players_per_team: manifest.slots.teamSize,
    min_players_to_ready: ready.players,
    min_spectators_to_ready: ready.spectators,
    team1: team(request.teams.teamA),
    team2: team(request.teams.teamB),
    // The request has no casters; an empty object is what MatchZy expects, never an absent key.
    spectators: { players: {} },
    cvars: mergeCvars(request, manifest),
  }
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
    wingman: false,
    players_per_team: shared.players_per_team,
    min_players_to_ready: shared.min_players_to_ready,
    min_spectators_to_ready: shared.min_spectators_to_ready,
    team1: shared.team1,
    team2: shared.team2,
    spectators: shared.spectators,
    cvars: shared.cvars,
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
