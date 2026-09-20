import type {
  GameserverEvent,
  GameserverPlayer,
  GameserverSource,
  MapPlan,
  MatchTeam,
  PlayerRoundSummary,
  RoundWinCondition,
  TeamScore,
  TeamSide,
} from '@ezpug/match-api'
import { steamId64Schema } from '@ezpug/match-api'
import { z } from 'zod'

/**
 * **MatchZy, translated once** (decision 19, PRD-02 T9). MatchZy 0.8.15 has
 * no in-process forwards — `documentation/docs/events_and_forwards.md` is
 * the HTTP remote log and nothing else — so every match-flow fact it knows
 * (`series_start`, `going_live`, `round_end`, `map_result`, `series_end`, the
 * three veto picks, `demo_upload_ended`, `player_disconnect`) arrives here as
 * one POST per event, with no retry and no dedup on its side, and leaves as
 * the vocabulary. Pure: the door (`door.ts`) resolves the server, the match
 * and the state, this file decides what a payload means.
 *
 * What is decided here, against `references/MatchZy/` at 0.8.15 rather than
 * its `event_schema.yml` where the two disagree — the recorded fixtures
 * (T13) are the arbiter and replace the schema-sourced ones beside this file:
 *
 * - **The round winner is the score delta, never MatchZy's `winner.team`.**
 *   `Utility.cs` `HandlePostRoundEndEvent` fills `winner.team` with whichever
 *   team *leads the map* (`t1score > t2score ? "team1" : "team2"`), not who
 *   took the round. The team whose score rose by one since the last round
 *   we saw is the winner; when that is ambiguous (a lost POST, a restart)
 *   the side that won and the sides the map plan started with decide, and
 *   only then MatchZy's own field — each fallback is said in the log.
 * - **`winner.side` is an engine team number in a string.** The schema says
 *   `ct`/`t`; the code writes `@event.Winner.ToString()` — `"3"` for CT,
 *   `"2"` for T. Both spellings are read.
 * - **Round numbers come from the score, not `round_number`.** The schema
 *   says rounds start at 0; the code sends `t1score + t2score` computed after
 *   the round, which is already 1-based for the round that just ended. The
 *   sum of the two scores in the payload is the same number either way, and
 *   is what the vocabulary's 1-based `roundNumber` wants.
 * - **A `round_end` whose score did not move is a repeat.** MatchZy sends
 *   two payloads for one round often enough that the recorded match caught
 *   it (round 1, a second apart, two different `reason`s); the second is
 *   dropped, because a durable log that holds round 1 twice is a log a
 *   client cannot count with.
 * - **A drawn map is `winner: null`**, whatever MatchZy says: `map_result`
 *   and `series_end` name team2 the winner of a tie (`t1score > t2score`).
 *   The scores decide, and a tie is a tie.
 * - **Map numbers are 0-based on the wire and 1-based in the vocabulary;**
 *   the map's name is the request's plan, because MatchZy's events never
 *   carry it.
 * - **Dropped, on purpose:** every name in {@link MATCHZY_DROPPED_EVENTS},
 *   each with its own reason, and any event naming another `matchid` than
 *   the match this server holds.
 *
 * **MatchZy-Enhanced 1.4.32** (PRD-03 T2) sends twenty-six names stock 0.8.15
 * never had, and PRD-03 T3 gave each of them one of three answers. The rule
 * is decision 19's: *neither double-speaks the other's events*, and the
 * arbiter is what a `pug` on the dev node actually put on the wire
 * (`packages/protocol/fixtures/recorded/real-pug-matchzy.json`, re-recorded
 * on the fork) beside what the core plugin put on the link
 * (`real-pug-link.json`) in the same match.
 *
 * - **Vocabulary**, because nobody else says it: the ready gate
 *   (`player_ready`, `player_unready`, `team_ready`, `all_players_ready` →
 *   `all_ready`) and the knife (`knife_round_started`, `knife_round_ended`).
 *   A client must not recompute the gate — whether a team has passed it is
 *   the match plugin's own judgement, which is the whole lesson of the
 *   2026-09-18 stall (T1). **A team says it once, and only when its own
 *   roster is through**: the fork re-checks the gate after every single ready
 *   and POSTs a `team_ready` for each team still through it, twice over and
 *   from one player ready upwards — 44 of them, four `all_players_ready` and
 *   eleven `player_ready` in the recorded pug of ten puppets (T5), for two
 *   teams that passed the gate once and ten puppets who readied once.
 *   {@link MatchZyState.ready} is the memory that makes the log facts rather
 *   than polls.
 * - **`round_started` too, and this was a hole.** `MatchZyFlow` (the core
 *   plugin) emits `match_paused`, `side_swap` and `backup_written` for a
 *   matchzy flow and deliberately nothing else; `GenericFlow` — the plugin
 *   flows — is the only thing that ever emitted `round_start`. The recorded
 *   `pug` proves it: five `round_started` from MatchZy, not one `round_start`
 *   on the link. A MatchZy match has had no round start in its durable log
 *   until now.
 * - **Already said by the core plugin, so dropped:** `player_connect` and
 *   `player_disconnect` (the plugin reads the engine), `side_swap`,
 *   `match_paused` / `match_unpaused` and the two `*_requested` events
 *   (`MatchZyFlow` polls the gamerules and knows *who* paused and why).
 * - **Internal to the orchestrator**, read for the log and never turned into
 *   a fact: `server_configured`, `server_health` (a `db_ok: false` or a
 *   `db_type` that is not sqlite is a warning — T2's cfg check says the
 *   multi-server database stays off), `test_event` and `cs2_update_required`
 *   (the auto-updater is off; one of these arriving means the image is due a
 *   rebuild, which is a human's job, not a match fact).
 * - **`warmup_ended` is not vocabulary**, though T3 listed it as a candidate.
 *   The fork sends it from exactly two places (`Utility.cs` `StartKnifeRound`
 *   and `StartLive`), and in both it is immediately followed by the event
 *   that says the same thing better — `knife_round_started` on a knifed map,
 *   `going_live` on every other. Two facts a millisecond apart for one moment
 *   is what the durable log must not hold.
 * - **Nor is `halftime_started` or `overtime_started`:** `side_swap` says the
 *   first and the round numbers say the second. Nor `demo_recording_start` /
 *   `_stop` or the four `demo_upload_*`, because the core plugin owns the
 *   demo (decision 10) and MatchZy's own upload URL is never set. Nor
 *   `backup_loaded`: the restore has no vocabulary yet, and inventing one
 *   here would be a contract the plugin's `backup_written` does not match.
 */

/** What a MatchZy payload needs from the match it is about. */
export interface MatchZyContext {
  matchId: string
  source: GameserverSource
  /** `matchzySerial(matchId)` — what the config told MatchZy the match is called. */
  serial: number
  /** The request's map plan, in order: the names MatchZy's events lack, and the starting sides. */
  maps: readonly MapPlan[]
  /**
   * The request's two rosters, as the config named them. A ready event says
   * which team a player is on with a **team name** — the request's own free
   * string, which two teams may well share — so the SteamID against the
   * roster decides first and the name is only the fallback.
   */
  teams: {
    teamA: MatchZyTeamContext
    teamB: MatchZyTeamContext
  }
}

export interface MatchZyTeamContext {
  /** `teams.teamX.name` from the request, which is what MatchZy prints and echoes. */
  name: string
  /** Every rostered SteamID64 on this team. */
  players: readonly string[]
}

/** What the translator remembers between one round and the next: the last score it saw, per map. */
export interface MatchZyState {
  /** The map score after the last `round_end`, keyed by 1-based map number. */
  scores: Record<number, { team1: number; team2: number }>
  /**
   * The last `round_started` reported, keyed by 1-based map number. The
   * engine restarts the round two or three times at go-live and MatchZy
   * forwards every one of them (the recorded `pug` has three identical
   * round 1 payloads), so an exact repeat of the round number *and* the
   * score is dropped. A backup restore moves the score, so it still passes.
   */
  starts: Record<number, { roundNumber: number; team1: number; team2: number }>
  /**
   * **What the ready gate has already said** (PRD-03 T5): `team_a`, `team_b`
   * and `all` for the gate itself, `p:<steamId64>` for where one person
   * stands.
   *
   * MatchZy-Enhanced re-checks the gate after every single ready and POSTs a
   * `team_ready` for *each* team that holds it — twice, from two call sites,
   * and with a fresh `total_ready` every time because the other team is still
   * readying up. Its reconcile pass re-readies a slot whose bot was remapped.
   * The four puppet pugs measured on the dev node sent 42 to 46 `team_ready`,
   * two to four `all_players_ready`, and ten to twelve `player_ready` — for
   * two teams that passed the gate once and ten puppets who readied once.
   *
   * A durable log holds facts and not polls: a team already through the gate
   * says nothing more until it leaves, a player already ready says nothing
   * more until they unready, and an `all_ready` repeating counts already said
   * says nothing. The counts as they move are `player_ready`'s, which carries
   * the whole tally on every single ready.
   *
   * An **unready is news**, and it takes its own team and `all` back out with
   * it: a team that fell out of the gate and came back through it is a fact a
   * client drawing a lobby has to see. **Going live spends the gate**, so a
   * map that runs one of its own starts from nothing.
   */
  ready: Record<string, string>
}

export function initialMatchZyState(): MatchZyState {
  return { scores: {}, starts: {}, ready: {} }
}

export interface TranslationResult {
  /** The vocabulary events this payload became, in order; empty when it was dropped. */
  events: GameserverEvent[]
  state: MatchZyState
  /** The MatchZy event name, for the log. */
  name: string
  /** Why nothing came out, when nothing did. */
  dropped?: string
  /** A fallback that was taken, worth a log line. */
  note?: string
}

// ---------------------------------------------------------------------------
// The payloads, as leniently as MatchZy writes them
// ---------------------------------------------------------------------------

const teamNameSchema = z.string()
const winnerSchema = z.object({ side: z.string().nullable(), team: z.string().nullable() })

const statsSchema = z
  .object({
    kills: z.number().int().nonnegative(),
    deaths: z.number().int().nonnegative(),
    assists: z.number().int().nonnegative(),
    damage: z.number().int().nonnegative(),
    flash_assists: z.number().int().nonnegative().optional(),
    utility_damage: z.number().int().nonnegative().optional(),
    enemies_flashed: z.number().int().nonnegative().optional(),
    headshot_kills: z.number().int().nonnegative().optional(),
    bomb_plants: z.number().int().nonnegative().optional(),
    bomb_defuses: z.number().int().nonnegative().optional(),
    mvp: z.number().int().nonnegative().optional(),
    score: z.number().int().optional(),
  })
  .loose()

const statsPlayerSchema = z
  .object({ steamid: z.string(), name: z.string(), stats: statsSchema })
  .loose()

const statsTeamSchema = z
  .object({
    id: z.string().nullable().optional(),
    name: teamNameSchema,
    series_score: z.number().int().nonnegative().optional(),
    score: z.number().int().nonnegative(),
    players: z.array(statsPlayerSchema).optional(),
  })
  .loose()

const base = z.object({ event: z.string(), matchid: z.coerce.number().int() })

const goingLiveSchema = base.extend({
  event: z.literal('going_live'),
  map_number: z.number().int().nonnegative(),
})

const roundEndSchema = base.extend({
  event: z.literal('round_end'),
  map_number: z.number().int().nonnegative(),
  round_number: z.number().int().nonnegative().optional(),
  round_time: z.number().int().nonnegative().optional(),
  reason: z.number().int(),
  winner: winnerSchema,
  team1: statsTeamSchema,
  team2: statsTeamSchema,
})

const mapResultSchema = base.extend({
  event: z.literal('map_result'),
  map_number: z.number().int().nonnegative(),
  winner: winnerSchema,
  team1: statsTeamSchema,
  team2: statsTeamSchema,
})

const seriesEndSchema = base.extend({
  event: z.literal('series_end'),
  winner: winnerSchema,
  team1_series_score: z.number().int().nonnegative(),
  team2_series_score: z.number().int().nonnegative(),
  time_until_restore: z.number().int().optional(),
})

const matchzyPlayerSchema = z
  .object({ steamid: z.string(), name: z.string(), team: z.string().nullish() })
  .loose()

/** The four counters every ready event carries. `expected_total` is `players_per_team × 2`. */
const readyCounts = {
  ready_count_team1: z.number().int().nonnegative(),
  ready_count_team2: z.number().int().nonnegative(),
  total_ready: z.number().int().nonnegative(),
  expected_total: z.number().int().nonnegative(),
}

const playerReadySchema = base.extend({
  event: z.literal('player_ready'),
  player: matchzyPlayerSchema,
  team: z.string().nullish(),
  ...readyCounts,
})

const playerUnreadySchema = base.extend({
  event: z.literal('player_unready'),
  player: matchzyPlayerSchema,
  team: z.string().nullish(),
  ...readyCounts,
})

const teamReadySchema = base.extend({
  event: z.literal('team_ready'),
  /** `team1` or `team2` here, unlike the player events' free team name. */
  team: z.string(),
  ready_count: z.number().int().nonnegative(),
  total_ready: z.number().int().nonnegative(),
  expected_total: z.number().int().nonnegative(),
})

const allPlayersReadySchema = base.extend({
  event: z.literal('all_players_ready'),
  ready_count_team1: z.number().int().nonnegative(),
  ready_count_team2: z.number().int().nonnegative(),
  total_ready: z.number().int().nonnegative(),
  countdown_started: z.boolean(),
})

const knifeRoundStartedSchema = base.extend({
  event: z.literal('knife_round_started'),
  map_number: z.number().int().nonnegative(),
})

const knifeRoundEndedSchema = base.extend({
  event: z.literal('knife_round_ended'),
  map_number: z.number().int().nonnegative(),
  /** `team1`, `team2` or `none` when the sides were unreadable. */
  winner: z.string(),
})

const roundStartedSchema = base.extend({
  event: z.literal('round_started'),
  map_number: z.number().int().nonnegative(),
  round_number: z.number().int().positive(),
  team1_score: z.number().int().nonnegative(),
  team2_score: z.number().int().nonnegative(),
})

/**
 * Everything MatchZy-Enhanced sends that becomes nothing of ours, and why —
 * the reason is what the door logs and what a fixture pins, so a name moving
 * from this table into the union is a diff a reader can argue with (PRD-03
 * T3). Every name here was weighed against the recorded `pug`; the doc block
 * at the top of this file carries the argument.
 */
export const MATCHZY_DROPPED_EVENTS: Readonly<Record<string, string>> = {
  // Nothing of ours to say.
  series_start: 'not a fact of ours: server_ready and going_live bracket it',
  map_picked: 'the platform runs the veto',
  map_vetoed: 'the platform runs the veto',
  side_picked: 'the platform runs the veto',
  halftime_started: 'side_swap says it, and the core plugin owns side_swap',
  overtime_started: 'the round numbers say it',
  backup_loaded:
    'a restore has no vocabulary yet; backup_written is the plugin’s and means the other direction',
  // The core plugin already says it; decision 19 — neither double-speaks.
  player_connect: 'the core plugin emits player_connected from the engine',
  player_disconnect: 'the core plugin emits player_disconnected from the engine',
  side_swap: 'the core plugin’s MatchZyFlow emits side_swap from the gamerules',
  match_paused: 'the core plugin’s MatchZyFlow emits match_paused, and knows who paused',
  match_unpaused: 'the core plugin’s MatchZyFlow emits match_unpaused',
  pause_requested: 'the core plugin reports a pause when it is requested',
  unpause_requested: 'the core plugin reports the unpause itself',
  // Said better by the event that follows it in the same breath.
  warmup_ended: 'knife_round_started or going_live follows it at once and says it better',
  // The core plugin owns the demo (decision 10); MatchZy’s upload URL is never set.
  demo_recording_start: 'the core plugin owns the demo (decision 10)',
  demo_recording_stop: 'the core plugin owns the demo (decision 10)',
  demo_upload_ended:
    'the core plugin owns the upload (decision 10); MatchZy’s upload URL is never set',
  demo_upload_start:
    'the core plugin owns the upload (decision 10); MatchZy’s upload URL is never set',
  demo_upload_success:
    'the core plugin owns the upload (decision 10); MatchZy’s upload URL is never set',
  demo_upload_fail:
    'the core plugin owns the upload (decision 10); MatchZy’s upload URL is never set',
}

/**
 * Names the door reads for its log and never turns into a fact. They are
 * about the server, not about a match, and the fleet already has a shape for
 * every one of them. {@link internalNoteOf} is what gets logged.
 */
export const MATCHZY_INTERNAL_EVENTS = [
  'server_configured',
  'server_health',
  'test_event',
  'cs2_update_required',
] as const

/** The names this translator knows, translated, internal or dropped. */
export const MATCHZY_KNOWN_EVENTS = [
  'going_live',
  'round_started',
  'round_end',
  'map_result',
  'series_end',
  'player_ready',
  'player_unready',
  'team_ready',
  'all_players_ready',
  'knife_round_started',
  'knife_round_ended',
  ...MATCHZY_INTERNAL_EVENTS,
  ...Object.keys(MATCHZY_DROPPED_EVENTS),
] as const

const matchzyPayloadSchema = z.discriminatedUnion('event', [
  goingLiveSchema,
  roundStartedSchema,
  roundEndSchema,
  mapResultSchema,
  seriesEndSchema,
  playerReadySchema,
  playerUnreadySchema,
  teamReadySchema,
  allPlayersReadySchema,
  knifeRoundStartedSchema,
  knifeRoundEndedSchema,
])

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * CounterStrikeSharp's `RoundEndReason` (the integers MatchZy forwards) onto
 * the vocabulary's five. `other` is the honest bucket, never a guess.
 */
export function winConditionOf(reason: number): RoundWinCondition {
  switch (reason) {
    case 1: // TargetBombed
      return 'bomb_exploded'
    case 7: // BombDefused
      return 'bomb_defused'
    case 8: // CTsWin
    case 9: // TerroristsWin
      return 'elimination'
    case 12: // TargetSaved — the clock ran out with the bomb unplanted
      return 'time_expired'
    default:
      return 'other'
  }
}

/** `ct`/`t` as the schema says, or the engine team number 0.8.15 actually writes. */
export function sideOf(side: string | null | undefined): TeamSide | null {
  switch ((side ?? '').trim().toLowerCase()) {
    case 'ct':
    case '3':
    case 'counterterrorist':
      return 'ct'
    case 't':
    case '2':
    case 'terrorist':
      return 't'
    default:
      return null
  }
}

/** `team1`/`team2` onto `team_a`/`team_b`; anything else (`"none"`, `null`) is nobody. */
export function teamOf(team: string | null | undefined): MatchTeam | null {
  switch ((team ?? '').trim().toLowerCase()) {
    case 'team1':
      return 'team_a'
    case 'team2':
      return 'team_b'
    default:
      return null
  }
}

/**
 * The side team A plays in round `roundNumber` of a map it started on
 * `start`: the second half of regulation swaps, overtime opens on the side
 * regulation ended on, and every overtime half swaps again. A guess the
 * schedule makes — a knife round or a `.switch` can move the teams — used
 * only as a fallback, and said in the log when it is.
 */
export function scheduledSide(
  start: TeamSide,
  roundNumber: number,
  regulation: number,
  overtime: number,
): TeamSide {
  const flip = (side: TeamSide): TeamSide => (side === 'ct' ? 't' : 'ct')
  if (roundNumber <= regulation / 2) return start
  if (roundNumber <= regulation) return flip(start)
  const into = roundNumber - regulation - 1
  const period = Math.floor(into / overtime)
  const inPeriod = into % overtime
  // Overtime begins on the side regulation's second half ended on; each half of it swaps.
  let side = flip(start)
  if (period % 2 === 1) side = flip(side)
  if (inPeriod >= overtime / 2) side = flip(side)
  return side
}

function scoreOf(team1: number, team2: number): TeamScore {
  return { teamA: team1, teamB: team2 }
}

/**
 * Which team a body belongs to. The roster decides — a SteamID the request
 * named is the one thing MatchZy cannot get wrong — and only then the team
 * label the payload carries, which is `team1`/`team2` on a `team_ready` and
 * the request's own free team name on a player event. Two teams sharing a
 * name resolve to nobody rather than to a guess.
 */
export function playerTeamOf(
  context: MatchZyContext,
  steamId64: string,
  label: string | null | undefined,
): MatchTeam | null {
  if (context.teams.teamA.players.includes(steamId64)) return 'team_a'
  if (context.teams.teamB.players.includes(steamId64)) return 'team_b'
  const slot = teamOf(label)
  if (slot) return slot
  const name = (label ?? '').trim()
  if (name.length === 0) return null
  const a = name === context.teams.teamA.name
  const b = name === context.teams.teamB.name
  return a && !b ? 'team_a' : b && !a ? 'team_b' : null
}

/** A player as the vocabulary wants one, or `null` when MatchZy named no real SteamID. */
function playerOf(
  context: MatchZyContext,
  player: { steamid: string; name: string; team?: string | null },
  label: string | null | undefined,
): GameserverPlayer | null {
  if (!steamId64Schema.safeParse(player.steamid).success) return null
  if (player.name.length === 0) return null
  const team = playerTeamOf(context, player.steamid, label ?? player.team)
  return { steamId64: player.steamid, name: player.name, ...(team && { team }) }
}

function summaries(
  team1: z.infer<typeof statsTeamSchema>,
  team2: z.infer<typeof statsTeamSchema>,
): PlayerRoundSummary[] | undefined {
  const players: PlayerRoundSummary[] = []
  for (const [team, stats] of [
    ['team_a', team1],
    ['team_b', team2],
  ] as const) {
    for (const entry of stats.players ?? []) {
      if (!steamId64Schema.safeParse(entry.steamid).success || entry.name.length === 0) continue
      const s = entry.stats
      players.push({
        player: { steamId64: entry.steamid, name: entry.name, team },
        kills: s.kills,
        deaths: s.deaths,
        assists: s.assists,
        damage: s.damage,
        ...(s.flash_assists !== undefined && { flashAssists: s.flash_assists }),
        ...(s.utility_damage !== undefined && { utilityDamage: s.utility_damage }),
        ...(s.enemies_flashed !== undefined && { enemiesFlashed: s.enemies_flashed }),
        ...(s.headshot_kills !== undefined && { headshotKills: s.headshot_kills }),
        ...(s.bomb_plants !== undefined && { bombPlants: s.bomb_plants }),
        ...(s.bomb_defuses !== undefined && { bombDefuses: s.bomb_defuses }),
        ...(s.mvp !== undefined && { mvps: s.mvp }),
        ...(s.score !== undefined && { score: s.score }),
      })
    }
  }
  return players.length > 0 ? players : undefined
}

/**
 * What the door logs for a server-level event. Never a fact: these say
 * something about the box, and the fleet has its own shapes for that. Two of
 * them are worth a warning rather than a line, because T2's cfg check exists
 * to make them impossible: a database that is not the local SQLite means the
 * multi-server database came on, and a CS2 update notice means the
 * auto-updater did.
 */
export function internalNoteOf(name: string, payload: unknown): { dropped: string; note?: string } {
  const body = (payload ?? {}) as Record<string, unknown>
  const said = (detail: string) => `server-level, not a match fact: ${detail}`
  switch (name) {
    case 'server_health': {
      const type = typeof body.db_type === 'string' ? body.db_type : 'unknown'
      const ok = body.db_ok === true
      const why = typeof body.reason === 'string' ? body.reason : 'unstated'
      if (ok && type === 'sqlite') return { dropped: said(`health (${why}), database ${type} ok`) }
      const detail = ok
        ? 'ok'
        : `failing — ${typeof body.db_error === 'string' ? body.db_error : 'no detail'}`
      return {
        dropped: said(`health (${why}), database ${type} ${detail}`),
        note: `MatchZy reports its database as ${type}, ${detail}; the image ships SQLite and the multi-server database is meant to be off (docker/cs2/matchzy-cfg-check.sh)`,
      }
    }
    case 'server_configured':
      return {
        dropped: said(
          `MatchZy ${typeof body.plugin_version === 'string' ? body.plugin_version : 'of an unstated version'} configured its remote log`,
        ),
      }
    case 'cs2_update_required':
      return {
        dropped: said('MatchZy reports a CS2 update'),
        note: 'MatchZy reports that CS2 needs updating; the auto-updater is off on purpose, so the image is due a rebuild — a human’s job, not a match fact',
      }
    default:
      return { dropped: said(name) }
  }
}

export interface TranslateOptions {
  /** `mp_maxrounds`, for the side schedule fallback. Default 24. */
  regulationRounds?: number
  /** `mp_overtime_maxrounds`, for the side schedule fallback. Default 6. */
  overtimeRounds?: number
}

/**
 * One MatchZy payload in, the vocabulary out. Never throws on a payload:
 * an unreadable one is `dropped` with the reason, and so is one about a
 * match this server does not hold.
 */
export function translateMatchZyEvent(
  payload: unknown,
  context: MatchZyContext,
  state: MatchZyState,
  options: TranslateOptions = {},
): TranslationResult {
  const name =
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { event?: unknown }).event === 'string'
      ? (payload as { event: string }).event
      : '?'
  const drop = (dropped: string): TranslationResult => ({ events: [], state, name, dropped })

  if (name === '?') return drop('no event name')
  const reason = MATCHZY_DROPPED_EVENTS[name]
  if (reason !== undefined) return drop(reason)
  if ((MATCHZY_INTERNAL_EVENTS as readonly string[]).includes(name)) {
    return { events: [], state, name, ...internalNoteOf(name, payload) }
  }
  const parsed = matchzyPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    return (MATCHZY_KNOWN_EVENTS as readonly string[]).includes(name)
      ? drop(`does not parse: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
      : drop('an event this translator does not know')
  }
  const event = parsed.data
  if (event.matchid !== context.serial) {
    return drop(`names matchid ${event.matchid}, this server holds ${context.serial}`)
  }
  const { matchId, source } = context
  const mapAt = (index: number): MapPlan | undefined => context.maps[index]

  switch (event.event) {
    case 'going_live': {
      const plan = mapAt(event.map_number)
      if (!plan) return drop(`map_number ${event.map_number} is outside the plan`)
      return {
        events: [
          { type: 'going_live', matchId, source, mapNumber: event.map_number + 1, map: plan.map },
        ],
        // The gate is behind this map: whatever it said is spent, and a map
        // that runs its own ready phase gets a fresh one
        // ({@link MatchZyState.ready}).
        state: { ...state, ready: {} },
        name,
      }
    }
    case 'round_started': {
      const plan = mapAt(event.map_number)
      if (!plan) return drop(`map_number ${event.map_number} is outside the plan`)
      const mapNumber = event.map_number + 1
      const score = scoreOf(event.team1_score, event.team2_score)
      const last = state.starts[mapNumber]
      // The engine restarts the round two or three times at go-live and
      // MatchZy forwards each one: the recorded `pug` opens with three
      // identical round 1 payloads. The same round number at the same score
      // is one of those, and the durable log must not hold round 1 thrice.
      if (
        last &&
        last.roundNumber === event.round_number &&
        last.team1 === score.teamA &&
        last.team2 === score.teamB
      )
        return drop(`round ${event.round_number} already started at ${score.teamA}–${score.teamB}`)
      return {
        events: [
          {
            type: 'round_start',
            matchId,
            source,
            mapNumber,
            roundNumber: event.round_number,
            score,
          },
        ],
        state: {
          ...state,
          starts: {
            ...state.starts,
            [mapNumber]: {
              roundNumber: event.round_number,
              team1: score.teamA,
              team2: score.teamB,
            },
          },
        },
        name,
      }
    }
    case 'player_ready':
    case 'player_unready': {
      const player = playerOf(context, event.player, event.team)
      if (!player)
        return drop(
          `a ready from "${event.player.name}" with no SteamID64 — a bot outside simulation mode`,
        )
      // **Where this person stands, said once.** The fork's reconcile pass
      // re-readies a slot whose bot was remapped — the recorded puppet pug had
      // eleven `player_ready` for ten puppets, `puppet-7` among those twice
      // (T5, measured) — and a durable log that holds a player readying
      // twice without unreadying in between is one a client cannot count with.
      const stands = `p:${player.steamId64}`
      const now = event.event === 'player_ready' ? 'ready' : 'unready'
      if (state.ready[stands] === now) return drop(`${player.name} was already ${now}`)
      return {
        events: [
          {
            type: event.event === 'player_ready' ? 'player_ready' : 'player_unready',
            matchId,
            source,
            player,
            tally: {
              ready: scoreOf(event.ready_count_team1, event.ready_count_team2),
              expected: event.expected_total,
            },
          },
        ],
        // An unready takes this player's team back out of the gate: whatever
        // was said about it being through no longer holds, so saying it again
        // is a fact. Whose team it is comes from the roster (`playerOf`), and
        // from nobody when the roster does not know them.
        state: {
          ...state,
          ready: {
            ...state.ready,
            [stands]: now,
            ...(now === 'unready' && {
              all: '',
              ...(player.team && { [player.team]: '' }),
            }),
          },
        },
        name,
      }
    }
    case 'team_ready': {
      const team = teamOf(event.team)
      if (!team) return drop(`team "${event.team}" is neither team1 nor team2`)
      // **A team is through the gate when its own roster is through it.** The
      // fork decides `IsTeamReady` from the CT/T *side* while it reports the
      // count from the logical team slots, and in simulation mode the two
      // disagree for as long as its bots are being spawned and mapped: every
      // recorded puppet pug opens with a `team_ready` for each team at
      // `ready_count: 0`, before a single `player_ready`, and announces team1
      // again at one of five (`EnsureSimulationBotsMappedAndAnnounced` marks a
      // bot ready by default while `readyAvailable` is false). Forwarding
      // those would put "team A is ready" in a durable log with one player
      // ready, and — worse — spend the edge below on a transient so the real
      // passage is dropped.
      //
      // So the count MatchZy sends is held against **the roster the request
      // named**, which is the only per-team expectation the door has and a
      // number this repo wrote into the match config itself
      // (`match-config/matchzy.ts`, `players_per_team`). A match that rosters
      // nobody on this team — the `--force-start` lane's — has nothing to
      // hold it against and the first one through stands.
      //
      // The one thing this filters that MatchZy meant: a team let through on
      // `min_players_to_ready` with somebody still missing. `all_ready` and
      // `going_live` still say the match started, and PRD-03 has a line for
      // teaching the door that floor.
      const rostered = (team === 'team_a' ? context.teams.teamA : context.teams.teamB).players
        .length
      if (rostered > 0 && event.ready_count !== rostered)
        return drop(
          `${team} is called through the gate with ${event.ready_count} of its ${rostered} rostered ready — the sides are still being filled`,
        )
      // MatchZy sends this team's count and the total; the other team's is
      // the difference, and never below zero however the two were counted.
      const other = Math.max(0, event.total_ready - event.ready_count)
      const tally = {
        ready:
          team === 'team_a' ? scoreOf(event.ready_count, other) : scoreOf(other, event.ready_count),
        expected: event.expected_total,
      }
      // **`team_ready` is an edge, not a tally** (see {@link MatchZyState.ready}).
      // The gate is re-checked after every single ready, and every team still
      // through it POSTs again — twice, and with a new `total_ready` each
      // time, because the *other* team is still readying up. That a team
      // passed the gate happens once; the counts as they move are what
      // `player_ready` carries, on every one of them. So the key is the team,
      // and the tally rides along as the snapshot at the moment of passage.
      if (state.ready[team] === 'through')
        return drop(`${team} was already through the gate before this`)
      return {
        events: [{ type: 'team_ready', matchId, source, team, tally }],
        state: { ...state, ready: { ...state.ready, [team]: 'through' } },
        name,
      }
    }
    case 'all_players_ready': {
      const ready = scoreOf(event.ready_count_team1, event.ready_count_team2)
      const said = `${ready.teamA}/${ready.teamB}${event.countdown_started ? ' counting down' : ''}`
      if (state.ready.all === said) return drop(`everybody is already ready at ${said}`)
      return {
        events: [
          {
            type: 'all_ready',
            matchId,
            source,
            ready,
            countdown: event.countdown_started,
          },
        ],
        state: { ...state, ready: { ...state.ready, all: said } },
        name,
      }
    }
    case 'knife_round_started': {
      if (!mapAt(event.map_number))
        return drop(`map_number ${event.map_number} is outside the plan`)
      return {
        events: [{ type: 'knife_start', matchId, source, mapNumber: event.map_number + 1 }],
        state,
        name,
      }
    }
    case 'knife_round_ended': {
      if (!mapAt(event.map_number))
        return drop(`map_number ${event.map_number} is outside the plan`)
      const winner = teamOf(event.winner)
      return {
        events: [{ type: 'knife_end', matchId, source, mapNumber: event.map_number + 1, winner }],
        state,
        name,
        ...(winner === null && {
          note: `knife_round_ended named "${event.winner}": the sides were unreadable, so nobody is credited with the pick`,
        }),
      }
    }
    case 'round_end': {
      const plan = mapAt(event.map_number)
      if (!plan) return drop(`map_number ${event.map_number} is outside the plan`)
      const mapNumber = event.map_number + 1
      const score = scoreOf(event.team1.score, event.team2.score)
      const roundNumber = score.teamA + score.teamB
      if (roundNumber === 0) return drop('a round_end with a 0–0 score')
      const side = sideOf(event.winner.side)
      if (!side)
        return drop(`winner.side "${event.winner.side}" is neither a side nor a team number`)

      const previous = state.scores[mapNumber] ?? { team1: 0, team2: 0 }
      const rose = {
        team1: score.teamA - previous.team1,
        team2: score.teamB - previous.team2,
      }
      // **The same round, twice.** MatchZy sent two `round_end` payloads for
      // round 1 of the recorded match, a second apart, with the same score
      // and different `reason`s (T13's recording, `real-pug-matchzy.json`).
      // A round nobody won cannot have happened: with a score identical to
      // the last one seen for this map, this is a repeat of a round already
      // in the durable log, and the log must not hold round 1 twice.
      // (A first sighting can never land here — `roundNumber` is the score's
      // sum and a 0–0 payload was dropped above.)
      if (rose.team1 === 0 && rose.team2 === 0)
        return drop(`round ${roundNumber} was already reported at ${score.teamA}–${score.teamB}`)
      let team: MatchTeam | null = null
      let note: string | undefined
      if (rose.team1 === 1 && rose.team2 === 0) team = 'team_a'
      else if (rose.team2 === 1 && rose.team1 === 0) team = 'team_b'
      else if (plan.sides !== 'knife') {
        const teamASide = scheduledSide(
          plan.sides,
          roundNumber,
          options.regulationRounds ?? 24,
          options.overtimeRounds ?? 6,
        )
        team = teamASide === side ? 'team_a' : 'team_b'
        note = `round ${roundNumber}: the score moved ${rose.team1}/${rose.team2} since the last round seen; the winner is the ${side} side by the map plan's schedule`
      } else {
        team = teamOf(event.winner.team) ?? (score.teamA >= score.teamB ? 'team_a' : 'team_b')
        note = `round ${roundNumber}: the score moved ${rose.team1}/${rose.team2} since the last round seen and the map was knifed; the winner is MatchZy's own field`
      }

      const next: MatchZyState = {
        ...state,
        scores: { ...state.scores, [mapNumber]: { team1: score.teamA, team2: score.teamB } },
      }
      const players = summaries(event.team1, event.team2)
      return {
        events: [
          {
            type: 'round_end',
            matchId,
            source,
            mapNumber,
            roundNumber,
            winner: { team, side },
            winCondition: winConditionOf(event.reason),
            score,
            ...(players && { players }),
            ...(event.round_time !== undefined &&
              event.round_time > 0 && { roundTimeMs: event.round_time }),
          },
        ],
        state: next,
        name,
        ...(note && { note }),
      }
    }
    case 'map_result': {
      const plan = mapAt(event.map_number)
      if (!plan) return drop(`map_number ${event.map_number} is outside the plan`)
      const score = scoreOf(event.team1.score, event.team2.score)
      const winner: MatchTeam | null =
        score.teamA === score.teamB ? null : score.teamA > score.teamB ? 'team_a' : 'team_b'
      return {
        events: [
          {
            type: 'map_end',
            matchId,
            source,
            mapNumber: event.map_number + 1,
            map: plan.map,
            score,
            winner,
          },
        ],
        state,
        name,
      }
    }
    case 'series_end': {
      const seriesScore = scoreOf(event.team1_series_score, event.team2_series_score)
      const winner: MatchTeam | null =
        seriesScore.teamA === seriesScore.teamB
          ? null
          : seriesScore.teamA > seriesScore.teamB
            ? 'team_a'
            : 'team_b'
      return {
        events: [{ type: 'series_end', matchId, source, seriesScore, winner }],
        state,
        name,
      }
    }
    default:
      return drop('an event this translator does not know')
  }
}
