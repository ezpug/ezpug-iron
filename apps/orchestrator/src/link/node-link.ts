import type { Clock, Timer } from '@ezpug/core'
import type { NodeFrame, NodeFrameOf, OrchestratorNodeFrame } from '@ezpug/protocol'
import {
  HEARTBEAT_INTERVAL_MS_DEFAULT,
  HELLO_TIMEOUT_MS,
  LINK_CLOSE_CODES,
  NODE_LINK_PATH,
  nodeFrameSchema,
  PROTOCOL_VERSION,
} from '@ezpug/protocol'
import { type WebSocket, WebSocketServer } from 'ws'
import type { Log } from '../log'
import type { MatchStore, NodeRow } from '../match/store'
import type { ConnectedNode, NodeRegistry } from '../nodes/registry'
import type { UpgradeRouter } from '../stream/upgrade'
import { hashToken, looksLikeToken, mintToken, type RandomBytes } from '../tokens'
import { nullTrace, type Trace } from '../trace'

/**
 * **`/node` — the socket every `ezpug-node` dials** (decision 23, PRD-02
 * T12), the server link's smaller twin: the same raw `ws` upgrade on the
 * router in front of Hono, the same "every listener before anything is
 * awaited" rule, the same `hello`-first handshake and the same close-code
 * vocabulary. What is different is what travels: this link carries
 * *containers*, never a match. The servers a node starts open server links
 * of their own, and from `/link`'s side a node's server and a Dathost
 * server are the same thing.
 *
 * - **`hello` first**, with one of two credentials. An `enrolment` token is
 *   the one-time secret `POST /v1/fleet/nodes` showed once: it is spent
 *   here, a node token is minted, and `welcome` hands it over — the only
 *   time it is ever readable. A `node` token is looked up by hash on the
 *   node's row. Either way the row must exist and not be revoked.
 * - **What the `hello` says lands on the row** (region, labels, capacity,
 *   version, image digest) — the fleet route reads one table, and a node
 *   that re-labels itself does not need re-enrolling.
 * - **`instances` is a whole snapshot**, never a delta, and nothing is
 *   acked: a lost frame is superseded by the next one and a reconnect's
 *   `hello` carries the state. The registry is what the provider reads.
 * - **Silence past two heartbeat intervals** closes the socket; the node
 *   reconnects with backoff (T11) and its containers keep running, so a
 *   node blip is not a match ending.
 */

/** `last_seen_at` is a heartbeat's fact, not a write per frame. */
const LAST_SEEN_WRITE_INTERVAL_MS = 5_000

export interface NodeLinkOptions {
  router: UpgradeRouter
  clock: Clock
  log: Log
  store: MatchStore
  registry: NodeRegistry
  /** What `welcome` asks for. Default {@link HEARTBEAT_INTERVAL_MS_DEFAULT}. */
  heartbeatIntervalMs?: number
  helloTimeoutMs?: number
  /** The bytes behind a minted node token; a test pins them. */
  random?: RandomBytes
  /** Once true, new sockets are refused with a 503 before the upgrade. */
  isDraining?: () => boolean
  /** The dev recorder (T13). Off by default; every frame both ways when on. */
  trace?: Trace
}

/** One connected node, as a test and the fleet route see it. Never a token. */
export interface NodeSessionView {
  nodeId: string
  version: string
  region: string
  instances: number
  lastSeenAt: string
}

export interface NodeLink {
  sessions: () => NodeSessionView[]
  /** Hang up on a node (an un-enrolment). True when there was a socket to close. */
  disconnect: (nodeId: string, code: number, reason: string) => boolean
  /** Wait for every tracked write to land — a test's door. */
  settle: () => Promise<void>
  /** Close every session `shuttingDown`; the agents reconnect with backoff. */
  close: () => Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Why a `hello` was refused, as a close code and a sentence. */
interface Refusal {
  code: number
  reason: string
}

export function attachNodeLink(options: NodeLinkOptions): NodeLink {
  const trace = options.trace ?? nullTrace
  /** One label per socket — the server link's rule, for the same reason. */
  const traceIds = new WeakMap<WebSocket, string>()
  let traced = 0
  const { router, clock, log, store, registry } = options
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS_DEFAULT
  const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS
  const wss = new WebSocketServer({ noServer: true })
  const sessions = new Map<string, { node: ConnectedNode; ws: WebSocket }>()
  const inflight = new Set<Promise<unknown>>()
  let closing = false

  const track = (promise: Promise<unknown>, what: string): void => {
    const tracked = promise
      .catch((error: unknown) => log.error(`node link ${what} failed`, error))
      .finally(() => inflight.delete(tracked))
    inflight.add(tracked)
  }

  /**
   * The row a `hello`'s token opens, and the node token to hand back when it
   * was an enrolment. Everything that can go wrong is a close code, not an
   * exception: a node that presented a dead credential must stop dialling
   * (T11 treats 4001 as fatal), and one that presented nothing we know must
   * not learn anything from the difference.
   */
  const resolveHello = async (
    hello: NodeFrameOf<'hello'>,
  ): Promise<{ row: NodeRow; nodeToken?: string } | Refusal> => {
    const unauthorized = (reason: string): Refusal => ({
      code: LINK_CLOSE_CODES.unauthorized,
      reason,
    })
    if (hello.tokenKind === 'enrolment') {
      if (!looksLikeToken('enrolment', hello.token)) return unauthorized('not an enrolment token')
      const enrolment = await store.findNodeEnrolmentByHash(hashToken(hello.token))
      if (!enrolment) return unauthorized('unknown enrolment token')
      if (enrolment.usedAt) return unauthorized('this enrolment token was already spent')
      if (enrolment.expiresAt.getTime() <= clock.now())
        return unauthorized('this enrolment token has expired')
      const row = await store.findNode(enrolment.nodeId)
      if (!row || row.revokedAt) return unauthorized('the node was revoked')
      const nodeToken = mintToken('node', options.random)
      await store.updateNode(row.id, { tokenHash: hashToken(nodeToken) })
      await store.useNodeEnrolment(enrolment.id, clock.date())
      log.info(`node ${row.id}: enrolled`)
      return { row: { ...row, tokenHash: hashToken(nodeToken) }, nodeToken }
    }
    if (!looksLikeToken('node', hello.token)) return unauthorized('not a node token')
    const row = await store.findNodeByTokenHash(hashToken(hello.token))
    if (!row || row.revokedAt) return unauthorized('unknown or revoked node token')
    return { row }
  }

  const greet = async (
    ws: WebSocket,
    hello: NodeFrameOf<'hello'>,
    peer: string | undefined,
  ): Promise<ConnectedNode | undefined> => {
    const resolved = await resolveHello(hello)
    if ('code' in resolved) {
      ws.close(resolved.code, resolved.reason)
      return undefined
    }
    if (ws.readyState !== ws.OPEN) return undefined
    const { row, nodeToken } = resolved
    sessions.get(row.id)?.ws.close(LINK_CLOSE_CODES.replaced, 'replaced by a newer socket')
    const at = clock.date()
    const inUse = hello.instances.filter(instance => instance.matchId !== undefined).length
    await store.updateNode(row.id, {
      region: hello.region,
      labels: hello.labels,
      version: hello.version,
      imageDigest: hello.imageDigest,
      connected: true,
      capacityTotal: hello.capacity.maxInstances,
      capacityWarm: hello.capacity.warm,
      capacityInUse: inUse,
      lastSeenAt: at,
    })

    const node: ConnectedNode = {
      id: row.id,
      region: hello.region,
      address: hello.labels.address ?? peer ?? row.id,
      lan: hello.lan,
      labels: hello.labels,
      capacity: hello.capacity,
      imageDigest: hello.imageDigest,
      version: hello.version,
      instances: hello.instances,
      lastSeenAt: at.toISOString(),
      drained: row.drained,
      send: frame => {
        if (ws.readyState !== ws.OPEN) return false
        ws.send(JSON.stringify(frame satisfies OrchestratorNodeFrame))
        if (trace.on) trace.write('node', { socket: traceIds.get(ws), from: 'orchestrator', frame })
        return true
      },
      disconnect: (code, reason) => ws.close(code, reason),
    }
    sessions.set(row.id, { node, ws })
    node.send({
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      nodeId: row.id,
      ...(nodeToken !== undefined && { nodeToken }),
      heartbeatIntervalMs,
      drained: row.drained,
    })
    log.info(
      `node ${row.id}: hello from agent ${hello.version} in ${hello.region}, ` +
        `${hello.instances.length}/${hello.capacity.maxInstances} instances` +
        `${row.drained ? ', drained' : ''}`,
    )
    // Attached last: a watcher that reacts by sending a `start` must find a
    // node it can already write to, and one that reads the snapshot must
    // read the `hello`'s.
    registry.attach(node)
    return node
  }

  const open = (ws: WebSocket, peer: string | undefined): void => {
    traced += 1
    const traceId = `node-${traced}`
    traceIds.set(ws, traceId)
    let node: ConnectedNode | undefined
    let chain: Promise<void> = Promise.resolve()
    let silence: Timer | undefined
    let lastSeenWrittenAt = clock.now()
    const helloTimer = clock.after(helloTimeoutMs, () => {
      if (!node) ws.close(LINK_CLOSE_CODES.helloTimeout, `no hello within ${helloTimeoutMs} ms`)
    })

    const armSilence = (): void => {
      silence?.cancel()
      silence = clock.after(2 * heartbeatIntervalMs, () => {
        log.warn(`node ${node?.id ?? '?'}: silent for ${2 * heartbeatIntervalMs} ms; closing`)
        ws.terminate()
      })
    }

    const seen = (): void => {
      if (!node) return
      armSilence()
      const at = clock.date()
      node.lastSeenAt = at.toISOString()
      if (clock.now() - lastSeenWrittenAt < LAST_SEEN_WRITE_INTERVAL_MS) return
      lastSeenWrittenAt = clock.now()
      track(store.updateNode(node.id, { lastSeenAt: at }), `${node.id} last_seen_at`)
    }

    const handle = async (frame: NodeFrame): Promise<void> => {
      if (!node) return
      switch (frame.type) {
        case 'hello':
          ws.close(LINK_CLOSE_CODES.malformed, 'hello twice')
          return
        case 'heartbeat':
          return
        case 'instances': {
          registry.setInstances(node.id, frame.instances, node.lastSeenAt)
          const inUse = frame.instances.filter(instance => instance.matchId !== undefined).length
          await store.updateNode(node.id, { capacityInUse: inUse, lastSeenAt: clock.date() })
          return
        }
        default:
          return
      }
    }

    const step = (run: () => Promise<void>): void => {
      chain = chain.then(run).catch((error: unknown) => {
        log.error('node frame failed', error)
        ws.close(1011, 'internal')
      })
    }

    // Every listener before anything is awaited: a frame behind the hello
    // waits on the chain, it is never dropped.
    ws.on('message', data => {
      let raw: unknown
      try {
        raw = JSON.parse(data.toString())
      } catch {
        ws.close(LINK_CLOSE_CODES.malformed, 'not JSON')
        return
      }
      if (isRecord(raw) && raw.type === 'hello' && raw.protocol !== PROTOCOL_VERSION) {
        ws.close(
          LINK_CLOSE_CODES.protocolMismatch,
          `protocol ${String(raw.protocol)}; this orchestrator speaks ${PROTOCOL_VERSION}`,
        )
        return
      }
      const parsed = nodeFrameSchema.safeParse(raw)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        ws.close(
          LINK_CLOSE_CODES.malformed,
          `${issue?.path.join('.') || 'frame'}: ${issue?.message ?? 'invalid'}`.slice(0, 123),
        )
        return
      }
      const frame = parsed.data
      if (trace.on) trace.write('node', { socket: traceId, from: 'node', frame })
      if (node) {
        seen()
        step(() => handle(frame))
        return
      }
      step(async () => {
        if (node) {
          seen()
          await handle(frame)
          return
        }
        if (frame.type !== 'hello') {
          ws.close(LINK_CLOSE_CODES.malformed, 'the first frame is hello')
          return
        }
        node = await greet(ws, frame, peer)
        if (node) {
          helloTimer.cancel()
          armSilence()
        }
      })
    })
    ws.on('close', (code: number, reason: Buffer) => {
      if (trace.on)
        trace.write('node', {
          socket: traceId,
          from: 'orchestrator',
          close: { code, reason: reason.toString() },
        })
      helloTimer.cancel()
      silence?.cancel()
      if (!node) return
      const gone = node
      if (sessions.get(gone.id)?.node === gone) sessions.delete(gone.id)
      registry.detach(gone)
      track(store.updateNode(gone.id, { connected: false }), `${gone.id} disconnected`)
      log.info(`node ${gone.id}: closed`)
    })
    ws.on('error', error => log.error('node socket', error))
  }

  router.route(NODE_LINK_PATH, (request, socket, head) => {
    if (closing || options.isDraining?.()) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const peer = request.socket.remoteAddress ?? undefined
    wss.handleUpgrade(request, socket, head, ws => open(ws, peer))
  })

  return {
    sessions: () =>
      [...sessions.values()].map(({ node }) => ({
        nodeId: node.id,
        version: node.version,
        region: node.region,
        instances: node.instances.length,
        lastSeenAt: node.lastSeenAt,
      })),
    disconnect: (nodeId, code, reason) => {
      const session = sessions.get(nodeId)
      if (!session) return false
      session.node.disconnect(code, reason)
      return true
    },
    settle: async () => {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
    close: async () => {
      closing = true
      for (const client of wss.clients)
        client.close(LINK_CLOSE_CODES.shuttingDown, 'the orchestrator is shutting down')
      await Promise.allSettled([...inflight])
    },
  }
}
