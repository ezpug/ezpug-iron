import { createServer, type Server } from 'node:http'
import { systemClock } from '@ezpug/core'
import type { WebhookEnvelope } from '@ezpug/match-api'
import { createMatchApiClient } from '@ezpug/match-api/client'
import {
  type ConformanceTarget,
  formatConformanceReport,
  MATCH_API_CONFORMANCE_FLOWS,
  runMatchApiConformance,
} from '@ezpug/match-api/fixtures'
import { describeMatchApiConformance } from '@ezpug/match-api/fixtures/vitest'
import { verifyWebhook, WEBHOOK_ATTEMPT_HEADER } from '@ezpug/match-api/webhooks'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { type OrchestratorConfig, readDatabaseConfig, readOrchestratorConfig } from './config'
import { sweepTestNamespace, testNamespace } from './db/testing'
import { loadRootEnv } from './env'
import { createMemoryLog } from './log'
import { createOrchestrator, type Orchestrator } from './orchestrator'
import type { SimProvider } from './providers/sim/provider'
import { tapOverWidgetSocket } from './widget/testing'

/**
 * **The conformance suite against the real service** — the round's first
 * extended-tier gate (PRD-02 T3): the orchestrator composed as `main.ts`
 * composes it, on the system clock, over the dev world's Postgres and
 * Redis, listening on a real port with the sim provider registered; the
 * published client over HTTP, the stream over a real `ws` upgrade through
 * the Redis fan-out, every webhook POSTed to a real endpoint that verifies
 * the signature with the published verifier before the runner hears it.
 *
 * **Time is the hard part here, and T10a is what it cost.** This tier has no
 * fake clock: the story plays on real timers while the client talks over a
 * real socket, so the two race. Two rules keep that honest, and both were
 * bought with a red suite:
 *
 * 1. **The story is slow enough that a starved client still finds the match
 *    live.** `SHORT_RULES` is two rounds — about four match-minutes — so at
 *    the sixty times real time this file used to ask for, everything between
 *    `going_live` and the last event fitted in four seconds. On a loaded box
 *    a client's own round trips eat that, the flow's `pause` arrives at an
 *    `ended` match and the machine refuses it `invalid_state`. At
 *    {@link SIM_TIME_SCALE} the same window is a dozen seconds, which no
 *    amount of scheduler starvation on this box has closed.
 * 2. **`settle()` is a barrier, not a sleep.** The orchestrator runs in this
 *    process, so "let the world catch up" can be its own promise —
 *    {@link quiesce} drains every match chain and every webhook attempt and
 *    leaves nothing due — instead of the half second of hope it used to be,
 *    which under load returned while the last envelopes were still queued
 *    and failed the flows' "every durable envelope was delivered" check.
 *
 * The runner polls every quarter second. Skips loudly when the dev world is
 * down; `EZPUG_IRON_DATABASE_TESTS=required` (what `pnpm verify:extended`
 * sets) makes that red.
 */

const SECRET_ID = 'whsec-conformance'
const SECRET = 'orchestrator-conformance-webhook-secret-not-a-real-one-0123456789'
const namespace = testNamespace(import.meta.url)

/**
 * How much faster than real time the story plays. Twenty leaves roughly a
 * dozen seconds between `going_live` and the end of a two-round map — the
 * margin a client's own latency lives in (see the file's note).
 */
const SIM_TIME_SCALE = 20
/** How long the runner waits for any one thing before it says what it waited for. */
const MAX_WAIT_MS = 120_000
/**
 * One flow's budget: a whole match at {@link SIM_TIME_SCALE}, with room to
 * spare — and **above {@link MAX_WAIT_MS} on purpose** (T39b). It used to sit
 * below it, so a flow that hung died on Vitest's bare `Test timed out`, which
 * names nothing; the runner's own `gave up waiting for the replacement server`
 * is the sentence the next author needs, and it can only be reached if the
 * wait is allowed to run out first.
 */
const FLOW_TIMEOUT_MS = 150_000
/** {@link quiesce} gives up after this long rather than hang a flow. */
const QUIESCE_TIMEOUT_MS = 15_000
/** Every {@link quiesce} that spent its whole budget: a barrier that did not settle. */
const stalls: string[] = []

let orchestrator: Orchestrator | undefined
let config: OrchestratorConfig | undefined
let url = ''
let unavailable: string | undefined
let endpoint: Server | undefined
let endpointUrl = ''
/** Every demo a simulated server PUT at the target's `demoUploadUrl`. */
const demos: { url: string; bytes: number; contentType: string }[] = []
const log = createMemoryLog()
let mints = 0
/**
 * **One inbox per target, addressed by its own path** (T39b). The endpoint
 * hears every key's deliveries, so a target has to know which are its own —
 * and it may not learn that from the matches it can *see*, because the
 * orchestrator POSTs `match.allocated` while the flow is still on the round
 * trip that would have told it (measured: the flow won by 37–130 ms on this
 * box, and lost outright on a loaded one, which is how `happy-bo1` came to
 * report `never delivered: 1`). The request names the URL, so the URL is the
 * answer: each target draws a path of its own and the endpoint routes by it.
 */
const inboxes = new Map<string, Set<(envelope: WebhookEnvelope) => void>>()
const unverified: string[] = []
/** A delivery that arrived at a path no target claims — nobody's, and a bug if it happens. */
const misaddressed: string[] = []
/** A delivery that needed more than one attempt against an endpoint that always says 200. */
const retried: string[] = []

/** The inbox a POST was addressed to: the path, without a query string. */
function hookPath(url: string | undefined): string {
  return (url ?? '').split('?')[0] as string
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`)
    })
  })
}

beforeAll(async () => {
  loadRootEnv()
  try {
    config = {
      // A deployment of this suite's own (T21c): the test database is shared
      // with every other suite that stands an orchestrator, and a neighbour's
      // reaper reading these rows would find no `sim` server behind them and
      // fail every match this file is playing.
      ...readOrchestratorConfig({
        ...process.env,
        EZPUG_IRON_PROVIDERS: 'sim',
        EZPUG_IRON_DEPLOYMENT: namespace,
      }),
      database: readDatabaseConfig(process.env, { target: 'test' }),
    }
    orchestrator = createOrchestrator({
      config,
      clock: systemClock,
      log,
      sim: { timeScale: SIM_TIME_SCALE, positionTickIntervalMs: 60_000 },
    })
    await orchestrator.database.ping()
    await orchestrator.redis.ping()
    const { runMigrations } = await import('./db/migrate')
    await runMigrations(orchestrator.database)
    await sweepNamespace()
    await orchestrator.start()
    url = (await orchestrator.listen({ port: 0, host: '127.0.0.1' })).url

    // The consumer's door: read the bytes, verify, then act — the shape
    // `docs/match-api.md` "Handling one" prescribes.
    endpoint = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        // The client's bucket, not a door of ours: a simulated server PUTs
        // its recording here exactly as a plugin PUTs a `.dem` at a presigned
        // URL (T21). Nothing is kept but the fact that it arrived.
        if (request.method === 'PUT') {
          demos.push({
            url: request.url ?? '',
            bytes: Buffer.concat(chunks).byteLength,
            contentType: request.headers['content-type'] ?? '',
          })
          response.writeHead(200).end()
          return
        }
        const body = Buffer.concat(chunks).toString('utf8')
        void verifyWebhook({
          headers: request.headers,
          body,
          secrets: { [SECRET_ID]: SECRET },
          clock: systemClock,
        }).then(result => {
          if (!result.ok) {
            unverified.push(result.reason)
            response.writeHead(result.status).end()
            return
          }
          // **Every delivery is a first attempt** (T39b). This endpoint
          // answers 200 to everything, so a second attempt means the first
          // one failed against loopback — and `quiesce` deliberately does
          // not wait on a row in backoff (T10a: a flow that means a
          // delivery to fail must still get its failure), so a five-second
          // retry landing after its flow is over is an envelope the flow
          // reports as never delivered. Named here rather than found there.
          const attempt = Number(request.headers[WEBHOOK_ATTEMPT_HEADER] ?? '1')
          if (attempt > 1)
            retried.push(
              `${result.envelope.payload.type} seq ${result.envelope.seq} on attempt ${attempt}`,
            )
          // The path the request named is the target it belongs to; an
          // inbox with nobody listening is a flow that has already ended
          // and is not an error, an unknown one would be.
          const inbox = inboxes.get(hookPath(request.url))
          if (inbox) for (const handler of inbox) handler(result.envelope)
          else misaddressed.push(`${request.url} — ${result.envelope.payload.type}`)
          response.writeHead(200).end()
        })
      })
    })
    endpointUrl = await listen(endpoint)
  } catch (error) {
    unavailable = error instanceof Error ? error.message : String(error)
    await orchestrator?.database.close().catch(() => {})
    await orchestrator?.redis.close().catch(() => {})
    orchestrator = undefined
    if (process.env.EZPUG_IRON_DATABASE_TESTS === 'required')
      throw new Error(`the extended conformance suite is required but ${unavailable}`)
    process.stderr.write(
      `\n[orchestrator] skipping the extended conformance suite — ${unavailable}\n` +
        '               boot the dev world with `pnpm dev:up`.\n\n',
    )
  }
}, 60_000)

/** Where the orchestrator's log and the stall list stood when this flow started. */
let markLines = 0
let markStalls = 0

beforeEach(ctx => {
  if (unavailable) ctx.skip(`dev world unavailable: ${unavailable}`)
  markLines = log.lines.length
  markStalls = stalls.length
})

/**
 * **A red flow says what the orchestrator was doing** (T39b, T39a's lesson
 * carried one step further). The runner reports the check that failed and the
 * thing it gave up waiting for; the *reason* is in the service's own log and
 * in the barrier, and both live in this process and were being thrown away.
 * A flow that ends red prints the log this flow wrote and every barrier that
 * spent its whole budget while it ran — a green one prints nothing.
 */
afterEach(async ctx => {
  if (ctx.task.result?.state !== 'fail') return
  const open = await (orchestrator as Orchestrator).store.listOpenMatches()
  const lines = log.lines
    .slice(markLines)
    .filter(line => line.startsWith('error') || line.startsWith('warn'))
  const stalled = stalls.slice(markStalls)
  process.stderr.write(
    `\n[conformance] ${ctx.task.name} went red; what this process saw:\n` +
      `  matches still open: ${
        open.length === 0
          ? 'none'
          : open.map(row => `${row.id.slice(0, 8)} ${row.state}`).join(', ')
      }\n` +
      `  barriers that gave up: ${stalled.length === 0 ? 'none' : `\n    ${stalled.join('\n    ')}`}\n` +
      `  log: ${lines.length === 0 ? 'nothing above info' : `\n    ${lines.slice(-40).join('\n    ')}`}\n\n`,
  )
})

/**
 * Everything this file ever wrote to the shared test database — the shared
 * sweep (`db/testing.ts`), which finds it all by the prefix this suite's key
 * names carry. Run before the suite as well as after it: a run Turbo
 * cancelled mid-flight (a sibling task failed) never reaches `afterAll`.
 */
async function sweepNamespace(): Promise<void> {
  if (config) await sweepTestNamespace(config.database, namespace)
}

afterAll(async () => {
  if (stalls.length > 0)
    process.stderr.write(
      `\n[conformance] ${stalls.length} stalled barriers:\n  ${stalls.join('\n  ')}\n\n`,
    )
  endpoint?.close()
  if (!orchestrator || !config) return
  if (orchestrator.server.listening) await orchestrator.close('afterAll')
  await sweepNamespace()
}, 60_000)

/**
 * **The barrier** (T10a): every match chain settled, every webhook attempt
 * finished, nothing left due. The orchestrator is in this process, so what
 * `ctx.settle()` promises the flows — "the world has caught up" — is asked
 * of it directly instead of slept for.
 *
 * A row in backoff is *not* due, so a flow that means a delivery to fail
 * still gets its failure; a live match keeps writing while this runs, which
 * is why the loop is bounded by {@link QUIESCE_TIMEOUT_MS} and by a pass
 * count rather than waiting for a silence that will not come until the
 * match is over.
 */
async function quiesce(): Promise<void> {
  const o = orchestrator as Orchestrator
  const started = systemClock.now()
  const deadline = started + QUIESCE_TIMEOUT_MS
  for (let pass = 0; pass < 8; pass += 1) {
    await o.matches.settle()
    await o.webhooks.settle()
    const due = await o.store.listDueDeliveries(systemClock.date(), 1)
    if (due.length === 0) return
    if (systemClock.now() >= deadline) {
      // The barrier is the one thing a flow cannot see past, so when it
      // gives up it says so rather than costing the flow a poll in silence
      // (T39b: a `Test timed out` names nothing).
      stalls.push(`quiesce gave up after ${systemClock.now() - started} ms on pass ${pass + 1}`)
      return
    }
  }
  stalls.push(`quiesce ran out of passes after ${systemClock.now() - started} ms`)
}

/** A fresh pair of keys per flow, on the one standing orchestrator. */
async function target(flow: { id: string }): Promise<ConformanceTarget> {
  const o = orchestrator as Orchestrator
  const budget = { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 0 }
  const webhookSecrets = [{ id: SECRET_ID, secret: SECRET }]
  mints += 1
  const platform = await o.keys.mint({
    name: `${namespace}-${flow.id}-${mints}`,
    scopes: ['matches'],
    budget,
    webhookSecrets,
  })
  const thrifty = await o.keys.mint({
    name: `${namespace}-${flow.id}-${mints}-thrifty`,
    scopes: ['matches'],
    budget: { ...budget, maxServerLifetimeMinutes: 60 },
    webhookSecrets,
  })
  const options = {
    baseUrl: url,
    clock: systemClock,
    retry: false as const,
    WebSocket: WebSocket as unknown as NonNullable<
      Parameters<typeof createMatchApiClient>[0]['WebSocket']
    >,
  }
  const client = createMatchApiClient({ ...options, apiKey: platform.secret })
  const budgetClient = createMatchApiClient({ ...options, apiKey: thrifty.secret })
  // Deliveries for this target only, by the path its own requests name.
  const path = `/hooks/${flow.id}-${mints}`
  const inbox = new Set<(envelope: WebhookEnvelope) => void>()
  inboxes.set(path, inbox)
  return {
    client,
    webhooks: handler => {
      inbox.add(handler)
      return () => {
        inbox.delete(handler)
      }
    },
    callbacks: {
      webhookUrl: `${endpointUrl}${path}`,
      webhookSecretId: SECRET_ID,
      demoUploadUrl: `${endpointUrl}/demos/conformance.dem?signed=1`,
    },
    // A series draws one per map (T38a) — the same bucket, one key each.
    demoUploadUrls: (count: number) =>
      Array.from({ length: count }, (_unused, index) => ({
        mapNumber: index + 1,
        url: `${endpointUrl}/demos/conformance/map-${index + 1}.dem?signed=${index + 1}`,
      })),
    clock: systemClock,
    pollIntervalMs: 250,
    maxWaitMs: MAX_WAIT_MS,
    // The one sim provider serves every flow, so the knobs are armed for
    // this flow's match and cleared when it is done with the target.
    faults: faults =>
      (o.providers.get('sim') as SimProvider).setFaults(
        faults.crash === undefined ? {} : { crash: faults.crash },
      ),
    close: () => (o.providers.get('sim') as SimProvider).setFaults({}),
    advance: async ms => {
      // Real time is what a poll waits for here; the barrier after it is so
      // the next read sees a written world rather than a half-written one.
      await systemClock.sleep(Math.min(ms, 250))
      await quiesce()
    },
    settle: quiesce,
    stream: (subscription, onFrame) => {
      const handle = client.subscribeStream({
        matchId: subscription.matchId,
        onFrame,
        ...(subscription.token === undefined ? {} : { token: subscription.token }),
      })
      return () => handle.close()
    },
    budget: { client: budgetClient, maxServerLifetimeMinutes: 60 },
    // The widget's tap over the real `/v1/widget` socket, as a browser would.
    playerCommand: command =>
      tapOverWidgetSocket(`${url.replace(/^http/, 'ws')}/v1/widget`, command, {
        clock: systemClock,
      }),
  }
}

describeMatchApiConformance(
  'the orchestrator over a real socket, Postgres and Redis',
  { target },
  { timeoutMs: FLOW_TIMEOUT_MS },
)

describe('the extended gate', () => {
  it('passes every flow it can run, verified every delivery, and left no server running', async () => {
    const report = await runMatchApiConformance({ target })
    expect(formatConformanceReport(report)).toContain('0 failed')
    expect(report.ok).toBe(true)
    expect(report.passed + report.skipped).toBe(MATCH_API_CONFORMANCE_FLOWS.length)
    expect(unverified).toEqual([])
    expect(misaddressed).toEqual([])
    expect(retried).toEqual([])
    const o = orchestrator as Orchestrator
    expect(await o.fleet.servers()).toEqual([])
    expect(await o.providers.get('sim')?.list()).toEqual([])
    expect(log.lines.filter(line => line.startsWith('error'))).toEqual([])
    // Every flow of the set, one after another, each a real match at
    // `SIM_TIME_SCALE` — a budget, not an expectation.
  }, 420_000)
})
