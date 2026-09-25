/**
 * The story builder: one seeded PRNG + one parsed match assignment + one
 * scenario → the complete, timed event stream of a simulated match, as data.
 * Built once at assign time, so the whole match is decided before the first
 * event fires; playback (`server.ts`) only walks the list on the injected
 * clock.
 *
 * Plausibility serves the UI and stops there: rounds have an economy-ish
 * rhythm (pistol rounds, ecos after losses), kill feeds name the rostered
 * players with skill-weighted attribution, bomb rounds tell a bomb story, and
 * every score is internally consistent — but nothing here pretends to be a
 * parsed demo. Beat times are game-time milliseconds from `start()`; the
 * contract's own `roundTimeMs` rides on in-round events.
 *
 * The platform's `story.ts` on 2026-09-05, verbatim, plus {@link resumeStory}:
 * what a replacement server plays after loading a round backup.
 */
import type { Prng } from '@ezpug/core'
import type {
  GamemodeLength,
  GameserverEvent,
  GameserverPlayer,
  GameserverSource,
  LiveLength,
  MapRadar,
  MapRadarLayer,
  MatchEndReason,
  MatchTeam,
  PlayerRoundSummary,
  RoundWinCondition,
  SimKnifePerk,
  TeamSide,
} from '@ezpug/match-api'
import {
  isEphemeralGameserverEvent,
  radarToWorld,
  SDK_TOLD_FLOWS,
  SIM_KNIFE_PERK_LINE,
  SIM_KNIFE_WEAPON,
} from '@ezpug/match-api'
import type { MatchAssignment, SimulatedPlayer } from './assignment'
import { SIM_CHAT_EVENT, sanitizeChatLine } from './chat'
import type { SimulatedChatMoment } from './chatter'
import { planSimulatedChatter } from './chatter'
import type { SimulatedRecording } from './record'
import { simulatedRecording } from './record'
import type { SimulatorScenario } from './scenario'
import { bombAt, planRoundUtility, utilitySampler } from './utility'

/** One event at its game-time offset. `seq` is stamped at emission, not here. */
export interface StoryBeat {
  atMs: number
  event: GameserverEvent
}

export type StoryOutcome =
  /** The series ended; the demo is out; the server may go quiet. */
  | 'completed'
  /** The server dies the moment the last beat fired (mid-match crash). */
  | 'crashed'
  /** The story runs dry without ending (no-show warmup) — the orchestrator decides. */
  | 'idle'

export interface MatchStory {
  beats: StoryBeat[]
  outcome: StoryOutcome
  /**
   * The recording behind each `demo_available` beat, in map order.
   * Built here rather than at fetch time so the announced `sizeBytes` and the
   * bytes the provider later hands over are the same object — and because a
   * map's recording *is* the beats this story just decided.
   */
  demos: SimulatedRecording[]
}

export interface StoryOptions {
  prng: Prng
  assignment: MatchAssignment
  scenario: SimulatorScenario
  source: GameserverSource
  /** Game-time from `start()` until `server_ready`. */
  bootDelayMs: number
  /** Position-tick sampling interval; `null` turns the ephemeral tier off. */
  positionTickIntervalMs: number | null
  /**
   * **Playback's speed, because one number on the wire is measured in it**
   * (PRD-03 T9a). Every beat here is stated in match time and playback divides
   * it by this, exactly as `host_timescale` speeds a real server's engine up
   * while the SDK's own timers keep counting real milliseconds. So
   * `going_live.length.durationSeconds` — the seconds a client counts down on
   * *its* clock — is the manifest's number divided by this one, which is what
   * `MatchLength.InForce` computes on a real server. Nothing else reads it and
   * no dice are drawn from it: a seeded match plays the same match at any
   * speed. Absent: 1.
   */
  timeScale?: number
  /**
   * The catalog's radar per map of the series, in `assignment.maps` order —
   * what the orchestrator told this server the maps it is playing look like.
   *
   * It buys exactly one thing: the ephemeral tier's positions land *on the
   * picture a spectator is looking at*. A simulated server that was told
   * nothing (or is playing a map nobody calibrated) still samples positions,
   * in the arbitrary world units this file used before there was a minimap —
   * the same tier, unrenderable, which is what a map without radar data looks
   * like anyway. Nothing else about the story reads it, and the dice are
   * drawn in the same order either way, so two servers handed the same seed
   * play the same match whether or not either of them knew the map.
   */
  radars?: readonly (MapRadar | null)[]
  /**
   * **A knife kill and the killer's `get ezpug`** (ezpug/ezpug-iron#6): the
   * request's `sim.knifePerk`. It rewrites one kill the story already dealt
   * rather than dealing a new one, and draws on its own fork, so the rounds,
   * the kills and the winner are the ones this seed plays without it.
   */
  knifePerk?: SimKnifePerk | null
}

// Game-time rhythm (milliseconds). Compressed or stretched only by playback's
// time scale — the story itself always speaks real match time.
/**
 * How long between two of the assignment's warmup lines — the plugin's own
 * `WarmupChat.IntervalMs` (`plugins/EZPug.Sdk/Branding/WarmupChat.cs`), because
 * a simulated warmup that filled chat at a different pace than a real one would
 * be a rehearsal for a different match (PRD-02 T30).
 */
const WARMUP_LINE_INTERVAL_MS = 8_000

const FREEZE_MS = 7_000
const HALFTIME_MS = 15_000
const MAP_GAP_MS = 25_000
const ROUND_FULL_MS = 115_000
const BOMB_TIMER_MS = 40_000

const WEAPONS: Record<'pistol' | 'smg' | 'rifle', Record<TeamSide, readonly string[]>> = {
  pistol: {
    t: ['glock', 'deagle', 'p250', 'tec9'],
    ct: ['usp_silencer', 'deagle', 'p250', 'fiveseven'],
  },
  smg: { t: ['mac10', 'mp5sd', 'ump45'], ct: ['mp9', 'mp5sd', 'ump45'] },
  rifle: {
    t: ['ak47', 'ak47', 'galilar', 'sg556'],
    ct: ['m4a1_silencer', 'm4a1', 'famas', 'aug'],
  },
}

/**
 * **A deathmatch body is back on its feet almost at once** — the modes with a
 * length respawn (`mp_respawn_on_death_*`) after the engine's immunity time.
 */
const RESPAWN_MS = 3_000

/**
 * The pace of a room with a length: one kill on the server roughly this often
 * *per player on it*. Six puppets killing each other 144 times in the ten
 * minutes of the dev lane's `powerup-dm` run (PRD-03 T9) is one every 4.2 s,
 * which is what this number is.
 */
const KILL_INTERVAL_PER_PLAYER_MS = 25_000

/**
 * **How long after the map is up a flow the SDK tells the story of ends its
 * own warmup** — `GenericFlow.GoLiveDelayMs` to the millisecond, because that
 * is the number a real one of these servers runs on. It is the window the
 * roster connects in, and it runs out whether or not anybody used it.
 */
const GO_LIVE_DELAY_MS = 20_000

/**
 * **Whose story this mode's server tells** (PRD-03 T11a). A `matchzy` mode is
 * MatchZy's: warmup is held open until the teams ready up, so an empty or a
 * short-handed server never goes live and the orchestrator's join deadline is
 * the only thing that ever gives up on it. A `plugin` or `none` mode is the
 * SDK's: `GenericFlow` runs `mp_warmup_end` itself once the delay is up and
 * the match is live with whoever is standing there, which is the only thing a
 * drop-in mode could sensibly do — people join it *live*. Absent, as a match
 * config read off a MatchZy handoff is: MatchZy's.
 */
const tellsItsOwnStory = (assignment: MatchAssignment): boolean =>
  SDK_TOLD_FLOWS.includes(assignment.flow ?? 'matchzy')

const flip = (side: TeamSide): TeamSide => (side === 'ct' ? 't' : 'ct')
const other = (team: MatchTeam): MatchTeam => (team === 'team_a' ? 'team_b' : 'team_a')
const indices = (count: number): number[] => Array.from({ length: count }, (_, i) => i)

interface PlayerState {
  player: SimulatedPlayer
  team: MatchTeam
  /** Kill-attribution weight, drawn once — the star players stay the stars. */
  skill: number
  kills: number
  deaths: number
  assists: number
  flashAssists: number
  damage: number
  headshotKills: number
  bombPlants: number
  bombDefuses: number
  mvps: number
}

/** Which side team A plays in round `round` (1-based, within one map). */
export function teamASideAt(
  round: number,
  firstHalfSide: TeamSide,
  regulationRounds: number,
  overtimeMaxRounds: number,
): TeamSide {
  const half = regulationRounds / 2
  if (round <= half) return firstHalfSide
  if (round <= regulationRounds) return flip(firstHalfSide)
  const overtimeRound = round - regulationRounds
  const overtimeHalf = Math.floor((overtimeRound - 1) / (overtimeMaxRounds / 2))
  return overtimeHalf % 2 === 0 ? firstHalfSide : flip(firstHalfSide)
}

/** `count` wins each, shuffled — a tied stretch of rounds. */
function tiedStretch(prng: Prng, a: MatchTeam, b: MatchTeam, count: number): MatchTeam[] {
  return prng.shuffle([...Array<MatchTeam>(count).fill(a), ...Array<MatchTeam>(count).fill(b)])
}

/**
 * The round-winner sequence for one map: ends exactly when the map is decided
 * (clinch in regulation, or through `overtimes` overtimes, the last of which
 * decides). The final round is always the winner's — a map ends on the
 * winning round.
 */
export function planMapRounds(
  prng: Prng,
  winner: MatchTeam,
  regulationRounds: number,
  overtimeMaxRounds: number,
  options: { overtimes: number; comeback: boolean },
): MatchTeam[] {
  const half = regulationRounds / 2
  const loser = other(winner)

  if (options.overtimes === 0) {
    const loserScore = options.comeback
      ? Math.max(0, half - prng.int(1, 3))
      : prng.int(Math.min(2, half - 1), half)
    const total = half + 1 + loserScore
    // The comeback concentrates the loser's rounds at the front — down big at
    // the half, then the winner runs the table.
    const pool = indices(options.comeback ? Math.min(total - 1, loserScore + 3) : total - 1)
    const loserRounds = new Set(prng.sample(pool, loserScore))
    return indices(total).map(i => (loserRounds.has(i) ? loser : winner))
  }

  const winners: MatchTeam[] = tiedStretch(prng, winner, loser, half)
  const overtimeHalf = overtimeMaxRounds / 2
  for (let overtime = 1; overtime < options.overtimes; overtime++) {
    winners.push(...tiedStretch(prng, winner, loser, overtimeHalf))
  }
  const loserOvertimeScore = prng.int(0, overtimeHalf)
  const decider = overtimeHalf + 1 + loserOvertimeScore
  const loserRounds = new Set(prng.sample(indices(decider - 1), loserOvertimeScore))
  for (let i = 0; i < decider; i++) winners.push(loserRounds.has(i) ? loser : winner)
  return winners
}

/** Map winners for the series: the overall winner clinches on the last map played. */
function planSeries(prng: Prng, winner: MatchTeam, mapsInSeries: number): MatchTeam[] {
  const target = Math.floor(mapsInSeries / 2) + 1
  if (mapsInSeries === 1) return [winner]
  const loserMaps = prng.int(0, target)
  const total = target + loserMaps
  const loserWins = new Set(prng.sample(indices(total - 1), loserMaps))
  return indices(total).map(i => (loserWins.has(i) ? other(winner) : winner))
}

/**
 * **Who won a map, or a series, or nobody** — the SDK's own rule
 * (`GenericFlow.Winner`, PRD-03 T9/T10) said again on this side of the seam:
 * a one-team mode has no team to have won it, and a tie names nobody either.
 */
function winnerOf(assignment: MatchAssignment, teamA: number, teamB: number): MatchTeam | null {
  if ((assignment.teamCount ?? 2) === 1 || teamA === teamB) return null
  return teamA > teamB ? 'team_a' : 'team_b'
}

/**
 * **What `going_live` carries**, or `null` when the mode's length is only an
 * idle timeout — nobody is watching a server that is empty, so there is
 * nothing to count down. `MatchLength.InForce` on a real server, to the same
 * rounding: the duration is the client's own seconds (the time scale already
 * divided out), the frag limit is a count and scales with nothing.
 */
export function liveLengthInForce(
  length: GamemodeLength | undefined,
  timeScale: number,
): LiveLength | null {
  if (!length) return null
  const scale = timeScale > 0 ? timeScale : 1
  const durationSeconds =
    length.durationSeconds === undefined
      ? undefined
      : Math.max(1, Math.ceil(length.durationSeconds / scale))
  if (durationSeconds === undefined && length.fragLimit === undefined) return null
  return {
    ...(durationSeconds !== undefined && { durationSeconds }),
    ...(length.fragLimit !== undefined && { fragLimit: length.fragLimit }),
  }
}

export function buildMatchStory(options: StoryOptions): MatchStory {
  const { prng, assignment, scenario, source, positionTickIntervalMs } = options
  const radars = options.radars ?? []
  const { matchId } = assignment

  if (scenario.neverReady) return { beats: [], outcome: 'idle', demos: [] }

  const beats: StoryBeat[] = []
  const demos: SimulatedRecording[] = []
  let t = 0
  const emit = (atMs: number, event: GameserverEvent): void => {
    beats.push({ atMs, event })
  }

  let players: PlayerState[] = [
    ...assignment.teamA.players.map(player => ({ player, team: 'team_a' as MatchTeam })),
    ...assignment.teamB.players.map(player => ({ player, team: 'team_b' as MatchTeam })),
  ].map(({ player, team }) => ({
    player,
    team,
    skill: 0.6 + prng.next() * 0.9,
    kills: 0,
    deaths: 0,
    assists: 0,
    flashAssists: 0,
    damage: 0,
    headshotKills: 0,
    bombPlants: 0,
    bombDefuses: 0,
    mvps: 0,
  }))
  const roster = (team: MatchTeam): PlayerState[] => players.filter(p => p.team === team)
  const asGameserverPlayer = (state: PlayerState): GameserverPlayer => ({
    steamId64: state.player.steamId64,
    name: state.player.name,
    team: state.team,
  })

  /**
   * **The lines the server itself says while it waits** (PRD-02 T30): the
   * assignment's warmup lines, one every {@link WARMUP_LINE_INTERVAL_MS} from
   * the moment the server is ready until the wait ends, cycling in order — the
   * same rule, the same pace and the same `plugin_event` a real plugin's
   * `WarmupChat` prints, so a client that renders them off a simulated match
   * renders them off a real one.
   *
   * Merged into the beats by time rather than appended: the connects and the
   * players' own chatter happen inside this window, and playback walks the
   * list in order. No dice are rolled here, so a seeded match plays exactly
   * the match it played before whether or not anybody wrote a warmup line.
   */
  const fillWarmup = (fromMs: number, untilMs: number): void => {
    const lines = (assignment.warmupLines ?? [])
      .map(line => {
        try {
          return sanitizeChatLine(line)
        } catch {
          // A line that is nothing once it is safe to say is dropped, exactly
          // as the plugin drops it at assignment.
          return null
        }
      })
      .filter((line): line is string => line !== null)
    if (lines.length === 0) return
    let spoken = 0
    for (let at = fromMs + WARMUP_LINE_INTERVAL_MS; at <= untilMs; at += WARMUP_LINE_INTERVAL_MS) {
      const line = lines[spoken % lines.length] as string
      spoken += 1
      emit(at, {
        type: 'plugin_event',
        matchId,
        source,
        name: SIM_CHAT_EVENT,
        data: { line },
      })
    }
    beats.sort((a, b) => a.atMs - b.atMs)
  }

  // --- boot & connects ------------------------------------------------------

  const firstMap = assignment.maps[0] as (typeof assignment.maps)[number]
  t += options.bootDelayMs
  const readyAtMs = t
  emit(t, { type: 'server_ready', matchId, source, map: firstMap.map })

  /**
   * **This map's demo, if this mode makes one at all** (PRD-03 T9c). Only a
   * manifest that `records: "demo"` produces a file: a `powerup-dm` or a
   * `flying-scoutsman` server records its events and hands over nothing, so
   * there is no `demo_available` to say and no GOTV to wait for either — the
   * orchestrator's demo window (`machine.ts` `demoPending`) is not armed for
   * such a match and its `match.ended` already says `skipped: "not_recorded"`.
   * Absent, as a match config read off a MatchZy handoff is: a demo.
   *
   * The recording itself is the honest one, not a plausible 90 MB of fake
   * demo: this map's own normalized events, minus the ephemeral tier, which is
   * what the parse pipeline produces this match's stats and replay from.
   * `sizeBytes` is the real length of the bytes `record()` will hand the
   * storage pipe.
   */
  const announceDemo = (mapNumber: number, map: string, fromIndex: number): void => {
    if ((assignment.records ?? 'demo') !== 'demo') return
    t += 6_000
    const demo = simulatedRecording({
      matchId,
      serverId: source.serverId,
      scenario: scenario.name,
      mapNumber,
      map,
      players: players.map(state => ({
        steamId64: state.player.steamId64,
        name: state.player.name,
        team: state.team,
      })),
      events: beats
        .slice(fromIndex)
        .map(beat => beat.event)
        .filter(event => !isEphemeralGameserverEvent(event.type)),
    })
    demos.push(demo)
    emit(t, {
      type: 'demo_available',
      matchId,
      source,
      mapNumber,
      filename: demo.filename,
      sizeBytes: demo.sizeBytes,
    })
  }

  // **Nobody ever comes** (PRD-03 T9a). What happens to an empty server is the
  // *mode's* to say, exactly as it is on real hardware — and the two kinds of
  // mode say different things (T11a, measured side by side on the dev node and
  // this engine in the lane's `idle` row).
  //
  // MatchZy holds its warmup open until two teams have readied up, so nothing
  // ever goes live and nothing ever ends: the story runs dry and the join
  // deadline is what decides. A `length` changes none of that — it is never
  // MatchZy's to enforce, and a real server drops it for that flow
  // (`MatchLength.OnAssigned`), as the manifest rules already refuse to carry
  // one there.
  //
  // A flow the SDK tells the story of ends its *own* warmup instead
  // (`GenericFlow`, `GoLiveDelayMs`): twenty seconds after the map is up the
  // server is live with nobody standing on it — `going_live` carrying whatever
  // length is in force, and round one with it — which is the only thing a
  // drop-in mode could sensibly do, since people join such a server *live*. It
  // then ends on the first clock to run out: the idle timeout, counted from
  // `server_ready` (`MatchLength.OnReady`), or the duration, counted from
  // `going_live` — and `map_end` carries the reason too, because this map was
  // live. A mode that names neither plays on for ever with nobody on it.
  //
  // Nothing is said out loud to an empty room either way: warmup chat has no
  // reader and nobody is there to kill anybody.
  if (scenario.idle) {
    if (!tellsItsOwnStory(assignment)) return { beats, outcome: 'idle', demos }
    const idleSeconds = assignment.length?.idleTimeoutSeconds
    const liveAtMs = readyAtMs + GO_LIVE_DELAY_MS
    const mapStartIndex = beats.length
    const inForce = liveLengthInForce(assignment.length, options.timeScale ?? 1)
    emit(liveAtMs, {
      type: 'going_live',
      matchId,
      source,
      mapNumber: 1,
      map: firstMap.map,
      ...(inForce && { length: inForce }),
    })
    emit(liveAtMs, {
      type: 'round_start',
      matchId,
      source,
      mapNumber: 1,
      roundNumber: 1,
      score: { teamA: 0, teamB: 0 },
    })
    // The race `MatchLength` runs, with nobody to reach a frag limit.
    const clocks: { atMs: number; reason: MatchEndReason }[] = []
    if (idleSeconds !== undefined) {
      clocks.push({ atMs: readyAtMs + idleSeconds * 1_000, reason: 'idle' })
    }
    if (assignment.length?.durationSeconds !== undefined) {
      clocks.push({
        atMs: liveAtMs + assignment.length.durationSeconds * 1_000,
        reason: 'time_limit',
      })
    }
    const ends = clocks.sort((a, b) => a.atMs - b.atMs)[0]
    if (!ends) return { beats, outcome: 'idle', demos }
    t = ends.atMs
    const score = { teamA: 0, teamB: 0 }
    emit(t, {
      type: 'map_end',
      matchId,
      source,
      mapNumber: 1,
      map: firstMap.map,
      score,
      winner: winnerOf(assignment, score.teamA, score.teamB),
      reason: ends.reason,
    })
    announceDemo(1, firstMap.map, mapStartIndex)
    t += 2_000
    emit(t, {
      type: 'series_end',
      matchId,
      source,
      seriesScore: score,
      winner: winnerOf(assignment, score.teamA, score.teamB),
      reason: ends.reason,
    })
    return { beats, outcome: 'completed', demos }
  }

  /**
   * **Who is missing.** The draw is over the whole room, as it has always
   * been; who may come *out* of it is the flow's. For MatchZy anybody can:
   * its warmup is held open until both teams are complete and ready, so a
   * missing player is the join deadline's problem and never the story's. A
   * flow the SDK tells the story of *plays* the match short-handed, so one
   * body a side is kept back — a round-based story with an empty side is
   * nobody's match, and a server with nobody on it at all is the `idle`
   * scenario rather than this one.
   */
  const sdkTold = tellsItsOwnStory(assignment)
  const keptBack = sdkTold ? [0, assignment.teamA.players.length] : []
  // **The people among the puppets never come** (PRD-04 T2): a simulated
  // server has no door for a human, so a seat `simulation.puppets` left to one
  // is an empty seat here, by the same rules as a no-show — held open under
  // MatchZy, played around by a flow the SDK tells. The door guarantees at
  // least one puppet, so the room is never empty by this route alone.
  const humans = new Set(assignment.humans ?? [])
  const order = prng
    .shuffle(players)
    .filter(state => !keptBack.some(index => players[index] === state))
    .filter(state => !humans.has(state.player.steamId64))
  const seated = players.filter(state => !humans.has(state.player.steamId64))
  const drawn = Math.min(scenario.absentPlayers ?? 0, seated.length - 1, order.length)
  const absent = new Set([
    ...humans,
    ...order.slice(0, Math.max(0, drawn)).map(p => p.player.steamId64),
  ])
  const absentCount = players.filter(p => absent.has(p.player.steamId64)).length
  const arrivals = players
    .filter(p => !absent.has(p.player.steamId64))
    .map(state => ({ state, atMs: t + prng.int(2_000, 25_001) }))
    .sort((a, b) => a.atMs - b.atMs)
  for (const { state, atMs } of arrivals) {
    emit(atMs, { type: 'player_connected', matchId, source, player: asGameserverPlayer(state) })
  }

  // **A no-show under MatchZy never goes live**: the server heartbeats in
  // warmup until the orchestrator's join deadline decides — the story just
  // runs dry. The lines are said for as long as there is a story, which for
  // this one is until the last player who *did* come arrived.
  const lastArrival = arrivals[arrivals.length - 1]
  if (absentCount > 0 && !sdkTold) {
    fillWarmup(readyAtMs, lastArrival?.atMs ?? t)
    return { beats, outcome: 'idle', demos }
  }
  // **A flow the SDK tells the story of waits for nobody** (T11a): warmup ends
  // on its own clock and the match is played by the bodies that came. The ones
  // that never did are out of it from here — they kill nobody, die to nobody
  // and stand in no round's scoreboard, exactly as a player who never
  // connected does not.
  if (absentCount > 0) players = players.filter(p => !absent.has(p.player.steamId64))

  /**
   * The three lines this match says, drawn on their **own** stream so
   * adding chat to the simulator moved nobody's rounds: `fork` is
   * order-independent by contract, and every seeded match still plays exactly
   * the match it played before. Planned once the room is known, so a line is
   * never put in the mouth of somebody who never came.
   */
  const chatter = planSimulatedChatter(prng.fork('chatter'), players.length)
  const say = (atMs: number, moment: SimulatedChatMoment): void => {
    const line = chatter?.[moment]
    const speaker = line ? players[line.speaker] : undefined
    if (!line || !speaker) return
    emit(atMs, {
      type: 'chat_message',
      matchId,
      source,
      player: asGameserverPlayer(speaker),
      text: line.text,
      scope: line.scope,
    })
  }

  /**
   * **The knife perk** (ezpug/ezpug-iron#6), dealt at most once. Looks at the
   * kills a round just dealt (`beats` from `fromIndex` on, every one of them
   * before `untilMs`), turns one by the asked-for team into a knife kill and
   * has its killer say the line before `untilMs`, which is the round's own
   * end. Nothing is added to the kill feed, so every stat the round's
   * `round_end` carries stays true once the headshot, if any, is taken back.
   * Its dice are its own fork's, so the story's stream never notices.
   */
  const knifePrng = prng.fork('knife-perk')
  let knifePerkDealt = false
  const dealKnifePerk = (round: number, fromIndex: number, untilMs: number): void => {
    const perk = options.knifePerk
    if (!perk || knifePerkDealt || round < perk.round) return
    const kills: number[] = []
    for (let i = fromIndex; i < beats.length; i++) {
      const { event } = beats[i] as StoryBeat
      if (event.type !== 'player_death' || event.killer === null) continue
      if (perk.killer === undefined || event.killer.team === perk.killer) kills.push(i)
    }
    if (kills.length === 0) return
    const index = knifePrng.pick(kills)
    const { atMs, event } = beats[index] as StoryBeat & {
      event: Extract<GameserverEvent, { type: 'player_death' }>
    }
    const { noscope: _noscope, ...death } = event
    const killer = players.find(p => p.player.steamId64 === death.killer?.steamId64)
    if (!killer || !death.killer) return
    if (death.headshot) killer.headshotKills--
    beats[index] = { atMs, event: { ...death, weapon: SIM_KNIFE_WEAPON, headshot: false } }
    const saidAtMs = Math.min(atMs + knifePrng.int(1_500, 4_001), untilMs)
    const line: StoryBeat = {
      atMs: saidAtMs,
      event: {
        type: 'chat_message',
        matchId,
        source,
        player: death.killer,
        text: SIM_KNIFE_PERK_LINE,
        scope: 'all',
      },
    }
    // After every beat at or before its instant, so the kill always comes first.
    const after = beats.findIndex((other, i) => i > index && other.atMs > saidAtMs)
    beats.splice(after < 0 ? beats.length : after, 0, line)
    knifePerkDealt = true
  }

  t = (lastArrival?.atMs ?? t) + prng.int(10_000, 20_001)

  // Warmup: somebody says something before anything has happened, so a pane
  // opened on a live match is never a blank rectangle.
  say(t, 'warmup')
  fillWarmup(readyAtMs, t)

  // --- a mode with a length: one map, one round, one clock ------------------
  //
  // **The story a mode with nothing to win tells** (PRD-03 T9a). The SDK owns
  // the clock on a real server (`mp_timelimit 0`), which makes such a mode one
  // round nobody wins: a `round_start` and never a `round_end`, bodies dying
  // and respawning until the duration or the frag limit is reached, then
  // `map_end` and `series_end` carrying the reason. This is that, beat for
  // beat, so a client drawing a countdown off the simulator draws it off the
  // dev node too. A length that is only an idle timeout says nothing here —
  // that mode still plays rounds, and its idle end is the `idle` scenario's.
  const inForce = liveLengthInForce(assignment.length, options.timeScale ?? 1)
  if (inForce && assignment.length) {
    t += 10_000
    const liveAtMs = t
    const mapStartIndex = beats.length
    // Emitted at the same instant, as the engine's own round-start frame emits
    // them (`GenericFlow.OnRoundStart`): the map goes live and round one is it.
    emit(t, {
      type: 'going_live',
      matchId,
      source,
      mapNumber: 1,
      map: firstMap.map,
      length: inForce,
    })
    emit(t, {
      type: 'round_start',
      matchId,
      source,
      mapNumber: 1,
      roundNumber: 1,
      score: { teamA: 0, teamB: 0 },
    })
    const teamASide =
      firstMap.teamASide === 'knife' ? prng.pick(['ct', 't'] as const) : firstMap.teamASide
    const openingLineAtMs = t + prng.int(20_000, 60_001)
    const played = playLength({
      prng,
      matchId,
      source,
      emit,
      players,
      asGameserverPlayer,
      tStart: liveAtMs,
      length: assignment.length,
      teams: assignment.teamCount ?? 2,
      teamASide,
      positionTickIntervalMs,
      radar: radars[0] ?? null,
    })
    dealKnifePerk(1, mapStartIndex, played.endAtMs)
    // Said into the middle of the kill feed, then merged by time: the beats
    // above are already sorted among themselves (`fillWarmup`'s rule).
    say(openingLineAtMs, 'pistol')
    beats.sort((a, b) => a.atMs - b.atMs)
    t = played.endAtMs
    say(t, 'end')
    t += 2_000
    // Nobody won a round, so the score is nought and the winner is nobody —
    // `GenericFlow.Finish` reads exactly these two numbers.
    const score = { teamA: 0, teamB: 0 }
    emit(t, {
      type: 'map_end',
      matchId,
      source,
      mapNumber: 1,
      map: firstMap.map,
      score,
      winner: winnerOf(assignment, score.teamA, score.teamB),
      reason: played.reason,
    })
    announceDemo(1, firstMap.map, mapStartIndex)
    t += 2_000
    // A length is the *match's*, not a map's: the series ends with it however
    // many maps the request planned (`GenericFlow.End`, `seriesOver: true`).
    const seriesScore = { teamA: 0, teamB: 0 }
    emit(t, {
      type: 'series_end',
      matchId,
      source,
      seriesScore,
      winner: winnerOf(assignment, seriesScore.teamA, seriesScore.teamB),
      reason: played.reason,
    })
    return { beats, outcome: 'completed', demos }
  }

  // --- the series -----------------------------------------------------------

  const seriesWinner = scenario.winner ?? prng.pick(['team_a', 'team_b'] as const)
  const mapWinners = planSeries(prng, seriesWinner, assignment.maps.length)
  const seriesScore = { teamA: 0, teamB: 0 }
  const overtimeMaxRounds = assignment.overtime.maxRounds

  for (let mapIndex = 0; mapIndex < mapWinners.length; mapIndex++) {
    const mapNumber = mapIndex + 1
    const decidedMap = assignment.maps[mapIndex] ?? firstMap
    const mapWinner = mapWinners[mapIndex] as MatchTeam
    if (mapIndex > 0) t += MAP_GAP_MS

    // A knife round decides sides where the config left them open — the
    // ranked queue never does , custom contexts may.
    let firstHalfSide: TeamSide
    if (decidedMap.teamASide === 'knife') {
      const knifeWinner = prng.pick(['team_a', 'team_b'] as const)
      const chosenSide = prng.pick(['ct', 't'] as const)
      firstHalfSide = knifeWinner === 'team_a' ? chosenSide : flip(chosenSide)
      t += 45_000
      emit(t, {
        type: 'plugin_event',
        matchId,
        source,
        name: 'knife_round_won',
        data: { team: knifeWinner, side: chosenSide },
      })
      t += 15_000
    } else {
      firstHalfSide = decidedMap.teamASide
    }

    // Where this map's recording begins: everything from `going_live` on.
    const mapStartIndex = beats.length
    emit(t, { type: 'going_live', matchId, source, mapNumber, map: decidedMap.map })

    const isFirstMap = mapIndex === 0
    const roundWinners = planMapRounds(
      prng,
      mapWinner,
      assignment.regulationRounds,
      overtimeMaxRounds,
      {
        overtimes: isFirstMap && assignment.overtime.enabled ? (scenario.overtimes ?? 0) : 0,
        comeback: isFirstMap && (scenario.comeback ?? false),
      },
    )
    const pauseRounds = new Set(
      isFirstMap && scenario.pauses
        ? prng.sample(
            indices(roundWinners.length - 1).map(i => i + 2),
            Math.min(scenario.pauses, roundWinners.length - 1),
          )
        : [],
    )

    const score = { teamA: 0, teamB: 0 }
    const lossStreak: Record<MatchTeam, number> = { team_a: 0, team_b: 0 }
    let previousSide = firstHalfSide

    for (let round = 1; round <= roundWinners.length; round++) {
      const roundWinner = roundWinners[round - 1] as MatchTeam
      const teamASide = teamASideAt(
        round,
        firstHalfSide,
        assignment.regulationRounds,
        overtimeMaxRounds,
      )
      if (teamASide !== previousSide) {
        t += HALFTIME_MS
        emit(t, {
          type: 'side_swap',
          matchId,
          source,
          mapNumber,
          sides: { teamA: teamASide, teamB: flip(teamASide) },
        })
        previousSide = teamASide
        lossStreak.team_a = 0
        lossStreak.team_b = 0
      }
      if (pauseRounds.has(round)) {
        t += 2_000
        emit(t, {
          type: 'match_paused',
          matchId,
          source,
          mapNumber,
          kind: 'tactical',
          pausedBy: prng.pick(['team_a', 'team_b'] as const),
        })
        t += prng.int(30_000, 60_001)
        emit(t, { type: 'match_unpaused', matchId, source, mapNumber })
      }

      t += FREEZE_MS
      emit(t, {
        type: 'backup_written',
        matchId,
        source,
        mapNumber,
        roundNumber: round,
        filename: `${assignment.game === 'cs2' ? 'matchzy' : 'get5'}_backup_map${mapNumber}_round${String(round).padStart(2, '0')}.cfg`,
      })
      emit(t, {
        type: 'round_start',
        matchId,
        source,
        mapNumber,
        roundNumber: round,
        score: { ...score },
      })

      const roundStartIndex = beats.length
      const { durationMs, winCondition } = playRound({
        prng,
        matchId,
        source,
        emit,
        players,
        roster,
        asGameserverPlayer,
        tStart: t,
        mapNumber,
        round,
        roundWinner,
        teamASide,
        pistolRound: round === 1 || round === assignment.regulationRounds / 2 + 1,
        lossStreak,
        positionTickIntervalMs,
        radar: radars[mapIndex] ?? null,
      })
      t += durationMs
      if (isFirstMap) dealKnifePerk(round, roundStartIndex, t)

      if (roundWinner === 'team_a') score.teamA++
      else score.teamB++
      lossStreak[roundWinner] = 0
      lossStreak[other(roundWinner)]++

      emit(t, {
        type: 'round_end',
        matchId,
        source,
        mapNumber,
        roundNumber: round,
        winner: {
          team: roundWinner,
          side: roundWinner === 'team_a' ? teamASide : flip(teamASide),
        },
        winCondition,
        score: { ...score },
        players: players.map(summarize),
        roundTimeMs: durationMs,
      })

      // The opening pistol is talked about to one's own team; the last round
      // of the series gets the `gg` everyone can read. Both land inside this
      // map's recording, which is what a demo of it would carry too.
      if (isFirstMap && round === 1) say(t, 'pistol')
      if (mapIndex === mapWinners.length - 1 && round === roundWinners.length) say(t, 'end')

      if (isFirstMap && scenario.crashAfterRound === round) {
        return { beats, outcome: 'crashed', demos }
      }
    }

    t += 2_000
    emit(t, {
      type: 'map_end',
      matchId,
      source,
      mapNumber,
      map: decidedMap.map,
      score: { ...score },
      // Who won the rounds still decides the series; who is *named* is the
      // SDK's rule — a one-team mode names nobody (PRD-03 T9a/T10).
      winner: winnerOf(assignment, score.teamA, score.teamB),
    })
    announceDemo(mapNumber, decidedMap.map, mapStartIndex)
    if (mapWinner === 'team_a') seriesScore.teamA++
    else seriesScore.teamB++
  }

  t += 2_000
  emit(t, {
    type: 'series_end',
    matchId,
    source,
    seriesScore,
    winner: winnerOf(assignment, seriesScore.teamA, seriesScore.teamB),
  })
  return { beats, outcome: 'completed', demos }
}

function summarize(state: PlayerState): PlayerRoundSummary {
  return {
    player: { steamId64: state.player.steamId64, name: state.player.name, team: state.team },
    kills: state.kills,
    deaths: state.deaths,
    assists: state.assists,
    damage: state.damage,
    flashAssists: state.flashAssists,
    headshotKills: state.headshotKills,
    bombPlants: state.bombPlants,
    bombDefuses: state.bombDefuses,
    mvps: state.mvps,
    score: state.kills * 2 + state.assists + (state.bombPlants + state.bombDefuses) * 2,
  }
}

// ---------------------------------------------------------------------------
// The ephemeral tier's fiction
// ---------------------------------------------------------------------------

/** A wandering player's position, in whatever space the wanderer works in. */
interface WanderPoint {
  x: number
  y: number
}

/**
 * Where a simulated player stands, and where they drift to next.
 *
 * Two implementations, one shape, and the difference is only ever *which
 * space the walk happens in*:
 *
 * - **With a radar** the walk is in the map's own image pixels — two clusters
 *   at opposite ends of the picture, drifting, clamped to the image — and the
 *   contract's inverse transform turns each step into world units on the way
 *   out. So the dots are on the map a spectator is looking at, which is the
 *   whole reason the orchestrator tells a server what it is playing.
 * - **Without one** the walk is the arbitrary world-unit wander this file did
 *   before there was a minimap. A map nobody calibrated has no picture to be
 *   on, so there is nothing better to be, and the tier stays exercised.
 *
 * Both draw the same dice in the same order (two per spawn, two per step), so
 * whether a server was told about the map cannot change the match it plays.
 */
function wanderer(
  prng: Prng,
  radar: MapRadar | null,
): {
  spawn: (side: TeamSide) => WanderPoint
  step: (point: WanderPoint) => void
  world: (point: WanderPoint) => { x: number; y: number; z: number }
} {
  // The floor a viewer sees by default (layers are ordered top
  // floor first) — the simulator's people are all on one storey.
  const layer = radar?.layers[0] ?? null
  if (!layer) {
    return {
      spawn: side =>
        side === 'ct'
          ? { x: 1400 + prng.int(-150, 151), y: 2200 + prng.int(-150, 151) }
          : { x: -1450 + prng.int(-150, 151), y: -2350 + prng.int(-150, 151) },
      step: point => {
        point.x += prng.int(-320, 321)
        point.y += prng.int(-320, 321)
      },
      world: point => ({ x: point.x, y: point.y, z: 64 }),
    }
  }

  const size = layer.size
  // Wide enough that five people read as five dots at freeze rather than as
  // one blob with five names under it.
  const jitter = Math.round(size * 0.09)
  const stride = Math.round(size * 0.035)
  const edge = Math.round(size * 0.08)
  const clamp = (value: number) => Math.min(size - edge, Math.max(edge, value))
  // Two ends of the picture rather than the two spawns: which corner a side
  // starts in is per-map knowledge the catalog does not publish, and a
  // minimap of a simulated match is a demonstration, not a claim.
  const anchor = (side: TeamSide) =>
    side === 'ct' ? { x: size * 0.32, y: size * 0.34 } : { x: size * 0.66, y: size * 0.68 }
  // An altitude inside the layer being drawn, so `radarLayerFor` puts every
  // dot back on the image it was placed on (`zMin` is inclusive).
  const z = layer.zMin !== null ? layer.zMin + 32 : layer.zMax !== null ? layer.zMax - 32 : 64

  return {
    spawn: side => {
      const at = anchor(side)
      return {
        x: clamp(at.x + prng.int(-jitter, jitter + 1)),
        y: clamp(at.y + prng.int(-jitter, jitter + 1)),
      }
    },
    step: point => {
      point.x = clamp(point.x + prng.int(-stride, stride + 1))
      point.y = clamp(point.y + prng.int(-stride, stride + 1))
    },
    world: point => ({ ...radarToWorld(layer as MapRadarLayer, point), z }),
  }
}

interface RoundOptions {
  prng: Prng
  matchId: string
  source: GameserverSource
  emit: (atMs: number, event: GameserverEvent) => void
  players: PlayerState[]
  roster: (team: MatchTeam) => PlayerState[]
  asGameserverPlayer: (state: PlayerState) => GameserverPlayer
  tStart: number
  mapNumber: number
  round: number
  roundWinner: MatchTeam
  teamASide: TeamSide
  pistolRound: boolean
  lossStreak: Record<MatchTeam, number>
  positionTickIntervalMs: number | null
  /** This map's radar, or null: the ephemeral tier's positions are drawn on it. */
  radar: MapRadar | null
}

type DecisiveWinCondition = Exclude<RoundWinCondition, 'other'>

/**
 * One round's in-round events — kills, the bomb story, position ticks — in
 * time order, with the cumulative stats updated so the caller's `round_end`
 * summary is consistent with every kill that was shown.
 */
function playRound(options: RoundOptions): {
  durationMs: number
  winCondition: DecisiveWinCondition
} {
  const { prng, matchId, source, tStart, mapNumber, round, roundWinner, teamASide } = options

  // In-round events are collected and sorted so playback sees them in the
  // order a spectator would — the dice roll them in planning order.
  const roundBeats: { atMs: number; event: GameserverEvent }[] = []
  const emit = (atMs: number, event: GameserverEvent): void => {
    roundBeats.push({ atMs, event })
  }

  const winnerSide: TeamSide = roundWinner === 'team_a' ? teamASide : flip(teamASide)
  const loserTeam = other(roundWinner)

  // The win condition must match the winning side: only Ts win by explosion,
  // only CTs by defuse or the clock (`roundWinConditionSchema`).
  let winCondition: DecisiveWinCondition
  if (winnerSide === 't') {
    winCondition = prng.bool(0.55) ? 'elimination' : 'bomb_exploded'
  } else {
    const roll = prng.next()
    winCondition = roll < 0.55 ? 'elimination' : roll < 0.8 ? 'bomb_defused' : 'time_expired'
  }

  let plantAtMs: number | undefined
  let resolveAtMs: number | undefined
  let endMs: number
  if (winCondition === 'bomb_exploded') {
    plantAtMs = prng.int(30_000, 75_001)
    resolveAtMs = plantAtMs + BOMB_TIMER_MS
    endMs = resolveAtMs + 1_000
  } else if (winCondition === 'bomb_defused') {
    plantAtMs = prng.int(30_000, 75_001)
    resolveAtMs = plantAtMs + prng.int(8_000, 35_001)
    endMs = resolveAtMs + 1_000
  } else if (winCondition === 'time_expired') {
    endMs = ROUND_FULL_MS
  } else {
    endMs = prng.int(30_000, 95_001)
  }

  const winners = options.roster(roundWinner)
  const losers = options.roster(loserTeam)

  let loserDeaths: number
  let winnerDeaths: number
  if (winCondition === 'elimination') {
    loserDeaths = losers.length
    winnerDeaths = prng.int(0, winners.length)
  } else if (winCondition === 'time_expired') {
    loserDeaths = prng.int(1, Math.max(2, losers.length))
    winnerDeaths = prng.int(0, Math.max(1, winners.length - 1))
  } else {
    loserDeaths = prng.int(Math.min(2, losers.length), losers.length + 1)
    winnerDeaths = prng.int(0, winners.length)
  }
  winnerDeaths = Math.min(winnerDeaths, winners.length - 1)

  const plannedDeaths = [...prng.sample(losers, loserDeaths), ...prng.sample(winners, winnerDeaths)]
    .map(victim => ({ victim, atMs: prng.int(8_000, Math.max(9_000, endMs - 3_000)) }))
    .sort((a, b) => a.atMs - b.atMs)

  /** Emitted deaths only — a planned death nobody was alive to cause never happened. */
  const deathTime = new Map<string, number>()
  const aliveOf = (team: MatchTeam, atMs: number): PlayerState[] =>
    options
      .roster(team)
      .filter(p => (deathTime.get(p.player.steamId64) ?? Number.POSITIVE_INFINITY) > atMs)
  const weightedPick = (candidates: PlayerState[]): PlayerState => {
    const total = candidates.reduce((sum, p) => sum + p.skill, 0)
    let roll = prng.next() * total
    for (const candidate of candidates) {
      roll -= candidate.skill
      if (roll <= 0) return candidate
    }
    return candidates[candidates.length - 1] as PlayerState
  }

  const weaponFor = (killer: PlayerState, side: TeamSide): string => {
    const tier = options.pistolRound
      ? 'pistol'
      : options.lossStreak[killer.team] >= 2
        ? 'pistol'
        : options.lossStreak[killer.team] === 1
          ? 'smg'
          : 'rifle'
    if (tier === 'rifle' && prng.bool(0.18)) return 'awp'
    return prng.pick(WEAPONS[tier][side])
  }

  const roundKills = new Map<string, number>()
  for (const { victim, atMs } of plannedDeaths) {
    const opponents = aliveOf(other(victim.team), atMs)
    // Everyone on the other side is already down — nobody left to credit, so
    // this planned death simply never happens (stats stay consistent).
    if (opponents.length === 0) continue
    const killer = weightedPick(opponents)
    const killerSide = killer.team === 'team_a' ? teamASide : flip(teamASide)
    const weapon = weaponFor(killer, killerSide)
    const headshot = weapon === 'awp' ? prng.bool(0.15) : prng.bool(0.45)

    const assists: { player: GameserverPlayer; flash: boolean }[] = []
    if (prng.bool(0.4)) {
      const helpers = aliveOf(killer.team, atMs).filter(p => p !== killer)
      if (helpers.length > 0) {
        const helper = prng.pick(helpers)
        const flash = prng.bool(0.3)
        assists.push({ player: options.asGameserverPlayer(helper), flash })
        if (flash) helper.flashAssists++
        else helper.assists++
        helper.damage += prng.int(15, 61)
      }
    }

    deathTime.set(victim.player.steamId64, atMs)
    victim.deaths++
    killer.kills++
    killer.damage += prng.int(80, 141)
    if (headshot) killer.headshotKills++
    roundKills.set(killer.player.steamId64, (roundKills.get(killer.player.steamId64) ?? 0) + 1)

    emit(tStart + atMs, {
      type: 'player_death',
      matchId,
      source,
      mapNumber,
      roundNumber: round,
      victim: options.asGameserverPlayer(victim),
      killer: options.asGameserverPlayer(killer),
      assists,
      weapon,
      headshot,
      ...(weapon === 'awp' && prng.bool(0.05) ? { noscope: true } : {}),
      ...(prng.bool(0.08) ? { penetrated: true } : {}),
      ...(prng.bool(0.06) ? { throughSmoke: true } : {}),
      roundTimeMs: atMs,
    })
  }

  let bombPlan:
    | { planter: PlayerState; atMs: number; resolveAtMs: number; site: 'a' | 'b' }
    | undefined

  // The bomb story. The planter is a T alive at plant time — or, if the dice
  // killed every T first, whoever died last carries it (plausible enough).
  if (plantAtMs !== undefined && resolveAtMs !== undefined) {
    const tTeam: MatchTeam = teamASide === 't' ? 'team_a' : 'team_b'
    const planterPool = aliveOf(tTeam, plantAtMs)
    const planter =
      planterPool.length > 0 ? prng.pick(planterPool) : prng.pick(options.roster(tTeam))
    const site = prng.pick(['a', 'b'] as const)
    bombPlan = { planter, atMs: plantAtMs, resolveAtMs, site }
    planter.bombPlants++
    emit(tStart + plantAtMs, {
      type: 'bomb_planted',
      matchId,
      source,
      mapNumber,
      roundNumber: round,
      player: options.asGameserverPlayer(planter),
      site,
      roundTimeMs: plantAtMs,
    })
    if (winCondition === 'bomb_exploded') {
      emit(tStart + resolveAtMs, {
        type: 'bomb_exploded',
        matchId,
        source,
        mapNumber,
        roundNumber: round,
        site,
        roundTimeMs: resolveAtMs,
      })
    } else {
      const ctTeam = other(tTeam)
      const defuserPool = aliveOf(ctTeam, resolveAtMs)
      const defuser =
        defuserPool.length > 0 ? weightedPick(defuserPool) : prng.pick(options.roster(ctTeam))
      defuser.bombDefuses++
      emit(tStart + resolveAtMs, {
        type: 'bomb_defused',
        matchId,
        source,
        mapNumber,
        roundNumber: round,
        player: options.asGameserverPlayer(defuser),
        site,
        roundTimeMs: resolveAtMs,
      })
    }
  }

  // The ephemeral tier: low-rate position samples of whoever is still alive.
  // Never event-sourced — plausible wandering is all a minimap
  // owes anybody, and it is drawn *on the map being played* wherever the
  // orchestrator told this server what that map looks like.
  if (options.positionTickIntervalMs !== null) {
    const ground = wanderer(prng, options.radar)
    const positions = new Map(
      options.players.map(p => [
        p.player.steamId64,
        ground.spawn(p.team === 'team_a' ? teamASide : flip(teamASide)),
      ]),
    )
    // The utility layer (ezpug/ezpug-iron#5), on a fork of its own per round,
    // so the story's own dice fall exactly where they fell before it existed.
    const utilityPrng = prng.fork(`utility:${mapNumber}:${round}`)
    const tTeam: MatchTeam = teamASide === 't' ? 'team_a' : 'team_b'
    const diedAt = (steamId64: string): number =>
      deathTime.get(steamId64) ?? Number.POSITIVE_INFINITY
    const throws = planRoundUtility({
      prng: utilityPrng,
      idPrefix: `m${mapNumber}r${round}`,
      sides: (['team_a', 'team_b'] as const).map(team => ({
        side: team === tTeam ? 't' : 'ct',
        players: options.roster(team).map(p => p.player.steamId64),
      })),
      endMs,
      aliveAt: (steamId64, atMs) => diedAt(steamId64) > atMs,
    })
    const sampleUtility = utilitySampler(throws, options.positionTickIntervalMs)
    const tPlayers = options.roster(tTeam)
    const carrier =
      bombPlan?.planter.player.steamId64 ??
      (tPlayers.length > 0 ? utilityPrng.pick(tPlayers).player.steamId64 : undefined)
    let plantedAt: { x: number; y: number; z: number } | undefined
    const worldOf = (steamId64: string) => {
      const point = positions.get(steamId64)
      return point ? ground.world(point) : undefined
    }
    for (
      let atMs = options.positionTickIntervalMs;
      atMs < endMs;
      atMs += options.positionTickIntervalMs
    ) {
      const sampled = options.players.filter(p => diedAt(p.player.steamId64) > atMs)
      const tickPositions = sampled.map(p => {
        const point = positions.get(p.player.steamId64) as WanderPoint
        ground.step(point)
        return {
          steamId64: p.player.steamId64,
          ...ground.world(point),
          yaw: prng.int(0, 360),
        }
      })
      if (bombPlan && atMs >= bombPlan.atMs && !plantedAt)
        plantedAt = worldOf(bombPlan.planter.player.steamId64)
      const bomb = bombAt({
        atMs,
        carrier,
        carrierDiedAtMs: carrier === undefined ? 0 : diedAt(carrier),
        plant: bombPlan,
        plantedAt,
        positionOf: worldOf,
      })
      emit(tStart + atMs, {
        type: 'position_tick',
        matchId,
        source,
        mapNumber,
        roundNumber: round,
        positions: tickPositions,
        grenades: sampleUtility(atMs, worldOf),
        ...(bomb ? { bomb } : {}),
      })
    }
  }

  // MVP: the winning side's top fragger this round, if anyone fragged.
  const topFragger = winners
    .map(p => ({ p, kills: roundKills.get(p.player.steamId64) ?? 0 }))
    .sort((a, b) => b.kills - a.kills)[0]
  if (topFragger) (topFragger.kills > 0 ? topFragger.p : weightedPick(winners)).mvps++

  // Sorted, so playback shows the round the way a spectator saw it. The sort
  // is stable — simultaneous beats keep planning order.
  roundBeats.sort((a, b) => a.atMs - b.atMs)
  for (const beat of roundBeats) options.emit(beat.atMs, beat.event)

  return { durationMs: endMs, winCondition }
}

// ---------------------------------------------------------------------------
// A mode with a length
// ---------------------------------------------------------------------------

interface LengthOptions {
  prng: Prng
  matchId: string
  source: GameserverSource
  emit: (atMs: number, event: GameserverEvent) => void
  players: PlayerState[]
  asGameserverPlayer: (state: PlayerState) => GameserverPlayer
  /** `going_live`'s own instant: the duration is counted from here. */
  tStart: number
  length: GamemodeLength
  /** The manifest's `slots.teams`: at `1` everybody is everybody's enemy. */
  teams: number
  teamASide: TeamSide
  positionTickIntervalMs: number | null
  radar: MapRadar | null
}

/**
 * **The one round a mode with a length plays.** Bodies kill each other and
 * respawn until the manifest's duration runs out or somebody reaches its frag
 * limit, whichever comes first — no round ever ends, because on a real server
 * the SDK owns the clock (`mp_timelimit 0`, `mp_roundtime` at the engine's
 * maximum) and nothing in the game is counting to anything (PRD-03 T9).
 *
 * The kill feed is the only story there is, so it is the one told honestly:
 * attribution is skill-weighted as it is in a round, a corpse is out for
 * {@link RESPAWN_MS} and back, and in a free-for-all (`teams: 1`) a victim's
 * killer is anybody else alive rather than anybody on the other side —
 * `mp_teammates_are_enemies`, which is what such a mode's cfg sets.
 *
 * Everything is collected and sorted before it is handed on, as
 * {@link playRound} does: playback walks the list in the order a spectator saw
 * it, and the dice roll in planning order.
 */
function playLength(options: LengthOptions): { endAtMs: number; reason: MatchEndReason } {
  const { prng, matchId, source, tStart, players, length, teams, teamASide } = options
  const mapNumber = 1
  const roundNumber = 1

  const beats: { atMs: number; event: GameserverEvent }[] = []
  const emit = (atMs: number, event: GameserverEvent): void => {
    beats.push({ atMs, event })
  }

  const durationMs = length.durationSeconds === undefined ? null : length.durationSeconds * 1_000
  const fragLimit = length.fragLimit ?? null
  /** Mean seconds between two kills anywhere on the server, for this many people. */
  const meanGapMs = Math.max(600, Math.round(KILL_INTERVAL_PER_PLAYER_MS / players.length))
  const sideOf = (state: PlayerState): TeamSide =>
    state.team === 'team_a' ? teamASide : flip(teamASide)

  /** Out of the fight until this instant — a deathmatch corpse, not a round's. */
  const upAt = new Map<string, number>()
  const aliveAt = (atMs: number): PlayerState[] =>
    players.filter(state => (upAt.get(state.player.steamId64) ?? 0) <= atMs)
  const weightedPick = (candidates: PlayerState[]): PlayerState => {
    const total = candidates.reduce((sum, p) => sum + p.skill, 0)
    let roll = prng.next() * total
    for (const candidate of candidates) {
      roll -= candidate.skill
      if (roll <= 0) return candidate
    }
    return candidates[candidates.length - 1] as PlayerState
  }

  let reason: MatchEndReason = durationMs === null ? 'frag_limit' : 'time_limit'
  let endAtMs = durationMs === null ? Number.POSITIVE_INFINITY : tStart + durationMs
  // A frag limit without a duration still has to stop: the guard is generous
  // enough that only a story nobody could tell would reach it.
  const maxKills = fragLimit === null ? Number.POSITIVE_INFINITY : fragLimit * players.length * 8
  let dealt = 0

  for (let atMs = tStart + prng.int(2_000, 8_001); atMs < endAtMs; ) {
    if (dealt >= maxKills) break
    const standing = aliveAt(atMs)
    if (standing.length >= 2) {
      const victim = weightedPick(standing)
      const opponents = standing.filter(
        state => state !== victim && (teams === 1 || state.team !== victim.team),
      )
      if (opponents.length > 0) {
        const killer = weightedPick(opponents)
        const killerSide = sideOf(killer)
        // Everybody buys what they like in a mode with a length
        // (`mp_buy_anywhere`), so the tiers are the room's taste, not an economy.
        const tier = prng.bool(0.2) ? 'pistol' : prng.bool(0.25) ? 'smg' : 'rifle'
        const weapon =
          tier === 'rifle' && prng.bool(0.15) ? 'awp' : prng.pick(WEAPONS[tier][killerSide])
        const headshot = weapon === 'awp' ? prng.bool(0.15) : prng.bool(0.45)

        const assists: { player: GameserverPlayer; flash: boolean }[] = []
        if (prng.bool(0.25)) {
          const helpers = opponents.filter(state => state !== killer)
          if (helpers.length > 0) {
            const helper = prng.pick(helpers)
            const flash = prng.bool(0.3)
            assists.push({ player: options.asGameserverPlayer(helper), flash })
            if (flash) helper.flashAssists++
            else helper.assists++
            helper.damage += prng.int(15, 61)
          }
        }

        upAt.set(victim.player.steamId64, atMs + RESPAWN_MS)
        victim.deaths++
        killer.kills++
        killer.damage += prng.int(80, 141)
        if (headshot) killer.headshotKills++
        dealt++

        emit(atMs, {
          type: 'player_death',
          matchId,
          source,
          mapNumber,
          roundNumber,
          victim: options.asGameserverPlayer(victim),
          killer: options.asGameserverPlayer(killer),
          assists,
          weapon,
          headshot,
          ...(weapon === 'awp' && prng.bool(0.05) ? { noscope: true } : {}),
          ...(prng.bool(0.08) ? { penetrated: true } : {}),
          ...(prng.bool(0.06) ? { throughSmoke: true } : {}),
          roundTimeMs: atMs - tStart,
        })

        if (fragLimit !== null && killer.kills >= fragLimit) {
          reason = 'frag_limit'
          endAtMs = atMs + 1_000
          break
        }
      }
    }
    atMs += prng.int(Math.ceil(meanGapMs / 2), meanGapMs * 2)
  }

  if (!Number.isFinite(endAtMs)) endAtMs = tStart + (dealt > 0 ? meanGapMs : 0)

  // The ephemeral tier, the same low-rate sampling a round gets — of whoever
  // is on their feet, which in this mode is nearly everybody nearly always.
  if (options.positionTickIntervalMs !== null) {
    const ground = wanderer(prng, options.radar)
    const positions = new Map(
      players.map(state => [state.player.steamId64, ground.spawn(sideOf(state))]),
    )
    for (
      let atMs = tStart + options.positionTickIntervalMs;
      atMs < endAtMs;
      atMs += options.positionTickIntervalMs
    ) {
      const sampled = aliveAt(atMs)
      if (sampled.length === 0) continue
      emit(atMs, {
        type: 'position_tick',
        matchId,
        source,
        mapNumber,
        roundNumber,
        positions: sampled.map(state => {
          const point = positions.get(state.player.steamId64) as WanderPoint
          ground.step(point)
          return {
            steamId64: state.player.steamId64,
            ...ground.world(point),
            yaw: prng.int(0, 360),
          }
        }),
      })
    }
  }

  beats.sort((a, b) => a.atMs - b.atMs)
  for (const beat of beats) options.emit(beat.atMs, beat.event)
  return { endAtMs, reason }
}

// ---------------------------------------------------------------------------
// Resuming from a backup
// ---------------------------------------------------------------------------

/** Which backup a replacement server loads: the round it starts over from. */
export interface StoryResumePoint {
  mapNumber: number
  roundNumber: number
}

/**
 * The `plugin_event` a restored server emits before the map goes live again —
 * `@ezpug/protocol`'s `BACKUP_RESTORED_EVENT`, spelled again here because the
 * simulator stands beside a real plugin rather than behind its protocol. It is
 * what closes the orchestrator's recovery window (PRD-02 T37a); this story says
 * `going_live` after it too, which real MatchZy does not.
 */
export const BACKUP_RESTORED_EVENT = 'backup_restored'

export class SimulatorRestoreError extends Error {
  constructor(point: StoryResumePoint) {
    super(`simulator: no backup for map ${point.mapNumber} round ${point.roundNumber}`)
    this.name = 'SimulatorRestoreError'
  }
}

export interface ResumeStoryOptions {
  /** The full story of the match — built without a crash, from the match's seed. */
  story: MatchStory
  assignment: MatchAssignment
  source: GameserverSource
  point: StoryResumePoint
  /** Jitter for the reconnects; forked off the match stream so nothing else moves. */
  prng: Prng
  /** Game-time from `start()` until `server_ready`, like a cold boot. */
  bootDelayMs: number
}

/**
 * The story a replacement server tells after loading a round backup — what
 * MatchZy's `matchzy_loadbackup` looks like from the outside: the box boots,
 * everybody reconnects, the backup is restored, the map goes live again with
 * the sides stated, and play continues from that round's own `backup_written`
 * as the original story decided it. Everything before the round is gone from
 * this server's stream; the orchestrator already has it from the dead one.
 *
 * Deterministic: the same full story and the same point yield the same beats,
 * so a recovery flow is as reproducible as the crash that started it.
 */
export function resumeStory(options: ResumeStoryOptions): MatchStory {
  const { story, assignment, source, point, prng } = options
  const { matchId } = assignment
  const index = story.beats.findIndex(
    ({ event }) =>
      event.type === 'backup_written' &&
      event.mapNumber === point.mapNumber &&
      event.roundNumber === point.roundNumber,
  )
  if (index < 0) throw new SimulatorRestoreError(point)
  const map = assignment.maps[point.mapNumber - 1]?.map ?? assignment.maps[0]?.map ?? ''

  const beats: StoryBeat[] = []
  let t = options.bootDelayMs
  beats.push({ atMs: t, event: { type: 'server_ready', matchId, source, map } })

  const players: GameserverPlayer[] = [
    ...assignment.teamA.players.map(player => ({ ...player, team: 'team_a' as MatchTeam })),
    ...assignment.teamB.players.map(player => ({ ...player, team: 'team_b' as MatchTeam })),
  ]
  const arrivals = players
    .map(player => ({ player, atMs: t + prng.int(2_000, 15_001) }))
    .sort((a, b) => a.atMs - b.atMs)
  for (const { player, atMs } of arrivals) {
    beats.push({ atMs, event: { type: 'player_connected', matchId, source, player } })
  }
  t = (arrivals[arrivals.length - 1]?.atMs ?? t) + 5_000

  const backup = story.beats[index] as StoryBeat
  beats.push({
    atMs: t,
    event: {
      type: 'plugin_event',
      matchId,
      source,
      name: BACKUP_RESTORED_EVENT,
      data: {
        mapNumber: point.mapNumber,
        roundNumber: point.roundNumber,
        filename: (backup.event as { filename: string }).filename,
      },
    },
  })
  t += 3_000
  beats.push({
    atMs: t,
    event: { type: 'going_live', matchId, source, mapNumber: point.mapNumber, map },
  })

  // The sides at the resumed round, read off the round's own end — so a
  // consumer that lost the halftime `side_swap` with the dead server still
  // knows who is where.
  const roundEnd = story.beats.find(
    ({ event }) =>
      event.type === 'round_end' &&
      event.mapNumber === point.mapNumber &&
      event.roundNumber === point.roundNumber,
  )?.event
  if (roundEnd?.type === 'round_end') {
    const teamASide: TeamSide =
      roundEnd.winner.team === 'team_a' ? roundEnd.winner.side : flip(roundEnd.winner.side)
    beats.push({
      atMs: t,
      event: {
        type: 'side_swap',
        matchId,
        source,
        mapNumber: point.mapNumber,
        sides: { teamA: teamASide, teamB: flip(teamASide) },
      },
    })
  }

  const shift = t + 1_000 - backup.atMs
  for (const beat of story.beats.slice(index)) {
    beats.push({ atMs: beat.atMs + shift, event: beat.event })
  }
  return { beats, outcome: story.outcome, demos: story.demos }
}
