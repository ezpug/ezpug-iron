import type { Clock, Timer } from '@ezpug/core'
import {
  type InstancePorts,
  type InstanceSpec,
  instancePurposeSchema,
  type NodeInstance,
  nodeInstanceSchema,
} from '@ezpug/protocol'
import { GAME_MOUNT_PATH, GAMEMODES_MOUNT_PATH } from './config'
import type { ContainerInfo, ContainerSpec, DockerPort } from './docker/port'
import type { Log } from './log'

/**
 * **The containers this node runs**, and the one place their life is
 * decided (PRD-02 T11). An `InstanceSpec` from the orchestrator's `start`
 * becomes a container from the server image on the host network with the
 * game volume mounted, the spec's ports and environment, and **the server
 * token in its environment** — the container's plugin dials the
 * orchestrator with it, and from then on the server link carries
 * everything about the match. This file never learns what the server does;
 * it knows what docker says.
 *
 * - **Every decision is a snapshot.** `start`, `stop` and every reconcile
 *   that changes anything call `onChange` with the whole list, which the
 *   agent sends as an `instances` frame; nothing is a delta, so a lost frame
 *   is superseded by the next.
 * - **Refusals are `failed` instances.** The protocol has no "no" frame: a
 *   `start` past capacity, on a port another instance holds, while drained,
 *   or for an image that cannot be pulled becomes a `failed` entry with the
 *   reason in `error`, kept in the snapshot until the orchestrator `stop`s
 *   it (idempotent by contract).
 * - **The containers carry the truth across a restart.** Labels on every
 *   container name the instance, its purpose, server id, match and ports;
 *   `adopt()` at boot reads them back, so a restarted agent finds its warm
 *   pool and its live matches where it left them and never kills a match by
 *   restarting itself.
 * - **Docker is polled on the clock**, not streamed: a container that
 *   exited (`failed`, with the code) or vanished (`failed`, said so) is
 *   noticed within `pollIntervalMs`, and a fake clock makes that instant.
 * - **The warm pool is the orchestrator's to fill.** A warm instance is a
 *   server with a server token, and only the orchestrator mints those; the
 *   node advertises `capacity.warm` in `hello` and runs what `start` says.
 */

/** The labels every container of ours carries — how it is found again, and by whom. */
export const INSTANCE_LABELS = Object.freeze({
  managed: 'com.ezpug.node.managed',
  node: 'com.ezpug.node.id',
  instance: 'com.ezpug.node.instance',
  purpose: 'com.ezpug.node.purpose',
  serverId: 'com.ezpug.node.server-id',
  matchId: 'com.ezpug.node.match-id',
  gamePort: 'com.ezpug.node.game-port',
  tvPort: 'com.ezpug.node.tv-port',
})

export const CONTAINER_NAME_PREFIX = 'ezpug-node-'

/** The environment the server image reads (`docker/cs2/entrypoint.sh`, `plugins/README.md`). */
export const CONTAINER_ENV = Object.freeze({
  serverToken: 'EZPUG_SERVER_TOKEN',
  gamePort: 'EZPUG_IRON_CS2_GAME_PORT',
  tvPort: 'EZPUG_IRON_CS2_GOTV_PORT',
})

export interface InstanceManagerOptions {
  docker: DockerPort
  clock: Clock
  log: Log
  /** The persisted node id — the value of the `node` label. Null before enrolment. */
  nodeId: () => string | null
  maxInstances: number
  gameVolume: string
  gamemodesDir: string | null
  stopTimeoutSeconds: number
  pollIntervalMs: number
  /** The whole list, every time it changes. */
  onChange: (snapshot: NodeInstance[]) => void
}

export interface InstanceManager {
  /** Run this spec. Never throws: a refusal or a docker failure is a `failed` instance. */
  start: (spec: InstanceSpec) => Promise<void>
  /** Remove this instance. Idempotent; an unknown id is nothing. */
  stop: (instanceId: string, reason?: string) => Promise<void>
  snapshot: () => NodeInstance[]
  /** Ask docker once and fold what it says into the snapshot. */
  reconcile: () => Promise<void>
  /** Boot: take over every container of this node docker still has. Resolves with how many. */
  adopt: () => Promise<number>
  drain: () => void
  undrain: () => void
  drained: () => boolean
  /** Poll docker every `pollIntervalMs` until `close()`. */
  watch: () => void
  /** Stop polling. The containers keep running — a restarting agent must not end a match. */
  close: () => Promise<void>
}

/** The container a spec becomes. Pure, so a test can assert it without docker. */
export function containerSpecFor(
  spec: InstanceSpec,
  options: {
    nodeId: string
    gameVolume: string
    gamemodesDir: string | null
    stopTimeoutSeconds: number
  },
): ContainerSpec {
  return {
    name: `${CONTAINER_NAME_PREFIX}${spec.id}`,
    image: spec.image,
    env: {
      ...spec.env,
      [CONTAINER_ENV.serverToken]: spec.serverToken,
      [CONTAINER_ENV.gamePort]: String(spec.ports.game),
      [CONTAINER_ENV.tvPort]: String(spec.ports.tv),
    },
    labels: {
      [INSTANCE_LABELS.managed]: 'true',
      [INSTANCE_LABELS.node]: options.nodeId,
      [INSTANCE_LABELS.instance]: spec.id,
      [INSTANCE_LABELS.purpose]: spec.purpose,
      [INSTANCE_LABELS.serverId]: spec.serverId,
      ...(spec.matchId !== undefined && { [INSTANCE_LABELS.matchId]: spec.matchId }),
      [INSTANCE_LABELS.gamePort]: String(spec.ports.game),
      [INSTANCE_LABELS.tvPort]: String(spec.ports.tv),
    },
    binds: [
      `${options.gameVolume}:${GAME_MOUNT_PATH}`,
      ...(options.gamemodesDir ? [`${options.gamemodesDir}:${GAMEMODES_MOUNT_PATH}:ro`] : []),
    ],
    tty: true,
    stopTimeoutSeconds: options.stopTimeoutSeconds,
  }
}

/** An instance read back out of a container's labels, or null when they are not ours to trust. */
export function instanceFromContainer(container: ContainerInfo): NodeInstance | null {
  const labels = container.labels
  const purpose = instancePurposeSchema.safeParse(labels[INSTANCE_LABELS.purpose])
  const ports: InstancePorts = {
    game: Number(labels[INSTANCE_LABELS.gamePort]),
    tv: Number(labels[INSTANCE_LABELS.tvPort]),
  }
  const state =
    container.status === 'running' || container.status === 'restarting'
      ? 'running'
      : container.status === 'created'
        ? 'starting'
        : 'failed'
  const candidate = {
    id: labels[INSTANCE_LABELS.instance],
    purpose: purpose.success ? purpose.data : undefined,
    state,
    serverId: labels[INSTANCE_LABELS.serverId],
    containerId: container.id,
    ports,
    ...(labels[INSTANCE_LABELS.matchId] !== undefined && {
      matchId: labels[INSTANCE_LABELS.matchId],
    }),
    ...(state === 'failed' && { error: exitReason(container) }),
  }
  const parsed = nodeInstanceSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

function exitReason(container: ContainerInfo): string {
  if (container.error) return container.error
  if (container.exitCode !== undefined && Number.isFinite(container.exitCode))
    return `exited with code ${container.exitCode}`
  return `container is ${container.status}`
}

function sameSnapshot(a: NodeInstance[], b: NodeInstance[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function createInstanceManager(options: InstanceManagerOptions): InstanceManager {
  const { docker, clock, log } = options
  const tracked = new Map<string, NodeInstance>()
  let drained = false
  let closed = false
  let poll: Timer | undefined
  // Every mutation and every reconcile on one chain: a `start` and the
  // `stop` for the same id must apply in the order they arrived, and a
  // reconcile must never read a container the create has not returned for.
  let chain: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work)
    chain = next.catch(() => undefined)
    return next
  }

  const snapshot = (): NodeInstance[] =>
    [...tracked.values()].map(instance => nodeInstanceSchema.parse(instance))

  let lastPublished: NodeInstance[] = []
  /** Containers with our labels and no instance, warned about once each rather than every poll. */
  const warnedAbout = new Set<string>()
  const publish = (): void => {
    const current = snapshot()
    if (sameSnapshot(current, lastPublished)) return
    lastPublished = current
    options.onChange(current)
  }

  const set = (instance: NodeInstance): void => {
    tracked.set(instance.id, instance)
    publish()
  }

  const fail = (spec: InstanceSpec, error: string, containerId?: string): void => {
    log.warn(`instance ${spec.id} failed: ${error}`)
    set({
      id: spec.id,
      purpose: spec.purpose,
      state: 'failed',
      serverId: spec.serverId,
      ...(containerId !== undefined && { containerId }),
      ports: spec.ports,
      ...(spec.matchId !== undefined && { matchId: spec.matchId }),
      error,
    })
  }

  /** The instances that hold a container docker may still be running. */
  const live = (): NodeInstance[] =>
    [...tracked.values()].filter(instance => instance.state !== 'failed')

  const ownLabels = (): Record<string, string> | null => {
    const nodeId = options.nodeId()
    if (nodeId === null) return null
    return { [INSTANCE_LABELS.managed]: 'true', [INSTANCE_LABELS.node]: nodeId }
  }

  const removeContainer = async (instance: NodeInstance): Promise<void> => {
    if (instance.containerId === undefined) return
    await docker.stopContainer(instance.containerId, options.stopTimeoutSeconds)
    await docker.removeContainer(instance.containerId)
  }

  const start = (spec: InstanceSpec): Promise<void> =>
    enqueue(async () => {
      const existing = tracked.get(spec.id)
      if (existing && existing.state !== 'failed') {
        // A resent `start` for what already runs: nothing to do, and the
        // snapshot the orchestrator asked for is the one it has.
        log.info(`instance ${spec.id} is already ${existing.state}; start ignored`)
        return
      }
      const nodeId = options.nodeId()
      if (nodeId === null) {
        fail(spec, 'the node is not enrolled')
        return
      }
      if (drained) {
        fail(spec, 'the node is draining and starts nothing')
        return
      }
      if (existing) {
        // A failed instance being started again: its old container, if any,
        // goes first, or the name would collide.
        await removeContainer(existing).catch(error => {
          log.warn(`could not remove the previous container of ${spec.id}: ${String(error)}`)
        })
        tracked.delete(spec.id)
      }
      const running = live()
      if (running.length >= options.maxInstances) {
        fail(spec, `capacity: ${running.length} of ${options.maxInstances} instances in use`)
        return
      }
      const clash = running.find(
        other =>
          other.ports.game === spec.ports.game ||
          other.ports.tv === spec.ports.tv ||
          other.ports.game === spec.ports.tv ||
          other.ports.tv === spec.ports.game,
      )
      if (clash) {
        fail(spec, `port ${spec.ports.game}/${spec.ports.tv} is in use by instance ${clash.id}`)
        return
      }
      const containerSpec = containerSpecFor(spec, {
        nodeId,
        gameVolume: options.gameVolume,
        gamemodesDir: options.gamemodesDir,
        stopTimeoutSeconds: options.stopTimeoutSeconds,
      })
      try {
        if ((await docker.imageDigest(spec.image)) === null) {
          log.info(`pulling ${spec.image} for instance ${spec.id}…`)
          await docker.pullImage(spec.image)
        }
      } catch (error) {
        fail(spec, `image ${spec.image}: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      let containerId: string
      try {
        containerId = await docker.createContainer(containerSpec)
      } catch (error) {
        fail(spec, `create: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      set({
        id: spec.id,
        purpose: spec.purpose,
        state: 'starting',
        serverId: spec.serverId,
        containerId,
        ports: spec.ports,
        ...(spec.matchId !== undefined && { matchId: spec.matchId }),
      })
      try {
        await docker.startContainer(containerId)
      } catch (error) {
        fail(spec, `start: ${error instanceof Error ? error.message : String(error)}`, containerId)
        return
      }
      log.info(
        `instance ${spec.id} (${spec.purpose}, server ${spec.serverId}) running on ${spec.ports.game}/${spec.ports.tv}`,
      )
      set({ ...tracked.get(spec.id)!, state: 'running' })
    })

  const stop = (instanceId: string, reason?: string): Promise<void> =>
    enqueue(async () => {
      const instance = tracked.get(instanceId)
      if (!instance) return
      set({ ...instance, state: 'stopping' })
      try {
        await removeContainer(instance)
      } catch (error) {
        // Docker would not let go: the entry stays, failed, so the next
        // reconcile and the next `stop` both get another go at it.
        const message = error instanceof Error ? error.message : String(error)
        log.error(`could not stop instance ${instanceId}`, error)
        set({ ...instance, state: 'failed', error: `stop: ${message}` })
        return
      }
      tracked.delete(instanceId)
      log.info(`instance ${instanceId} stopped${reason ? ` (${reason})` : ''}`)
      publish()
    })

  const reconcile = (): Promise<void> =>
    enqueue(async () => {
      const labels = ownLabels()
      if (labels === null) return
      let containers: ContainerInfo[]
      try {
        containers = await docker.listContainers(labels)
      } catch (error) {
        log.error('docker did not answer a list', error)
        return
      }
      const byInstance = new Map<string, ContainerInfo>()
      for (const container of containers) {
        const id = container.labels[INSTANCE_LABELS.instance]
        if (id !== undefined) byInstance.set(id, container)
        else if (!warnedAbout.has(container.id)) {
          warnedAbout.add(container.id)
          log.warn(`container ${container.name} carries our labels but not an instance; left alone`)
        }
      }
      for (const instance of [...tracked.values()]) {
        if (instance.state === 'stopping' || instance.state === 'failed') continue
        const container = byInstance.get(instance.id)
        if (!container) {
          log.warn(`instance ${instance.id}: its container vanished`)
          tracked.set(instance.id, { ...instance, state: 'failed', error: 'container vanished' })
          continue
        }
        if (container.status === 'running' && instance.state === 'starting')
          tracked.set(instance.id, { ...instance, state: 'running' })
        else if (container.status !== 'running' && container.status !== 'created') {
          const error = exitReason(container)
          log.warn(`instance ${instance.id}: ${error}`)
          tracked.set(instance.id, { ...instance, state: 'failed', error })
        }
      }
      for (const [id, container] of byInstance) {
        if (tracked.has(id)) continue
        const adopted = instanceFromContainer(container)
        if (!adopted) {
          if (!warnedAbout.has(container.id)) {
            warnedAbout.add(container.id)
            log.warn(
              `container ${container.name} carries our labels but not an instance; left alone`,
            )
          }
          continue
        }
        log.info(`adopted instance ${adopted.id} (${adopted.purpose}, ${adopted.state})`)
        tracked.set(id, adopted)
      }
      publish()
    })

  const watch = (): void => {
    if (closed || poll) return
    const tick = (): void => {
      poll = clock.after(options.pollIntervalMs, () => {
        poll = undefined
        void reconcile().finally(() => {
          if (!closed) tick()
        })
      })
    }
    tick()
  }

  return {
    start,
    stop,
    snapshot,
    reconcile,
    adopt: async () => {
      await reconcile()
      return tracked.size
    },
    drain: () => {
      drained = true
    },
    undrain: () => {
      drained = false
    },
    drained: () => drained,
    watch,
    close: async () => {
      closed = true
      poll?.cancel()
      poll = undefined
      await chain
    },
  }
}
