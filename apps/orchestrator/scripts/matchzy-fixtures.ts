/**
 * **The MatchZy door's fixtures, written from the recording** (PRD-02 T13,
 * re-planned for MatchZy-Enhanced by PRD-03 T3).
 *
 *   pnpm --filter @ezpug/orchestrator fixtures:matchzy
 *
 * The payloads under `src/matchzy/fixtures/` are not invented: most of them
 * are bytes a real MatchZy sent to the door during `scripts/iron-match.mjs`
 * (kept whole in
 * `packages/protocol/fixtures/recorded/real-pug-matchzy.json`, re-recorded on
 * MatchZy-Enhanced 1.4.32 by T2), and the rest are those payloads edited into
 * the cases one bots match on one map cannot produce — a draw, a lost POST, a
 * foreign `matchid` — plus the events that run never produced at all, whose
 * shape is read off MatchZy's own source. `src/matchzy/fixtures.test.ts`
 * holds that rule; this file is where the plan lives and where a re-recording
 * is folded in.
 *
 * **Payloads are chosen by name and occurrence, never by index.** T2's
 * re-record put twenty `player_disconnect` payloads in front of the flow and
 * moved every position in the file; a plan that counted from zero would have
 * silently pinned the wrong bytes.
 *
 * The **expectations are computed, never typed**: this runs the translator
 * and writes what it said. That is not circular — `translate.test.ts` then
 * asserts the translator still says it, so the file is the diff a reader sees
 * when a rule moves, and the notes beside each payload are the argument for
 * why the new answer is right.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { FIXTURE_MATCH_ID } from '@ezpug/match-api/fixtures'
import { matchzySerial } from '../src/match-config/matchzy'
import {
  initialMatchZyState,
  type MatchZyContext,
  type MatchZyState,
  translateMatchZyEvent,
} from '../src/matchzy/translate'

const DIR = new URL('../src/matchzy/fixtures/', import.meta.url).pathname
const RECORDING = '../../../packages/protocol/fixtures/recorded/real-pug-matchzy.json'
const recorded = (
  JSON.parse(readFileSync(new URL(RECORDING, import.meta.url).pathname, 'utf8')) as {
    events: { name: string; payload: Record<string, unknown> }[]
  }
).events

/** The two rostered SteamIDs the whole fixture set uses (`@ezpug/match-api/fixtures`). */
const TK = '76561198279375306'
const MAEX = '76561198279375307'
/**
 * **The roster the recorded pug was played with** (PRD-03 T5): ten puppets,
 * `scripts/iron-match.mjs`'s own, counted out from tk and maex alternately so
 * team A opens with tk and team B with maex. The door holds a `team_ready`
 * against this — MatchZy calls a team through the gate while its bots are
 * still being mapped — so the fixtures' context has to be the ten the
 * recording had, not a stand-in.
 */
const PUPPETS = Array.from({ length: 10 }, (_, index) => String(76561198279375306n + BigInt(index)))
const TEAM_A = PUPPETS.filter((_, index) => index % 2 === 0)
const TEAM_B = PUPPETS.filter((_, index) => index % 2 === 1)

const context: MatchZyContext = {
  matchId: FIXTURE_MATCH_ID,
  source: { provider: 'nodes', serverId: 'devbox-1' },
  serial: matchzySerial(FIXTURE_MATCH_ID),
  maps: [{ map: 'de_dust2', sides: 'ct' }],
  // The names the recorded run's config carried, and a roster of one a side
  // so a ready event's SteamID resolves without leaning on those names.
  teams: {
    teamA: { name: 'EZPug A', players: TEAM_A },
    teamB: { name: 'EZPug B', players: TEAM_B },
  },
  // The recorded run asked for `minPlayersToReady: 0` — the fork's "everybody
  // connected must ready" — so the roster is the only thing a `team_ready` is
  // held against here (PRD-03 T5a).
  readyFloor: 0,
}

/**
 * **The uneven roster, for the one case a 5v5 cannot make** (PRD-03 T6): the
 * 2v1 the matrix played, tk and puppet-3 against maex. Its `players_per_team`
 * is **one** — the smaller team's, because MatchZy has one number for both
 * sides and the larger team's would refuse the single player for ever (T1) —
 * and that is what makes the fork's `total_ready >= players_per_team × 2`
 * announce a room of three all ready at two.
 */
const UNEVEN: MatchZyContext['teams'] = {
  teamA: { name: 'EZPug A', players: [TEAM_A[0], TEAM_A[1]] as string[] },
  teamB: { name: 'EZPug B', players: [TEAM_B[0]] as string[] },
}

const RECORDING_PATH = 'packages/protocol/fixtures/recorded/real-pug-matchzy.json'
const ENHANCED = 'references/MatchZy-Enhanced/src'
const SERIAL = matchzySerial(FIXTURE_MATCH_ID)

interface Plan {
  file: string
  source: 'recorded' | 'derived' | 'upstream'
  from: string
  note: string
  payload: Record<string, unknown>
  state?: MatchZyState
  /** The floor this payload's match config carried, when it was not the recorded run's `0` (PRD-03 T5a). */
  readyFloor?: number
  /** The roster this payload's match had, when it was not the recorded run's ten (PRD-03 T6). */
  teams?: MatchZyContext['teams']
}

/** The first payload under `name` that answers `pick` — the SteamID, usually. */
function where(
  name: string,
  pick: (payload: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  const entry = recorded.filter(item => item.name === name).find(item => pick(item.payload))
  if (!entry)
    throw new Error(
      `no ${name} payload in the recording answers that — re-record and revisit the plan`,
    )
  return entry.payload
}

/** The SteamID a ready payload names, however the fork spelled the player. */
function readySteamId(payload: Record<string, unknown>): string {
  return String((payload.player as { steamid?: unknown } | undefined)?.steamid ?? '')
}

/**
 * **The two payloads of a player who readied twice.** The fork's reconcile
 * pass re-readies a slot whose bot was remapped, so a pug of ten puppets sends
 * eleven or twelve `player_ready` (PRD-03 T5, measured twice on the dev node).
 * The pair is what pins the door saying where one person stands exactly once.
 */
function readiedTwice(): [Record<string, unknown>, Record<string, unknown>] {
  const readies = recorded.filter(item => item.name === 'player_ready').map(item => item.payload)
  for (const [index, payload] of readies.entries()) {
    const again = readies
      .slice(index + 1)
      .find(other => readySteamId(other) === readySteamId(payload))
    if (again) return [payload, again]
  }
  throw new Error(
    'no puppet readied twice in this recording — drop 40/41 from the plan, or record a run where one did',
  )
}

/** The `nth` payload the recording holds under `name` — never a bare index. */
function at(name: string, nth = 0): Record<string, unknown> {
  const matches = recorded.filter(entry => entry.name === name)
  const entry = matches[nth]
  if (!entry)
    throw new Error(
      `the recording holds ${matches.length} ${name} payload(s), not ${nth + 1} — re-record and revisit the plan`,
    )
  return entry.payload
}

const scores = (team1: number, team2: number): MatchZyState => ({
  scores: { 1: { team1, team2 } },
  starts: {},
  ready: {},
})
const fresh = (): MatchZyState => initialMatchZyState()

const plan: Plan[] = [
  // ------------------------------------------------------- the recorded run
  {
    file: '01-series-start.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'MatchZy fires it at the end of matchzy_loadmatch; server_ready and going_live bracket it in the vocabulary.',
    payload: at('series_start'),
  },
  {
    file: '02-demo-recording-start.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'New in the fork. The core plugin owns the demo (decision 10) and says demo_available when the file is there; MatchZy starting its recorder is not a fact of ours.',
    payload: at('demo_recording_start'),
  },
  {
    file: '03-warmup-ended.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'New in the fork, and deliberately not vocabulary: Utility.cs sends it from StartKnifeRound and StartLive, and in both the very next event (knife_round_started, going_live) says the same moment better.',
    payload: at('warmup_ended'),
  },
  {
    file: '04-going-live.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'map_number is 0-based on the wire; the map name is the plan’s, MatchZy never sends it.',
    payload: at('going_live'),
  },
  {
    file: '05-round-start.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'New in the fork, and a hole it fills: MatchZyFlow never emitted round_start, so a pug’s durable log had no round start at all. round_number is already 1-based here.',
    payload: at('round_started', 0),
  },
  {
    file: '06-round-start-repeated.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'The engine restarts the round at go-live and MatchZy forwards each one: the run opens with three identical round 1 payloads. The same round at the same score is a repeat.',
    payload: at('round_started', 1),
  },
  {
    file: '07-round-end-warmup.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'Reason 16 (GameCommencing) at 0–0, before anybody has played a round: a round_end whose scores sum to zero is not a round.',
    payload: at('round_end', 0),
  },
  {
    file: '08-round-end-team-b.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'winner.side "2" is T as the engine numbers it; winner.team is the map leader, the delta 0-1 says team B.',
    payload: at('round_end', 1),
  },
  {
    file: '09-round-start-second.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'Round 2, carrying the score it starts from — what the vocabulary’s optional round_start score is for.',
    payload: at('round_started', 3),
  },
  {
    file: '10-round-end-bomb-exploded.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'Reason 1: the bomb went off, still on the first half’s sides.',
    payload: at('round_end', 2),
  },
  {
    file: '11-halftime-started.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'New in the fork. side_swap says halftime, and the core plugin’s MatchZyFlow is what emits side_swap.',
    payload: at('halftime_started'),
  },
  {
    file: '12-side-swap.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'New in the fork, and dropped: the core plugin emitted its own side_swap in this very match (real-pug-link.json). Decision 19 — neither double-speaks.',
    payload: at('side_swap'),
  },
  {
    file: '13-round-start-third.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'Round 3, after the swap.',
    payload: at('round_started', 4),
  },
  {
    file: '14-round-end-clinch.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'The round that clinched the map at 0-3; winner.side "3" is CT.',
    payload: at('round_end', 3),
  },
  {
    file: '15-map-result-won.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'winner.side "3" and winner.team "team2"; the scores are what decides.',
    payload: at('map_result'),
  },
  {
    file: '16-series-end-won.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'Sent moments after map_result, with time_until_restore.',
    payload: at('series_end'),
  },
  {
    file: '17-demo-recording-stop.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'The other half of the fork’s recorder pair; the core plugin’s demo_available is the fact.',
    payload: at('demo_recording_stop'),
  },
  {
    file: '18-player-disconnect.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'The fork sends one per bot at the end of the match, steamid "0" and all. The core plugin emits player_disconnected from the engine; nobody double-speaks.',
    payload: at('player_disconnect'),
  },

  // --------------------------------------------- edited from a recorded one
  {
    file: '19-round-end-after-a-lost-post.json',
    source: 'derived',
    from: '14-round-end-clinch.json',
    note: 'Round 3 never arrived (MatchZy does not retry). Round 4 shows both scores up by one: the side that won and the map plan’s schedule (team A started CT, round 4 is first half) decide, with a log line.',
    state: scores(1, 1),
    payload: {
      ...at('round_end', 3),
      round_number: 4,
      team1: { ...(at('round_end', 3).team1 as object), score: 2 },
      team2: { ...(at('round_end', 3).team2 as object), score: 2 },
      winner: { side: 'ct', team: 'team1' },
    },
  },
  {
    file: '20-round-start-after-a-restore.json',
    source: 'derived',
    from: '13-round-start-third.json',
    note: 'A backup restored to round 3 at a different score. The repeat rule keys on the round number *and* the score, so a restore is not mistaken for a go-live restart.',
    state: { scores: {}, starts: { 1: { roundNumber: 3, team1: 0, team2: 2 } }, ready: {} },
    payload: { ...at('round_started', 4), team1_score: 1, team2_score: 1 },
  },
  {
    file: '21-map-result-draw.json',
    source: 'derived',
    from: '15-map-result-won.json',
    note: 'A 2–2 map: MatchZy names team2 the winner of a tie (t1score > t2score is false); the scores say a draw. MatchZy itself then replays the map rather than ending the series — see docs/operations.md.',
    state: scores(2, 2),
    payload: {
      ...at('map_result'),
      team1: { ...(at('map_result').team1 as object), score: 2, series_score: 0 },
      team2: { ...(at('map_result').team2 as object), score: 2, series_score: 0 },
    },
  },
  {
    file: '22-series-end-draw.json',
    source: 'derived',
    from: '16-series-end-won.json',
    note: 'A 0–0 series is a draw; "none" is not a team.',
    state: scores(2, 2),
    payload: {
      ...at('series_end'),
      team1_series_score: 0,
      team2_series_score: 0,
      winner: { side: '2', team: 'none' },
    },
  },
  {
    file: '23-round-end-side-unreadable.json',
    source: 'derived',
    from: '14-round-end-clinch.json',
    note: 'A winner side that is neither a side nor a team number cannot become a round_end; the vocabulary insists on one.',
    state: scores(1, 1),
    payload: { ...at('round_end', 3), winner: { side: 'spec', team: 'team1' } },
  },
  {
    file: '24-going-live-foreign-matchid.json',
    source: 'derived',
    from: '04-going-live.json',
    note: 'A MatchZy still talking about an earlier match on the same server.',
    state: fresh(),
    payload: { ...at('going_live'), matchid: 4711 },
  },

  // ----------- the fork's own events, shaped from its source (PRD-03 T3/T5)
  {
    file: '25-player-ready.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'A puppet readying up through MatchZy’s own ready system (PRD-03 T5) — tk’s, of the ten, because the SteamID the request named is what the team comes from, never the free team name beside it.',
    payload: where('player_ready', payload => readySteamId(payload) === TK),
  },
  {
    file: '26-player-unready.json',
    source: 'upstream',
    from: `${ENHANCED}/ReadyEventHelpers.cs`,
    note: 'Somebody took their ready back; the tally is the whole gate as of that moment. Still upstream-shaped: puppets ready up and never change their mind, so no recorded run has produced one.',
    state: fresh(),
    payload: {
      event: 'player_unready',
      matchid: SERIAL,
      player: { steamid: MAEX, name: 'maex', team: 'EZPug B' },
      team: 'EZPug B',
      ready_count_team1: 1,
      ready_count_team2: 0,
      total_ready: 1,
      expected_total: 2,
    },
  },
  {
    file: '27-player-ready-bot.json',
    source: 'upstream',
    from: `${ENHANCED}/SimulationMode.cs`,
    note: 'BuildPlayerInfo falls back to the engine’s SteamID, which is "0" for a bot outside simulation mode. A ready with no SteamID64 cannot be attributed and is dropped rather than guessed at.',
    state: fresh(),
    payload: {
      event: 'player_ready',
      matchid: SERIAL,
      player: { steamid: '0', name: 'Romanov', team: 'EZPug B' },
      team: 'EZPug B',
      ready_count_team1: 1,
      ready_count_team2: 1,
      total_ready: 2,
      expected_total: 2,
    },
  },
  {
    file: '28-team-ready.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'Here the team really is "team1"/"team2". MatchZy sends this team’s count and the total, so the other team’s is the difference — and whether a team has passed the gate is MatchZy’s judgement, never a number a client recomputes (the 2026-09-18 stall, T1). The first the recorded pug sent with anybody ready on the team; 42 and 44 are the two that say nothing.',
    payload: where('team_ready', payload => Number(payload.ready_count) === 5),
  },
  {
    file: '29-all-players-ready.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'Both teams through the gate, ten of ten. countdown_started is what a lobby turns into a countdown; going_live still follows, after the knife round where there is one.',
    payload: at('all_players_ready', 0),
  },
  {
    file: '30-knife-round-started.json',
    source: 'upstream',
    from: `${ENHANCED}/Utility.cs`,
    note: 'Only a map whose sides are knifed for has one, and the recorded pug’s map plan is ct — so no run has produced it yet.',
    state: fresh(),
    payload: { event: 'knife_round_started', matchid: SERIAL, map_number: 0 },
  },
  {
    file: '31-knife-round-ended.json',
    source: 'upstream',
    from: `${ENHANCED}/MatchZy.cs`,
    note: 'The winner picks the side. The pick itself arrives as the core plugin’s side_swap when they swap, and as nothing at all when they stay.',
    state: fresh(),
    payload: { event: 'knife_round_ended', matchid: SERIAL, map_number: 0, winner: 'team1' },
  },
  {
    file: '32-knife-round-ended-none.json',
    source: 'upstream',
    from: `${ENHANCED}/MatchZy.cs`,
    note: 'MatchZy writes "none" when reverseTeamSides holds no entry for the winning side. The fact still travels — the knife happened — with nobody credited, and a log line.',
    state: fresh(),
    payload: { event: 'knife_round_ended', matchid: SERIAL, map_number: 0, winner: 'none' },
  },
  {
    file: '33-server-health.json',
    source: 'upstream',
    from: `${ENHANCED}/Events.cs`,
    note: 'Server-level, not a match fact. The door reads it for the log: sqlite and db_ok is the shape T2’s cfg check exists to guarantee.',
    state: fresh(),
    payload: {
      event: 'server_health',
      server_id: 'devbox-1',
      plugin_version: '1.4.32',
      timestamp: 1_758_312_168,
      db_ok: true,
      db_type: 'sqlite',
      reason: 'startup',
    },
  },
  {
    file: '34-server-health-failing.json',
    source: 'upstream',
    from: `${ENHANCED}/Events.cs`,
    note: 'A db_type that is not sqlite means the multi-server database came on, which T2’s off-list forbids. Still not a fact — the log is where an operator meets it.',
    state: fresh(),
    payload: {
      event: 'server_health',
      server_id: 'devbox-1',
      plugin_version: '1.4.32',
      timestamp: 1_758_312_168,
      db_ok: false,
      db_type: 'mysql',
      db_error: 'connection refused',
      reason: 'periodic',
    },
  },
  {
    file: '35-server-configured.json',
    source: 'upstream',
    from: `${ENHANCED}/Events.cs`,
    note: 'The fork announcing which remote log it will POST to. The token rides in a header, never here.',
    state: fresh(),
    payload: {
      event: 'server_configured',
      server_id: 'devbox-1',
      hostname: 'EZPug · pug · Dust II',
      plugin_version: '1.4.32',
      remote_log_url: 'http://172.17.0.1:3430/matchzy/log',
      timestamp: 1_758_312_168,
      configured_by: 'console',
    },
  },
  {
    file: '36-match-paused.json',
    source: 'upstream',
    from: `${ENHANCED}/Events.cs`,
    note: 'New in the fork and dropped: MatchZyFlow polls the gamerules and emits match_paused itself, knowing the kind and who asked. Decision 19 — neither double-speaks.',
    state: fresh(),
    payload: {
      event: 'match_paused',
      matchid: SERIAL,
      map_number: 0,
      paused_by: 'EZPug A',
      is_tactical: true,
      is_admin: false,
      pause_time: 30,
    },
  },
  {
    file: '37-demo-upload-ended.json',
    source: 'upstream',
    from: `${ENHANCED}/DemoManagement.cs`,
    note: 'The core plugin owns the upload (decision 10, T21); MatchZy’s own upload URL is never set, so it never sends this.',
    state: fresh(),
    payload: {
      event: 'demo_upload_ended',
      matchid: SERIAL,
      map_number: 0,
      filename: '1083740696_map_0_de_dust2.dem',
      success: false,
    },
  },
  {
    file: '38-map-vetoed.json',
    source: 'upstream',
    from: 'references/MatchZy/MapVeto.cs',
    note: 'The veto is the platform’s; the three veto events are dropped. The fork has no MapVeto.cs at all, so it cannot send one — the name stays in the table because a cfg can never bring it back.',
    state: fresh(),
    payload: { event: 'map_vetoed', matchid: SERIAL, team: 'team1', map_name: 'de_nuke' },
  },
  {
    file: '39-player-connect.json',
    source: 'upstream',
    from: `${ENHANCED}/Events.cs`,
    note: 'New in the fork, synthesised because EventPlayerConnectFull is unreliable for bots. The core plugin reads the engine and emits player_connected; nobody double-speaks.',
    state: fresh(),
    payload: {
      event: 'player_connect',
      matchid: SERIAL,
      player: { steamid: TK, name: 'tk', team: 'EZPug A' },
    },
  },
  // ------------------------------- what the gate says twice, and the door once
  //
  // These four carry the state the four above left, which is the point: the
  // fork re-checks the ready gate after every single ready and re-POSTs what
  // still holds, and its reconcile pass readies a slot whose bot was remapped.
  // A durable log holds facts (PRD-03 T5, `matchzy/translate.ts`).
  {
    file: '40-player-ready-remapped.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'The puppet whose bot the reconcile pass remapped, readying the first time.',
    payload: readiedTwice()[0],
  },
  {
    file: '41-player-ready-repeated.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'The same puppet, readied a second time by the reconcile pass with nothing in between — already ready, and dropped. Ten puppets sent eleven and twelve of these on the two recorded runs.',
    payload: readiedTwice()[1],
  },
  {
    file: '42-team-ready-repeated.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: '28 again, byte for byte: the fork re-announces every team still through the gate on every later ready, twice over from two call sites. A team passes the gate once.',
    payload: where('team_ready', payload => Number(payload.ready_count) === 5),
  },
  {
    file: '43-all-players-ready-repeated.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: '29 again: the same counts, already said. The counts as they move are player_ready’s, which carries the whole tally on every single ready.',
    payload: at('all_players_ready', 0),
  },
  {
    file: '44-team-ready-half-filled.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'The first team_ready of every recorded puppet pug, before a single player_ready: the fork decides IsTeamReady from the CT/T side and counts from the logical team slots, and while the bots are still being spawned and mapped the two disagree — here at none of five. A team nobody on it has readied for has passed nothing, and forwarding it would spend the edge on a transient so the real passage is dropped.',
    payload: at('team_ready', 0),
  },
  // ------------------------------------------- the floor a slack gate sets
  {
    file: '45-team-ready-on-the-floor.json',
    source: 'derived',
    from: '28-team-ready.json',
    readyFloor: 4,
    state: fresh(),
    note: 'The one passage T5 dropped (PRD-03 T5a). A 5v5 whose request asked minPlayersToReady: 8 carries min_players_to_ready: 4, and MatchZy-Enhanced’s IsTeamReady passes a side at four ready with its fifth still silent — so this is a fact, and holding it against the whole roster made the durable log say the team passed one puppet later than it did. 28 with ready_count 4 and total_ready 6, which is byte for byte what the gate-of-four pug on the dev node sent: eleven of its forty-six team_ready payloads read exactly this.',
    payload: {
      ...where('team_ready', payload => Number(payload.ready_count) === 5),
      ready_count: 4,
      total_ready: 6,
    },
  },
  {
    file: '46-team-ready-under-the-floor.json',
    source: 'derived',
    from: '28-team-ready.json',
    readyFloor: 4,
    state: fresh(),
    note: 'The same match one ready earlier. The fork re-checks the gate after every single ready and the side count runs ahead of the logical one while its bots are mapped, so three of five is announced too — under the floor, and the sides are still being filled. The gate-of-four run sent five of these and the door said nothing to any of them.',
    payload: {
      ...where('team_ready', payload => Number(payload.ready_count) === 5),
      ready_count: 3,
      total_ready: 5,
    },
  },
  // ------------------------------------------ one number for two teams
  //
  // The 2v1 the matrix played (PRD-03 T6). `players_per_team` is the smaller
  // team's (T1, because one number has to let both sides through), so the
  // fork's `total_ready >= players_per_team × 2` calls the whole room ready
  // at two of three — while team A still holds a player who has said nothing.
  {
    file: '47-all-ready-under-a-side.json',
    source: 'derived',
    from: '29-all-players-ready.json',
    teams: UNEVEN,
    state: fresh(),
    note: 'What the uneven 2v1 on the dev node really sent, and the reason T6 went red. players_per_team is 1 there — the smaller team’s — so the fork announced the whole room ready on total_ready 2 while team A had one of its two still silent, and a client drawing "everybody’s in" would have drawn it a player early. Held against each side’s own floor instead, this says nothing.',
    payload: {
      ...where('all_players_ready', payload => Number(payload.total_ready) === 10),
      ready_count_team1: 1,
      ready_count_team2: 1,
      total_ready: 2,
    },
  },
  {
    file: '48-all-ready-when-both-sides-are.json',
    source: 'derived',
    from: '29-all-players-ready.json',
    teams: UNEVEN,
    state: fresh(),
    note: 'The same 2v1 one ready later: team A’s second player has said yes, both sides are through their own gate, and this is the one all_ready the room is owed. The fork sent four more identical to it and the door says it once.',
    payload: {
      ...where('all_players_ready', payload => Number(payload.total_ready) === 10),
      ready_count_team1: 2,
      ready_count_team2: 1,
      total_ready: 3,
    },
  },
  // ------------------------------------------ a rewind on a live server
  {
    file: '49-backup-loaded.json',
    source: 'upstream',
    from: `${ENHANCED}/BackupManagement.cs`,
    note: 'PRD-04 T8: MatchZy handed the engine the backup of round 4, the round being played (an admin’s restore — somebody’s machine crashed). Dropped, because the core plugin says the restore; what it changes is the door’s memory of map 1 — its last start and score are forgotten, so the round played again is not dropped as a go-live repeat (translate.test.ts plays that chain).',
    state: {
      scores: { 1: { team1: 1, team2: 2 } },
      starts: { 1: { roundNumber: 4, team1: 1, team2: 2 } },
      ready: {},
    },
    payload: {
      event: 'backup_loaded',
      matchid: SERIAL,
      map_number: 0,
      round_number: 3,
      filename: `matchzy_${SERIAL}_0_round03.json`,
    },
  },
]

// Only the fixtures: the folder's README is written by hand.
for (const name of readdirSync(DIR).filter(file => file.endsWith('.json'))) rmSync(`${DIR}${name}`)

let state = initialMatchZyState()
for (const entry of plan) {
  const result = translateMatchZyEvent(
    entry.payload,
    {
      ...context,
      ...(entry.readyFloor !== undefined && { readyFloor: entry.readyFloor }),
      ...(entry.teams !== undefined && { teams: entry.teams }),
    },
    entry.state ?? state,
  )
  if (entry.state === undefined) state = result.state
  const expected: Record<string, unknown> = result.dropped
    ? { dropped: result.dropped }
    : { events: result.events }
  if (result.note) expected.note = true
  const file = {
    source: entry.source,
    from: entry.from,
    note: entry.note,
    ...(entry.state !== undefined && { state: entry.state }),
    ...(entry.readyFloor !== undefined && { readyFloor: entry.readyFloor }),
    ...(entry.teams !== undefined && { teams: entry.teams }),
    payload: entry.payload,
    expect: expected,
  }
  writeFileSync(`${DIR}${entry.file}`, `${JSON.stringify(file, null, 2)}\n`)
  console.log(
    entry.file,
    result.dropped ? `dropped: ${result.dropped}` : `${result.events.length} event(s)`,
    result.note ? `note: ${result.note}` : '',
  )
}
