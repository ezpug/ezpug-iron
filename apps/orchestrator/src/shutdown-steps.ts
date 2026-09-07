/**
 * The order this process leaves in, beside the machinery that runs it
 * (`shutdown.ts`). It lives in its own file because it is the one part of
 * the composition root that is a *statement about every other part*: each
 * step names something `orchestrator.ts` opened, so whoever adds a
 * connection adds a line here, and the reading of the whole drain is one
 * screen. Later tasks insert their steps where the comments say: the links
 * (T6) and the node links (T12) close between the listener and the
 * requests; the pool is always last.
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
  /** The server links (T6): every session told `shuttingDown`, so the plugins reconnect with backoff. */
  links?: Closable
  /** The node links (T12): the agents are told to go after their servers were, and reconnect with backoff. */
  nodeLinks?: Closable
  /** The stream sockets (T3). Absent in a composition without a listener. */
  streams?: Closable
  reaper?: { stop: () => Promise<void> }
  /** The provider health loop (T31) — a timer, disarmed with the reaper's. */
  probes?: { stop: () => Promise<void> }
  /** The budget sweep (T5) — a timer, disarmed with the reaper's. */
  budgets?: { stop: () => Promise<void> }
  /** The GSLT pool's sweep (T17) — disarmed here, and its lease chain awaited. */
  gslt?: { stop: () => Promise<void> }
  webhooks?: Closable
  matches?: Closable
  hub?: Closable
}

export function shutdownSteps(options: ShutdownStepsOptions): DrainStep[] {
  const {
    clock,
    httpDrain,
    redis,
    database,
    links,
    nodeLinks,
    streams,
    reaper,
    probes,
    budgets,
    gslt,
    webhooks,
    matches,
    hub,
  } = options
  return [
    // 1. Out of rotation first, while everything still works.
    { name: 'health', run: () => clock.sleep(HEALTH_GRACE_MS) },
    // 2. No new connections. In-flight ones keep running.
    { name: 'listener', run: () => httpDrain.stopAccepting() },
    // 3. The server links (T6; the node links join them in T12): a link is
    //    not in flight, it is *parked*, and its peer reconnects by itself with
    //    backoff — told to go while the machines below are still open, so a
    //    last `state` frame still lands.
    ...(links ? [{ name: 'links', run: () => links.close() }] : []),
    //    The node agents go after the servers they run, so a container's last
    //    `state` frame is still on a link the orchestrator is listening to.
    ...(nodeLinks ? [{ name: 'node-links', run: () => nodeLinks.close() }] : []),
    // 4. The stream's subscribers: told to go (1001) and to replay from the
    //    events route when they come back, before the hub they hang off.
    ...(streams ? [{ name: 'streams', run: () => streams.close() }] : []),
    // 5. Now the wait means what it says: only requests are left.
    { name: 'requests', run: () => httpDrain.finish(REQUEST_GRACE_MS) },
    // 6. The reaper, the probe loop, the budget sweep, the webhook worker and the match
    //    machines drain here — sweeps disarmed, attempts in flight awaited,
    //    deadlines disarmed and chains awaited — before the hub whose fan-out
    //    they publish into.
    ...(reaper ? [{ name: 'reaper', run: () => reaper.stop() }] : []),
    ...(probes ? [{ name: 'probes', run: () => probes.stop() }] : []),
    ...(budgets ? [{ name: 'budgets', run: () => budgets.stop() }] : []),
    ...(gslt ? [{ name: 'gslt', run: () => gslt.stop() }] : []),
    ...(webhooks ? [{ name: 'webhooks', run: () => webhooks.close() }] : []),
    ...(matches ? [{ name: 'matches', run: () => matches.close() }] : []),
    ...(hub ? [{ name: 'hub', run: () => hub.close() }] : []),
    // 7. The Redis clients.
    { name: 'redis', run: () => redis.close() },
    // 8. Last, because every step above may still have been writing.
    { name: 'database', run: () => database.close() },
  ]
}
