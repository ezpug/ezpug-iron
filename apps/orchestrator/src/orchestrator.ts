import type { Server as HttpServer } from 'node:http'
import type { Clock } from '@ezpug/core'
import { SHIPPED_GAMEMODES } from '@ezpug/match-api'
import { createAdaptorServer } from '@hono/node-server'
import { createApp } from './app'
import type { OrchestratorConfig } from './config'
import { createDatabase, type DatabaseHandle } from './db/client'
import { createFleet, type Fleet } from './fleet/service'
import { createHealth } from './health'
import { createDispatch } from './http/dispatch'
import { createHandlers } from './http/handlers'
import { createRateLimiter } from './http/rate-limit'
import { createPostgresKeyStore } from './keys/postgres-store'
import { createKeys, type Keys } from './keys/service'
import { createLinkRegistry, type LinkRegistry } from './link/channels'
import type { Log } from './log'
import { createMatches, type Matches } from './match/machine'
import { createPostgresMatchStore } from './match/postgres-store'
import type { MatchStore } from './match/store'
import { createReaper, type Reaper } from './providers/reaper'
import { createProviderRegistry, type ProviderRegistry } from './providers/registry'
import { createSimProvider } from './providers/sim/provider'
import { createRedis, type RedisHandle } from './redis'
import { createHttpDrain, createShutdown, type DrainResult, type Shutdown } from './shutdown'
import { shutdownSteps } from './shutdown-steps'
import { createRedisFanout } from './stream/fanout'
import { createStreamHub, type StreamHub } from './stream/hub'
import { attachStreamUpgrade, attachUpgradeRouter, type UpgradeRouter } from './stream/upgrade'
import { createWebhookWorker, type WebhookWorker } from './webhooks/worker'

/**
 * **The composition root**, minus the process: open the rails — the pool,
 * Redis, the key store, the match store — register the providers
 * `EZPUG_IRON_PROVIDERS` names, build the machine, the hub, the webhook
 * worker and the reaper over them, build the app, attach the upgrade router
 * to the server the links dial, and name the drain. `main.ts` reads the
 * environment, calls this, listens and arms the signals; a test calls this
 * with its own config and clock and listens on port 0.
 *
 * The server exists here because the upgrade routes attach to it; it does
 * **not** listen here. Hono builds its route matcher on the first request it
 * dispatches and refuses a route added after that, so the port is opened
 * only once everything is mounted (`listen()`), and until then a probe gets
 * a refused connection — the honest answer to "are you ready".
 *
 * `start()` is what runs *after* the rails answered: the hub joins the
 * fan-out, the machine re-arms every open match, the worker and the reaper
 * arm their sweeps. `main.ts` calls it before `listen()`.
 */
export interface Orchestrator {
  readonly config: OrchestratorConfig
  readonly clock: Clock
  readonly database: DatabaseHandle
  readonly redis: RedisHandle
  readonly keys: Keys
  readonly store: MatchStore
  readonly providers: ProviderRegistry
  readonly links: LinkRegistry
  readonly matches: Matches
  readonly fleet: Fleet
  readonly hub: StreamHub
  readonly webhooks: WebhookWorker
  readonly reaper: Reaper
  readonly upgrades: UpgradeRouter
  readonly app: ReturnType<typeof createApp>
  readonly server: HttpServer
  readonly shutdown: Shutdown
  /** Join the fan-out, resume open matches, arm the worker and the reaper. */
  start: () => Promise<void>
  /** Bind the port. `port: 0` lets the OS pick; the answer says which. */
  listen: (options?: { port?: number; host?: string }) => Promise<{ url: string; port: number }>
  /** Run the drain — what a signal does, callable by a test. */
  close: (signal?: string) => Promise<DrainResult>
}

export interface CreateOrchestratorOptions {
  config: OrchestratorConfig
  clock: Clock
  log: Log
  /** What the webhook worker POSTs with. Default: the global `fetch`. */
  fetch?: typeof globalThis.fetch
  /** The sim provider's defaults (time scale, boot delay) when it is registered. */
  sim?: Parameters<typeof createSimProvider>[0]['defaults']
}

export function createOrchestrator(options: CreateOrchestratorOptions): Orchestrator {
  const { config, clock, log } = options

  // One pool per process, created at startup and passed down.
  const database = createDatabase(config.database, { applicationName: 'orchestrator' })
  const redis = createRedis(config.redis, { name: 'orchestrator' })

  const keys = createKeys({
    store: createPostgresKeyStore(database.db),
    clock,
    onError: (error, context) => log.error(`keys ${String(context.op)}`, error),
  })
  const store = createPostgresMatchStore(database.db)
  const providers = createProviderRegistry()
  const links = createLinkRegistry()
  const hub = createStreamHub({
    clock,
    log,
    fanout: createRedisFanout({ config: config.redis, log }),
  })
  const webhooks = createWebhookWorker({
    clock,
    log,
    store,
    keys,
    fetch: options.fetch ?? globalThis.fetch,
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
    baseUrl: config.baseUrl,
  })
  const reaper = createReaper({ registry: providers, store, matches, clock, log })
  const fleet = createFleet({ clock, store, registry: providers, matches })

  for (const id of config.providers) {
    if (id === 'sim') {
      providers.register(
        createSimProvider({
          clock,
          sink: matches,
          links,
          ...(options.sim && { defaults: options.sim }),
          onError: (error, context) => log.error(`sim ${JSON.stringify(context)}`, error),
        }),
      )
    } else {
      // `dathost` (T16) and `nodes` (T12) register here when they exist.
      throw new Error(`EZPUG_IRON_PROVIDERS names "${id}", which this build does not provide`)
    }
  }

  const health = createHealth({
    clock,
    database: () => database.ping(),
    redis: () => redis.ping(),
    providers: Object.fromEntries(
      providers.all().map(provider => [
        provider.id,
        async () => {
          await provider.offerings()
        },
      ]),
    ),
  })

  /**
   * Assigned below, read from the app's `isDraining`: the health route has
   * to exist before the drain does (the drain closes the server the route is
   * served by), and a lazy read is the whole of what it takes to tie the knot.
   */
  let shutdown: Shutdown | undefined

  const app = createApp({
    clock,
    log,
    dispatch: createDispatch(
      keys,
      createHandlers({ keys, gamemodes: SHIPPED_GAMEMODES, matches, fleet }),
    ),
    rateLimiter: createRateLimiter({ clock, ...config.rateLimit }),
    health,
    isDraining: () => shutdown?.draining === true,
  })

  const server = createAdaptorServer({ fetch: app.fetch }) as HttpServer
  // Attached before anything is awaited, and before the port opens.
  const upgrades = attachUpgradeRouter(server, { log })
  const wss = attachStreamUpgrade({
    router: upgrades,
    clock,
    log,
    keys,
    store,
    hub,
    isDraining: () => shutdown?.draining === true,
  })
  const httpDrain = createHttpDrain(server, clock)

  shutdown = createShutdown({
    clock,
    log,
    steps: shutdownSteps({
      clock,
      httpDrain,
      redis,
      database,
      streams: {
        close: () => {
          for (const client of wss.clients) client.close(1001, 'draining')
        },
      },
      reaper,
      webhooks,
      matches,
      hub,
    }),
  })

  return {
    config,
    clock,
    database,
    redis,
    keys,
    store,
    providers,
    links,
    matches,
    fleet,
    hub,
    webhooks,
    reaper,
    upgrades,
    app,
    server,
    shutdown,
    async start() {
      await hub.start()
      await matches.resume()
      webhooks.start()
      reaper.start()
    },
    listen: ({ port = config.port, host = config.host } = {}) =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          const address = server.address()
          const bound = typeof address === 'object' && address ? address.port : port
          resolve({ url: `http://${host}:${bound}`, port: bound })
        })
      }),
    close: (signal = 'close') => shutdown.drain(signal),
  }
}
