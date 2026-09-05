import type {
  GameserverEvent,
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
 * - **A drawn map is `winner: null`**, whatever MatchZy says: `map_result`
 *   and `series_end` name team2 the winner of a tie (`t1score > t2score`).
 *   The scores decide, and a tie is a tie.
 * - **Map numbers are 0-based on the wire and 1-based in the vocabulary;**
 *   the map's name is the request's plan, because MatchZy's events never
 *   carry it.
 * - **Dropped, on purpose:** `series_start` (no fact of ours; `server_ready`
 *   and `going_live` bracket it), the veto trio (the platform runs the veto),
 *   `demo_upload_ended` (the core plugin owns the upload, decision 10 / T21),
 *   `player_disconnect` (the core plugin emits `player_disconnected` from the
 *   engine; nobody double-speaks), and any event naming another `matchid`
 *   than the match this server holds.
 */

/** What a MatchZy payload needs from the match it is about. */
export interface MatchZyContext {
  matchId: string
  source: GameserverSource
  /** `matchzySerial(matchId)` — what the config told MatchZy the match is called. */
  serial: number
  /** The request's map plan, in order: the names MatchZy's events lack, and the starting sides. */
  maps: readonly MapPlan[]
}

/** What the translator remembers between one round and the next: the last score it saw, per map. */
export interface MatchZyState {
  /** The map score after the last `round_end`, keyed by 1-based map number. */
  scores: Record<number, { team1: number; team2: number }>
}

export function initialMatchZyState(): MatchZyState {
  return { scores: {} }
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

/** Everything MatchZy sends that becomes nothing of ours, by name. */
export const MATCHZY_DROPPED_EVENTS = [
  'series_start',
  'map_picked',
  'map_vetoed',
  'side_picked',
  'demo_upload_ended',
  'player_disconnect',
] as const

/** The names this translator knows, translated or dropped. */
export const MATCHZY_KNOWN_EVENTS = [
  'going_live',
  'round_end',
  'map_result',
  'series_end',
  ...MATCHZY_DROPPED_EVENTS,
] as const

const matchzyPayloadSchema = z.discriminatedUnion('event', [
  goingLiveSchema,
  roundEndSchema,
  mapResultSchema,
  seriesEndSchema,
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
  if ((MATCHZY_DROPPED_EVENTS as readonly string[]).includes(name)) {
    return drop('not a fact of ours')
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
        state,
        name,
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
