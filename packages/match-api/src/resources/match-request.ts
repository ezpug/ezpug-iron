import { z } from 'zod'
import { type MatchFormat, matchFormatSchema, WINGMAN_TEAM_SIZE } from '../vocabulary/format'
import { gameSchema } from '../vocabulary/game'
import { SERVER_CHAT_TEXT_MAX, teamSideSchema } from '../vocabulary/gameserver'
import { DEFAULT_LOCALE, localeSchema } from '../vocabulary/locale'
import { kebabNameSchema } from '../vocabulary/naming'
import { steamId64Schema } from '../vocabulary/steam-id'
import { clientMatchIdSchema } from './common'
import { loadoutSchema } from './loadout'
import { simChaosSchema, simModeSchema, simTimeScaleSchema } from './sim'

/**
 * **What a client asks for** (`POST /v1/matches`): everything a server needs
 * to play one match, and nothing the platform owns. Derived from the
 * platform's `matchRequestSchema` — `maps` and `rules` are copied as they are,
 * so a decided platform request maps onto this without translation — plus
 * what a server needs that the platform never had to know: the gamemode, the
 * callbacks, the placement requirements and per-player profiles.
 *
 * The platform owns people; the orchestrator owns servers. A roster entry
 * carries what the server must *show* about a person — name, locale, rating,
 * rank, loadout — and none of it is the orchestrator's truth: it relays, it
 * never stores a player.
 */

/**
 * A rostered (or, in an open-join mode, a pushed) player as the server needs
 * them: the SteamID64 the roster pins, and the profile the plugin renders.
 */
export const rosterEntrySchema = z.object({
  steamId64: steamId64Schema,
  /** The display name the server shows — the platform's, not Steam's persona. */
  name: z.string().min(1).max(64),
  /** The language the plugin prints to this player in. German when unsaid. */
  locale: localeSchema.default(DEFAULT_LOCALE),
  /** EZ Rating, shown Premier-style on the scoreboard (decision 21). */
  rating: z.number().int().nonnegative().optional(),
  /** The rank's display name, for chat and the connect card. */
  rankName: z.string().min(1).max(32).optional(),
  loadout: loadoutSchema.optional(),
})
export type RosterEntry = z.infer<typeof rosterEntrySchema>

/**
 * A team as the request locks it. Team A is the platform's Captain A's team.
 * `players` may be empty for an open-join gamemode (retakes, a deathmatch):
 * people arrive and are pushed with a `profile` command instead.
 */
export const rosterSchema = z.object({
  name: z.string().min(1).max(64),
  players: z.array(rosterEntrySchema),
})
export type Roster = z.infer<typeof rosterSchema>

export const matchTeamsSchema = z
  .object({
    teamA: rosterSchema,
    teamB: rosterSchema,
  })
  .superRefine((teams, ctx) => {
    const seen = new Set<string>()
    for (const player of [...teams.teamA.players, ...teams.teamB.players]) {
      if (seen.has(player.steamId64))
        ctx.addIssue({ code: 'custom', message: `${player.steamId64} is rostered twice` })
      seen.add(player.steamId64)
    }
  })
export type MatchTeams = z.infer<typeof matchTeamsSchema>

/**
 * Which side **team A** starts on, or `knife` to let a knife round decide.
 * The platform's `mapPlanSidesSchema`, verbatim.
 */
export const mapPlanSidesSchema = z.union([teamSideSchema, z.literal('knife')])
export type MapPlanSides = z.infer<typeof mapPlanSidesSchema>

/** One map to be played: engine name or `workshop/<id>/<name>`. The platform's, verbatim. */
export const mapPlanSchema = z.object({
  map: z.string().min(1),
  sides: mapPlanSidesSchema,
})
export type MapPlan = z.infer<typeof mapPlanSchema>

/**
 * The rules a context decided — the platform's `matchRulesSchema`, plus the
 * two fields a server needed that a platform never had to say: `warmup.autoReady`
 * (PRD-03 T3a) and {@link matchFormatSchema | `format`} (PRD-03 T3b). Both
 * default, so a request written before either existed parses unchanged.
 */
export const matchRulesSchema = z.object({
  /**
   * **Which game the engine plays.** `competitive` (the default, and what a
   * request that says nothing gets) or `wingman`; {@link matchFormatSchema}
   * has what each means and what it does to the map. A gamemode lists the
   * formats it can play (`GamemodeManifest.formats`); asking one for a format
   * it does not list is `validation_failed`, never a match quietly played as
   * the other game.
   */
  format: matchFormatSchema
    .default('competitive')
    .describe('the engine game: competitive (5v5) or wingman (2v2)'),
  /** `mp_maxrounds`, the MR format before overtime. Even, positive. */
  regulationRounds: z.number().int().positive().multipleOf(2),
  overtime: z.object({
    enabled: z.boolean(),
    /** Full MR pair count (MR3 = 6). Even — an odd overtime could tie again. */
    maxRounds: z.number().int().positive().multipleOf(2),
    startMoney: z.number().int().nonnegative(),
  }),
  warmup: z.object({
    /**
     * **How many players in the whole match** — both teams together, not per
     * team — must be ready before it goes live. A client computes it from the
     * roster it already holds and never has to know which match plugin runs
     * the server; the orchestrator converts it to whatever that plugin counts
     * (MatchZy counts per team, so it is halved there). `0` gates on nobody.
     */
    minPlayersToReady: z
      .number()
      .int()
      .nonnegative()
      .describe('ready players across both teams, not per team'),
    /** How many spectators must be ready. Casters are one group, so this one is not split. */
    minSpectatorsToReady: z
      .number()
      .int()
      .nonnegative()
      .describe('ready spectators; casters are one group'),
    /**
     * **Nobody has to type `.ready`.** On (the default), the match plugin
     * readies each player a couple of seconds after they pick a side and
     * counts down out loud once the gate is passed; a player who types
     * `.unready` is left alone until they type `.ready` again, so the two
     * commands still mean what they always did. Off is the LAN admin's
     * manual ready-up, where a captain wants the room to say so.
     *
     * It does **not** loosen any gate: the same roster has to be connected
     * and on its side, and the same {@link minPlayersToReady} has to be met
     * (MatchZy-Enhanced's `CheckAndAutoReadyPlayers` only simulates the
     * command, `IsLiveRequirementSatisfied` still decides). A rostered
     * player who never connects still holds the match in warmup for ever —
     * the client's own join deadline is the only thing that gives up.
     */
    autoReady: z
      .boolean()
      .default(true)
      .describe('ready each player automatically; the gate itself is unchanged'),
  }),
  /**
   * A preset's cvars, merged **under** the ones the gamemode derives — a
   * request can never redirect the event sink or change the round format
   * behind the rules' back. Defaults to none.
   */
  cvars: z.record(z.string(), z.string()).default({}),
})
export type MatchRules = z.infer<typeof matchRulesSchema>

/**
 * Where the server may be placed. Every field but `preferLan` narrows; none
 * is required. A request nothing can satisfy is refused `no_capable_server`
 * at the door, not discovered later.
 */
export const matchRequirementsSchema = z
  .object({
    /** A provider region id (`eu-central`); omitted = any. */
    region: kebabNameSchema.optional(),
    /** Only a self-hosted node — the venue's own capacity during an event (decision 23). */
    lan: z.boolean().optional(),
    /**
     * **Prefer** a self-hosted node, and take anything else when there is
     * none: the only field here that ranks instead of narrowing. A LAN night
     * held before a node is enrolled plays on a rented box rather than
     * refusing every match — which is what `lan: true` does, and why it is
     * still the field for "the venue's own hardware or nothing".
     */
    preferLan: z.boolean().optional(),
    /** Only the `sim` provider — a match nobody will connect to. */
    simulated: z.boolean().optional(),
    /** Exactly this provider (`dathost`, `sim`, a node's provider id). */
    provider: kebabNameSchema.optional(),
  })
  .superRefine((requirements, ctx) => {
    // Two different sentences about the same wish; a request that says both
    // has not decided whether a rented box is acceptable.
    if (requirements.lan && requirements.preferLan)
      ctx.addIssue({
        code: 'custom',
        path: ['preferLan'],
        message: 'lan and preferLan say different things; ask for one of them',
      })
  })
export type MatchRequirements = z.infer<typeof matchRequirementsSchema>

/** The longest series a client may hand upload urls for — a Bo9 and then some. */
export const DEMO_UPLOAD_URLS_MAX = 16

/**
 * Where the client wants to hear back (decisions 6, 10). `webhookSecretId`
 * names one of the secrets registered on the API key, so a client can rotate
 * by registering a new id and switching new requests to it. `demoUploadUrl`
 * is a presigned PUT into the client's own storage: the plugin uploads
 * straight there and the orchestrator relays `demo.uploaded` with size and
 * hash, never touching a demo byte. `streamAllowedOrigins` is the CORS
 * allow-list for the match's stream and widget sockets.
 */
export const matchCallbacksSchema = z
  .object({
    webhookUrl: z.url(),
    webhookSecretId: z.string().min(1).max(64),
    demoUploadUrl: z.url().optional(),
    /**
     * One presigned PUT per map of a series, for a client that keeps every
     * map's demo. A signature covers the key it was drawn for, so a template
     * with a `{mapNumber}` in it could not be signed — the list is the only
     * honest shape. The entry for the map being uploaded wins;
     * `demoUploadUrl` is the fallback for every map without one, which is
     * exactly what a Bo1 already had.
     */
    demoUploadUrls: z
      .array(
        z.object({
          /** 1-based, matching `demo.uploaded.mapNumber` and the request's `maps` order. */
          mapNumber: z.number().int().positive().max(DEMO_UPLOAD_URLS_MAX),
          url: z.url(),
        }),
      )
      .min(1)
      .max(DEMO_UPLOAD_URLS_MAX)
      .optional(),
    streamAllowedOrigins: z.array(z.url()).max(16).optional(),
  })
  .superRefine((callbacks, ctx) => {
    const seen = new Set<number>()
    for (const entry of callbacks.demoUploadUrls ?? []) {
      if (seen.has(entry.mapNumber))
        ctx.addIssue({
          code: 'custom',
          path: ['demoUploadUrls'],
          message: `map ${entry.mapNumber} is given two upload urls`,
        })
      seen.add(entry.mapNumber)
    }
  })
export type MatchCallbacks = z.infer<typeof matchCallbacksSchema>

/**
 * Where map `mapNumber`'s demo goes: its own presigned PUT when the request
 * drew one, else the single `demoUploadUrl`, else nowhere (no upload, and
 * `match.ended` reads `no_upload_url`). The orchestrator, the fake and the
 * plugin all resolve it this way, so a client reads the same rule everywhere.
 */
export function demoUploadUrlFor(
  callbacks: Pick<MatchCallbacks, 'demoUploadUrl' | 'demoUploadUrls'>,
  mapNumber: number,
): string | undefined {
  const perMap = callbacks.demoUploadUrls?.find(entry => entry.mapNumber === mapNumber)
  return perMap?.url ?? callbacks.demoUploadUrl
}

/** Whether a demo has anywhere at all to land — one url is enough. */
export function hasDemoUploadUrl(
  callbacks: Pick<MatchCallbacks, 'demoUploadUrl' | 'demoUploadUrls'>,
): boolean {
  return callbacks.demoUploadUrl !== undefined || (callbacks.demoUploadUrls?.length ?? 0) > 0
}

/** Branding this round: hostname and chat (decision 22). */
export const matchBrandingSchema = z.object({
  /** The server's `hostname`, shown in the browser and the scoreboard. */
  hostname: z.string().min(1).max(63).optional(),
  /** The event's name, for the connect card and the chat prefix. */
  eventName: z.string().min(1).max(64).optional(),
})
export type MatchBranding = z.infer<typeof matchBrandingSchema>

/**
 * Knobs for a simulated match — honoured only when the match lands on the
 * `sim` provider; refused `validation_failed` otherwise, so a stray `sim`
 * block can never steer a real server.
 */
export const matchSimOptionsSchema = z.object({
  /** A scenario the engine knows (`happy-path`, `crash-after-round-5`, …); its default when unsaid. */
  scenario: kebabNameSchema.optional(),
  /** The seed the story is built from; the orchestrator picks one when unsaid, and reports it. */
  seed: z.string().min(1).max(64).optional(),
  mode: simModeSchema.optional(),
  timeScale: simTimeScaleSchema.optional(),
  chaos: simChaosSchema.nullable().optional(),
})
export type MatchSimOptions = z.infer<typeof matchSimOptionsSchema>

/**
 * What a real engine's `host_timescale` can honestly be asked for — MatchZy-
 * Enhanced clamps a match file's `simulation_timescale` to exactly this
 * range (`src/MatchLogic.cs`), and a number outside it would be silently
 * clamped rather than played, which is the one thing a contract must not do.
 * Deliberately not {@link simTimeScaleSchema}'s range: the simulator engine
 * runs a story on a clock and can do six hundred, a game server cannot.
 */
export const SIMULATION_TIME_SCALE_MIN = 0.1
export const SIMULATION_TIME_SCALE_MAX = 10

/**
 * **Puppets** (PRD-03 T4): the match is played by simulated players. Every
 * rostered player gets one — a body on the server carrying that entry's
 * SteamID and name, connecting, readying up and playing through the doors a
 * human takes — so a client sees exactly the facts a real match would send,
 * about exactly the players it rostered. There is no half measure this
 * round: the match software fills every roster seat or none
 * (`references/MatchZy-Enhanced/src/SimulationMode.cs` spawns one bot per
 * configured player), so a request that wants some humans and some puppets
 * is a request for a later contract, not a quietly different match.
 *
 * Needs the `simulation` scope on the key ({@link matchRequestScopes}) and
 * `capabilities.simulation` on the gamemode ({@link matchSimulationProblem});
 * every gameserver event of the match then carries `source.simulated: true`
 * and the `Match` says `simulated: true`, so no consumer can count it as
 * real. It is **not** {@link matchSimOptionsSchema}: that block steers the
 * simulator *provider*, where no server exists; this one asks a real
 * server — rented, LAN or the simulator alike — to play without people, and
 * costs what a real server costs.
 */
export const matchSimulationSchema = z.object({
  /**
   * A scenario from `GET /v1/sim/scenarios`, the same catalog the simulator
   * plays: what the puppets do beyond playing the match out. Unsaid is the
   * catalog's default. A knob a real server cannot execute is listed as
   * sim-only in `docs/gamemodes.md`, never silently ignored. Saying it here
   * *and* in `sim.scenario` is fine when the two agree and
   * `validation_failed` when they do not.
   */
  scenario: kebabNameSchema.optional(),
  /**
   * The engine's `host_timescale` for the match, `1` when unsaid. The lane's
   * knob: a real match never asks for it, and a server puts the clock back
   * at series end.
   */
  timeScale: z.number().min(SIMULATION_TIME_SCALE_MIN).max(SIMULATION_TIME_SCALE_MAX).optional(),
})
export type MatchSimulation = z.infer<typeof matchSimulationSchema>

/**
 * **Whether a gamemode can play this request with puppets**, decided once
 * here so an orchestrator and the fake refuse the same requests for the same
 * reasons (PRD-03 T4). `undefined` means play it; anything else is a
 * `validation_failed` with the field that has to change. The scope is not
 * judged here — that is {@link matchRequestScopes}' business and comes first.
 *
 * Three refusals: the mode does not claim `capabilities.simulation` (its
 * match software cannot seat a puppet, so the request would wait in warmup
 * for people who are never coming); nobody is rostered (a puppet is a roster
 * entry made flesh, and a match with no entries has nobody to simulate);
 * and `sim.scenario` names a different story than `simulation.scenario`.
 */
export function matchSimulationProblem(
  request: Pick<MatchRequest, 'simulation' | 'sim' | 'teams'>,
  mode: { id: string; capabilities: { simulation: boolean } },
): { message: string; field: string } | undefined {
  const simulation = request.simulation
  if (simulation === undefined) return undefined
  if (!mode.capabilities.simulation)
    return { message: `${mode.id} cannot play with simulated players`, field: 'simulation' }
  if (request.teams.teamA.players.length + request.teams.teamB.players.length === 0)
    return { message: 'a simulated match needs at least one rostered player', field: 'teams' }
  const other = request.sim?.scenario
  if (simulation.scenario !== undefined && other !== undefined && other !== simulation.scenario)
    return {
      message: `simulation.scenario says ${simulation.scenario} and sim.scenario says ${other}`,
      field: 'simulation.scenario',
    }
  return undefined
}

/**
 * **Whether a gamemode can play the format a request asks for**, decided once
 * here so an orchestrator and the fake refuse the same requests for the same
 * reasons (PRD-03 T3b). `undefined` means play it; anything else is a
 * `validation_failed` with the field that has to change.
 *
 * Two ways a request is refused, and neither is a quiet demotion to the other
 * game: the mode does not list the format ({@link GamemodeManifest.formats} —
 * only some match software can switch the engine's game), and `wingman` with
 * more than {@link WINGMAN_TEAM_SIZE} players on a side, who would arrive at a
 * map with no spawn for them.
 */
export function matchFormatProblem(
  request: Pick<MatchRequest, 'rules' | 'teams'>,
  mode: { id: string; formats: readonly MatchFormat[] },
): { message: string; field: string } | undefined {
  const format = request.rules?.format
  if (format === undefined) return undefined
  if (!mode.formats.includes(format))
    return {
      message: `${mode.id} plays ${mode.formats.join(', ')}, not ${format}`,
      field: 'rules.format',
    }
  if (format !== 'wingman') return undefined
  for (const side of ['teamA', 'teamB'] as const) {
    const rostered = request.teams[side].players.length
    if (rostered > WINGMAN_TEAM_SIZE)
      return {
        message: `wingman plays ${WINGMAN_TEAM_SIZE} a side; ${side} rosters ${rostered}`,
        field: `teams.${side}.players`,
      }
  }
  return undefined
}

/** The longest a match may hold a server. The key's own ceiling may be lower. */
export const MATCH_TTL_MINUTES_MAX = 24 * 60

export const matchRequestSchema = z.object({
  clientMatchId: clientMatchIdSchema,
  game: gameSchema,
  /** A gamemode id from `GET /v1/gamemodes`. */
  gamemode: kebabNameSchema,
  teams: matchTeamsSchema,
  /** One entry per map, in order. Bo1 is one entry. */
  maps: z.array(mapPlanSchema).min(1),
  /** Absent = the gamemode's own defaults (a config-only mode needs none). */
  rules: matchRulesSchema.optional(),
  requirements: matchRequirementsSchema.default({}),
  callbacks: matchCallbacksSchema,
  /** Lines the plugin prints during warmup, in order, each bilingual-or-not as the client chose. */
  warmupLines: z.array(z.string().min(1).max(SERVER_CHAT_TEXT_MAX)).max(20).optional(),
  branding: matchBrandingSchema.optional(),
  sim: matchSimOptionsSchema.optional(),
  /**
   * Play it with puppets ({@link matchSimulationSchema}). Needs the
   * `simulation` scope; absent is a real match, which is what every request
   * written before this field existed meant.
   */
  simulation: matchSimulationSchema.optional(),
  /**
   * How long the server may live from allocation, whatever happens; the
   * reaper ends it past this (decision 7). Never above the key's ceiling.
   */
  ttlMinutes: z.number().int().positive().max(MATCH_TTL_MINUTES_MAX),
})
export type MatchRequest = z.infer<typeof matchRequestSchema>
export type MatchRequestInput = z.input<typeof matchRequestSchema>
