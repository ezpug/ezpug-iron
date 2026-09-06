import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadRootEnv } from './env'

/**
 * **The `EZPUG_CS2_TESTS` lane** (PRD-02 T13): a whole `pug` on real hardware,
 * asserted. Bots play four rounds on a CS2 container an `ezpug-node` on this
 * box started, MatchZy runs the match, the core plugin speaks the vocabulary
 * over its link, and the client — `scripts/iron-match.mjs`, the same script an
 * operator runs — watches it through nothing but the Match API.
 *
 * **It shells out to that script on purpose.** The flow is one thing, not two:
 * a test that reimplemented "create a match, fill the bots, force the start,
 * wait" would be a second answer to how a match is played, and the two would
 * drift. The script prints its summary as JSON; this file is the assertions.
 *
 * The demo rides along: the script mints a presigned PUT into the platform's
 * dev MinIO on this box and the core plugin uploads to it, so `demo.uploaded`
 * is asserted here too (PRD-02 T21) whenever the match played itself out.
 *
 * What it needs, and what it says when it does not have it: a dev orchestrator
 * answering on {@link BASE_URL} with the `nodes` provider registered, and this
 * box enrolled as a node (`pnpm dev:up && pnpm dev && pnpm dev:node up`).
 * Skipped with a printed reason otherwise; `EZPUG_CS2_TESTS=required` makes
 * that skip a failure.
 *
 * The lane costs fifteen to twenty-five minutes of wall clock and one CS2
 * container — bots draw a four-round map more often than they win it, and the
 * overtime that follows is most of the spread — which is why it is never part
 * of `pnpm verify` and is opt-in even in the extended tier. The script releases its server in a `finally` and on a signal, and the
 * summary it returns carries the ledger — an open row here is a red test, not
 * a note for later.
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
 * The whole match, generously: allocation, a 67 GB game booting, ten bots
 * playing four rounds and as many overtimes as they need to break the tie — on
 * a box that is usually running something else. The script gets
 * {@link SCRIPT_MINUTES} and this is the outer wall.
 */
const SCRIPT_MINUTES = 45
const BUDGET_MS = (SCRIPT_MINUTES + 5) * 60_000

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

describe.skipIf(reason !== null && !DEMANDED)('bots play a real match on the dev node', () => {
  if (reason !== null) {
    it('is demanded but its world is absent', () => {
      expect.fail(`EZPUG_CS2_TESTS=required: ${reason}`)
    })
    return
  }

  it(
    'plays a pug end to end and closes its ledger row',
    async () => {
      const run = spawnSync(
        'node',
        ['scripts/iron-match.mjs', '--json', '--timeout-minutes', String(SCRIPT_MINUTES)],
        { cwd: REPO, encoding: 'utf8', timeout: BUDGET_MS },
      )
      // The exit code first: a run that died has no summary to parse, and its
      // stderr is the only thing worth reading when it did.
      expect(run.status, `iron-match exited ${run.status}\n${run.stderr.slice(-6_000)}`).toBe(0)
      // Everything the script says to a human goes to stderr; stdout under
      // `--json` is the summary and nothing else.
      const summary = JSON.parse(run.stdout.trim() || '{}') as {
        finalState?: string
        forcedEnd?: boolean
        endedReason?: { kind?: string } | null
        ledger?: { rows: number; open: number }
        payloads?: Record<string, number>
        counts?: Record<string, number>
        demoTarget?: string | null
        demo?: { uploaded: number; skipped?: string } | null
      }

      // The match played itself out: MatchZy said so and the machine agreed.
      expect(summary.finalState).toBe('ended')
      expect(summary.payloads?.going_live, 'MatchZy never went live').toBe(1)
      expect(summary.payloads?.round_end ?? 0, 'no round was played').toBeGreaterThanOrEqual(1)
      expect(summary.payloads?.['match.ended'], 'no match.ended reached the client').toBe(1)
      // `series_end` only when MatchZy finished the series itself. A 2–2 map
      // goes to overtime, and CS2 works its overtime clinch out from the
      // `mp_maxrounds 24` MatchZy's own `live.cfg` sets rather than the four
      // this request asked for, so a bots match can wander; the script ends
      // one that does (`--max-live-minutes`) and says it had to. Everything
      // above is true either way, and that is what this lane is for.
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
      // `server_ready` and `player_death` are the core plugin's, over the
      // link; `going_live` and `round_end` exist only because MatchZy POSTed
      // them to `/matchzy/log` and the translator turned them into these.
      // (The frame counts in `counts` are the trace's, and the trace is a
      // developer's recording switch, not something a test turns on.)
      expect(summary.payloads?.server_ready, 'the plugin never said it was ready').toBe(1)
      expect(summary.payloads?.player_death ?? 0, 'nobody died: no link events').toBeGreaterThan(0)

      // **The demo pipe** (T21, the half of this lane that waited on it; T21a,
      // which made it true). The plugin finds the finished `.dem`, PUTs it at
      // the presigned URL the script minted into the platform's dev MinIO, and
      // the orchestrator relays it: `demo_available` from the server, then
      // `demo.uploaded` to the client, then the ended fact counting it.
      //
      // This used to accept "nothing was recorded" as an outcome, because on
      // this box nothing was: `bot_quota_mode fill` made the engine evict the
      // GOTV client along with the bots on MatchZy's `live.cfg`
      // (`SourceTV kicked by Console`), and CS2 will not bring SourceTV back
      // without a level change. Nothing sets that cvar any more (T21a,
      // `gamemodes/pug/cfg/ezpug/pug.cfg` carries the measurement), so a
      // recorded map without a demo is a regression and reads as one here.
      //
      // A forced end cuts the recording off before GOTV finished it, and a box
      // without the platform's S3 credentials never minted a target at all;
      // neither is asked about.
      if (!summary.forcedEnd && summary.demoTarget) {
        expect(summary.payloads?.demo_available, 'the server never announced a demo').toBe(1)
        expect(summary.payloads?.['demo.uploaded'], 'the demo never landed in MinIO').toBe(1)
        expect(summary.demo, 'the ended fact did not count the demo').toEqual({ uploaded: 1 })
      }
    },
    BUDGET_MS + 30_000,
  )
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
})
