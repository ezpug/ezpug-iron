import { cpus } from 'node:os'
import type { Clock } from '@ezpug/core'
import type { NodeInstance, OrchestratorNodeFrameOf } from '@ezpug/protocol'
import type { NodeConfig } from './config'
import type { DockerPort } from './docker/port'
import { createInstanceManager, type InstanceManager } from './instances'
import {
  createNodeLink,
  type HelloBody,
  type LinkClosure,
  type NodeLink,
  type NodeLinkSocketConstructor,
} from './link'
import type { Log } from './log'
import type { NodeState, StateStore } from './state'
import { NODE_AGENT_VERSION } from './version'

/**
 * **`ezpug-node`, composed** (decision 23, PRD-02 T11): the link
 * (`link.ts`), the containers (`instances.ts`) and the identity on disk
 * (`state.ts`), wired so that
 *
 * - `enrol(token)` dials once with the one-time token, keeps the node token
 *   the `welcome` hands over, and hangs up;
 * - `run()` checks docker and the image, adopts the containers a previous
 *   agent left running, dials with the node token and keeps dialling,
 *   applies `start`/`stop`/`drain`/`undrain`, sends an `instances`
 *   snapshot whenever one changes, and writes `health.json` on every
 *   heartbeat for the image's `HEALTHCHECK`.
 *
 * Stopping the agent stops the agent: the containers keep running, the
 * orchestrator notices the node is gone (T12's `fleet.node_disconnected`),
 * and a restarted agent adopts them back. A node that *dies* mid-match is a
 * server that dies mid-match, which is T14's flow on the other side.
 */

export interface NodeAgentOptions {
  config: NodeConfig
  clock: Clock
  log: Log
  docker: DockerPort
  state: StateStore
  WebSocket?: NodeLinkSocketConstructor
  /** The `cores` label when the operator set none. Default: this host's. */
  cores?: number
  helloTimeoutMs?: number
  backoffInitialMs?: number
  backoffMaxMs?: number
}

export interface NodeRunOutcome {
  /** Present when the orchestrator ended the link with a decision (unauthorized, revoked…). */
  fatal?: LinkClosure
}

export interface NodeAgent {
  /** Enrol this host once. Resolves with the identity written to disk; the token in it is never logged. */
  enrol: (enrolmentToken: string) => Promise<NodeState>
  /** Serve until `close()` or a fatal close. */
  run: () => Promise<NodeRunOutcome>
  snapshot: () => NodeInstance[]
  drained: () => boolean
  connected: () => boolean
  nodeId: () => string | null
  close: () => Promise<void>
}

/** Docker must be there and the image must be here (pulled if not) before a hello can be honest. */
async function ensureImage(docker: DockerPort, image: string, log: Log): Promise<string> {
  await docker.ping()
  let digest = await docker.imageDigest(image)
  if (digest === null) {
    log.info(`the server image ${image} is not on this host; pulling…`)
    await docker.pullImage(image)
    digest = await docker.imageDigest(image)
    if (digest === null) throw new Error(`pulled ${image} and still cannot find it`)
  }
  return digest
}

export function createNodeAgent(options: NodeAgentOptions): NodeAgent {
  const { config, clock, log, docker, state } = options
  const cores = options.cores ?? cpus().length

  let identity: NodeState | null = null
  let link: NodeLink | undefined
  let imageDigest: string | null = null
  let heartbeatIntervalMs = 0
  let welcomedDrained = false
  let closed = false
  let resolveRun: ((outcome: NodeRunOutcome) => void) | undefined

  const instances: InstanceManager = createInstanceManager({
    docker,
    clock,
    log,
    nodeId: () => identity?.nodeId ?? null,
    maxInstances: config.maxInstances,
    gameVolume: config.gameVolume,
    gamemodesDir: config.gamemodesDir,
    stopTimeoutSeconds: config.stopTimeoutSeconds,
    pollIntervalMs: config.pollIntervalMs,
    onChange: snapshot => {
      if (link?.send({ type: 'instances', instances: snapshot }) === false)
        log.info(
          `instances changed while the link is down; the next hello carries ${snapshot.length}`,
        )
    },
  })

  const labels = (): Record<string, string> => ({
    ...(config.labels.cores === undefined && { cores: String(cores) }),
    ...config.labels,
  })

  const hello = (): HelloBody => ({
    version: NODE_AGENT_VERSION,
    region: config.region,
    lan: config.lan,
    labels: labels(),
    capacity: { maxInstances: config.maxInstances, warm: config.warm },
    imageDigest: imageDigest ?? '',
    instances: instances.snapshot(),
  })

  const writeHealth = (connected: boolean): void => {
    if (!identity) return
    void state
      .writeHealth({
        nodeId: identity.nodeId,
        connected,
        lastLinkAt: clock.now(),
        heartbeatIntervalMs: Math.max(heartbeatIntervalMs, 1),
        instances: instances.snapshot().length,
      })
      .catch(error => log.error('could not write health.json', error))
  }

  const onWelcome = (welcome: OrchestratorNodeFrameOf<'welcome'>): void => {
    heartbeatIntervalMs = welcome.heartbeatIntervalMs
    welcomedDrained = welcome.drained
    if (welcome.drained) instances.drain()
    else instances.undrain()
    log.info(
      `linked to ${config.orchestratorUrl} as ${welcome.nodeId}` +
        `${welcome.drained ? ' (drained)' : ''}; ${instances.snapshot().length} instance(s), ` +
        `capacity ${config.maxInstances}, warm ${config.warm}`,
    )
    writeHealth(true)
  }

  return {
    enrol: async enrolmentToken => {
      const existing = await state.read()
      if (existing)
        throw new Error(
          `this host is already enrolled as ${existing.nodeId} against ${existing.orchestratorUrl} ` +
            `(${state.path}); run \`ezpug-node forget\` first if that identity was revoked`,
        )
      imageDigest = await ensureImage(docker, config.image, log)
      const once = createNodeLink({
        url: config.linkUrl,
        clock,
        log,
        credentials: () => ({ token: enrolmentToken, tokenKind: 'enrolment' }),
        handler: {
          hello,
          onWelcome: () => undefined,
          onStart: () => undefined,
          onStop: () => undefined,
          onDrain: () => undefined,
          onUndrain: () => undefined,
        },
        WebSocket: options.WebSocket,
        helloTimeoutMs: options.helloTimeoutMs,
      })
      try {
        const welcome = await once.connectOnce()
        if (welcome.nodeToken === undefined)
          throw new Error('the orchestrator accepted the enrolment but handed over no node token')
        const written: NodeState = {
          nodeId: welcome.nodeId,
          nodeToken: welcome.nodeToken,
          orchestratorUrl: config.orchestratorUrl,
          enrolledAt: clock.date().toISOString(),
        }
        await state.write(written)
        identity = written
        log.info(
          `enrolled as ${welcome.nodeId}; the node token is in ${state.path} and nowhere else`,
        )
        return written
      } finally {
        await once.close()
      }
    },

    run: async () => {
      if (closed) throw new Error('the agent was closed')
      identity = await state.read()
      if (!identity)
        throw new Error(
          `this host is not enrolled (no ${state.path}); run \`ezpug-node enrol <token>\` first`,
        )
      if (identity.orchestratorUrl !== config.orchestratorUrl)
        throw new Error(
          `enrolled against ${identity.orchestratorUrl} but configured for ${config.orchestratorUrl}; ` +
            'point EZPUG_NODE_ORCHESTRATOR_URL back, or `ezpug-node forget` and enrol again',
        )
      imageDigest = await ensureImage(docker, config.image, log)
      const adopted = await instances.adopt()
      if (adopted > 0) log.info(`adopted ${adopted} container(s) from a previous run`)
      instances.watch()
      const outcome = new Promise<NodeRunOutcome>(resolve => {
        resolveRun = resolve
      })
      link = createNodeLink({
        url: config.linkUrl,
        clock,
        log,
        credentials: () => ({ token: identity!.nodeToken, tokenKind: 'node' }),
        handler: {
          hello,
          onWelcome,
          onStart: spec => instances.start(spec),
          onStop: (instanceId, reason) => instances.stop(instanceId, reason),
          onDrain: () => {
            welcomedDrained = true
            instances.drain()
            log.info('drained: live matches finish, nothing starts')
          },
          onUndrain: () => {
            welcomedDrained = false
            instances.undrain()
            log.info('undrained: taking work again')
          },
          onHeartbeat: () => writeHealth(true),
          onDisconnect: () => writeHealth(false),
          onFatal: closure => {
            resolveRun?.({ fatal: closure })
            resolveRun = undefined
          },
        },
        WebSocket: options.WebSocket,
        helloTimeoutMs: options.helloTimeoutMs,
        backoffInitialMs: options.backoffInitialMs,
        backoffMaxMs: options.backoffMaxMs,
      })
      link.run()
      return outcome
    },

    snapshot: () => instances.snapshot(),
    drained: () => welcomedDrained || instances.drained(),
    connected: () => link?.connected() ?? false,
    nodeId: () => identity?.nodeId ?? null,

    close: async () => {
      if (closed) return
      closed = true
      await link?.close()
      await instances.close()
      writeHealth(false)
      resolveRun?.({})
      resolveRun = undefined
    },
  }
}
