import { z } from 'zod'
import { gameserverEventTypeSchema, kebabNameSchema } from './naming'
import { steamId64Schema } from './steam-id'

/*
 * **v1 of the vocabulary** (decision 4): the platform's
 * `packages/contracts/src/gameserver.ts` on 2026-09-05, copied verbatim — the
 * doc comments still cite the platform's specs (Match.md §5, Queue.md) because
 * they are the reasons these shapes are what they are. What did not come along
 * is the platform's ingestion surface (`gameserverRoutes`, the submission and
 * ack shapes): that is the platform's own door, and here a server speaks to the
 * orchestrator over the internal plugin protocol instead. The JSON every event
 * serializes to is byte-compatible with the platform's, and stays so: the union
 * changes only by a release with a changelog line (decision 24).
 */

/**
 * **The normalized gameserver event contract** (Match.md §5) — the single
 * vocabulary gameservers speak to the platform. Provider- and plugin-specific
 * payloads (MatchZy webhooks, Get5 forwards, node-channel messages) are
 * translated at the edge into this union; consumers — the match machine, the
 * `match:{id}` channel, stats-to-come — never learn a provider existed. The
 * Foundation simulator emits exactly this union: if the simulator and a real
 * server ever disagree in shape, that is a bug in an adapter, never a consumer
 * change.
 *
 * Decisions this file fixes (the normalized shape wins over provider quirks;
 * `references/MatchZy/` is the ground truth adapters translate *from*):
 *
 * - **`matchId` is the platform match id** (uuid). MatchZy's numeric `matchid`
 *   never reaches a consumer — the adapter resolves it from its own context
 *   (the callback URL / token subject identify the match anyway).
 * - **Players are SteamID64 + in-game name.** A gameserver knows Steam
 *   identity, not user rows; consumers join to `playerRefSchema` via the
 *   SteamID-pinned roster.
 * - **Teams are `team_a` / `team_b`** — the platform's own language (Queue.md's
 *   Captain A/B), not MatchZy's `team1`/`team2`. Sides are `ct` / `t`.
 * - **Round and map numbers are 1-based** ("round 1" is the first round).
 *   MatchZy counts both from 0; its adapter adds one.
 * - **Sequence hints, not guarantees.** `seq` is a monotonic per-match hint
 *   where the source provides one (the simulator and the EZPug plugin do;
 *   stock webhooks do not). Ingestion (Match.md §2) dedups and tolerates
 *   out-of-order delivery either way — `seq` sharpens the dedup key, it never
 *   substitutes for idempotency.
 * - **Position ticks are ephemeral** — live channel only, never event-sourced
 *   (Match.md §5 verbatim; the demo is the authoritative movement record).
 *   {@link isEphemeralGameserverEvent} is the one switch ingestion consults.
 */

/**
 * Bumped only when the union changes shape incompatibly. Adapters stamp it so
 * a stored raw payload can always be re-read; additive evolution (new optional
 * fields, new event types) does not bump it.
 */
export const GAMESERVER_EVENT_CONTRACT_VERSION = 1

/**
 * Who is speaking: which provider adapter produced this normalized event and
 * which of its servers it came from. `serverId` is the provider's own handle
 * (a Dathost server id, a LAN node id, a simulator instance id) — the audit
 * trail back to a physical box, not a platform key.
 */
export const gameserverSourceSchema = z.object({
  /** Provider adapter id — `simulator`, `dathost`, `lan-node`. */
  provider: kebabNameSchema,
  serverId: z.string().min(1),
})
export type GameserverSource = z.infer<typeof gameserverSourceSchema>

/** A match team as every gameserver event names one. */
export const matchTeamSchema = z.enum(['team_a', 'team_b'])
export type MatchTeam = z.infer<typeof matchTeamSchema>

/** A CS side. Only humans get to be `spec`; a round is never won by it. */
export const teamSideSchema = z.enum(['ct', 't'])
export type TeamSide = z.infer<typeof teamSideSchema>

/** Where a connected human sits on the server. */
export const serverSlotSchema = z.enum(['team_a', 'team_b', 'spec'])
export type ServerSlot = z.infer<typeof serverSlotSchema>

/**
 * A player as a gameserver sees one. `team` is present where the source knows
 * it (the plugin tier always does; a bare connect may not yet).
 */
export const gameserverPlayerSchema = z.object({
  steamId64: steamId64Schema,
  /** The in-game name at the time of the event, not the EZPug display name. */
  name: z.string().min(1),
  team: serverSlotSchema.optional(),
})
export type GameserverPlayer = z.infer<typeof gameserverPlayerSchema>

/** A map or series score, always in team order — never "winner first". */
export const teamScoreSchema = z.object({
  teamA: z.number().int().nonnegative(),
  teamB: z.number().int().nonnegative(),
})
export type TeamScore = z.infer<typeof teamScoreSchema>

/**
 * Why a round ended, normalized from provider reason codes (MatchZy sends
 * CounterStrikeSharp `RoundEndReason` integers; the adapter maps them).
 * `other` is the honest bucket for exotic reasons (surrender, game commencing
 * quirks) — an adapter never invents a condition and never crashes on one.
 */
export const roundWinConditionSchema = z.enum([
  'elimination',
  'bomb_exploded',
  'bomb_defused',
  'time_expired',
  'other',
])
export type RoundWinCondition = z.infer<typeof roundWinConditionSchema>

/** Who took a round: the team, and the side they were playing at the time. */
export const roundWinnerSchema = z.object({
  team: matchTeamSchema,
  side: teamSideSchema,
})
export type RoundWinner = z.infer<typeof roundWinnerSchema>

/**
 * One player's cumulative match stats as of a round end — the **event tier**
 * (Match.md §5): what the server reports live, good enough for the scoreboard
 * and the post-match screen, refined later by demo parsing (Stats.md), never
 * the other way around. Kills/deaths/assists/damage are the floor every source
 * can provide; the rest travels where available (MatchZy's round_end carries
 * all of it, a minimal source may not).
 */
export const playerRoundSummarySchema = z.object({
  player: gameserverPlayerSchema,
  kills: z.number().int().nonnegative(),
  deaths: z.number().int().nonnegative(),
  assists: z.number().int().nonnegative(),
  damage: z.number().int().nonnegative(),
  flashAssists: z.number().int().nonnegative().optional(),
  utilityDamage: z.number().int().nonnegative().optional(),
  enemiesFlashed: z.number().int().nonnegative().optional(),
  headshotKills: z.number().int().nonnegative().optional(),
  bombPlants: z.number().int().nonnegative().optional(),
  bombDefuses: z.number().int().nonnegative().optional(),
  mvps: z.number().int().nonnegative().optional(),
  /** The in-game score column, not anything of ours. */
  score: z.number().int().optional(),
})
export type PlayerRoundSummary = z.infer<typeof playerRoundSummarySchema>

/**
 * Every event carries the match it belongs to, who said it, and a sequence
 * hint where the source keeps one. Ingestion stamps arrival time itself —
 * gameserver clocks are not trusted for wall-clock facts, so no `occurredAt`
 * travels here (relative `roundTimeMs` does, because the server *is* the
 * authority on its own round clock).
 */
const eventBase = z.object({
  matchId: z.uuid(),
  source: gameserverSourceSchema,
  /** Monotonic per-match sequence hint, where the source provides one. */
  seq: z.number().int().nonnegative().optional(),
})

/** 1-based map number within the series (`1` for the whole of a Bo1). */
const mapScoped = eventBase.extend({
  mapNumber: z.number().int().positive(),
})

/** 1-based round number within the map. */
const roundScoped = mapScoped.extend({
  roundNumber: z.number().int().positive(),
})

/** Milliseconds into the round, from the server's own round clock. */
const roundTimeMs = z.number().int().nonnegative().optional()

// ---------------------------------------------------------------------------
// Server / plumbing
// ---------------------------------------------------------------------------

/** The server booted, loaded its match config, and accepts players. */
export const serverReadyEventSchema = eventBase.extend({
  type: z.literal('server_ready'),
  /** Engine map name currently loaded, where the source reports it. */
  map: z.string().min(1).optional(),
})

/** Periodic liveness. A gap in these opens Match.md §2's recovery window. */
export const heartbeatEventSchema = eventBase.extend({
  type: z.literal('heartbeat'),
  playerCount: z.number().int().nonnegative().optional(),
})

export const playerConnectedEventSchema = eventBase.extend({
  type: z.literal('player_connected'),
  player: gameserverPlayerSchema,
})

export const playerDisconnectedEventSchema = eventBase.extend({
  type: z.literal('player_disconnected'),
  player: gameserverPlayerSchema,
})

// ---------------------------------------------------------------------------
// Match flow
// ---------------------------------------------------------------------------

/** Knife/warmup is over — the map is live. */
export const goingLiveEventSchema = mapScoped.extend({
  type: z.literal('going_live'),
  /** Engine map name — the moment a map is definitively being played. */
  map: z.string().min(1),
})

export const roundStartEventSchema = roundScoped.extend({
  type: z.literal('round_start'),
  /** Score coming into the round, where the source reports it. */
  score: teamScoreSchema.optional(),
})

/**
 * The result of one round — fired when the result is in, not when play stops.
 * This is the score authority during `live`; `map_end` decides the recorded
 * map result (Match.md §2 result authority ladder).
 */
export const roundEndEventSchema = roundScoped.extend({
  type: z.literal('round_end'),
  winner: roundWinnerSchema,
  winCondition: roundWinConditionSchema,
  /** Map score *after* this round. */
  score: teamScoreSchema,
  /** Per-player cumulative summaries, where the source provides them. */
  players: z.array(playerRoundSummarySchema).optional(),
  roundTimeMs,
})

/** Halftime (or overtime half): the sides now in effect, per team. */
export const sideSwapEventSchema = mapScoped.extend({
  type: z.literal('side_swap'),
  sides: z.object({ teamA: teamSideSchema, teamB: teamSideSchema }),
})

/**
 * The recorded result of one map. `winner: null` is a drawn map — impossible
 * in a ranked context (overtime is always on, Queue.md §1), legal in the
 * contract because casual contexts may allow it.
 */
export const mapEndEventSchema = mapScoped.extend({
  type: z.literal('map_end'),
  map: z.string().min(1).optional(),
  score: teamScoreSchema,
  winner: matchTeamSchema.nullable(),
})

/** The recorded result of the series — maps won, in team order. */
export const seriesEndEventSchema = eventBase.extend({
  type: z.literal('series_end'),
  seriesScore: teamScoreSchema,
  winner: matchTeamSchema.nullable(),
})

/** Why the match is standing still. Named, because the live channel shows it. */
export const pauseKindSchema = z.enum(['tactical', 'technical', 'admin'])
export type PauseKind = z.infer<typeof pauseKindSchema>

/** Who asked for the pause, where the source knows. */
export const pauseSourceSchema = z.enum(['team_a', 'team_b', 'admin', 'server'])
export type PauseSource = z.infer<typeof pauseSourceSchema>

export const matchPausedEventSchema = mapScoped.extend({
  type: z.literal('match_paused'),
  kind: pauseKindSchema.optional(),
  /** Who asked for it, where the source knows. */
  pausedBy: pauseSourceSchema.optional(),
})

export const matchUnpausedEventSchema = mapScoped.extend({
  type: z.literal('match_unpaused'),
})

// ---------------------------------------------------------------------------
// Live gameplay (the EZPug plugin tier — first-class, Match.md §5)
// ---------------------------------------------------------------------------

/** One kill for the feed. `killer: null` is the world (fall, self). */
export const playerDeathEventSchema = roundScoped.extend({
  type: z.literal('player_death'),
  victim: gameserverPlayerSchema,
  killer: gameserverPlayerSchema.nullable(),
  assists: z.array(
    z.object({
      player: gameserverPlayerSchema,
      /** True for a flash assist rather than damage. */
      flash: z.boolean(),
    }),
  ),
  weapon: z.string().min(1),
  headshot: z.boolean(),
  /** Special-kill flags, present where the source reports them. */
  penetrated: z.boolean().optional(),
  noscope: z.boolean().optional(),
  throughSmoke: z.boolean().optional(),
  attackerBlind: z.boolean().optional(),
  roundTimeMs,
})

export const bombSiteSchema = z.enum(['a', 'b'])

export const bombPlantedEventSchema = roundScoped.extend({
  type: z.literal('bomb_planted'),
  player: gameserverPlayerSchema,
  site: bombSiteSchema.optional(),
  roundTimeMs,
})

export const bombDefusedEventSchema = roundScoped.extend({
  type: z.literal('bomb_defused'),
  player: gameserverPlayerSchema,
  site: bombSiteSchema.optional(),
  roundTimeMs,
})

export const bombExplodedEventSchema = roundScoped.extend({
  type: z.literal('bomb_exploded'),
  site: bombSiteSchema.optional(),
  roundTimeMs,
})

/**
 * Tick-sampled player positions at a low, configurable rate, for the live 2D
 * minimap. **Ephemeral** (Match.md §5 verbatim): live channel only, never
 * event-sourced — the demo is the authoritative movement record. Only living
 * players appear; deaths come from the kill feed, not from here.
 */
export const positionTickEventSchema = mapScoped.extend({
  type: z.literal('position_tick'),
  roundNumber: z.number().int().positive().optional(),
  positions: z.array(
    z.object({
      steamId64: steamId64Schema,
      /** Engine world units, as the map's radar metadata expects them. */
      x: z.number(),
      y: z.number(),
      z: z.number(),
      /** View direction in degrees, where sampled. */
      yaw: z.number().optional(),
    }),
  ),
})

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/** A MatchZy/Get5 round backup landed on disk — `server_lost` recovery fuel. */
export const backupWrittenEventSchema = mapScoped.extend({
  type: z.literal('backup_written'),
  /** The round this backup restores to (the next round to be played). */
  roundNumber: z.number().int().positive(),
  filename: z.string().min(1),
})

/**
 * The demo of a map is finished — the T7 storage trigger. The server owns the
 * upload (decision 10): where it has already put the file where the request's
 * `demoUploadUrl` said, it announces what it put there, and `sha256` is the
 * orchestrator's cue to relay a `demo.uploaded` fact. Without a hash the demo
 * exists and nothing has it but the server.
 */
export const demoAvailableEventSchema = mapScoped.extend({
  type: z.literal('demo_available'),
  filename: z.string().min(1),
  /** Where the provider exposes a direct fetch, the adapter passes it on. */
  url: z.url().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  /** Lowercase hex of the bytes the server uploaded; present only once they landed. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'expected a lowercase hex sha256')
    .optional(),
  /** What the server PUT it as; `application/octet-stream` for a `.dem`. */
  contentType: z.string().min(1).optional(),
})

// ---------------------------------------------------------------------------
// Ad-hoc
// ---------------------------------------------------------------------------

/**
 * A player-triggered in-server command we choose to expose (`.tech`, `.gg`).
 * `command` is normalized lowercase without the chat prefix; the raw remainder
 * of the line rides in `args`.
 */
export const chatCommandEventSchema = eventBase.extend({
  type: z.literal('chat_command'),
  player: gameserverPlayerSchema,
  command: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'expected the bare lowercase command, no chat prefix'),
  args: z.string().optional(),
})

/** Which window a line was said in: everybody's chat, or one team's. */
export const serverChatScopes = ['all', 'team'] as const
export const serverChatScopeSchema = z.enum(serverChatScopes)
export type ServerChatScope = (typeof serverChatScopes)[number]

/** The longest line a server may report. CS2's own is 127; a plugin may batch. */
export const SERVER_CHAT_TEXT_MAX = 512

/**
 * **A human said something in the server** (Match.md §5's ad-hoc tier, PRD-08
 * T8) — the other half of {@link chatCommandEventSchema}, and the platform's
 * inbound half of one conversation with two windows on it (Social.md §8): a
 * line typed in the server appears on the match page, a line typed on the page
 * is said in the server.
 *
 * Three decisions this shape fixes:
 *
 * - **A command is never a message.** A line that starts with a chat prefix is
 *   a `chat_command`; everything else is a `chat_message`, and the *adapter*
 *   decides which, once, with {@link parseServerChatLine}. No consumer ever
 *   sees a `!rehost` and has to know it was not conversation.
 * - **`text` is what was typed**, raw. Segments (mentions, links, emotes) are
 *   the chat parser's business on the way in, exactly as for a web line —
 *   there is one parser and it lives in `chat/segments.ts`.
 * - **Two identical lines are two events only where the source keeps a hint.**
 *   The dedup key is a hash of the whole event (Match.md §2), so a player who
 *   says "gg" twice is heard twice because `seq` (or `tick`) differs — and a
 *   source that provides neither collapses them, the same trade every other
 *   event in this union makes.
 */
export const chatMessageEventSchema = eventBase.extend({
  type: z.literal('chat_message'),
  player: gameserverPlayerSchema,
  /** Exactly as typed, after the prefix check — never a command. */
  text: z.string().min(1).max(SERVER_CHAT_TEXT_MAX),
  scope: serverChatScopeSchema,
  /** The server's own tick, where the source reports one. */
  tick: z.number().int().nonnegative().optional(),
})

/**
 * The prefixes CS2 chat treats as commands — MatchZy's own (`!`, `.`) plus
 * the console habit (`/`). A line beginning with one of these is never
 * conversation and is never bridged.
 */
export const SERVER_CHAT_COMMAND_PREFIXES = ['!', '.', '/'] as const

const BARE_COMMAND = /^[a-z0-9][a-z0-9_-]*$/

/**
 * **The split, decided once, at the edge** (PRD-08 T8): which of the two
 * ad-hoc events a raw server chat line becomes. Adapters call this — the
 * simulator, the MatchZy/plugin translator — and consumers never learn a
 * prefix existed.
 *
 * A prefix alone (`.`), a prefix followed by something that is not a command
 * name (`!!!`, `.42px?`) or an empty remainder is *conversation*: a player
 * typed characters at each other, and refusing to relay them because the first
 * one was a full stop would lose a real line.
 */
export function parseServerChatLine(
  raw: string,
): { kind: 'command'; command: string; args?: string } | { kind: 'message'; text: string } {
  const text = raw.trim()
  const prefix = SERVER_CHAT_COMMAND_PREFIXES.find(candidate => text.startsWith(candidate))
  if (prefix !== undefined) {
    const [word = '', ...rest] = text.slice(prefix.length).trim().split(/\s+/)
    const command = word.toLowerCase()
    if (BARE_COMMAND.test(command)) {
      const args = rest.join(' ')
      return { kind: 'command', command, ...(args.length > 0 ? { args } : {}) }
    }
  }
  return { kind: 'message', text }
}

/**
 * The escape hatch for EZPug-plugin extras (drop announcements, warmup DJ
 * facts). A `plugin_event` a consumer depends on is a candidate for promotion
 * into a first-class event — this exists so shipping one is not blocked on a
 * contracts round-trip, not so the union stops growing.
 */
export const pluginEventSchema = eventBase.extend({
  type: z.literal('plugin_event'),
  name: gameserverEventTypeSchema,
  data: z.record(z.string(), z.unknown()),
})

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

export const gameserverEventSchema = z.discriminatedUnion('type', [
  serverReadyEventSchema,
  heartbeatEventSchema,
  playerConnectedEventSchema,
  playerDisconnectedEventSchema,
  goingLiveEventSchema,
  roundStartEventSchema,
  roundEndEventSchema,
  sideSwapEventSchema,
  mapEndEventSchema,
  seriesEndEventSchema,
  matchPausedEventSchema,
  matchUnpausedEventSchema,
  playerDeathEventSchema,
  bombPlantedEventSchema,
  bombDefusedEventSchema,
  bombExplodedEventSchema,
  positionTickEventSchema,
  backupWrittenEventSchema,
  demoAvailableEventSchema,
  chatCommandEventSchema,
  chatMessageEventSchema,
  pluginEventSchema,
])
export type GameserverEvent = z.infer<typeof gameserverEventSchema>

/** Every event type, in Match.md §5's groups and order. */
export const GAMESERVER_EVENT_TYPES = [
  // server / plumbing
  'server_ready',
  'heartbeat',
  'player_connected',
  'player_disconnected',
  // match flow
  'going_live',
  'round_start',
  'round_end',
  'side_swap',
  'map_end',
  'series_end',
  'match_paused',
  'match_unpaused',
  // live gameplay (plugin tier)
  'player_death',
  'bomb_planted',
  'bomb_defused',
  'bomb_exploded',
  'position_tick',
  // artifacts
  'backup_written',
  'demo_available',
  // ad-hoc
  'chat_command',
  'chat_message',
  'plugin_event',
] as const
export type GameserverEventType = (typeof GAMESERVER_EVENT_TYPES)[number]

/** The event for one `type` — `GameserverEventOf<'round_end'>` etc. */
export type GameserverEventOf<T extends GameserverEventType> = Extract<GameserverEvent, { type: T }>

/**
 * The ephemeral tier (Match.md §5): delivered on the live channel, **never**
 * event-sourced and exempt from ingestion's dedup guarantees — losing one
 * costs a stale minimap frame, nothing else.
 */
export const EPHEMERAL_GAMESERVER_EVENT_TYPES = ['position_tick'] as const satisfies readonly [
  GameserverEventType,
  ...GameserverEventType[],
]

/** True when `type` must bypass the event log (the one switch T6 consults). */
export function isEphemeralGameserverEvent(type: GameserverEventType): boolean {
  return (EPHEMERAL_GAMESERVER_EVENT_TYPES as readonly string[]).includes(type)
}

// The T2 rule: a misnamed contract throws the moment its module loads. The
// union's option literals and the published list must be the same closed set,
// and every name must satisfy the grammar in `naming.ts`.
{
  const optionTypes = gameserverEventSchema.options.map(option => option.shape.type.value)
  for (const type of optionTypes) gameserverEventTypeSchema.parse(type)
  const published = new Set<string>(GAMESERVER_EVENT_TYPES)
  if (
    optionTypes.length !== GAMESERVER_EVENT_TYPES.length ||
    !optionTypes.every(type => published.has(type))
  ) {
    throw new Error(
      'gameserver contract: GAMESERVER_EVENT_TYPES and the union options disagree — ' +
        'the set is closed, update both together',
    )
  }
}
