import { createFakeClock, type FakeClock } from '@ezpug/core'
import { SHIPPED_GAMEMODES, type WebhookEnvelope } from '@ezpug/match-api'
import type { SimPlan } from '@ezpug/sim'
import { createApp } from '../app'
import { createFleet, type Fleet } from '../fleet/service'
import { createHealth, type HealthReport } from '../health'
import { createMemoryKeyStore } from '../keys/memory-store'
import { createKeys, type Keys } from '../keys/service'
import { createLinkRegistry, type LinkRegistry } from '../link/channels'
import { createMemoryLog } from '../log'
import { createMatches, type MatchDeadlines, type Matches } from '../match/machine'
import { createMemoryMatchStore } from '../match/memory-store'
import { createReaper, type Reaper } from '../providers/reaper'
import { createProviderRegistry, type ProviderRegistry } from '../providers/registry'
import { createSimProvider, type SimProvider } from '../providers/sim/provider'
import { createStreamHub, type StreamHub } from '../stream/hub'
import {
  createWebhookWorker,
  type WebhookAttemptReport,
  type WebhookWorker,
} from '../webhooks/worker'
import { createDispatch } from './dispatch'
import { createHandlers } from './handlers'
import { createRateLimiter } from './rate-limit'

/**
 * The whole orchestrator composed over memory — what every test of the
 * machine, the walk, the reaper, the webhooks, the stream and the HTTP
 * rails runs on: a fake clock, the in-memory stores, the sim provider, a
 * local fan-out, a webhook `fetch` a test scripts, a captured log, health
 * checks a test can flip. Nothing here opens a socket or a pool; the
 * database-backed suites and the standing and extended suites prove those.
 */
export interface TestApp {
  app: ReturnType<typeof createApp>
  keys: Keys
  clock: FakeClock
  log: ReturnType<typeof createMemoryLog>
  store: ReturnType<typeof createMemoryMatchStore>
  providers: ProviderRegistry
  sim: SimProvider
  links: LinkRegistry
  matches: Matches
  fleet: Fleet
  hub: StreamHub
  webhooks: WebhookWorker
  reaper: Reaper
  /** Every webhook POST the worker made, in order, as the endpoint saw it. */
  posted: { url: string; headers: Record<string, string>; body: string }[]
  /** Every attempt's outcome. */
  attempts: WebhookAttemptReport[]
  /** What the endpoint answers a POST with; a test replaces it. Default: 200. */
  respond: (request: {
    url: string
    headers: Record<string, string>
    body: string
  }) => number | null
  /** Every envelope the endpoint accepted, parsed. */
  received: WebhookEnvelope[]
  /** Flip a rail's health; both start healthy. */
  rails: { database: boolean; redis: boolean }
  draining: { value: boolean }
  /** One request through the app, in-process. */
  request: (
    path: string,
    init?: RequestInit & { key?: string; json?: unknown },
    // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever JSON came back
  ) => Promise<{ status: number; body: any; headers: Headers }>
  /** An in-process `fetch` over the app — what the published client takes. */
  fetch: typeof globalThis.fetch
  health: () => Promise<HealthReport>
  /** Let every chain, delivery and timer armed for *now* finish. */
  settle: () => Promise<void>
  /** Advance the clock, then settle. */
  advance: (ms: number) => Promise<void>
  /** Run timers and settle until the world is quiet — a whole match. */
  playOut: () => Promise<void>
  close: () => Promise<void>
}

export interface TestAppOptions {
  burst?: number
  perSecond?: number
  deadlines?: Partial<MatchDeadlines>
  /** The sim provider's per-server defaults (time scale, boot delay…). */
  sim?: SimPlan
  simCapacity?: number
  simHourlyCents?: number
  /** Register no provider at all — a world with nothing to allocate. */
  noProviders?: boolean
  webhookPollIntervalMs?: number
}

export function createTestApp(options: TestAppOptions = {}): TestApp {
  const clock = createFakeClock({ start: '2026-09-05T18:00:00.000Z' })
  const log = createMemoryLog()
  const keys = createKeys({ store: createMemoryKeyStore(), clock })
  const store = createMemoryMatchStore()
  const providers = createProviderRegistry()
  const links = createLinkRegistry()
  const hub = createStreamHub({ clock, log })
  const posted: TestApp['posted'] = []
  const attempts: WebhookAttemptReport[] = []
  const received: WebhookEnvelope[] = []
  const rig: Pick<TestApp, 'respond'> = { respond: () => 200 }

  const webhookFetch: typeof globalThis.fetch = (url, init) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value
    })
    const body = String(init?.body ?? '')
    const request = { url: String(url), headers, body }
    posted.push(request)
    const status = rig.respond(request)
    if (status === null) return Promise.reject(new Error('connection refused'))
    if (status >= 200 && status < 300) received.push(JSON.parse(body) as WebhookEnvelope)
    return Promise.resolve(new Response(null, { status }))
  }
  const webhooks = createWebhookWorker({
    clock,
    log,
    store,
    keys,
    fetch: webhookFetch,
    pollIntervalMs: options.webhookPollIntervalMs,
    onAttempt: report => void attempts.push(report),
  })
  const matches = createMatches({
    clock,
    log,
    store,
    providers,
    links,
    gamemodes: SHIPPED_GAMEMODES,
    hub,
    webhooks,
    baseUrl: 'http://localhost:3430',
    deadlines: options.deadlines,
  })
  const sim = createSimProvider({
    clock,
    sink: matches,
    links,
    capacity: options.simCapacity,
    hourlyCents: options.simHourlyCents,
    defaults: options.sim,
    onError: (error, context) => log.error(`sim ${JSON.stringify(context)}`, error),
  })
  if (!options.noProviders) providers.register(sim)
  const reaper = createReaper({ registry: providers, store, matches, clock, log })
  const fleet = createFleet({ clock, store, registry: providers, matches })

  const rails = { database: true, redis: true }
  const draining = { value: false }
  const rail = (name: keyof typeof rails) => (): Promise<void> =>
    rails[name] ? Promise.resolve() : Promise.reject(new Error(`${name} is down`))
  const health = createHealth({ clock, database: rail('database'), redis: rail('redis') })
  const app = createApp({
    clock,
    log,
    dispatch: createDispatch(
      keys,
      createHandlers({ keys, gamemodes: SHIPPED_GAMEMODES, matches, fleet }),
    ),
    rateLimiter: createRateLimiter({
      clock,
      burst: options.burst ?? 120,
      perSecond: options.perSecond ?? 10,
    }),
    health,
    isDraining: () => draining.value,
  })
  void hub.start()

  const settle = async (): Promise<void> => {
    for (let round = 0; round < 50; round += 1) {
      await matches.settle()
      await webhooks.settle()
      await new Promise<void>(resolve => setImmediate(resolve))
      // A settled chain may have armed a zero-delay timer (a tick flush).
      if (clock.nextDeadline() === clock.now()) await clock.advance(0)
      else return
    }
  }

  const fetchImpl: typeof globalThis.fetch = (input, init) =>
    Promise.resolve(app.request(input instanceof Request ? input : String(input), init))

  return {
    app,
    keys,
    clock,
    log,
    store,
    providers,
    sim,
    links,
    matches,
    fleet,
    hub,
    webhooks,
    reaper,
    posted,
    attempts,
    get respond() {
      return rig.respond
    },
    set respond(value) {
      rig.respond = value
    },
    received,
    rails,
    draining,
    health,
    fetch: fetchImpl,
    settle,
    request: async (path, init = {}) => {
      const { key, json, ...rest } = init
      const headers = new Headers(rest.headers)
      if (key) headers.set('authorization', `Bearer ${key}`)
      if (json !== undefined) headers.set('content-type', 'application/json')
      const response = await app.request(path, {
        ...rest,
        headers,
        body: json !== undefined ? JSON.stringify(json) : rest.body,
      })
      const text = await response.text()
      return {
        status: response.status,
        body: text.length > 0 ? JSON.parse(text) : undefined,
        headers: response.headers,
      }
    },
    advance: async ms => {
      await settle()
      await clock.advance(ms)
      await settle()
    },
    playOut: async () => {
      for (let round = 0; round < 10_000; round += 1) {
        await settle()
        if (clock.pending() === 0) {
          await settle()
          if (clock.pending() === 0) return
        }
        await clock.next()
      }
      throw new Error('playOut did not settle')
    },
    close: async () => {
      await matches.close()
      await webhooks.close()
      await reaper.stop()
      await hub.close()
    },
  }
}

/** A key request with the round's default budget — what most tests mint. */
export function keyRequest(name: string, scopes: ('matches' | 'fleet' | 'admin')[] = ['matches']) {
  return {
    name,
    scopes,
    budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
    webhookSecrets: [],
  }
}
