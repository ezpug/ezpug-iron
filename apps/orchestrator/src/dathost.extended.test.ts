import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readDathostConfig } from './config'
import { loadRootEnv } from './env'

/**
 * **The `EZPUG_DATHOST_TESTS` lane** (PRD-02 T19): one real server in
 * Frankfurt, rented and given back, asserted.
 *
 * It shells out to `scripts/dathost-smoke.mjs` — the same command an operator
 * runs — for the reason the CS2 lane shells out to `iron-match.mjs`: the flow
 * is one thing, not two, and a test that reimplemented "allocate, wait for the
 * link, talk to it, release" would be a second answer to how a Dathost server
 * is driven, and the two would drift. The script prints its summary as JSON;
 * this file is the assertions.
 *
 * **What it needs**, and what it says when it does not have it:
 *
 * - `EZPUG_DATHOST_TESTS` set at all. It costs real euros, so it is opt-in
 *   even in the extended tier; `required` turns a missing world from a
 *   printed skip into a failure.
 * - The Dathost credential trio in the environment or `.env`.
 * - An orchestrator at `EZPUG_IRON_BASE_URL` **that a datacentre can reach**,
 *   with the `dathost` provider registered — the whole smoke turns on a
 *   plugin in Düsseldorf dialling home, so a loopback dev box is not enough.
 *   `https://gs.ezpug.com` after T35, or a tunnel before it.
 *
 * The whole run is bounded to one server-hour by the script and to
 * {@link BUDGET_MS} by this file; the script releases in a `finally` and on a
 * signal, deletes any clone the release left behind, and the summary carries
 * the ledger — an open row here is a red test, not a note for later.
 *
 * Everything this lane cannot reach without an account is proven offline
 * instead, in `providers/dathost/smoke-script.test.ts`, which runs the same
 * script's same nine steps against the fake vendor on every `pnpm verify`.
 */

loadRootEnv()

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BASE_URL = (
  process.env.EZPUG_IRON_BASE_URL ??
  process.env.EZPUG_IRON_PUBLIC_URL ??
  'http://127.0.0.1:3430'
).replace(/\/+$/, '')

const LANE = process.env.EZPUG_DATHOST_TESTS ?? ''
const DEMANDED = LANE === 'required'

/** The script's own wall, and the outer one this file holds it to. */
const SCRIPT_MINUTES = 30
const BUDGET_MS = (SCRIPT_MINUTES + 5) * 60_000

async function why(): Promise<string | null> {
  if (LANE === '') return 'EZPUG_DATHOST_TESTS is not set'
  let account: ReturnType<typeof readDathostConfig>
  try {
    account = readDathostConfig(process.env)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  if (account === null)
    return (
      'no Dathost account — put EZPUG_IRON_DATHOST_EMAIL, EZPUG_IRON_DATHOST_PASSWORD and ' +
      'EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID in `.env` (never in `.env.example`)'
    )
  let health: { checks?: { providers?: Record<string, unknown> } }
  try {
    const response = await fetch(`${BASE_URL}/healthz`, { signal: AbortSignal.timeout(5_000) })
    health = (await response.json()) as typeof health
  } catch {
    return `no orchestrator at ${BASE_URL} — set EZPUG_IRON_BASE_URL to one a datacentre can reach`
  }
  if (!health.checks?.providers?.dathost)
    return `the orchestrator at ${BASE_URL} has no \`dathost\` provider — give it the credential trio and EZPUG_IRON_PROVIDERS=dathost,…`
  return null
}

const reason = await why()
if (reason !== null && !DEMANDED)
  process.stderr.write(
    `\n[orchestrator] skipping the Dathost live smoke — ${reason}\n` +
      '               demand it with EZPUG_DATHOST_TESTS=required. It rents a real server.\n\n',
  )

describe.skipIf(reason !== null && !DEMANDED)(
  'one real Dathost server, rented and given back',
  () => {
    if (reason !== null) {
      it('is demanded but its world is absent', () => {
        expect.fail(`EZPUG_DATHOST_TESTS=required: ${reason}`)
      })
      return
    }

    it(
      'boots, dials the link, answers, and leaves nothing on the account',
      () => {
        const run = spawnSync(
          'node',
          ['scripts/dathost-smoke.mjs', '--json', '--budget-minutes', String(SCRIPT_MINUTES)],
          { cwd: REPO, encoding: 'utf8', timeout: BUDGET_MS },
        )
        const summary = JSON.parse(run.stdout.trim() || '{}') as {
          ok?: boolean
          steps?: string[]
          problems?: string[]
          account?: { credits: number | null } | null
          imageCheck?: { ok: boolean | null } | null
          finalState?: string
          connect?: { host: string; port: number; passwordSet: boolean } | null
          tv?: { host: string; port: number; delaySeconds: number } | null
          status?: { applied: boolean; lines: number; output: string } | null
          ledger?: { rows: number; open: number; hourlyCents: number | null } | null
          clones?: { before: number; afterRelease: number; deleted: number }
        }
        // The exit code first: a run that died has no summary to parse, and its
        // stderr is the only thing worth reading when it did.
        expect(
          run.status,
          `dathost-smoke exited ${run.status}\n${JSON.stringify(summary.problems ?? [], null, 2)}\n${run.stderr.slice(-6_000)}`,
        ).toBe(0)
        expect(summary.problems).toEqual([])
        expect(summary.ok).toBe(true)

        // The account and the template, before anything was rented.
        expect(summary.account?.credits).toBeTypeOf('number')
        expect(summary.imageCheck?.ok, 'the template is not what this tree builds').toBe(true)

        // **The link crossed the real internet.** `ready` is only reachable by
        // the plugin on the clone saying `server_ready` over its own outbound
        // socket, and `ezpug_status` only answers because a command went back
        // down it — decision 5, proven on rented hardware.
        expect(summary.finalState).toBe('ready')
        expect(summary.status?.applied, 'ezpug_status was not applied').toBe(true)
        expect(summary.status?.output).toContain('link:')

        // The connect facts a player would use, and the GOTV relay the
        // template's `enable_gotv` provides.
        expect(summary.connect?.host).toBeTypeOf('string')
        expect(summary.connect?.port).toBeGreaterThan(0)
        expect(summary.connect?.passwordSet).toBe(true)
        expect(summary.tv?.port, 'no GOTV relay on the clone').toBeGreaterThan(0)

        // The money: a row was opened, it is closed, it cost something real,
        // and the account holds no server of ours afterwards.
        expect(summary.ledger?.rows ?? 0).toBeGreaterThanOrEqual(1)
        expect(summary.ledger?.open, 'a ledger row is still open').toBe(0)
        expect(summary.ledger?.hourlyCents ?? 0).toBeGreaterThan(0)
        expect(summary.clones?.afterRelease, 'a server is still on the account').toBe(0)
        expect(summary.clones?.deleted, 'the release did not close its own server out').toBe(0)
      },
      BUDGET_MS + 30_000,
    )
  },
)

/**
 * True whether or not the lane runs: the command an operator is told to type
 * has to exist and be the one the docs name.
 */
describe('the dathost-smoke script', () => {
  it('is where every doc and this lane says it is', () => {
    const pkg = JSON.parse(readFileSync(`${REPO}package.json`, 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['dathost:smoke']).toBe('node scripts/dathost-smoke.mjs')
    const operations = readFileSync(`${REPO}docs/operations.md`, 'utf8')
    expect(operations).toContain('pnpm dathost:smoke')
    expect(operations).toContain('EZPUG_DATHOST_TESTS')
    expect(readFileSync(`${REPO}.env.example`, 'utf8')).toContain('#EZPUG_DATHOST_TESTS=required')
  })
})
