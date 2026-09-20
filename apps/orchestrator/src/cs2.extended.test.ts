import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { loadRootEnv } from './env'

/**
 * **The `EZPUG_CS2_TESTS` lane** (PRD-02 T13, re-pointed at the front door by
 * PRD-03 T5, made a matrix by T6): whole matches on real hardware, asserted.
 * **Puppets** play them on a CS2 container an `ezpug-node` on this box
 * started, MatchZy runs the match, the core plugin speaks the vocabulary over
 * its link, and the client — `scripts/iron-match.mjs`, the same script an
 * operator runs — watches it through nothing but the Match API.
 *
 * **Nobody types `css_start` any more.** Every case is `--simulate`: each
 * roster entry is a SteamID a MatchZy-Enhanced bot answers for, and they
 * ready up through `OnPlayerReady` — the handler `.ready` calls. So the ready
 * gate T1 fixed, the ready events T3 gave the vocabulary and the switches T3a
 * turned on are all on the path of every run here, where an RCON shortcut used
 * to be four assertions skipped. The escape hatch still exists
 * (`--force-start`) and **no case takes it**: each one asserts its own
 * `commands.rcon`, so "nothing typed at the match" is a measurement of the run
 * rather than a claim about the code. Exactly one row declares a number above
 * zero — `drop`, whose stimulus has no front door until T7a — and it says why.
 *
 * **The matrix** (T6) is every shape of match the owner's two weeks of bugs
 * came out of, and one row each:
 *
 *  - a `pug` at **every size from one to five a side**, because the
 *    2026-09-18 stall was a 1v1 carrying a 5v5's `players_per_team` and the
 *    only size ever played here was ten;
 *  - **2v1**, uneven, which is the same bug wearing the other roster and what
 *    the platform's PRD-10 T1 lets a custom match ask for;
 *  - **wingman**, T3b's second format, which is a different engine game;
 *  - **a knifed map**, where a room of puppets never types `.stay` and the
 *    side-selection timer T3a turned on is the only thing that can decide it;
 *  - **a pause and an unpause** through the Match API, the facts for which are
 *    the core plugin's and not MatchZy's (T3);
 *  - **a puppet leaving and coming back**, the one thing that holds a loaded
 *    match at the gate.
 *
 * The stall itself is reproduced red one floor down, where it lives and where
 * it costs nothing: `match-config/matchzy.test.ts` replays MatchZy's own
 * `IsTeamReady` against the builder's output and forces the manifest's five
 * back in for a 1v1 ("is the stall itself when the manifest's five is sent for
 * a 1v1"). This lane is the other half — the same roster on a real server.
 *
 * **It shells out to that script on purpose.** The flow is one thing, not two:
 * a test that reimplemented "create a match, roster the puppets, wait" would
 * be a second answer to how a match is played, and the two would drift. The
 * script prints its summary as JSON; this file is the assertions.
 *
 * The demo rides along on the full pug: the script mints a presigned PUT into
 * the platform's dev MinIO on this box and the core plugin uploads to it, so
 * `demo.uploaded` is asserted there too (PRD-02 T21).
 *
 * What it needs, and what it says when it does not have it: a dev orchestrator
 * answering on {@link BASE_URL} with the `nodes` provider registered, and this
 * box enrolled as a node (`pnpm dev:up && pnpm dev && pnpm dev:node up`).
 * Skipped with a printed reason otherwise; `EZPUG_CS2_TESTS=required` makes
 * that skip a failure.
 *
 * The matrix costs **one CS2 container and the better part of two hours** —
 * puppets draw a four-round map more often than they win it, and the overtime
 * that follows is most of the spread — which is why it is never part of
 * `pnpm verify` and is opt-in even in the extended tier.
 * {@link ONLY} runs one row of it while something is being fixed. The script
 * releases its server in a `finally` and on a signal, and the summary it
 * returns carries the ledger — an open row here is a red test, not a note for
 * later.
 */

loadRootEnv()

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BASE_URL = (
  process.env.EZPUG_IRON_BASE_URL ??
  process.env.EZPUG_IRON_PUBLIC_URL ??
  'http://127.0.0.1:3430'
).replace(/\/+$/, '')
/**
 * The lane is **opt-in twice over**: it does not run unless `EZPUG_CS2_TESTS`
 * is set at all (CLAUDE.md — ten minutes and a CS2 container is nobody's idea
 * of `pnpm verify`), and `required` turns a missing world from a printed skip
 * into a failure.
 */
const LANE = process.env.EZPUG_CS2_TESTS ?? ''
const DEMANDED = LANE === 'required'
/**
 * **One row of the matrix, by id** (`EZPUG_CS2_CASES=knife,pause`), for the
 * hour somebody is fixing exactly one of them. Unset is the whole matrix,
 * which is what `required` means and what a round is judged on.
 */
const ONLY = (process.env.EZPUG_CS2_CASES ?? '')
  .split(',')
  .map(id => id.trim())
  .filter(id => id !== '')
/**
 * **The lane's engine clock** (`simulation.timeScale`, T4), and it is the
 * lane's to choose rather than a request's — a production match is played at
 * the speed the players are in. Measured on this box: a 1v1 of puppets at `1`
 * takes about as long as the map does, and the matrix is eleven maps.
 *
 * The fork clamps `host_timescale` to 0.1–10 and the contract takes its bounds
 * from that; `2` is what the matrix runs at, because the demo the full pug
 * asserts is GOTV's and GOTV records in the server's time, not the wall's.
 */
const TIMESCALE = process.env.EZPUG_CS2_TIMESCALE ?? '2'
/**
 * The whole match, generously: allocation, a 67 GB game booting, bots playing
 * four rounds and as many overtimes as they need to break the tie — on a box
 * that is usually running something else. The script gets
 * {@link SCRIPT_MINUTES} and this is the outer wall.
 */
const SCRIPT_MINUTES = 35
const BUDGET_MS = (SCRIPT_MINUTES + 5) * 60_000

/** What `iron-match --json` prints, and everything this file reads off it. */
type Summary = {
  run?: string
  matchId?: string
  finalState?: string
  forcedEnd?: boolean
  endedReason?: { kind?: string } | null
  ledger?: { rows: number; open: number }
  payloads?: Record<string, number>
  counts?: Record<string, number>
  commands?: { rcon: number; total: number }
  paused?: { pause: unknown; unpause: unknown } | null
  dropped?: {
    rostered: string
    body: string
    state: string
    standing: number
    frontDoor: unknown
    synthetic: unknown
    stimulus: string | null
    left: { afterMs: number; standing: number } | null
    back: { afterMs: number; standing: number } | null
  } | null
  matchzy?: Record<string, number>
  demoTarget?: string | null
  demo?: { uploaded: number; skipped?: string } | null
  simulation?: { puppets: number; timeScale: number; simulated: boolean } | null
}

/** One row of the matrix. */
type LaneCase = {
  /** What `EZPUG_CS2_CASES` names it. */
  id: string
  /** The sentence the test is called by. */
  what: string
  /** How many puppets are rostered — and so how many `player_ready` are owed. */
  puppets: number
  /** Everything after `--simulate --bots <puppets>`. */
  args: string[]
  /**
   * How many `rcon` commands this case sends *at the match*. **Zero
   * everywhere but `drop`**, whose stimulus has no front door until PRD-03 T7a
   * — the field is how a case that has no other door says so out loud rather
   * than quietly raising the count.
   */
  rcon?: number
  /** The facts only this case can produce. The invariants are in {@link play}. */
  facts?: (summary: Summary) => void
}

/**
 * **Every size, because the stall was a size** (T1). `players_per_team` comes
 * off the roster now — the smaller team's count, capped by the manifest — so
 * each of these is a different number in the match file and a different
 * answer from MatchZy's `IsTeamReady`. Five a side is the one the demo and the
 * full vocabulary are asserted on, because it is the match the owner actually
 * plays.
 */
const SIZES = [2, 4, 6, 8, 10]

const CASES: LaneCase[] = [
  ...SIZES.map(
    (puppets): LaneCase => ({
      id: `pug-${puppets / 2}v${puppets / 2}`,
      what: `plays a ${puppets / 2}v${puppets / 2} pug that ${puppets} puppets readied up for`,
      puppets,
      args: [],
      facts: summary => {
        readiedUp(summary, puppets)
        // **The full pug carries the demo** (PRD-02 T21, T21a). A forced end
        // cuts GOTV off before it finishes the file and a box without the
        // platform's S3 credentials never minted a target at all; neither is
        // asked about.
        if (puppets === 10 && !summary.forcedEnd && summary.demoTarget) {
          expect(summary.payloads?.demo_available, 'the server never announced a demo').toBe(1)
          expect(summary.payloads?.['demo.uploaded'], 'the demo never landed in MinIO').toBe(1)
          expect(summary.demo, 'the ended fact did not count the demo').toEqual({ uploaded: 1 })
        }
      },
    }),
  ),
  {
    // **Uneven, which is the same stall wearing the other roster** (T1's own
    // note): MatchZy has one `players_per_team` for both teams, so the larger
    // team's count would refuse the single player for ever. It is the smaller
    // team's, and this is the case that says so on hardware. The platform's
    // PRD-10 T1 is what lets a custom match ask for it.
    id: 'pug-2v1',
    what: 'plays an uneven 2v1, which one number for both teams could not',
    puppets: 3,
    args: [],
    facts: summary => readiedUp(summary, 3),
  },
  {
    // **A different engine game** (T3b): `game_mode 2`, `live_wingman.cfg`
    // and a map reload before anything else happens. `de_dust2` is a full
    // map played under it on purpose — the catalog has no wingman layouts and
    // substitutes nothing, so what a full map does under wingman is a fact
    // this lane owns rather than an assumption.
    id: 'wingman',
    what: 'plays a wingman match, the other format on the wire',
    puppets: 4,
    args: ['--format', 'wingman'],
    facts: summary => {
      readiedUp(summary, 4)
      // **The map reload, measured.** MatchZy switches the engine to
      // `game_mode 2` from the match file and reloads the map when the server
      // was not already in that mode (`Utility.cs` `SetCorrectGameMode`,
      // `IsMapReloadRequiredForGameMode`), and the core plugin announces
      // itself again on the new map — so a wingman match says `server_ready`
      // **twice** where every competitive one says it once. Two runs on the
      // dev node agree. The client is still told once (`match.server_ready`,
      // asserted for every case), so this is the reload showing through the
      // link rather than a fact said twice.
      expect(
        summary.payloads?.server_ready,
        'no second server_ready: the map was never reloaded for game_mode 2',
      ).toBe(2)
    },
  },
  {
    // **A knifed map, and nobody to answer it.** Stock MatchZy waits for the
    // knife winner to type `.stay` or `.switch`; a bot never will, so the map
    // would hold the box until a human looked. MatchZy-Enhanced's
    // side-selection timer is what decides it instead, and T3a turned that on
    // in the image's own cfg for exactly this. The two facts below are T3's
    // vocabulary reaching a real server for the first time.
    id: 'knife',
    what: 'knifes for the side and lets the timer decide it, because puppets never type .stay',
    puppets: 4,
    args: ['--sides', 'knife'],
    facts: summary => {
      readiedUp(summary, 4)
      expect(summary.payloads?.knife_start, 'the knife round never began').toBe(1)
      expect(summary.payloads?.knife_end, 'the knife round was never decided').toBe(1)
    },
  },
  {
    // **A pause and an unpause through the front door**, which is the path
    // the platform's admin console takes and the only one a client has. Both
    // facts are the core plugin's `MatchZyFlow` — MatchZy's own pause events
    // are dropped at the door because the plugin already says it (T3) — so
    // this is where that decision meets hardware.
    id: 'pause',
    what: 'pauses and unpauses a live match, and the core plugin is what says so',
    puppets: 2,
    args: ['--pause'],
    facts: summary => {
      readiedUp(summary, 2)
      expect(summary.paused, 'the run never paused').not.toBeNull()
      expect(summary.payloads?.match_paused, 'the match never paused').toBe(1)
      expect(summary.payloads?.match_unpaused, 'the match never came back').toBe(1)
    },
  },
  {
    // **One puppet leaves and comes back.** The window is the warmup, because
    // that is the only place a missing rostered player changes anything: the
    // fork holds a loaded match at the gate while any rostered SteamID is
    // absent (`AreAllConfiguredPlayersConnectedAndOnCorrectTeams`, T3a's
    // sentence), and once the match is live it stops caring.
    //
    // **This is the one row of the matrix that types at a match, and what it
    // buys is the measurement of why it has to.** The run knocks on the front
    // door twice — `kick` by the **rostered** SteamID, the only id a client
    // ever holds, and `kick` by the **synthetic** one a position tick hands
    // back — and both are refused with `player_not_in_match`. Neither reaches
    // the plugin at all: the orchestrator gates `kick` on its own presence
    // map, and that map is filled from `player_connected` /
    // `player_disconnected`, which the core plugin emits for humans only. So
    // for a room of puppets it is empty and **no player command can reach any
    // of them** — the gap PRD-03 T7a closes, pinned to the orchestrator rather
    // than to an id, because an id is not where the fix goes. Both assertions
    // are meant to go red the day T7a lands (T7 closed it for the SDK's own modes only).
    //
    // The stimulus is then `bot_kick ct` over RCON, declared here rather than
    // smuggled, and the behaviour it provokes is what the case is really for:
    // the room goes one short, the engine's quota and the fork's reconcile
    // pass put a body back on the empty side and map it onto the free roster
    // slot, and the match goes live — which it could not do while a rostered
    // SteamID was missing.
    //
    // **Nothing announces the leaving, and that is a finding.** The core
    // plugin emits `player_connected` for humans only, so the durable log is
    // silent; and the fork synthesises its `player_connect` only on the
    // `bot_quota` walk that first fills the room — a body its **reconcile
    // pass** adds later is mapped onto the free slot and re-readied
    // (`SimulationMode.cs`, `Reconcile: adding a bot on …`) but never
    // announced, so its wire is silent too. Measured here: two
    // `player_connect` and two `player_disconnect` for a 1v1 that lost and
    // regained a body, and **three** `player_ready` for two puppets.
    //
    // So the leaving and the return are measured off **position ticks** — the
    // room goes one short and then whole again — and the go-live is the
    // second proof, because the fork will not start a loaded match while a
    // rostered SteamID is absent. A vendor property recorded, not filed.
    id: 'drop',
    what: 'loses a puppet in warmup, gets it back and still goes live',
    puppets: 2,
    args: ['--drop-puppet'],
    rcon: 1,
    facts: summary => {
      expect(summary.dropped, 'nothing was ever taken off the server').not.toBeNull()
      // The front door, twice, and both refusals are the T7a gap measured
      // rather than described.
      for (const [which, answer] of [
        ['the rostered SteamID', summary.dropped?.frontDoor],
        ['the synthetic id', summary.dropped?.synthetic],
      ] as const)
        expect(
          JSON.stringify(answer),
          `${which} was kickable: T7a landed and this case is stale`,
        ).toContain('player_not_in_match')
      // The room really went one short, and really filled back up. A `back`
      // without a `left` is a room that was simply never disturbed, which is
      // what the first cut of this case recorded.
      expect(summary.dropped?.left, 'nobody ever left the server').not.toBeNull()
      expect(summary.dropped?.back, 'the room never filled back up').not.toBeNull()
      // The replacement was mapped onto the free roster slot, which is only
      // visible as a ready the fork sent for a body that had already readied.
      expect(summary.counts?.matchzyPayloads ?? 0, 'the run recorded no trace').toBeGreaterThan(0)
      expect(
        summary.matchzy?.player_ready ?? 0,
        'the replacement was never mapped onto the free slot',
      ).toBeGreaterThanOrEqual(2)
      // **And it went live anyway**, which is what the case is really for: the
      // fork holds a loaded match in warmup while any rostered SteamID is
      // absent, so the `going_live` every row of this matrix asserts is the
      // proof the body came back and was mapped onto its roster slot again.
      //
      // The durable log still says each puppet readied **once**, however many
      // times the fork said it — the "already said" rule (T5) doing its work
      // on a real return rather than on a poll.
      readiedUp(summary, 2)
    },
  },
]

/**
 * **The room readied up** (T5), which is the whole reason this lane has this
 * shape: one `player_ready` per puppet, then each team through the gate once —
 * MatchZy re-announces a team that is already through on every later ready and
 * the door says each fact once (`matchzy/translate.ts`) — and then everybody,
 * with a countdown.
 */
function readiedUp(summary: Summary, puppets: number): void {
  expect(summary.payloads?.player_ready, 'not every puppet readied up').toBe(puppets)
  expect(summary.payloads?.team_ready, 'the two teams did not pass the gate').toBe(2)
  expect(summary.payloads?.all_ready, 'the room was never all ready').toBe(1)
}

/** How long each case took and what it played, printed as the matrix's own note (T13). */
const runtimes: { id: string; minutes: number; rounds: number; overtime: boolean }[] = []

async function why(): Promise<string | null> {
  if (LANE === '') return 'EZPUG_CS2_TESTS is not set'
  let health: { checks?: { providers?: Record<string, unknown> } }
  try {
    const response = await fetch(`${BASE_URL}/healthz`, {
      signal: AbortSignal.timeout(3_000),
    })
    health = (await response.json()) as typeof health
  } catch {
    return `no orchestrator at ${BASE_URL} — \`pnpm dev:up\` then \`pnpm dev\``
  }
  if (!health.checks?.providers?.nodes)
    return 'the orchestrator has no `nodes` provider — set EZPUG_IRON_PROVIDERS=sim,nodes and restart it'
  if (!existsSync(`${REPO}.ezpug-node/node.json`))
    return 'this box is not enrolled as a node — `pnpm dev:node up`'
  return null
}

const reason = await why()
if (reason !== null && !DEMANDED)
  process.stderr.write(
    `\n[orchestrator] skipping the CS2 lane — ${reason}\n` +
      '               demand it with EZPUG_CS2_TESTS=required once the dev node is up.\n\n',
  )

/**
 * Play one row: spawn the operator's own script, parse its summary, and hold
 * it to everything that is true of **every** match on this lane. The case's
 * own {@link LaneCase.facts} are the part only it can prove.
 */
function play(lane: LaneCase): Summary {
  const startedAt = performance.now()
  const run = spawnSync(
    'node',
    [
      'scripts/iron-match.mjs',
      '--json',
      '--simulate',
      '--bots',
      String(lane.puppets),
      '--timescale',
      TIMESCALE,
      '--timeout-minutes',
      String(SCRIPT_MINUTES),
      ...lane.args,
    ],
    { cwd: REPO, encoding: 'utf8', timeout: BUDGET_MS },
  )
  // The exit code first: a run that died has no summary to parse, and its
  // stderr is the only thing worth reading when it did.
  expect(run.status, `iron-match exited ${run.status}\n${run.stderr.slice(-6_000)}`).toBe(0)
  // Everything the script says to a human goes to stderr; stdout under
  // `--json` is the summary and nothing else.
  const summary = JSON.parse(run.stdout.trim() || '{}') as Summary
  const rounds = summary.payloads?.round_end ?? 0

  // **Puppets, and the marker every consumer reads** (T4): the resource said
  // the match was simulated, so every fact of it carries `source.simulated`
  // and nobody can mistake it for a real one.
  expect(summary.simulation, 'the run did not ask for puppets').toMatchObject({
    puppets: lane.puppets,
    simulated: true,
  })
  // **Nothing was typed at the match** (Attitude 2). This is the assertion the
  // escape hatch used to stand in front of: a `--simulate` match that went
  // live with a zero here went live because players readied.
  expect(summary.commands?.rcon, 'the run took an RCON shortcut').toBe(lane.rcon ?? 0)

  // The match played itself out: MatchZy said so and the machine agreed.
  expect(summary.finalState).toBe('ended')
  expect(summary.payloads?.going_live, 'MatchZy never went live').toBe(1)
  expect(rounds, 'no round was played').toBeGreaterThanOrEqual(1)
  expect(summary.payloads?.['match.ended'], 'no match.ended reached the client').toBe(1)
  // `series_end` only when MatchZy finished the series itself. A drawn map
  // goes to overtime, and CS2 works its overtime clinch out from the
  // `mp_maxrounds 24` MatchZy's own `live.cfg` sets rather than the four this
  // request asked for, so a bots match can wander; the script ends one that
  // does (`--max-live-minutes`) and says it had to. Everything above is true
  // either way, and that is what this lane is for.
  if (summary.forcedEnd) {
    expect(summary.endedReason?.kind, 'a forced end must say so').toBe('force_ended')
  } else {
    expect(summary.payloads?.series_end, 'the series never ended').toBe(1)
    expect(summary.payloads?.map_end, 'the map never ended').toBe(1)
  }

  // A ledger row was opened and it is closed. This is the P1 the working
  // rules name: a live test that leaves a server running.
  expect(summary.ledger?.rows ?? 0).toBeGreaterThanOrEqual(1)
  expect(summary.ledger?.open, 'a ledger row is still open').toBe(0)
  expect(summary.counts?.openServersAfter, 'a server is still running').toBe(0)

  // **The link and the MatchZy door both carried the match**, proven by
  // events only one of them can produce rather than by counting frames:
  // `server_ready` and `player_death` are the core plugin's, over the link;
  // `going_live` and `round_end` exist only because MatchZy POSTed them to
  // `/matchzy/log` and the translator turned them into these.
  //
  // **The client is told once; the server may say it more than once.**
  // `match.server_ready` is the durable fact and is exact. The raw
  // `server_ready` is only `>= 1`, because a **map reload re-announces the
  // server** and wingman needs one to switch `game_mode` — measured here, and
  // pinned as that case's own fact rather than smoothed away.
  expect(summary.payloads?.['match.server_ready'], 'the client was not told once').toBe(1)
  expect(
    summary.payloads?.server_ready ?? 0,
    'the plugin never said it was ready',
  ).toBeGreaterThanOrEqual(1)
  expect(summary.payloads?.player_death ?? 0, 'nobody died: no link events').toBeGreaterThan(0)

  lane.facts?.(summary)

  // **Four regulation rounds, and whatever the draw cost.** Whether a short
  // `mp_maxrounds` can force an overtime *reliably* is a question this matrix
  // answers by counting rather than by asserting (T6): a map that clinches
  // 3–1 never sees one, and a request cannot make two evenly matched bots
  // draw on demand.
  runtimes.push({
    id: lane.id,
    minutes: Math.round(((performance.now() - startedAt) / 60_000) * 10) / 10,
    rounds,
    overtime: rounds > 4,
  })
  return summary
}

describe.skipIf(reason !== null && !DEMANDED)('puppets play real matches on the dev node', () => {
  if (reason !== null) {
    it('is demanded but its world is absent', () => {
      expect.fail(`EZPUG_CS2_TESTS=required: ${reason}`)
    })
    return
  }

  afterAll(() => {
    if (runtimes.length === 0) return
    process.stderr.write(
      `\n[orchestrator] the CS2 matrix, at timescale ${TIMESCALE}:\n${runtimes
        .map(
          row =>
            `               ${row.id.padEnd(12)} ${String(row.minutes).padStart(5)} min  ` +
            `${String(row.rounds).padStart(2)} rounds${row.overtime ? ' (overtime)' : ''}`,
        )
        .join('\n')}\n\n`,
    )
  })

  for (const lane of CASES) {
    const chosen = ONLY.length === 0 || ONLY.includes(lane.id)
    it.skipIf(!chosen)(`${lane.id}: ${lane.what}`, () => void play(lane), BUDGET_MS + 30_000)
  }
})

/**
 * The recorded files this lane's script writes are checked where they live
 * (`packages/protocol`, `packages/match-api`); here only that the run bundle's
 * own reader is honest about the script it names.
 */
describe('the iron-match script', () => {
  it('is where every doc and this lane says it is', () => {
    expect(existsSync(`${REPO}scripts/iron-match.mjs`)).toBe(true)
    const pkg = JSON.parse(readFileSync(`${REPO}package.json`, 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['iron:match']).toBe('node scripts/iron-match.mjs')
  })

  it('is documented by the name an operator types, and so is its trace', () => {
    const operations = readFileSync(`${REPO}docs/operations.md`, 'utf8')
    const readme = readFileSync(`${REPO}README.md`, 'utf8')
    const example = readFileSync(`${REPO}.env.example`, 'utf8')
    for (const doc of [operations, readme]) expect(doc).toContain('pnpm iron:match')
    expect(operations).toContain('EZPUG_IRON_TRACE_FILE')
    expect(operations).toContain('EZPUG_CS2_TESTS')
    // The variable the trace is turned on with, commented out and explained.
    expect(example).toContain('#EZPUG_IRON_TRACE_FILE=')
  })

  it('offers every flag its own help text names', () => {
    const script = readFileSync(`${REPO}scripts/iron-match.mjs`, 'utf8')
    const help = script.slice(script.indexOf('const HELP ='), script.indexOf('function args('))
    for (const flag of help.matchAll(/^ {2}--([a-z-]+)/gm))
      expect(
        script.includes(`flags.get('${flag[1]}')`) || script.includes(`flags.has('${flag[1]}')`),
        `--${flag[1]} is in --help but nothing reads it`,
      ).toBe(true)
  })

  /**
   * **The matrix is the PRD's list, and a row that quietly disappeared would
   * be a lane case nobody missed.** Cheap, and it runs in `pnpm verify` where
   * the lane itself never does.
   */
  it('covers every shape PRD-03 T6 names', () => {
    const ids = CASES.map(lane => lane.id)
    expect(ids).toEqual([
      'pug-1v1',
      'pug-2v2',
      'pug-3v3',
      'pug-4v4',
      'pug-5v5',
      'pug-2v1',
      'wingman',
      'knife',
      'pause',
      'drop',
    ])
    // **Exactly one row of the matrix types at the match, and it is the one
    // whose stimulus has no front door yet.** `drop` knocks on `kick` twice
    // and is refused both times — the orchestrator's presence map holds no
    // puppet until PRD-03 T7a announces one like a human — so `bot_kick ct` is
    // what is left. Every other row goes live because players readied and
    // nothing else, and a row that quietly grew an RCON would be caught here.
    expect(CASES.filter(lane => (lane.rcon ?? 0) > 0).map(lane => lane.id)).toEqual(['drop'])
  })
})
