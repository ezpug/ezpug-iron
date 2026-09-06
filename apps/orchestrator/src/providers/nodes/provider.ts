import { randomBytes, randomUUID } from 'node:crypto'
import type { Clock, Timer } from '@ezpug/core'
import type { InstancePorts, InstanceSpec, NodeInstance } from '@ezpug/protocol'
import type { ServerRef } from '../../link/channels'
import type { Log } from '../../log'
import type { MatchStore, NodeRow, ServerRow } from '../../match/store'
import type { ConnectedNode, NodeRegistry } from '../../nodes/registry'
import { createRconClient, type RconClient } from '../../rcon/client'
import { hashToken, mintToken, type RandomBytes } from '../../tokens'
import type {
  AllocatedServer,
  AllocationRequest,
  GameServerProvider,
  ProvisionedServer,
  ServerConfiguration,
  ServerOffering,
  ServerStatus,
} from '../provider'

/**
 * **The `nodes` provider** (decision 23, PRD-02 T12): every enrolled
 * `ezpug-node` as one pool of free, LAN-capable capacity. A node is a
 * docker host that dials `/node` and runs the server image on request; this
 * turns that into the provider verbs the machine's walk already speaks, so
 * nothing above it can tell a venue box from Dathost.
 *
 * The two ways a server is obtained here:
 *
 * - **A warm instance.** A node advertises `capacity.warm`, and this
 *   provider keeps that many containers running ahead of demand. A warm
 *   container is a *server*: it has its own ledger row and its own server
 *   token, it dials `/link` and it sits `idle` — which is what makes a `lan`
 *   request ready in seconds instead of a CS2 boot. `allocate` claims one.
 * - **A cold start.** No warm instance free, so `start` sends the node a
 *   container spec with the token the walk minted, and the boot deadline is
 *   what covers the minutes it takes.
 *
 * **What a claim does to the ledger.** A warm row is a real row — a server
 * that existed and cost nothing — so claiming it *closes* that row (`released`,
 * "claimed by …") and the walk's own row takes over, charged to the match's
 * key, which is what makes the concurrency ceiling count a node match at
 * all. The container keeps the credential it booted with: the token is
 * re-pointed at the new row ({@link MatchStore.reassignServerToken}) rather
 * than replaced, because there is no way to hand a running CS2 server a new
 * one. The walk's freshly minted token stays on the row unused and dies
 * with it.
 *
 * **What this provider never does** is talk to a game server. Events,
 * commands, the assignment and the release all travel on the server's own
 * link; a node only ever hears `start`, `stop`, `drain` and `undrain`. The
 * one exception is the `rcon` verb (T20), and it is the exception that proves
 * the rule: it exists for the minutes *before* a container's plugin has
 * dialled in, it goes to the game's own RCON port rather than through the
 * node, and the fleet only reaches for it when there is no link to use.
 */

export const NODES_PROVIDER_ID = 'nodes'

/**
 * The variable the server image reads its RCON password from
 * (`docker/cs2/entrypoint.sh`, documented in `.env.example`). The node agent
 * copies a spec's `env` into the container verbatim, so putting it here is
 * the whole delivery.
 */
export const CS2_RCON_PASSWORD_VAR = 'EZPUG_IRON_CS2_RCON_PASSWORD'

/** The GOTV delay a node's servers state, matching the image's `tv_delay`. */
export const NODE_TV_DELAY_SECONDS = 90

/**
 * How long a warm container may live before the reaper takes it. It is a
 * ceiling, not a schedule: nothing here refreshes it, so an instance the
 * pool forgot is deallocated by the reaper (an open row with no match past
 * its expiry) and the pool starts a fresh one in its place.
 */
export const WARM_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** How long a node may be off the wire before its servers are reported `gone`. */
export const NODE_LOST_MS = 60_000

/**
 * How long a node has to be gone before its absence is an incident worth a
 * `fleet.node_disconnected` — and how long it has to be *back* before the
 * next absence counts as a new one.
 *
 * Two agents holding one node identity replace each other's socket about
 * once a second (`scripts/dev-node.sh` used to let that happen; PRD-02
 * T21b), and billing a fact per close buried one match's log under 1910 of
 * them. A window an order of magnitude above the agent's first reconnect
 * backoff (`BACKOFF_INITIAL_MS_DEFAULT`, one second) turns that loop into
 * the single fact it actually is, and still lands well inside
 * {@link NODE_LOST_MS}, so nothing downstream learns about it later than it
 * used to.
 */
export const NODE_DISCONNECT_GRACE_MS = 15_000

/** The first game port a node's instances take; the GOTV relay is the one above it. */
export const NODE_PORT_BASE = 27_415

/** What the link seam needs to be, so a claimed warm instance gets its assignment. */
export interface NodeAssignSeam {
  /** Point a live session at another ledger row and match — the warm claim (T12). */
  rebind: (server: ServerRef, fleetServerId: string, matchId: string | null) => boolean
  /** Compose and send the assignment for a connected server's row. */
  assign: (server: ServerRef) => Promise<boolean>
}

/** The one thing this provider says into a match's log: the node under it went away. */
export interface NodeFacts {
  emit: (
    matchId: string,
    fact: { type: 'fleet.node_disconnected'; node: string; lastSeenAt: string | null },
  ) => Promise<unknown>
}

export interface NodesProviderOptions {
  clock: Clock
  log: Log
  store: MatchStore
  registry: NodeRegistry
  /** The server image a node runs, with a digest where an operator pinned one. */
  image: string
  /** What a container's plugin dials — the orchestrator's own public origin. */
  baseUrl: string
  /** Resolved lazily: the link exists after the provider (the composition root's knot). */
  link: () => NodeAssignSeam | undefined
  /** Where `fleet.node_disconnected` goes; absent in a test that does not care. */
  facts?: NodeFacts
  portBase?: number
  warmTtlMs?: number
  nodeLostMs?: number
  /** How long a close waits before it is an incident ({@link NODE_DISCONNECT_GRACE_MS}). */
  disconnectGraceMs?: number
  /** The bytes behind a minted server token; a test pins them. */
  random?: RandomBytes
  /** The RCON door (T20); the default opens a real socket to the game port. */
  rcon?: RconClient
}

/** A container this provider knows about, warm or claimed. */
interface Instance {
  /** The instance id on the node, and this provider's `serverId` — one name, one thing. */
  readonly id: string
  readonly nodeId: string
  readonly ports: InstancePorts
  /** The ledger row that owns the container right now. */
  fleetServerId: string
  /** The warm row it booted with, until a claim closes it. */
  warmFleetServerId?: string
  /** The live server token's row id, so a claim can move it. */
  tokenId: string | null
  /** Set from `allocate` on. */
  matchId?: string
  /** The configuration the walk delivered, kept until `start`. */
  configuration?: ServerConfiguration
  /** True once this provider was asked to allocate it. */
  claimed: boolean
  /** True when it booted as a warm instance — a claim has a row to close. */
  bornWarm: boolean
  /** True once the node was told to run it. */
  started: boolean
  /**
   * The RCON password this process minted for the container and put in its
   * environment. Memory only, never the ledger and never a log line — the
   * schema's note on `servers` says why (CLAUDE.md, "secrets stay in the
   * process"). Undefined for a container **adopted** after a restart: the
   * password died with the process that minted it, and the honest answer to
   * an RCON request on such a server is that there is no door, not a guess.
   */
  rconPassword?: string
}

export interface NodesProvider extends GameServerProvider {
  /** Fill every connected node's warm pool up to what it advertises. Idempotent. */
  topUp: () => Promise<void>
  /** Resolve once every top-up and every deferred assignment has settled — a barrier's door. */
  settle: () => Promise<void>
  /** What this provider believes is running, for a test. */
  instances: () => { id: string; nodeId: string; matchId?: string; warm: boolean }[]
  /** Stop watching the registry. */
  close: () => void
}

/** A container the node reports that is idle, warm and unclaimed — what a claim looks for. */
const isFreeWarm = (instance: NodeInstance): boolean =>
  instance.purpose === 'warm' &&
  instance.matchId === undefined &&
  (instance.state === 'running' || instance.state === 'starting')

export function createNodesProvider(options: NodesProviderOptions): NodesProvider {
  const { clock, log, store, registry, image, baseUrl } = options
  const portBase = options.portBase ?? NODE_PORT_BASE
  const rconClient = options.rcon ?? createRconClient({ clock })
  const warmTtlMs = options.warmTtlMs ?? WARM_TTL_MS
  const nodeLostMs = options.nodeLostMs ?? NODE_LOST_MS
  const disconnectGraceMs = options.disconnectGraceMs ?? NODE_DISCONNECT_GRACE_MS
  const instances = new Map<string, Instance>()
  /** When a node dropped off the wire, so `status` can stop pretending. */
  const disconnectedAt = new Map<string, number>()
  const warned = new Set<string>()
  /**
   * **One `fleet.node_disconnected` per incident, never one per flap.**
   * `pending` is the grace timer a close arms — only silence for the whole
   * of it is an incident. `reported` is every node whose current incident has
   * already been said out loud; `settling` is the timer a reconnect arms to
   * prove the node stayed, and it is the only thing that clears `reported`.
   * A node that re-`hello`s in a loop therefore costs exactly one fact, and
   * a node that comes back for good can raise a fresh one the next time it
   * goes ({@link NODE_DISCONNECT_GRACE_MS}).
   */
  const pendingDisconnect = new Map<string, Timer>()
  const settlingAfter = new Map<string, Timer>()
  const reportedDisconnect = new Set<string>()

  const cancel = (timers: Map<string, Timer>, nodeId: string): void => {
    timers.get(nodeId)?.cancel()
    timers.delete(nodeId)
  }

  const ref = (serverId: string): ServerRef => ({ provider: NODES_PROVIDER_ID, serverId })
  const on = (nodeId: string): Instance[] =>
    [...instances.values()].filter(instance => instance.nodeId === nodeId)

  const tickrateOf = (node: ConnectedNode): number => {
    const label = Number(node.labels.tickrate)
    return Number.isFinite(label) && label > 0 ? Math.trunc(label) : 128
  }

  const connectOf = (node: ConnectedNode, ports: InstancePorts) => ({
    host: node.address,
    port: ports.game,
  })

  const tvOf = (node: ConnectedNode, ports: InstancePorts) => ({
    host: node.address,
    port: ports.tv,
    delaySeconds: NODE_TV_DELAY_SECONDS,
  })

  /** The lowest free game/GOTV pair on a node: ours, plus whatever it already runs. */
  const freePorts = (node: ConnectedNode): InstancePorts => {
    const taken = new Set<number>()
    for (const instance of node.instances) {
      taken.add(instance.ports.game)
      taken.add(instance.ports.tv)
    }
    for (const instance of on(node.id)) {
      taken.add(instance.ports.game)
      taken.add(instance.ports.tv)
    }
    for (let slot = 0; slot < 128; slot += 1) {
      const game = portBase + slot * 2
      const tv = game + 1
      if (!taken.has(game) && !taken.has(tv)) return { game, tv }
    }
    throw new Error(`nodes: no free port pair on ${node.id}`)
  }

  /** A container's own RCON password, minted here and delivered in its environment. */
  const mintRconPassword = (): string =>
    (options.random ?? randomBytes)(12).toString('base64url').slice(0, 16)

  const mintInstanceId = (nodeId: string): string => {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const id = `${nodeId}-${randomUUID().replaceAll('-', '').slice(0, 6)}`
      if (!instances.has(id)) return id
    }
    throw new Error(`nodes: could not mint an instance id on ${nodeId}`)
  }

  const specFor = (
    instance: Instance,
    serverToken: string,
    purpose: 'warm' | 'match',
  ): InstanceSpec => ({
    id: instance.id,
    purpose,
    image,
    serverId: instance.id,
    serverToken,
    ports: instance.ports,
    env: {
      EZPUG_IRON_URL: baseUrl,
      ...(instance.rconPassword !== undefined && {
        [CS2_RCON_PASSWORD_VAR]: instance.rconPassword,
      }),
    },
    ...(instance.matchId !== undefined && { matchId: instance.matchId }),
  })

  /** How many containers a node may still take, from its own ceiling. */
  const freeCapacity = (node: ConnectedNode): number =>
    Math.max(0, node.capacity.maxInstances - Math.max(on(node.id).length, node.instances.length))

  const openRow = async (
    node: ConnectedNode,
    nodeRow: NodeRow,
    instance: Instance,
    keyId: string,
  ): Promise<string> => {
    const at = clock.date()
    const fleetServerId = randomUUID()
    await store.insertServer({
      id: fleetServerId,
      provider: NODES_PROVIDER_ID,
      serverId: instance.id,
      nodeId: node.id,
      matchId: null,
      keyId,
      state: 'allocated',
      game: 'cs2',
      region: node.region,
      lan: node.lan,
      address: connectOf(node, instance.ports),
      tv: tvOf(node, instance.ports),
      costHourlyCents: 0,
      // A node is a LAN box; nothing there needs a Steam login token (T17).
      gsltTokenId: null,
      providerMeta: { instanceId: instance.id, purpose: 'warm', node: nodeRow.id },
      versions: null,
      hostname: null,
      currentMap: null,
      linkState: null,
      linkAckedSeq: 0,
      lastSeenAt: null,
      lastError: null,
      releasedReason: null,
      allocatedAt: at,
      releasedAt: null,
      expiresAt: new Date(at.getTime() + warmTtlMs),
    })
    return fleetServerId
  }

  /** Start one warm container on a node: a row, a token, a `start` frame. */
  const startWarm = async (node: ConnectedNode, nodeRow: NodeRow): Promise<void> => {
    if (!nodeRow.enrolledByKeyId) {
      if (!warned.has(node.id)) {
        warned.add(node.id)
        log.warn(
          `node ${node.id} advertises ${node.capacity.warm} warm instances but no enrolling key; ` +
            're-enrol it so a warm container has a ledger row to belong to',
        )
      }
      return
    }
    const instance: Instance = {
      id: mintInstanceId(node.id),
      nodeId: node.id,
      ports: freePorts(node),
      fleetServerId: '',
      tokenId: null,
      claimed: false,
      bornWarm: true,
      started: false,
      rconPassword: mintRconPassword(),
    }
    instance.fleetServerId = await openRow(node, nodeRow, instance, nodeRow.enrolledByKeyId)
    const serverToken = mintToken('server', options.random)
    instance.tokenId = randomUUID()
    await store.insertServerToken({
      id: instance.tokenId,
      fleetServerId: instance.fleetServerId,
      tokenHash: hashToken(serverToken),
      createdAt: clock.date(),
      lastUsedAt: null,
      revokedAt: null,
    })
    instances.set(instance.id, instance)
    if (!node.send({ type: 'start', instance: specFor(instance, serverToken, 'warm') })) {
      instances.delete(instance.id)
      await store.updateServer(instance.fleetServerId, {
        state: 'failed',
        releasedAt: clock.date(),
        releasedReason: 'the node went away before the warm start was sent',
      })
      return
    }
    instance.started = true
    log.info(`node ${node.id}: warming ${instance.id} on ${instance.ports.game}`)
  }

  /**
   * Fill every connected, undrained node's warm pool. Never awaited by a
   * caller that matters: a pool that could not be filled is a slower `lan`
   * request, never a failed one.
   */
  const topUp = async (): Promise<void> => {
    for (const node of registry.all()) {
      if (node.drained) continue
      const nodeRow = await store.findNode(node.id)
      if (!nodeRow || nodeRow.revokedAt || nodeRow.drained) continue
      const want = Math.min(node.capacity.warm, node.capacity.maxInstances)
      for (let guard = 0; guard < want; guard += 1) {
        const warm = on(node.id).filter(instance => !instance.claimed).length
        if (warm >= want || freeCapacity(node) <= 0) break
        await startWarm(node, nodeRow)
      }
    }
  }

  /**
   * Work this provider started that nobody upstream can await: a warm pool
   * top-up from a socket's callback, and the assignment a claimed warm
   * instance is sent *after* the walk let go of its match's chain. Both are
   * visible ({@link NodesProvider.settle}), because a barrier that cannot
   * see them returns on a world that is still moving (T10a).
   */
  const inflight = new Set<Promise<unknown>>()
  const track = (what: string, run: () => Promise<unknown>): void => {
    const tracked = run()
      .catch((error: unknown) => log.error(`nodes ${what}`, error))
      .finally(() => inflight.delete(tracked))
    inflight.add(tracked)
  }

  /**
   * What a node's containers mean after a restart of this process: the
   * ledger, read back. Without it `list()` would be empty on the first pass
   * and the reaper would call every live node match lost.
   */
  const adopt = async (node: ConnectedNode): Promise<void> => {
    const rows = (await store.listOpenServers(NODES_PROVIDER_ID)).filter(
      (row: ServerRow) => row.nodeId === node.id && row.serverId !== null,
    )
    for (const row of rows) {
      const id = row.serverId as string
      if (instances.has(id)) continue
      const reported = node.instances.find(instance => instance.id === id)
      const token = await store.findLiveServerToken(row.id)
      instances.set(id, {
        id,
        nodeId: node.id,
        ports: reported?.ports ?? { game: portBase, tv: portBase + 1 },
        fleetServerId: row.id,
        tokenId: token?.id ?? null,
        ...(row.matchId !== null && { matchId: row.matchId }),
        claimed: row.matchId !== null,
        bornWarm: reported?.purpose === 'warm',
        started: true,
      })
    }
  }

  const unwatch = registry.watch({
    connected: node => {
      disconnectedAt.delete(node.id)
      cancel(pendingDisconnect, node.id)
      // Back, but not yet believed: an incident closes only once the node has
      // held the wire for a whole grace window, so a flapping identity cannot
      // raise a second fact by reconnecting between two of them.
      if (reportedDisconnect.has(node.id) && !settlingAfter.has(node.id))
        settlingAfter.set(
          node.id,
          clock.after(disconnectGraceMs, () => {
            settlingAfter.delete(node.id)
            reportedDisconnect.delete(node.id)
            log.info(`node ${node.id}: back on the wire and steady`)
          }),
        )
      track(`adopt ${node.id}`, async () => {
        await adopt(node)
        await topUp()
      })
    },
    instances: () => track('top up', topUp),
    disconnected: (nodeId, lastSeenAt) => {
      disconnectedAt.set(nodeId, clock.now())
      cancel(settlingAfter, nodeId)
      log.warn(`node ${nodeId}: disconnected; its servers are on their own until it dials back`)
      const facts = options.facts
      if (!facts || pendingDisconnect.has(nodeId)) return
      pendingDisconnect.set(
        nodeId,
        clock.after(disconnectGraceMs, () => {
          pendingDisconnect.delete(nodeId)
          // Silence for the whole window, and nothing said about it yet.
          if (registry.get(nodeId) || reportedDisconnect.has(nodeId)) return
          reportedDisconnect.add(nodeId)
          track(`node_disconnected ${nodeId}`, async () => {
            for (const instance of on(nodeId)) {
              if (instance.matchId === undefined) continue
              await facts.emit(instance.matchId, {
                type: 'fleet.node_disconnected',
                node: nodeId,
                lastSeenAt,
              })
            }
          })
        }),
      )
    },
  })

  /** The node a server sits on, if it is still on the wire. */
  const nodeOf = (serverId: string): ConnectedNode | undefined => {
    const instance = instances.get(serverId)
    return instance ? registry.get(instance.nodeId) : undefined
  }

  const send = (serverId: string, frame: Parameters<ConnectedNode['send']>[0]): boolean =>
    nodeOf(serverId)?.send(frame) ?? false

  return {
    id: NODES_PROVIDER_ID,

    /**
     * One offering per node. A connected, undrained node offers what it can
     * still run; every other enrolled node offers **zero** rather than
     * disappearing, so `GET /v1/capacity` keeps saying a venue exists and is
     * not answering, which is the fact an operator needs.
     */
    async offerings(): Promise<ServerOffering[]> {
      const rows = await store.listNodes()
      return rows.map(row => {
        const node = registry.get(row.id)
        const available = !node || node.drained || row.drained ? 0 : freeCapacity(node)
        return {
          capabilities: {
            games: ['cs2'],
            region: node?.region ?? row.region,
            tickrate: node ? tickrateOf(node) : 128,
            lan: node?.lan ?? true,
            workshopMaps: true,
          },
          hourlyCents: 0,
          available,
        }
      })
    },

    allocate(request: AllocationRequest): Promise<AllocatedServer> {
      const candidates = registry
        .all()
        .filter(node => !node.drained)
        .filter(
          node =>
            request.requirements.region === undefined ||
            node.region === request.requirements.region,
        )
        .filter(node => node.region === request.offering.capabilities.region)
      if (candidates.length === 0)
        return Promise.reject(new Error('nodes: no connected node can take this match'))

      // A warm container first: it is already booted and already linked.
      for (const node of candidates) {
        const free = node.instances
          .filter(isFreeWarm)
          .map(reported => instances.get(reported.id))
          .find(instance => instance !== undefined && !instance.claimed)
        if (!free) continue
        free.claimed = true
        free.matchId = request.matchId
        free.warmFleetServerId = free.fleetServerId
        free.fleetServerId = request.fleetServerId
        log.info(`node ${node.id}: ${free.id} claimed warm for ${request.matchId}`)
        return Promise.resolve({
          serverId: free.id,
          connect: connectOf(node, free.ports),
          tv: tvOf(node, free.ports),
          nodeId: node.id,
          meta: { instanceId: free.id, node: node.id, warm: true },
        })
      }

      const node = candidates.find(candidate => freeCapacity(candidate) > 0)
      if (!node) throw new Error('nodes: every connected node is full')
      const instance: Instance = {
        id: mintInstanceId(node.id),
        nodeId: node.id,
        ports: freePorts(node),
        fleetServerId: request.fleetServerId,
        tokenId: null,
        matchId: request.matchId,
        claimed: true,
        bornWarm: false,
        started: false,
        rconPassword: mintRconPassword(),
      }
      instances.set(instance.id, instance)
      return Promise.resolve({
        serverId: instance.id,
        connect: connectOf(node, instance.ports),
        tv: tvOf(node, instance.ports),
        nodeId: node.id,
        meta: { instanceId: instance.id, node: node.id, warm: false },
      })
    },

    /**
     * Deliver the configuration. For a cold instance there is nothing to
     * deliver yet — the token rides into the container's environment when
     * `start` runs it. For a claimed warm one the container is already up
     * with a credential of its own, so this is where the ledger catches up:
     * the token moves to the match's row and the warm row closes.
     */
    async configure(serverId: string, configuration: ServerConfiguration): Promise<void> {
      const instance = instances.get(serverId)
      if (!instance) throw new Error(`nodes: no instance ${serverId}`)
      instance.configuration = configuration
      const warmRow = instance.warmFleetServerId
      if (warmRow === undefined) return
      if (instance.tokenId)
        await store.reassignServerToken(instance.tokenId, instance.fleetServerId)
      instance.warmFleetServerId = undefined
      await store.updateServer(warmRow, {
        state: 'released',
        releasedAt: clock.date(),
        releasedReason: `claimed by match ${configuration.matchId}`,
      })
    },

    /**
     * Run it. A cold instance is a `start` frame and a CS2 boot; a claimed
     * warm one is already running and already linked, so the assignment goes
     * straight down the socket it is holding.
     */
    start(serverId: string): Promise<void> {
      const instance = instances.get(serverId)
      if (!instance) return Promise.reject(new Error(`nodes: no instance ${serverId}`))
      const configuration = instance.configuration
      if (!configuration)
        return Promise.reject(new Error(`nodes: ${serverId} was never configured`))
      if (instance.bornWarm) {
        const link = options.link()
        if (!link)
          return Promise.reject(new Error('nodes: no link to assign a warm instance through'))
        // The socket is already open under the warm row: point it at the
        // match's row now, and send the assignment **after** this returns —
        // composing one runs on the match's chain, which the walk that called
        // us is still holding, and awaiting it here would deadlock.
        if (!link.rebind(ref(serverId), instance.fleetServerId, configuration.matchId))
          return Promise.reject(
            new Error(`nodes: ${serverId} is warm but holds no link to assign on`),
          )
        track(`assign ${serverId}`, async () => {
          if (!(await link.assign(ref(serverId))))
            log.warn(
              `node ${instance.nodeId}: ${serverId} took no assignment; the boot deadline decides`,
            )
        })
        return Promise.resolve()
      }
      const spec = specFor(instance, configuration.link.serverToken, 'match')
      if (!send(serverId, { type: 'start', instance: spec }))
        return Promise.reject(new Error(`nodes: ${instance.nodeId} is not connected`))
      instance.started = true
      return Promise.resolve()
    },

    stop(serverId: string): Promise<void> {
      send(serverId, { type: 'stop', instanceId: serverId, reason: 'stopped' })
      return Promise.resolve()
    },

    status(serverId: string): Promise<ServerStatus> {
      const instance = instances.get(serverId)
      if (!instance) return Promise.resolve({ state: 'gone' })
      const node = registry.get(instance.nodeId)
      if (!node) {
        const since = disconnectedAt.get(instance.nodeId)
        // A node that is merely reconnecting is not a dead server; one that
        // has been away longer than the window is not a live one either.
        const state = since !== undefined && clock.now() - since >= nodeLostMs ? 'gone' : 'running'
        return Promise.resolve({ state })
      }
      const reported = node.instances.find(candidate => candidate.id === serverId)
      if (!reported) return Promise.resolve({ state: instance.started ? 'gone' : 'allocated' })
      const state: ServerStatus['state'] =
        reported.state === 'running'
          ? 'running'
          : reported.state === 'starting'
            ? 'starting'
            : reported.state === 'stopping' || reported.state === 'stopped'
              ? 'stopped'
              : 'gone'
      return Promise.resolve({
        state,
        connect: connectOf(node, instance.ports),
        tv: tvOf(node, instance.ports),
      })
    },

    /** Idempotent: a container that is already gone deallocates successfully. */
    deallocate(serverId: string): Promise<void> {
      const instance = instances.get(serverId)
      if (!instance) return Promise.resolve()
      send(serverId, { type: 'stop', instanceId: serverId, reason: 'deallocated' })
      instances.delete(serverId)
      track('top up', topUp)
      return Promise.resolve()
    },

    list(): Promise<ProvisionedServer[]> {
      return Promise.resolve(
        [...instances.values()].map(instance => ({
          serverId: instance.id,
          ...(instance.matchId !== undefined && { matchId: instance.matchId }),
          fleetServerId: instance.fleetServerId,
        })),
      )
    },

    /**
     * **The operator's fallback on a venue box** (T20). A node has no control
     * plane of its own to relay a command through — the container is the
     * server — so this is Source RCON straight at the game port, with the
     * password this process put in the container's environment. It answers
     * `null` for an instance it does not hold or one whose node has gone
     * away, which is the interface's "I have nothing to do that on".
     */
    async rcon(serverId: string, command: string): Promise<string | null> {
      const instance = instances.get(serverId)
      if (!instance?.rconPassword) return null
      const node = registry.get(instance.nodeId)
      if (!node) return null
      return await rconClient.exec(
        { host: node.address, port: instance.ports.game, password: instance.rconPassword },
        command,
      )
    },

    // A node keeps no console of its own: the container's tail arrives over
    // the server's link, which is where the fleet route reads it.
    console: () => Promise.resolve(null),

    topUp,
    settle: async () => {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
    instances: () =>
      [...instances.values()].map(instance => ({
        id: instance.id,
        nodeId: instance.nodeId,
        ...(instance.matchId !== undefined && { matchId: instance.matchId }),
        warm: instance.bornWarm && !instance.claimed,
      })),
    close: () => {
      unwatch()
      for (const timer of pendingDisconnect.values()) timer.cancel()
      for (const timer of settlingAfter.values()) timer.cancel()
      pendingDisconnect.clear()
      settlingAfter.clear()
    },
  }
}
