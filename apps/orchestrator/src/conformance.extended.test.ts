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
import { verifyWebhook } from '@ezpug/match-api/webhooks'
import { eq, inArray, like } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { type OrchestratorConfig, readDatabaseConfig, readOrchestratorConfig } from './config'
import { createDatabase } from './db/client'
import {
  apiKeys,
  apiKeyWebhookSecrets,
  backups,
  matchCommands,
  matchEvents,
  matches,
  servers,
  serverTokens,
  webhookDeliveries,
} from './db/schema'
import { testNamespace } from './db/testing'
import { loadRootEnv } from './env'
import { createMemoryLog } from './log'
import { createOrchestrator, type Orchestrator } from './orchestrator'
import type { SimProvider } from './providers/sim/provider'

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
/** One flow's budget: a whole match at {@link SIM_TIME_SCALE}, with room to spare. */
const FLOW_TIMEOUT_MS = 90_000
/** {@link quiesce} gives up after this long rather than hang a flow. */
const QUIESCE_TIMEOUT_MS = 15_000

let orchestrator: Orchestrator | undefined
let config: OrchestratorConfig | undefined
let url = ''
let unavailable: string | undefined
let endpoint: Server | undefined
let endpointUrl = ''
const log = createMemoryLog()
const minted: string[] = []
let mints = 0
const handlers = new Set<(envelope: WebhookEnvelope) => void>()
const unverified: string[] = []

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
      ...readOrchestratorConfig({ ...process.env, EZPUG_IRON_PROVIDERS: 'sim' }),
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
          for (const handler of handlers) handler(result.envelope)
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

beforeEach(ctx => {
  if (unavailable) ctx.skip(`dev world unavailable: ${unavailable}`)
})

/**
 * Everything this file ever wrote to the shared test database — every key
 * under its namespace (the names are stable per file, `testNamespace`), with
 * the matches, servers, tokens, events, deliveries and commands hanging off
 * them. Run before a suite as well as after it: a run Turbo cancelled
 * mid-flight (a sibling task failed) never reaches `afterAll`, and its rows
 * would otherwise make the next run's key names collide and its `sim-1` rows
 * leak into other suites' listings.
 */
async function sweepNamespace(): Promise<void> {
  if (!config) return
  const cleanup = createDatabase(config.database, { applicationName: 'ezpug-iron-test-cleanup' })
  try {
    const { db } = cleanup
    const keys = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(like(apiKeys.name, `${namespace}-%`))
    const keyIds = [...new Set([...keys.map(row => row.id), ...minted])]
    if (keyIds.length === 0) return
    const rows = await db
      .select({ id: matches.id })
      .from(matches)
      .where(inArray(matches.keyId, keyIds))
    const ids = rows.map(row => row.id)
    if (ids.length > 0) {
      await db.delete(webhookDeliveries).where(inArray(webhookDeliveries.matchId, ids))
      await db.delete(matchEvents).where(inArray(matchEvents.matchId, ids))
      await db.delete(matchCommands).where(inArray(matchCommands.matchId, ids))
      // Round backups hang off a match too (the sim reports them since T14).
      await db.delete(backups).where(inArray(backups.matchId, ids))
    }
    const owned = await db
      .select({ id: servers.id })
      .from(servers)
      .where(inArray(servers.keyId, keyIds))
    if (owned.length > 0)
      await db.delete(serverTokens).where(
        inArray(
          serverTokens.fleetServerId,
          owned.map(row => row.id),
        ),
      )
    await db.delete(servers).where(inArray(servers.keyId, keyIds))
    await db.delete(matches).where(inArray(matches.keyId, keyIds))
    for (const id of keyIds) {
      await db.delete(apiKeyWebhookSecrets).where(eq(apiKeyWebhookSecrets.keyId, id))
      await db.delete(apiKeys).where(eq(apiKeys.id, id))
    }
  } finally {
    await cleanup.close()
  }
}

afterAll(async () => {
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
  const deadline = systemClock.now() + QUIESCE_TIMEOUT_MS
  for (let pass = 0; pass < 8; pass += 1) {
    await o.matches.settle()
    await o.webhooks.settle()
    const due = await o.store.listDueDeliveries(systemClock.date(), 1)
    if (due.length === 0 || systemClock.now() >= deadline) return
  }
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
  minted.push(platform.key.id, thrifty.key.id)
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
  // Deliveries for this key only: the endpoint hears every key's.
  const mine = new Set<string>()
  return {
    client,
    webhooks: handler => {
      const filtered = (envelope: WebhookEnvelope): void => {
        if (mine.has(envelope.matchId)) handler(envelope)
      }
      handlers.add(filtered)
      const seen = client.matches.list
      void seen
      return () => {
        handlers.delete(filtered)
      }
    },
    callbacks: { webhookUrl: `${endpointUrl}/hooks/ezpug`, webhookSecretId: SECRET_ID },
    clock: systemClock,
    pollIntervalMs: 250,
    maxWaitMs: 120_000,
    // The one sim provider serves every flow, so the knobs are armed for
    // this flow's match and cleared when it is done with the target.
    faults: faults =>
      (o.providers.get('sim') as SimProvider).setFaults(
        faults.crash === undefined ? {} : { crash: faults.crash },
      ),
    close: () => (o.providers.get('sim') as SimProvider).setFaults({}),
    advance: async ms => {
      // Which matches are ours is learned from the list, so the filter above
      // never needs the flow to say.
      const page = await client.matches.list({ query: {} })
      for (const match of page.items) mine.add(match.id)
      // Real time is what a poll waits for here; the barrier after it is so
      // the next read sees a written world rather than a half-written one.
      await systemClock.sleep(Math.min(ms, 250))
      await quiesce()
    },
    settle: async () => {
      const page = await client.matches.list({ query: {} })
      for (const match of page.items) mine.add(match.id)
      await quiesce()
    },
    stream: (subscription, onFrame) => {
      const handle = client.subscribeStream({
        matchId: subscription.matchId,
        onFrame,
        ...(subscription.token === undefined ? {} : { token: subscription.token }),
      })
      return () => handle.close()
    },
    budget: { client: budgetClient, maxServerLifetimeMinutes: 60 },
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
    const o = orchestrator as Orchestrator
    expect(await o.fleet.servers()).toEqual([])
    expect(await o.providers.get('sim')?.list()).toEqual([])
    expect(log.lines.filter(line => line.startsWith('error'))).toEqual([])
    // Every flow of the set, one after another, each a real match at
    // `SIM_TIME_SCALE` — a budget, not an expectation.
  }, 420_000)
})
