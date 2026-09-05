import { z } from 'zod'
import { assertClosedSet } from '../closed-set'
import { matchApiErrorCodeSchema } from '../errors'
import { pauseKindSchema, SERVER_CHAT_TEXT_MAX } from '../vocabulary/gameserver'
import { gameserverEventTypeSchema } from '../vocabulary/naming'
import { steamId64Schema } from '../vocabulary/steam-id'
import { rosterEntrySchema } from './match-request'
import { simChaosSchema, simModeSchema, simStatusSchema, simTimeScaleSchema } from './sim'

/**
 * **What a client tells a running match** (`POST /v1/matches/:matchId/commands`).
 * One route with a closed command union: every command addresses the same
 * server, every one is "do this now", and one result shape means every call
 * leaves the client holding the server's answer.
 *
 * `correlationId` is the client's own id for the call — the idempotency key of
 * a command. A retried command with the same id is not applied twice; the
 * result of the first call is returned. The same id comes back on the stream's
 * `command_result` frame for a command the server answers later.
 */

/** The client's id for one command call. */
export const correlationIdSchema = z.string().min(1).max(128)

const commandBase = z.object({ correlationId: correlationIdSchema })

export const matchCommandSchema = z.discriminatedUnion('type', [
  /** Pause the match (the gamemode's own pause where it has one). */
  commandBase.extend({ type: z.literal('pause'), kind: pauseKindSchema.optional() }),
  commandBase.extend({ type: z.literal('unpause') }),
  /** Restart the current round. */
  commandBase.extend({ type: z.literal('restart_round') }),
  /** End the match now; it ends `force_ended`. */
  commandBase.extend({ type: z.literal('force_end'), reason: z.string().max(256).optional() }),
  /** Kick a player from the server. Says nothing about the roster. */
  commandBase.extend({
    type: z.literal('kick'),
    steamId64: steamId64Schema,
    reason: z.string().max(256).optional(),
  }),
  /** Say one line in the server's chat. The plugin prints it; a sim echoes it as a `plugin_event`. */
  commandBase.extend({
    type: z.literal('announce'),
    text: z.string().min(1).max(SERVER_CHAT_TEXT_MAX),
  }),
  /**
   * The operator fallback (decision 5): an RCON command, verbatim, on a real
   * server. Needs the `admin` scope on top of the route's `matches`
   * ({@link MATCH_COMMANDS_REQUIRING_ADMIN}); `command_unsupported` on a sim.
   */
  commandBase.extend({ type: z.literal('rcon'), command: z.string().min(1).max(1024) }),
  /**
   * Restore from a round backup: the named round's, or the latest when unsaid.
   * `no_backup` when there is none. The recovery flow's own verb, exposed so a
   * client can drive it by hand.
   */
  commandBase.extend({
    type: z.literal('restore'),
    roundNumber: z.number().int().positive().optional(),
  }),
  /** Start the match over on the same server: fresh warmup, scores cleared, rosters kept. */
  commandBase.extend({ type: z.literal('reroll') }),
  /**
   * Push a player's profile: the way an open-join gamemode learns who just
   * connected, and the way a rostered player's rating or loadout is refreshed
   * mid-match. `player_not_in_match` for an unrostered player on a closed mode.
   */
  commandBase.extend({ type: z.literal('profile'), player: rosterEntrySchema }),
  // The sim family — the `sim` provider only (decision 9).
  /** Deal the next story beat (step mode only). */
  commandBase.extend({ type: z.literal('sim.step') }),
  commandBase.extend({ type: z.literal('sim.mode'), mode: simModeSchema }),
  commandBase.extend({ type: z.literal('sim.speed'), timeScale: simTimeScaleSchema }),
  /** Arm or clear this server's delivery chaos. */
  commandBase.extend({ type: z.literal('sim.chaos'), chaos: simChaosSchema.nullable() }),
  /** The kill-server button: the box dies, probes answer gone, heartbeats stop. */
  commandBase.extend({ type: z.literal('sim.kill') }),
])
export type MatchCommand = z.infer<typeof matchCommandSchema>

/** Every command type, in the union's order. */
export const MATCH_COMMAND_TYPES = [
  'pause',
  'unpause',
  'restart_round',
  'force_end',
  'kick',
  'announce',
  'rcon',
  'restore',
  'reroll',
  'profile',
  'sim.step',
  'sim.mode',
  'sim.speed',
  'sim.chaos',
  'sim.kill',
] as const
export type MatchCommandType = (typeof MATCH_COMMAND_TYPES)[number]

/** The command for one `type` — `MatchCommandOf<'announce'>` etc. */
export type MatchCommandOf<T extends MatchCommandType> = Extract<MatchCommand, { type: T }>

/** The commands only a `sim` server understands. */
export const SIM_COMMAND_TYPES = [
  'sim.step',
  'sim.mode',
  'sim.speed',
  'sim.chaos',
  'sim.kill',
] as const satisfies readonly [MatchCommandType, ...MatchCommandType[]]

export function isSimCommand(type: MatchCommandType): boolean {
  return (SIM_COMMAND_TYPES as readonly string[]).includes(type)
}

/** Commands the `matches` scope alone may not send. */
export const MATCH_COMMANDS_REQUIRING_ADMIN = ['rcon'] as const satisfies readonly [
  MatchCommandType,
  ...MatchCommandType[],
]

assertClosedSet('match commands', matchCommandSchema, 'type', MATCH_COMMAND_TYPES)

/**
 * What became of a command:
 *
 * - `applied` — done, and the server's new truth is in the result.
 * - `accepted` — relayed to the server; the answer arrives on the stream as a
 *   `command_result` frame with the same `correlationId`.
 * - `rejected` — not done; `code` says why in the error vocabulary and
 *   `message` says it for a human. The HTTP status is still 200: the call
 *   itself succeeded, the command did not.
 */
export const matchCommandStatusSchema = z.enum(['applied', 'accepted', 'rejected'])
export type MatchCommandStatus = z.infer<typeof matchCommandStatusSchema>

export const matchCommandResultSchema = z.object({
  correlationId: correlationIdSchema,
  type: z.enum(MATCH_COMMAND_TYPES),
  status: matchCommandStatusSchema,
  /** Why a `rejected` command was rejected, in the error vocabulary. */
  code: matchApiErrorCodeSchema.optional(),
  message: z.string().optional(),
  /** For an `rcon` command: what the server printed. */
  output: z.string().optional(),
  /** For a `sim.*` command: the simulator's state after it. */
  sim: simStatusSchema.optional(),
  /** For a `sim.step`: the event type the beat dealt, or null (dry). */
  stepped: gameserverEventTypeSchema.nullable().optional(),
})
export type MatchCommandResult = z.infer<typeof matchCommandResultSchema>
