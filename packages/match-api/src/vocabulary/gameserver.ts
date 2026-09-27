import { z } from 'zod'
import { engineGameSchema, matchFormatSchema } from './format'
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
  /**
   * **Present, and true, when the players are puppets** (PRD-03 T4): the
   * request carried `simulation`, so nobody on this server is a person and
   * nothing it says may count for a rating, a board or a drop. Stamped by the
   * orchestrator on every event of such a match, whatever the server said,
   * so a consumer reads one field and never a request. Absent on a real
   * match — and absent on a `sim`-provider match that did not ask for it,
   * whose players are the simulator's own inventions and whose `provider`
   * has always said so.
   */
  simulated: z.boolean().optional(),
})
export type GameserverSource = z.infer<typeof gameserverSourceSchema>

/** A match team as every gameserver event names one. */
export const matchTeamSchema = z.enum(['team_a', 'team_b'])
export type MatchTeam = z.infer<typeof matchTeamSchema>

/** A CS side. Only humans get to be `spec`; a round is never won by it. */
export const teamSideSchema = z.enum(['ct', 't'])
export type TeamSide = z.infer<typeof teamSideSchema>

/**
 * Where a body sits on the server. `team_a` and `team_b` are **the roster's
 * word**: a rostered player carries their team wherever they stand, and a
 * puppet is a rostered player. `unrostered` is a body the request never named
 * that is *playing* — on a side, scoring and dying: an open-join guest, a
 * plain bot filling a seat (PRD-03 T7). It belongs to neither team, so it
 * never counts towards one. `spec` is a body the request never named that is
 * on no side: a caster, somebody still choosing.
 */
export const serverSlotSchema = z.enum(['team_a', 'team_b', 'spec', 'unrostered'])
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
 *
 * **A tower round** (`rush`, PRD-06 T1) is won by whoever owns the room's
 * tower when it ends, and says which of three ways that happened:
 *
 * - `tower_held` — the round ran out and the side that held the tower as it
 *   began still owns it, alive or not (an owner wiped out while nobody
 *   presses the button in the short window still wins on the clock).
 * - `tower_captured` — the winner did not hold the tower as the round began:
 *   it pressed the button and kept it, to the clock or until the side it took
 *   the tower from was dead.
 * - `elimination` — the holders kept the tower and every attacker died (or
 *   both sides did, which the tower's owner wins too).
 *
 * The rule is the winner against {@link roundTowerSchema}'s `heldBy`, so a
 * source that follows the walk and the deaths can name it without reading
 * the map script's state.
 */
export const roundWinConditionSchema = z.enum([
  'elimination',
  'bomb_exploded',
  'bomb_defused',
  'time_expired',
  'tower_held',
  'tower_captured',
  'other',
])
export type RoundWinCondition = z.infer<typeof roundWinConditionSchema>

/**
 * **The rooms of Rush** (PRD-06 T1), as `maps/scripts/rush_001.vjs` numbers
 * them: the start rooms `101`–`104`, the mid rooms `201`–`212`, the castles
 * `301` (the CT end) and `401` (the T end), and `convoy`, the decider swapped
 * in at 7–7. A match draws one line of seven from these.
 */
export const RUSH_ROOM_IDS = [
  '101',
  '102',
  '103',
  '104',
  '201',
  '202',
  '203',
  '204',
  '205',
  '206',
  '207',
  '208',
  '209',
  '210',
  '211',
  '212',
  '301',
  '401',
  'convoy',
] as const
export const rushRoomIdSchema = z.enum(RUSH_ROOM_IDS)
export type RushRoomId = z.infer<typeof rushRoomIdSchema>

/** How many rooms a Rush line holds: a castle, two mid rooms, the start, two mid rooms, a castle. */
export const TOWER_LINE_LENGTH = 7

/**
 * **Where on the line of seven a room is**, 1-based and in side order: `1` is
 * the T castle, `4` the start room, `7` the CT castle. A T win moves play one
 * room up, a CT win one room down; winning in the enemy castle ends the match.
 * Sides are fixed for the whole map (`mp_halftime 0`), so the order never flips.
 */
const towerRoomSchema = z.object({
  room: z.number().int().min(1).max(TOWER_LINE_LENGTH),
  /** The arena the map put there, where the source knows it. */
  roomId: rushRoomIdSchema.optional(),
})

/**
 * **The tower of a round** (PRD-06 T1): the room it was played in and the side
 * that held the tower as the round began. The owner at the end is the
 * round's `winner`, always. `heldBy: null` is a room nobody owns, which only a
 * drawn round leaves behind; a drawn round replays the room and, having no
 * winner, is no `round_end`.
 */
export const roundTowerSchema = towerRoomSchema.extend({
  heldBy: teamSideSchema.nullable(),
})
export type RoundTower = z.infer<typeof roundTowerSchema>

/**
 * How a tower match ended: `castle` — a win inside the enemy castle, before
 * the rounds ran out; `rounds` — the rounds did (15, or 8 clinched), and the
 * map score decides.
 */
export const TOWER_MAP_ENDINGS = ['castle', 'rounds'] as const
export const towerMapEndingSchema = z.enum(TOWER_MAP_ENDINGS)
export type TowerMapEnding = z.infer<typeof towerMapEndingSchema>

/** **Where the line stood when a tower map ended** (PRD-06 T1): the last room played, and why it was the last. */
export const mapTowerSchema = towerRoomSchema.extend({
  ending: towerMapEndingSchema,
})
export type MapTower = z.infer<typeof mapTowerSchema>

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
  /**
   * The engine's name for the map it loaded, where the source reports it. For
   * a workshop map that is the map's own name and not the plan's
   * `workshop/<id>/<name>`; `going_live.map` is the plan's.
   */
  map: z.string().min(1).optional(),
  /**
   * The engine game this map loaded under (PRD-05 T2d), where the source
   * reads it. A wingman match under MatchZy says `server_ready` twice, and
   * only the second, after the map was loaded again, says `gameMode: 2`;
   * `going_live.engine` is the one to assert on.
   */
  engine: engineGameSchema.optional(),
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
// Ready-up (the warmup tier)
// ---------------------------------------------------------------------------

/**
 * How far the ready gate has got. `ready` is the ready player count per team,
 * in team order; `expected` is how many the server is waiting for in total
 * across both teams. Both are the **server's** arithmetic, not the client's:
 * whether a team passes the gate is a judgement the match plugin makes from
 * its own rules (who is connected, who is on which side, the configured
 * minimum), and a client that recomputed it would be reimplementing that
 * plugin — the thing decision 19 exists to prevent.
 */
export const readyTallySchema = z.object({
  ready: teamScoreSchema,
  expected: z.number().int().nonnegative(),
})
export type ReadyTally = z.infer<typeof readyTallySchema>

/** One player readied. The tally is the whole gate as of this moment. */
export const playerReadyEventSchema = eventBase.extend({
  type: z.literal('player_ready'),
  player: gameserverPlayerSchema,
  tally: readyTallySchema,
})

/** One player took their ready back. */
export const playerUnreadyEventSchema = eventBase.extend({
  type: z.literal('player_unready'),
  player: gameserverPlayerSchema,
  tally: readyTallySchema,
})

/** A whole team passed the server's ready gate. */
export const teamReadyEventSchema = eventBase.extend({
  type: z.literal('team_ready'),
  team: matchTeamSchema,
  tally: readyTallySchema,
})

/**
 * Both teams are ready and the server is starting. `countdown` is true when
 * the server is counting down rather than starting at once — the moment a
 * lobby stops offering a ready button. `going_live` still follows, after the
 * knife round where there is one.
 */
export const allReadyEventSchema = eventBase.extend({
  type: z.literal('all_ready'),
  ready: teamScoreSchema,
  countdown: z.boolean(),
})

// ---------------------------------------------------------------------------
// Match flow
// ---------------------------------------------------------------------------

/** The knife round began. Only a map whose sides are knifed for has one. */
export const knifeStartEventSchema = mapScoped.extend({
  type: z.literal('knife_start'),
})

/**
 * The knife round was decided. `winner` is who picks the side — `null` when
 * the server could not attribute it. The pick itself arrives as `side_swap`
 * when they swap, and as nothing at all when they stay.
 */
export const knifeEndEventSchema = mapScoped.extend({
  type: z.literal('knife_end'),
  winner: matchTeamSchema.nullable(),
})

/**
 * **What will end this map besides the game itself** (PRD-03 T9), as the
 * server enforces it: the mode's manifest `length`, in force. `durationSeconds`
 * is what a client counts down **from the arrival of this event** — seconds of
 * the client's own clock, so a simulated match's time scale is already taken
 * out of it — and `fragLimit` is what it counts a leader's kills up to. The
 * idle timeout is not here: nobody is watching a server that is empty.
 */
export const liveLengthSchema = z.object({
  durationSeconds: z.number().int().positive().optional(),
  fragLimit: z.number().int().positive().optional(),
})
export type LiveLength = z.infer<typeof liveLengthSchema>

/**
 * Why a map, and the series with it, ended when the game itself did not end
 * it (PRD-03 T9): the mode's `length` ran out. `time_limit` — its duration;
 * `frag_limit` — somebody reached its frag limit; `idle` — nobody was on the
 * server for its idle timeout, which may be before it ever went live.
 */
export const MATCH_END_REASONS = ['time_limit', 'frag_limit', 'idle'] as const
export const matchEndReasonSchema = z.enum(MATCH_END_REASONS)
export type MatchEndReason = z.infer<typeof matchEndReasonSchema>

/** Knife/warmup is over — the map is live. */
export const goingLiveEventSchema = mapScoped.extend({
  type: z.literal('going_live'),
  /**
   * The map as the plan named it (`MatchRequest.maps[mapNumber - 1].map`):
   * `de_mirage`, or `workshop/<id>/<name>` for a workshop map, never the
   * engine's own name for one. The moment a map is definitively being played.
   */
  map: z.string().min(1),
  /** Present when the mode's manifest gives the match a duration or a frag limit. */
  length: liveLengthSchema.optional(),
  /**
   * **The engine game the map is being played under** (PRD-05 T2d,
   * ezpug/ezpug-iron#4): `game_type` / `game_mode` as the server read them
   * when this map loaded. On a MatchZy flow, whose `going_live` reaches the
   * orchestrator over MatchZy's own log, the orchestrator copies it from
   * this server's last `server_ready` for the match. Absent where the source
   * never read it.
   */
  engine: engineGameSchema.optional(),
  /**
   * The format `engine` is (`formatOfEngineGame`): the engine's word,
   * not the request's, so a client proves the format it asked for by
   * comparing the two. Absent when `engine` is, or when it is a game with no
   * format (deathmatch).
   */
  format: matchFormatSchema.optional(),
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
  /** A tower round's room and who held it (`rush`, PRD-06 T1); absent on every other mode. */
  tower: roundTowerSchema.optional(),
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
  /** The map as the plan named it, like `going_live.map`, where the source says. */
  map: z.string().min(1).optional(),
  score: teamScoreSchema,
  winner: matchTeamSchema.nullable(),
  /** Present when the mode's `length` ended the map; absent when the game did. */
  reason: matchEndReasonSchema.optional(),
  /** Where a tower map's line stood at the end, and whether a castle ended it (`rush`, PRD-06 T1). */
  tower: mapTowerSchema.optional(),
})

/**
 * The recorded result of the series — maps won, in team order. `winner` is
 * `null` for a drawn series and **always** for a one-team mode
 * (`slots.teams: 1`): a free-for-all has no team to have won it.
 */
export const seriesEndEventSchema = eventBase.extend({
  type: z.literal('series_end'),
  seriesScore: teamScoreSchema,
  winner: matchTeamSchema.nullable(),
  /** Present when the mode's `length` ended the series; absent when the game did. */
  reason: matchEndReasonSchema.optional(),
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
 * What a thrown grenade is. The same six names as the platform's replay
 * artifact (`grenadeKindSchema` there), so the live radar and the replay draw
 * utility the same way. `incendiary` is the CT's fire, `molotov` the T's.
 */
export const grenadeKindSchema = z.enum(['he', 'flash', 'smoke', 'molotov', 'incendiary', 'decoy'])
export type GrenadeKind = z.infer<typeof grenadeKindSchema>

/**
 * **One grenade in a {@link positionTickEventSchema}** (ezpug/ezpug-iron#5).
 * `flying` while it is in the air. `active` while it occupies space: a smoke
 * from its bloom to its expiry, a fire from its first flame to its last. A flash,
 * an HE and a decoy are `active` in one tick only, at the place they went off.
 * After that the grenade is simply absent from the next tick.
 */
export const liveGrenadeSchema = z.object({
  /** Stable for the grenade's life and unique within the map, so a renderer can follow it. */
  id: z.string().min(1).max(64),
  kind: grenadeKindSchema,
  /** Engine world units, like the positions beside it. For a fire, the centre of its flames. */
  x: z.number(),
  y: z.number(),
  z: z.number(),
  state: z.enum(['flying', 'active']),
  /** For an active smoke or fire: how far it reaches, in world units, where the source knows. */
  radius: z.number().positive().optional(),
  /** Who threw it, where the source knows. */
  steamId64: steamId64Schema.optional(),
})
export type LiveGrenade = z.infer<typeof liveGrenadeSchema>

/**
 * **The bomb in a {@link positionTickEventSchema}.** `carried` names the carrier
 * and sits where they stand; `dropped` lies where it fell; `planted` names its
 * site where the source knows it. Absent while there is no bomb in play: a mode
 * without one, before the round hands it out, and once it has exploded or been
 * defused (`bomb_exploded` and `bomb_defused` say which).
 */
export const liveBombSchema = z.object({
  state: z.enum(['carried', 'dropped', 'planted']),
  /** Engine world units, like the positions beside it. */
  x: z.number(),
  y: z.number(),
  z: z.number(),
  /** The carrier, while `carried`. */
  steamId64: steamId64Schema.optional(),
  /** The site, once `planted`, where the source knows it. */
  site: bombSiteSchema.optional(),
})
export type LiveBomb = z.infer<typeof liveBombSchema>

/**
 * Tick-sampled player positions at a low, configurable rate, for the live 2D
 * minimap. **Ephemeral** (Match.md §5 verbatim): live channel only, never
 * event-sourced — the demo is the authoritative movement record. Only living
 * players appear; deaths come from the kill feed, not from here.
 *
 * `grenades` and `bomb` are the utility layer beside them (0.26.0,
 * ezpug/ezpug-iron#5): every grenade flying or active at that instant, and
 * where the bomb is. Both are optional. A source that samples utility sends
 * `grenades` on every tick, empty when nothing is in the air, so a missing
 * `grenades` means "not sampled" and the client draws no utility layer. A
 * missing `bomb` beside a present `grenades` means no bomb is in play.
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
  grenades: z.array(liveGrenadeSchema).optional(),
  bomb: liveBombSchema.optional(),
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
  playerReadyEventSchema,
  playerUnreadyEventSchema,
  teamReadyEventSchema,
  allReadyEventSchema,
  knifeStartEventSchema,
  knifeEndEventSchema,
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
  // ready-up (the warmup tier)
  'player_ready',
  'player_unready',
  'team_ready',
  'all_ready',
  // match flow
  'knife_start',
  'knife_end',
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
