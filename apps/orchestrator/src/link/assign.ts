import type { GamemodeManifest, MatchRequest, MatchTeams, RosterEntry } from '@ezpug/match-api'
import {
  type AssignedGamemode,
  assignedGamemodeSchema,
  assignOrchestratorFrameSchema,
  type OrchestratorFrameOf,
  type RoundBackup,
} from '@ezpug/protocol'
import { mergeCvars } from '../match-config/cvars'
import { buildMatchZyConfig } from '../match-config/matchzy'

export { derivedCvars, mergeCvars } from '../match-config/cvars'

/**
 * **The assignment, composed once** (PRD-02 T6): everything a server needs
 * to play one match, from the request, the manifest and what the machine
 * learned since — pushed profiles, a backup to restore from (T14). Pure, so
 * the shape is proven without a socket, and parsed through the frame
 * schema so the bytes on the wire are the schema's own order.
 *
 * Precedence, decided here and nowhere else (the manifest's own comment on
 * `cvars`): a request's `rules.cvars` sit **under** the mode's, which sit
 * **under** what the rules derive — a request can never undo what a mode
 * needs, and a mode never redirects the round format behind the rules'
 * back. For a `matchzy` flow the same flat map travels a second time inside
 * `matchzyConfig` (`match-config/matchzy.ts`), because MatchZy's own
 * `live.cfg` would undo a cvar the loader set and MatchZy re-applies its
 * config's cvars after that cfg — the document is what keeps the round
 * format in force, and MatchZy is what reads it.
 */

/** The plugin folder the skins layer lives in (decision 20, T28); enabled when a loadout is on the roster and the image has it. */
export const SKINS_PLUGIN = 'WeaponPaints'

export interface AssignInput {
  matchId: string
  request: MatchRequest
  manifest: GamemodeManifest
  /** Every profile pushed since the request, by SteamID64; replaces the roster's entry of the same player. */
  profiles?: ReadonlyMap<string, RosterEntry>
  /** The plugin folders the server's `hello` listed. */
  installed: readonly string[]
  restore?: RoundBackup
}

/** The roster with every pushed profile applied in place. */
export function withProfiles(
  teams: MatchTeams,
  profiles: ReadonlyMap<string, RosterEntry> | undefined,
): MatchTeams {
  if (!profiles || profiles.size === 0) return teams
  const apply = (team: MatchTeams['teamA']): MatchTeams['teamA'] => ({
    ...team,
    players: team.players.map(player => profiles.get(player.steamId64) ?? player),
  })
  return { teamA: apply(teams.teamA), teamB: apply(teams.teamB) }
}

/** The plugin folders to enable: the manifest's, plus the skins layer when a loadout needs it and the image has it. */
export function pluginsFor(
  manifest: GamemodeManifest,
  teams: MatchTeams,
  installed: readonly string[],
): string[] {
  const plugins = [...manifest.plugins]
  const loadouts = [...teams.teamA.players, ...teams.teamB.players].some(
    player => player.loadout !== undefined,
  )
  if (loadouts && installed.includes(SKINS_PLUGIN) && !plugins.includes(SKINS_PLUGIN))
    plugins.push(SKINS_PLUGIN)
  return plugins
}

/** The manifest as a server reads it: minus the map allow-list and the widget bundle. */
export function assignedGamemode(manifest: GamemodeManifest): AssignedGamemode {
  return assignedGamemodeSchema.parse(manifest)
}

/** The plugins the manifest names that the server's image lacks — an assignment is refused before it is sent. */
export function missingPlugins(manifest: GamemodeManifest, installed: readonly string[]): string[] {
  return manifest.plugins.filter(plugin => !installed.includes(plugin))
}

export function composeAssign(input: AssignInput): OrchestratorFrameOf<'assign'> {
  const { matchId, request, manifest, installed, restore } = input
  const teams = withProfiles(request.teams, input.profiles)
  return assignOrchestratorFrameSchema.parse({
    type: 'assign',
    matchId,
    game: request.game,
    gamemode: assignedGamemode(manifest),
    plugins: pluginsFor(manifest, teams, installed),
    cfg: manifest.cfg,
    cvars: mergeCvars(request, manifest),
    ...(manifest.flow === 'matchzy' && {
      matchzyConfig: buildMatchZyConfig({ matchId, request, manifest }),
    }),
    maps: request.maps,
    ...(request.rules && { rules: request.rules }),
    teams,
    warmupLines: request.warmupLines ?? [],
    branding: request.branding ?? {},
    ...(request.callbacks.demoUploadUrl && { demoUploadUrl: request.callbacks.demoUploadUrl }),
    ...(restore && { restore }),
  })
}
