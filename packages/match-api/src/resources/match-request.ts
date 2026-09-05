import { z } from 'zod'
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

/** The rules a context decided — the platform's `matchRulesSchema`, verbatim. */
export const matchRulesSchema = z.object({
  /** `mp_maxrounds`, the MR format before overtime. Even, positive. */
  regulationRounds: z.number().int().positive().multipleOf(2),
  overtime: z.object({
    enabled: z.boolean(),
    /** Full MR pair count (MR3 = 6). Even — an odd overtime could tie again. */
    maxRounds: z.number().int().positive().multipleOf(2),
    startMoney: z.number().int().nonnegative(),
  }),
  warmup: z.object({
    minPlayersToReady: z.number().int().nonnegative(),
    minSpectatorsToReady: z.number().int().nonnegative(),
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
 * Where the server may be placed. Every field narrows; none is required. A
 * request nothing can satisfy is refused `no_capable_server` at the door, not
 * discovered later.
 */
export const matchRequirementsSchema = z.object({
  /** A provider region id (`eu-central`); omitted = any. */
  region: kebabNameSchema.optional(),
  /** Only a self-hosted node — the venue's own capacity during an event (decision 23). */
  lan: z.boolean().optional(),
  /** Only the `sim` provider — a match nobody will connect to. */
  simulated: z.boolean().optional(),
  /** Exactly this provider (`dathost`, `sim`, a node's provider id). */
  provider: kebabNameSchema.optional(),
})
export type MatchRequirements = z.infer<typeof matchRequirementsSchema>

/**
 * Where the client wants to hear back (decisions 6, 10). `webhookSecretId`
 * names one of the secrets registered on the API key, so a client can rotate
 * by registering a new id and switching new requests to it. `demoUploadUrl`
 * is a presigned PUT into the client's own storage: the plugin uploads
 * straight there and the orchestrator relays `demo.uploaded` with size and
 * hash, never touching a demo byte. `streamAllowedOrigins` is the CORS
 * allow-list for the match's stream and widget sockets.
 */
export const matchCallbacksSchema = z.object({
  webhookUrl: z.url(),
  webhookSecretId: z.string().min(1).max(64),
  demoUploadUrl: z.url().optional(),
  streamAllowedOrigins: z.array(z.url()).max(16).optional(),
})
export type MatchCallbacks = z.infer<typeof matchCallbacksSchema>

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
   * How long the server may live from allocation, whatever happens; the
   * reaper ends it past this (decision 7). Never above the key's ceiling.
   */
  ttlMinutes: z.number().int().positive().max(MATCH_TTL_MINUTES_MAX),
})
export type MatchRequest = z.infer<typeof matchRequestSchema>
export type MatchRequestInput = z.input<typeof matchRequestSchema>
