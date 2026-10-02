import { z } from 'zod'
import { assertClosedSet } from '../closed-set'
import { matchApiErrorCodeSchema } from '../errors'
import { pauseKindSchema, SERVER_CHAT_TEXT_MAX } from '../vocabulary/gameserver'
import { gameserverEventTypeSchema, kebabNameSchema } from '../vocabulary/naming'
import { steamId64Schema } from '../vocabulary/steam-id'
import { hudKeySchema } from './hud'
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

/**
 * The kinds of moment a server knows how to dress: somebody won a `drop`,
 * used a `perk`, was drawn in a `raffle`. **The set is open** — `kind` is any
 * kebab-case name ({@link momentKindSchema}), and a server shows one it does
 * not know plainly rather than refusing it, so a new kind is a client's
 * release and nobody else's.
 */
export const MOMENT_KINDS = ['drop', 'perk', 'raffle'] as const
export type MomentKind = (typeof MOMENT_KINDS)[number]

/** A moment's kind as a command carries it: one of {@link MOMENT_KINDS}, or a name of the client's own. */
export const momentKindSchema = kebabNameSchema.max(32)

/**
 * How much a moment matters, least to most — the platform's drop rarities,
 * word for word. A server tints by it and never does more: a tier changes
 * how a moment looks and sounds, not whether or when it is shown.
 */
export const MOMENT_TIERS = ['common', 'uncommon', 'rare', 'legendary'] as const
export const momentTierSchema = z.enum(MOMENT_TIERS)
export type MomentTier = z.infer<typeof momentTierSchema>

/** One line of a moment, in one language: a chat line's budget, never empty. */
const momentLineSchema = z.string().min(1).max(SERVER_CHAT_TEXT_MAX)

/**
 * **A moment's words in one language**: the line everybody reads, and the
 * line the person it is about reads in its place ("tk hat ein Trikot
 * gezogen" for the server, "Du hast ein Trikot gezogen" for tk). Without
 * `you`, the person reads what everybody reads.
 */
export const momentWordsSchema = z.object({
  /** What everybody on the server reads. */
  everyone: momentLineSchema,
  /** What the person the moment is about reads instead. Read only when the moment names one. */
  you: momentLineSchema.optional(),
})
export type MomentWords = z.infer<typeof momentWordsSchema>

/** The furthest ahead a moment may be told: a server is not a calendar. */
export const MOMENT_IN_MS_MAX = 60_000

/**
 * **This happened to this player** (PRD-07 T4, decision 34): the client says
 * what, to whom and how much it matters, and the server decides how and when
 * to show it.
 *
 * Every server answers it, and a client needs no knowledge of what a server
 * can draw. **A server without a HUD prints the line**, as `announce` does but
 * behind the server's own chat prefix — to each player in their own language,
 * the person's own line to the person. A server with one shows it too: a toast for everybody, and for the
 * person a card, at a point in the round where nobody is playing. The
 * command never names a layout, a panel or a class; `kind`, `tier` and `art`
 * are all a server is told about how it should look.
 *
 * `inMs` is **when**: how long after the server receives the command the
 * moment is due. Relative on purpose — the server's clock is not the
 * client's, so "at 20:15:07" would mean two different instants. A client
 * that reveals the same win elsewhere at a time of its own says how far off
 * that time is; `0`, the default, is now. The answer does not wait for it:
 * `applied` means the server holds the moment, and a server that is gone
 * before it is due shows nothing.
 *
 * The person need not be on the server, or on the roster: everybody else
 * still reads the line, and nothing waits for somebody to come back.
 */
export const momentCommandSchema = commandBase.extend({
  type: z.literal('moment'),
  kind: momentKindSchema,
  /** The person it is about, when there is one. */
  steamId64: steamId64Schema.optional(),
  tier: momentTierSchema.default('common'),
  /**
   * The picture, by key: one of {@link HUD_ART_KEYS} for one the addon
   * ships. A key it does not hold, and no key at all, is the default
   * picture ({@link HUD_DEFAULT_ART_KEY}) — never a refusal.
   */
  art: hudKeySchema.optional(),
  /** The words, in both languages; a player reads the roster locale's. */
  text: z.object({ de: momentWordsSchema, en: momentWordsSchema }),
  /** Milliseconds from the server receiving this until the moment is due. */
  inMs: z
    .number()
    .int()
    .nonnegative()
    .max(MOMENT_IN_MS_MAX)
    .default(0)
    .describe('how long after the server receives it the moment is due; relative, never a time'),
})
export type MomentCommand = z.infer<typeof momentCommandSchema>

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
  /** Something happened to somebody: the server shows it its own way ({@link momentCommandSchema}). */
  momentCommandSchema,
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
   * The same match, **a different box**. Before the match is live the current
   * server is released and the placement walk runs again for the same
   * `clientMatchId` — the answer to a box that booted badly before kickoff,
   * where a second create would need a second id and a `release` would only
   * end the match. From `live` it is the recovery an operator starts by hand:
   * `match.recovering`, a replacement handed the newest round backup,
   * `match.recovered` — the path a lost server takes by itself, on purpose.
   * `no_backup` from `live` when there is nothing to resume from, and
   * `invalid_state` from `recovering` (one is already running) and from a
   * terminal match. The ledger and the events replay tell the whole story.
   */
  commandBase.extend({ type: z.literal('reprovision') }),
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
  'moment',
  'rcon',
  'restore',
  'reroll',
  'reprovision',
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

/**
 * Commands the **orchestrator** answers by itself and never relays to a
 * server: they are about *where* the match runs, not about what the box
 * should do — and the box a `reprovision` replaces is in no position to be
 * asked. `packages/protocol`'s link command union is every other one.
 */
export const ORCHESTRATOR_COMMAND_TYPES = ['reprovision'] as const satisfies readonly [
  MatchCommandType,
  ...MatchCommandType[],
]

export function isOrchestratorCommand(type: MatchCommandType): boolean {
  return (ORCHESTRATOR_COMMAND_TYPES as readonly string[]).includes(type)
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
