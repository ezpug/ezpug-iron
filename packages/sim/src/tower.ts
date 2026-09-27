/**
 * **A tower map's rules, as the map's own script plays them** (PRD-06 T2).
 * Rush is not the engine's game and not a plugin's: `maps/scripts/rush_001.vjs`
 * decides every round, so the simulator's job is to walk the same line by the
 * same rules and let `story.ts` tell each round. Read off the script on the
 * dev node's install (CS2 1.41.8.2), never copied:
 *
 * - **The line.** Seven rooms, drawn once per map: the T castle `401` at
 *   index 0, two mid rooms, a start room (`101`–`104`) at index 3, two more
 *   mid rooms, the CT castle `301` at index 6. The four mid rooms are four
 *   different arenas out of `201`–`212` (`RandomizeRooms`).
 * - **Who holds what.** The T side holds rooms 0–2 and CT holds 3–6 as the
 *   map begins, and a room keeps whoever won the last round played in it
 *   (`SetRoomControl` on every round end), so a room play walks back into is
 *   held by its last winner, not by the side whose half of the line it is on.
 * - **The walk.** A T win moves play one room towards the CT castle, a CT win
 *   one room towards the T castle; a win that would walk out past a castle
 *   ends the match there (`EndMatch`).
 * - **The rounds.** `mp_maxrounds 15`, clinched at 8 (`mp_match_can_clinch`).
 *   A round end at 7–7 swaps the next room for Convoy (`MaybeSwapInDeciderRoom`).
 *   Rounds are 40 s, 60 s in a castle and in Convoy (`RoundTimeMinutesForRoom`).
 * - **The short window.** When the side holding the tower is wiped out, the
 *   clock drops to at most 7 s (`COUNTDOWN_TIME_SECONDS`, flat on this build,
 *   the end rooms included) for the survivors to press the button.
 *
 * The script can also end a round drawn, when nobody owns the room. No room
 * is ever left unowned by a round that is played out, so no walk here draws.
 */
import type { Prng } from '@ezpug/core'
import type {
  EngineGame,
  RushRoomId,
  SimTowerEnding,
  TeamSide,
  TowerMapEnding,
} from '@ezpug/match-api'

/**
 * **The maps whose rounds are a tower script's**, and the engine game each is
 * played under. `rush_001` is `game_type 0` / `game_mode 6`, its own entry in
 * the node's `gamemodes.txt` and what `rush.cfg` sets (PRD-06 T1). Keyed on
 * the map rather than the mode because the rules live on the map: a server
 * that loads it plays tower rounds, whichever manifest asked.
 */
export const TOWER_MAPS: Readonly<Record<string, EngineGame>> = Object.freeze({
  rush_001: Object.freeze({ gameType: 0, gameMode: 6 }),
})

export function isTowerMap(map: string): boolean {
  return Object.hasOwn(TOWER_MAPS, map)
}

/** Where play starts, 0-based: the start room. On the wire it is room 4. */
export const TOWER_START_INDEX = 3
/** The T castle's index: a CT win here ends the match. */
const T_CASTLE_INDEX = 0
/** The CT castle's index: a T win here ends the match. */
const CT_CASTLE_INDEX = 6
export const TOWER_MAX_ROUNDS = 15
export const TOWER_ROUNDS_TO_WIN = 8
/** A mid room's and a start room's round. */
export const TOWER_ROUND_MS = 40_000
/** A castle's and Convoy's round. */
export const TOWER_LONG_ROUND_MS = 60_000
/** At most this long for the survivors to press once the tower's side is wiped out. */
export const TOWER_WINDOW_MS = 7_000

const START_ROOMS = ['101', '102', '103', '104'] as const satisfies readonly RushRoomId[]
const MID_ROOMS = [
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
] as const satisfies readonly RushRoomId[]

/** The seven rooms of one map, T castle first, as `RandomizeRooms` draws them. */
export function drawTowerLine(prng: Prng): RushRoomId[] {
  const mids = prng.sample([...MID_ROOMS], 4)
  return ['401', mids[0], mids[1], prng.pick(START_ROOMS), mids[2], mids[3], '301'] as RushRoomId[]
}

/** One round of the walk: where it was played, who held the tower as it began, who won it. */
export interface TowerRound {
  /** 0-based index on the line; the wire's `room` is this plus one. */
  index: number
  roomId: RushRoomId
  heldBy: TeamSide
  winner: TeamSide
  /** The round's clock: {@link TOWER_ROUND_MS}, or {@link TOWER_LONG_ROUND_MS} in a castle or Convoy. */
  clockMs: number
}

/** A tower map played out: every round, and how and where it ended. */
export interface TowerWalk {
  rounds: TowerRound[]
  ending: TowerMapEnding
  /** The side with more rounds, which is always the side that won the last one. */
  winner: TeamSide
}

const flip = (side: TeamSide): TeamSide => (side === 'ct' ? 't' : 'ct')

/**
 * The script's state for one map, stepped one round winner at a time. The
 * random walk and the replay of a forced one both go through it, so neither
 * can drift from the rules the other plays.
 */
class TowerLine {
  private index = TOWER_START_INDEX
  private readonly held: TeamSide[] = ['t', 't', 't', 'ct', 'ct', 'ct', 'ct']
  private readonly rooms: RushRoomId[]
  private readonly wins: Record<TeamSide, number> = { t: 0, ct: 0 }
  readonly rounds: TowerRound[] = []
  ending: TowerMapEnding | null = null

  constructor(line: readonly RushRoomId[]) {
    this.rooms = [...line]
  }

  get holder(): TeamSide {
    return this.held[this.index] as TeamSide
  }

  play(winner: TeamSide): void {
    if (this.ending) throw new Error('simulator: a tower map played past its end')
    const roomId = this.rooms[this.index] as RushRoomId
    const long =
      this.index === T_CASTLE_INDEX || this.index === CT_CASTLE_INDEX || roomId === 'convoy'
    this.rounds.push({
      index: this.index,
      roomId,
      heldBy: this.holder,
      winner,
      clockMs: long ? TOWER_LONG_ROUND_MS : TOWER_ROUND_MS,
    })
    this.held[this.index] = winner
    this.wins[winner] += 1
    const next = this.index + (winner === 't' ? 1 : -1)
    if (next < T_CASTLE_INDEX || next > CT_CASTLE_INDEX) {
      this.ending = 'castle'
      return
    }
    if (this.wins[winner] >= TOWER_ROUNDS_TO_WIN || this.rounds.length >= TOWER_MAX_ROUNDS) {
      this.ending = 'rounds'
      return
    }
    if (this.wins.t === TOWER_ROUNDS_TO_WIN - 1 && this.wins.ct === TOWER_ROUNDS_TO_WIN - 1)
      this.rooms[next] = 'convoy'
    this.index = next
  }
}

/** Replays a sequence of round winners along `line` by the script's rules. */
export function walkTower(line: readonly RushRoomId[], winners: readonly TeamSide[]): TowerWalk {
  const state = new TowerLine(line)
  for (const winner of winners) state.play(winner)
  const last = state.rounds[state.rounds.length - 1]
  if (!state.ending || !last) throw new Error('simulator: a tower walk that never ends')
  return { rounds: state.rounds, ending: state.ending, winner: last.winner }
}

/**
 * The chance the side holding the tower keeps it. A little over even: the
 * holders know the room and the attackers have to come to them.
 */
const HOLDER_WINS = 0.55

/**
 * **Who wins each round of a tower map that `winner` wins.** Left to the dice
 * the walk is the script's own, round by round, with the holders a little
 * favoured; a walk the other side won is mirrored, which is still a walk the
 * script plays (the line is symmetric about the start room, and so are the
 * castle and the round limits) and now ends on the same round in `winner`'s
 * favour. A forced ending is built straight from its shape instead:
 *
 * - `castle`: the loser takes 0–3 rounds and the winner four more, never four
 *   clear of the start until the last round, which walks out past the castle.
 * - `clinch`: the winner reaches eight with the loser on five or six, never
 *   four rooms clear either way. That is the only way to eight without a castle.
 * - `convoy`: fourteen rounds that leave it 7–7 back in the start room, then
 *   the winner takes Convoy.
 */
export function planTowerWalk(
  prng: Prng,
  line: readonly RushRoomId[],
  winner: TeamSide,
  forced?: SimTowerEnding,
): TowerWalk {
  if (forced === undefined) {
    const state = new TowerLine(line)
    while (!state.ending) state.play(prng.bool(HOLDER_WINS) ? state.holder : flip(state.holder))
    const winners = state.rounds.map(round => round.winner)
    const last = winners[winners.length - 1]
    return walkTower(line, last === winner ? winners : winners.map(flip))
  }
  const loser = flip(winner)
  let steps: boolean[]
  if (forced === 'castle') {
    const loserWins = prng.int(0, 4)
    steps = [...interleave(prng, loserWins + 3, loserWins), true]
  } else if (forced === 'clinch') {
    const loserWins = prng.int(TOWER_ROUNDS_TO_WIN - 3, TOWER_ROUNDS_TO_WIN - 1)
    steps = interleave(prng, TOWER_ROUNDS_TO_WIN, loserWins, true)
  } else {
    const even = TOWER_ROUNDS_TO_WIN - 1
    steps = [...interleave(prng, even, even), true]
  }
  return walkTower(
    line,
    steps.map(won => (won ? winner : loser)),
  )
}

/**
 * `wins` rounds for the winner and `losses` for the loser in a random order
 * that never walks four rooms from the start either way, so neither castle
 * falls early. With `winnerLast` the winner's last round is the sequence's
 * last, as a clinch must be. The bounds never trap the draw: whatever the
 * counts left, one of the two moves is always allowed.
 */
function interleave(prng: Prng, wins: number, losses: number, winnerLast = false): boolean[] {
  const reach = CT_CASTLE_INDEX - TOWER_START_INDEX
  const steps: boolean[] = []
  let net = 0
  let winsLeft = wins
  let lossesLeft = losses
  while (winsLeft > 0 || lossesLeft > 0) {
    const winOk = winsLeft > 0 && net < reach && (!winnerLast || winsLeft > 1 || lossesLeft === 0)
    const lossOk = lossesLeft > 0 && net > -reach
    if (!winOk && !lossOk) throw new Error('simulator: no tower walk fits these counts')
    const won = winOk && (!lossOk || prng.bool(winsLeft / (winsLeft + lossesLeft)))
    steps.push(won)
    if (won) {
      winsLeft -= 1
      net += 1
    } else {
      lossesLeft -= 1
      net -= 1
    }
  }
  return steps
}
