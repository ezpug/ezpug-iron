import type { Server as HttpServer } from 'node:http'
import type { Clock } from '@ezpug/core'
import { SHIPPED_GAMEMODES } from '@ezpug/match-api'
import { createAdaptorServer } from '@hono/node-server'
import { createApp } from './app'
import type { OrchestratorConfig } from './config'
import { createDatabase, type DatabaseHandle } from './db/client'
import { createHealth } from './health'
import { createDispatch } from './http/dispatch'
import { createHandlers } from './http/handlers'
import { createRateLimiter } from './http/rate-limit'
import { createPostgresKeyStore } from './keys/postgres-store'
import { createKeys, type Keys } from './keys/service'
import type { Log } from './log'
import { createRedis, type RedisHandle } from './redis'
import { createHttpDrain, createShutdown, type DrainResult, type Shutdown } from './shutdown'
import { shutdownSteps } from './shutdown-steps'

/**
 * **The composition root**, minus the process: open the rails — the pool,
 * Redis, the key store — build the app over them, create the server the
 * links will attach to (T6), and name the drain. `main.ts` reads the
 * environment, calls this, listens and arms the signals; a test calls this
 * with its own config and clock and listens on port 0.
 *
 * The server exists here because the link sockets attach to it; it does
 * **not** listen here. Hono builds its route matcher on the first request it
 * dispatches and refuses a route added after that, so the port is opened
 * only once everything is mounted (`listen()`), and until then a probe gets
 * a refused connection — the honest answer to "are you ready".
 */
export interface Orchestrator {
  readonly config: OrchestratorConfig
  readonly clock: Clock
  readonly database: DatabaseHandle
  readonly redis: RedisHandle
  readonly keys: Keys
  readonly app: ReturnType<typeof createApp>
  readonly server: HttpServer
  readonly shutdown: Shutdown
  /** Bind the port. `port: 0` lets the OS pick; the answer says which. */
  listen: (options?: { port?: number; host?: string }) => Promise<{ url: string; port: number }>
  /** Run the drain — what a signal does, callable by a test. */
  close: (signal?: string) => Promise<DrainResult>
}

export interface CreateOrchestratorOptions {
  config: OrchestratorConfig
  clock: Clock
  log: Log
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

  const health = createHealth({
    clock,
    database: () => database.ping(),
    redis: () => redis.ping(),
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
    dispatch: createDispatch(keys, createHandlers({ keys, gamemodes: SHIPPED_GAMEMODES })),
    rateLimiter: createRateLimiter({ clock, ...config.rateLimit }),
    health,
    isDraining: () => shutdown?.draining === true,
  })

  const server = createAdaptorServer({ fetch: app.fetch }) as HttpServer
  const httpDrain = createHttpDrain(server, clock)

  shutdown = createShutdown({
    clock,
    log,
    steps: shutdownSteps({ clock, httpDrain, redis, database }),
  })

  return {
    config,
    clock,
    database,
    redis,
    keys,
    app,
    server,
    shutdown,
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
