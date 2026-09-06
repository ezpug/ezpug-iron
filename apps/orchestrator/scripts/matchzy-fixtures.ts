/**
 * **The MatchZy door's fixtures, written from the recording** (PRD-02 T13).
 *
 *   pnpm --filter @ezpug/orchestrator fixtures:matchzy
 *
 * The payloads under `src/matchzy/fixtures/` are not invented: nine of them
 * are bytes a real MatchZy 0.8.15 sent to the door during
 * `scripts/iron-match.mjs` (kept whole in
 * `packages/protocol/fixtures/recorded/real-pug-matchzy.json`), and the rest
 * are those payloads edited into the cases one bots match on one map cannot
 * produce — a draw, a lost POST, a foreign `matchid` — plus the three events
 * our flow never produces at all, whose shape is read off MatchZy's own
 * source. `src/matchzy/fixtures.test.ts` holds that rule; this file is where
 * the plan lives and where a re-recording is folded in.
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

const context: MatchZyContext = {
  matchId: FIXTURE_MATCH_ID,
  source: { provider: 'nodes', serverId: 'devbox-1' },
  serial: matchzySerial(FIXTURE_MATCH_ID),
  maps: [{ map: 'de_dust2', sides: 'ct' }],
}

const RECORDING_PATH = 'packages/protocol/fixtures/recorded/real-pug-matchzy.json'

interface Plan {
  file: string
  source: 'recorded' | 'derived' | 'upstream'
  from: string
  note: string
  payload: Record<string, unknown>
  state?: MatchZyState
}

function round(index: number): Record<string, unknown> {
  const entry = recorded[index]
  if (!entry)
    throw new Error(`the recording has no event ${index} — re-record and revisit the plan`)
  return entry.payload
}
const scores = (team1: number, team2: number): MatchZyState => ({ scores: { 1: { team1, team2 } } })

const plan: Plan[] = [
  {
    file: '01-series-start.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'MatchZy fires it at the end of matchzy_loadmatch; server_ready and going_live bracket it in the vocabulary.',
    payload: round(0),
  },
  {
    file: '02-going-live.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'map_number is 0-based on the wire; the map name is the plan’s, MatchZy never sends it.',
    payload: round(1),
  },
  {
    file: '03-round-end-team-b.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'winner.side "2" is T as the engine numbers it; winner.team is the map leader, the delta 0-1 says team B.',
    payload: round(2),
  },
  {
    file: '04-round-end-repeated.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'MatchZy sent round 1 twice, a second apart, with the same score and a different reason. The second is a repeat and is dropped: a durable log that holds round 1 twice is one a client cannot count with.',
    payload: round(3),
  },
  {
    file: '05-round-end-team-a.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'winner.side "3" is CT; the delta 1-0 says team A took it, though MatchZy still names the leader.',
    payload: round(4),
  },
  {
    file: '06-round-end-bomb-defused.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'Reason 7 after the swap: team B is on CT now and defused.',
    payload: round(5),
  },
  {
    file: '07-round-end-clinch.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'The round that clinched the map at 1-3.',
    payload: round(6),
  },
  {
    file: '08-map-result-won.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'winner.side "2" and winner.team "team2"; the scores are what decides.',
    payload: round(7),
  },
  {
    file: '09-series-end-won.json',
    source: 'recorded',
    from: RECORDING_PATH,
    note: 'Sent moments after map_result, with time_until_restore.',
    payload: round(8),
  },
  {
    file: '10-round-end-after-a-lost-post.json',
    source: 'derived',
    from: '07-round-end-clinch.json',
    note: 'Round 3 never arrived (MatchZy does not retry). Round 4 shows both scores up by one: the side that won and the map plan’s schedule (team A started CT, round 4 is first half) decide, with a log line.',
    state: scores(1, 1),
    payload: {
      ...round(6),
      round_number: 4,
      team1: { ...(round(6).team1 as object), score: 2 },
      team2: { ...(round(6).team2 as object), score: 2 },
      winner: { side: 'ct', team: 'team1' },
    },
  },
  {
    file: '11-map-result-draw.json',
    source: 'derived',
    from: '08-map-result-won.json',
    note: 'A 2–2 map: MatchZy names team2 the winner of a tie (t1score > t2score is false); the scores say a draw. MatchZy itself then replays the map rather than ending the series — see docs/operations.md.',
    state: scores(2, 2),
    payload: {
      ...round(7),
      team1: { ...(round(7).team1 as object), score: 2, series_score: 0 },
      team2: { ...(round(7).team2 as object), score: 2, series_score: 0 },
    },
  },
  {
    file: '12-series-end-draw.json',
    source: 'derived',
    from: '09-series-end-won.json',
    note: 'A 0–0 series is a draw; "none" is not a team.',
    state: scores(2, 2),
    payload: {
      ...round(8),
      team1_series_score: 0,
      team2_series_score: 0,
      winner: { side: '2', team: 'none' },
    },
  },
  {
    file: '13-round-end-side-unreadable.json',
    source: 'derived',
    from: '07-round-end-clinch.json',
    note: 'A winner side that is neither a side nor a team number cannot become a round_end; the vocabulary insists on one.',
    state: scores(1, 1),
    payload: { ...round(6), winner: { side: 'spec', team: 'team1' } },
  },
  {
    file: '14-going-live-foreign-matchid.json',
    source: 'derived',
    from: '02-going-live.json',
    note: 'A MatchZy still talking about an earlier match on the same server.',
    state: initialMatchZyState(),
    payload: { ...round(1), matchid: 4711 },
  },
  {
    file: '15-map-vetoed.json',
    source: 'upstream',
    from: 'references/MatchZy/MapVeto.cs',
    note: 'The veto is the platform’s; the three veto events are dropped. Never seen on our wire — skip_veto is always true.',
    state: initialMatchZyState(),
    payload: {
      event: 'map_vetoed',
      matchid: matchzySerial(FIXTURE_MATCH_ID),
      team: 'team1',
      map_name: 'de_nuke',
    },
  },
  {
    file: '16-demo-upload-ended.json',
    source: 'upstream',
    from: 'references/MatchZy/DemoManagement.cs',
    note: 'The core plugin owns the upload (decision 10, T21); MatchZy’s own upload URL is never set, so it never sends this.',
    state: initialMatchZyState(),
    payload: {
      event: 'demo_upload_ended',
      matchid: matchzySerial(FIXTURE_MATCH_ID),
      map_number: 0,
      filename: '1083740696_map_0_de_dust2.dem',
      success: false,
    },
  },
  {
    file: '17-player-disconnect.json',
    source: 'upstream',
    from: 'references/MatchZy/Events.cs',
    note: 'The core plugin emits player_disconnected from the engine; nobody double-speaks. Bots never reach it either.',
    state: initialMatchZyState(),
    payload: { event: 'player_disconnect', matchid: matchzySerial(FIXTURE_MATCH_ID), player: 3 },
  },
]

// Only the fixtures: the folder's README is written by hand.
for (const name of readdirSync(DIR).filter(file => file.endsWith('.json'))) rmSync(`${DIR}${name}`)

let state = initialMatchZyState()
for (const entry of plan) {
  const result = translateMatchZyEvent(entry.payload, context, entry.state ?? state)
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
