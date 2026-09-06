import type { Server as HttpServer } from 'node:http'
import type { Clock } from '@ezpug/core'
import { SHIPPED_GAMEMODES } from '@ezpug/match-api'
import { createAdaptorServer } from '@hono/node-server'
import { createApp } from './app'
import { type Budgets, createBudgets } from './budget/service'
import type { OrchestratorConfig } from './config'
import { createDatabase, type DatabaseHandle } from './db/client'
import { createFleet, type Fleet } from './fleet/service'
import { createFakeSteam } from './gslt/fake-steam'
import { createGsltPool, type GsltPool } from './gslt/pool'
import { createSteamGameServers, type SteamGameServers } from './gslt/steam'
import { createHealth } from './health'
import { createDispatch } from './http/dispatch'
import { createHandlers } from './http/handlers'
import { createRateLimiter } from './http/rate-limit'
import { createPostgresKeyStore } from './keys/postgres-store'
import { createKeys, type Keys } from './keys/service'
import { createLinkRegistry, type LinkRegistry } from './link/channels'
import { attachNodeLink, type NodeLink } from './link/node-link'
import { attachServerLink, type ServerLink } from './link/server-link'
import type { Log } from './log'
import { createMatches, type Matches } from './match/machine'
import { createPostgresMatchStore } from './match/postgres-store'
import type { MatchStore } from './match/store'
import { createMatchZyDoor } from './matchzy/door'
import { createNodeRegistry, type NodeRegistry } from './nodes/registry'
import { createNodes, type Nodes } from './nodes/service'
import { createDathostProvider, DATHOST_PROVIDER_ID } from './providers/dathost/provider'
import { createNodesProvider, type NodesProvider } from './providers/nodes/provider'
import { createReaper, type Reaper } from './providers/reaper'
import { createProviderRegistry, type ProviderRegistry } from './providers/registry'
import { createSimProvider } from './providers/sim/provider'
import { createRedis, type RedisHandle } from './redis'
import { createHttpDrain, createShutdown, type DrainResult, type Shutdown } from './shutdown'
import { shutdownSteps } from './shutdown-steps'
import { createRedisFanout } from './stream/fanout'
import { createStreamHub, type StreamHub } from './stream/hub'
import { attachStreamUpgrade, attachUpgradeRouter, type UpgradeRouter } from './stream/upgrade'
import { createFileTrace, nullTrace, type Trace } from './trace'
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
  readonly budgets: Budgets
  readonly store: MatchStore
  readonly providers: ProviderRegistry
  readonly links: LinkRegistry
  /** The `/link` sessions (T6). */
  readonly link: ServerLink
  /** The `/node` sessions (T12). */
  readonly nodeLink: NodeLink
  readonly nodeRegistry: NodeRegistry
  readonly nodes: Nodes
  readonly matches: Matches
  readonly fleet: Fleet
  readonly hub: StreamHub
  readonly webhooks: WebhookWorker
  readonly reaper: Reaper
  /** The Steam login tokens rented servers need (T17). */
  readonly gslt: GsltPool
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
  /**
   * What the Dathost provider calls the vendor with. Default: the global
   * `fetch`. A suite that wants a whole orchestrator over the fake Dathost
   * (T15) hands its door here; nothing in production sets it.
   */
  dathostFetch?: Parameters<typeof createDathostProvider>[0]['fetch']
}

/** The host of a URL, for a name a human reads — never the whole URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'unknown'
  }
}

export function createOrchestrator(options: CreateOrchestratorOptions): Orchestrator {
  const { config, clock, log } = options

  // The dev recorder (T13): off unless `EZPUG_IRON_TRACE_FILE` names a file,
  // and refused outright in production (`config.ts`).
  const trace: Trace = config.traceFile
    ? createFileTrace({
        path: config.traceFile,
        clock,
        onOpen: path => log.info(`tracing every link frame and MatchZy payload to ${path}`),
      })
    : nullTrace

  // One pool per process, created at startup and passed down.
  const database = createDatabase(config.database, { applicationName: 'orchestrator' })
  const redis = createRedis(config.redis, { name: 'orchestrator' })

  const keyStore = createPostgresKeyStore(database.db)
  const keys = createKeys({
    store: keyStore,
    clock,
    onError: (error, context) => log.error(`keys ${String(context.op)}`, error),
  })
  const store = createPostgresMatchStore(database.db)
  const providers = createProviderRegistry()
  const links = createLinkRegistry()
  const nodeRegistry = createNodeRegistry()
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
  // The budget needs the machine's `emit` and the machine needs the budget's
  // `check`: the knot is tied with a lazy read, the same trick the drain uses
  // for the health route, because both only ever fire after both exist.
  const budgets = createBudgets({
    clock,
    log,
    store,
    keys: keyStore,
    emit: async (matchId, fact) => {
      await matches.emit(matchId, fact)
    },
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
    budget: budgets,
    baseUrl: config.baseUrl,
  })
  const reaper = createReaper({ registry: providers, store, matches, clock, log })

  // **The GSLT pool** (T17): the Steam accounts a rented server logs in
  // with. Always built — `GET /v1/fleet/gslt` is a route whether or not a
  // key exists, and a pool with no Steam door still leases the accounts the
  // table holds. Where it mints from is the one decision:
  const steam: SteamGameServers | undefined = config.gslt.steamApiKey
    ? createSteamGameServers({ clock, log, apiKey: config.gslt.steamApiKey })
    : config.gslt.fakeSteam
      ? createSteamGameServers({
          clock,
          log,
          apiKey: 'fake-steam-key',
          fetch: createFakeSteam({ clock, apiKey: 'fake-steam-key' }).fetch,
          baseUrl: 'http://fake-steam.invalid',
        })
      : undefined
  if (config.gslt.fakeSteam)
    log.warn(
      'gslt: minting login tokens against the in-process fake Steam — every server this ' +
        'deployment starts accepts LAN connections only',
    )
  const gslt = createGsltPool({
    clock,
    log,
    store,
    max: config.gslt.poolMax,
    // One Steam key may serve two deployments; the memo says whose an
    // account is, and the sweep only ever adopts its own.
    deployment: hostOf(config.baseUrl),
    ...(steam && { steam }),
  })
  const fleet = createFleet({ clock, store, registry: providers, matches, links })

  // The node provider needs the server link (a claimed warm instance is
  // assigned down the socket it already holds) and the link needs the app's
  // server, which does not exist yet — the same lazy knot the drain uses.
  let link: ServerLink | undefined
  let nodesProvider: NodesProvider | undefined
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
    } else if (id === 'nodes') {
      nodesProvider = createNodesProvider({
        clock,
        log,
        store,
        registry: nodeRegistry,
        image: config.nodeServerImage,
        baseUrl: config.baseUrl,
        link: () => link,
        facts: {
          emit: (matchId, fact) => matches.emit(matchId, fact),
        },
      })
      providers.register(nodesProvider)
    } else if (id === DATHOST_PROVIDER_ID) {
      // Registered iff the account is configured (T16). A deployment without
      // the credentials still serves `sim` and `nodes` rather than refusing
      // to boot — the deploy that goes out while the owner is finding the
      // password (T35) — and says so once, loudly, at startup.
      if (config.dathost)
        providers.register(
          createDathostProvider({
            clock,
            log,
            email: config.dathost.email,
            password: config.dathost.password,
            templateServerId: config.dathost.templateServerId,
            location: config.dathost.location,
            gslt,
            ...(options.dathostFetch && { fetch: options.dathostFetch }),
          }),
        )
      else
        log.warn(
          `EZPUG_IRON_PROVIDERS names "${DATHOST_PROVIDER_ID}" but no account is configured ` +
            '(EZPUG_IRON_DATHOST_EMAIL, EZPUG_IRON_DATHOST_PASSWORD, ' +
            'EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID) — the provider is not registered',
        )
    } else {
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

  const nodes = createNodes({
    clock,
    log,
    store,
    registry: nodeRegistry,
    disconnect: (nodeId, code, reason) => nodeLink.disconnect(nodeId, code, reason),
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
      createHandlers({ keys, budgets, gamemodes: SHIPPED_GAMEMODES, matches, fleet, nodes, gslt }),
    ),
    rateLimiter: createRateLimiter({ clock, ...config.rateLimit }),
    health,
    isDraining: () => shutdown?.draining === true,
    matchzy: createMatchZyDoor({ store, matches, log, trace }),
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
  const serverLink = attachServerLink({
    router: upgrades,
    clock,
    log,
    store,
    matches,
    links,
    trace,
    isDraining: () => shutdown?.draining === true,
  })
  link = serverLink
  const nodeLink = attachNodeLink({
    router: upgrades,
    clock,
    log,
    store,
    registry: nodeRegistry,
    trace,
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
      links: serverLink,
      nodeLinks: nodeLink,
      streams: {
        close: () => {
          for (const client of wss.clients) client.close(1001, 'draining')
        },
      },
      reaper,
      budgets,
      gslt,
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
    budgets,
    store,
    providers,
    links,
    link: serverLink,
    nodeLink,
    nodeRegistry,
    nodes,
    matches,
    fleet,
    hub,
    webhooks,
    reaper,
    gslt,
    upgrades,
    app,
    server,
    shutdown,
    async start() {
      await hub.start()
      await matches.resume()
      await nodesProvider?.topUp()
      webhooks.start()
      reaper.start()
      budgets.start()
      gslt.start()
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
