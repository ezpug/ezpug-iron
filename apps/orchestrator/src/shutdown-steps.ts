/**
 * The order this process leaves in, beside the machinery that runs it
 * (`shutdown.ts`). It lives in its own file because it is the one part of
 * the composition root that is a *statement about every other part*: each
 * step names something `orchestrator.ts` opened, so whoever adds a
 * connection adds a line here, and the reading of the whole drain is one
 * screen. Later tasks insert their steps where the comments say: the links
 * (T6) and the node links (T12) close between the listener and the
 * requests; the machines, the reaper and the webhook worker (T3) drain
 * before the hub and the Redis clients; the pool is always last.
 */
import type { Clock } from '@ezpug/core'
import type { DrainStep, HttpDrain } from './shutdown'

/**
 * How long to keep serving after `/healthz` turns 503, before the listener
 * closes. Zero today, deliberately: nothing in front of this process polls
 * health — Traefik load-balances to a single server with no health check,
 * and compose's probe only decides what `docker compose ps` prints. The day
 * a second replica or a health-checked front door exists, this becomes the
 * time it needs to notice, and it is the only line that has to change.
 */
export const HEALTH_GRACE_MS = 0

/** What a request that is already running gets before it is hung up on. */
export const REQUEST_GRACE_MS = 5_000

/** Something with a `close()`; every connection this process opened has one. */
interface Closable {
  close: () => void | Promise<void>
}

export interface ShutdownStepsOptions {
  clock: Clock
  httpDrain: HttpDrain
  redis: Closable
  database: Closable
}

export function shutdownSteps(options: ShutdownStepsOptions): DrainStep[] {
  const { clock, httpDrain, redis, database } = options
  return [
    // 1. Out of rotation first, while everything still works.
    { name: 'health', run: () => clock.sleep(HEALTH_GRACE_MS) },
    // 2. No new connections. In-flight ones keep running.
    { name: 'listener', run: () => httpDrain.stopAccepting() },
    // 3. (T6, T12) The server links and node links go here: a link is not in
    //    flight, it is *parked*, and its peer reconnects by itself with
    //    backoff — told to go while the machines below are still open, so a
    //    last `state` frame still lands.
    // 4. Now the wait means what it says: only requests are left.
    { name: 'requests', run: () => httpDrain.finish(REQUEST_GRACE_MS) },
    // 5. (T3) The reaper, the webhook worker and the match machines drain
    //    here — deadlines disarmed, transitions in progress awaited — before
    //    the hub whose fan-out they publish into.
    // 6. The Redis clients.
    { name: 'redis', run: () => redis.close() },
    // 7. Last, because every step above may still have been writing.
    { name: 'database', run: () => database.close() },
  ]
}
