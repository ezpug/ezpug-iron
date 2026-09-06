import { HEARTBEAT_INTERVAL_MS_DEFAULT, NODE_LINK_PATH, PROTOCOL_VERSION } from './constants'
import { LinkClosedError, type LinkClosure, type LinkSocketConstructor } from './fake-server'
import type {
  InstanceSpec,
  NodeFrame,
  NodeFrameInput,
  NodeInstance,
  NodeTokenKind,
  OrchestratorNodeFrame,
  OrchestratorNodeFrameOf,
  OrchestratorNodeFrameType,
} from './node-link'
import { nodeFrameSchema, orchestratorNodeFrameSchema } from './node-link'

/**
 * **A node that speaks the node link from TypeScript** (PRD-02 T12), the
 * twin of `fake-server.ts`: what every orchestrator test of `/node` and of
 * the `nodes` provider connects in place of a real `ezpug-node` agent, and
 * the shape `apps/node` proves itself against from the other side
 * (`apps/node/src/testing.ts` is the scripted *orchestrator*; this is the
 * scripted *node*).
 *
 * It keeps the little state the protocol says a node keeps and nothing
 * more: the first frame is `hello`, `welcome` may hand over a node token,
 * `start` creates an instance that goes `starting` → `running`, `stop`
 * removes one, `drain`/`undrain` flip a flag, and every change is reported
 * as a **whole `instances` snapshot**, never a delta. Nothing is acked, so
 * there is no buffer and no resend: a reconnect's `hello` carries the
 * snapshot and that is the whole recovery story.
 *
 * No timers, no backoff, no clock — a test drives it and awaits what it
 * expects. A real agent's reconnect policy is `apps/node`'s own (T11).
 */

const SOCKET_OPEN = 1

/** What a fake node says about itself, over the defaults below. */
export type FakeNodeHello = Partial<{
  version: string
  region: string
  lan: boolean
  labels: Record<string, string>
  capacity: { maxInstances: number; warm: number }
  imageDigest: string
}>

export interface FakeNodeOptions {
  /** `ws://host:port/node`. */
  url: string
  /** The one-time enrolment token or the node token a previous `welcome` handed over. */
  token: string
  /** Which of the two it is. Default `node`. */
  tokenKind?: NodeTokenKind
  /** The socket class. Default: the WHATWG `WebSocket` Node ships. */
  WebSocket?: LinkSocketConstructor
  hello?: FakeNodeHello
  /**
   * Take every `start` all the way to `running` in one snapshot. Default
   * true; `false` leaves it `starting` so a test can decide what docker did
   * next ({@link FakeNode.setState}).
   */
  autoStart?: boolean
  /** Refuse every `start` with a `failed` instance carrying this reason — docker, saying no. */
  refuseStarts?: string | null
}

export interface FakeNode {
  /** Open a socket, say `hello`, resolve on `welcome`; reject with {@link LinkClosedError} if closed first. */
  connect: () => Promise<OrchestratorNodeFrameOf<'welcome'>>
  close: (code?: number, reason?: string) => Promise<LinkClosure>
  /** Resolves when the current socket closes, however it does. */
  closed: () => Promise<LinkClosure>
  connected: () => boolean
  /** Send any node frame (parsed first, so the bytes are the schema's). */
  send: (frame: NodeFrameInput) => void
  /** Send text as it is — a frame that must not parse. */
  raw: (text: string) => void
  heartbeat: () => void
  /** Send the whole snapshot as it stands. */
  report: () => void
  instances: () => NodeInstance[]
  /** Move an instance (a container died, a start failed) and report the snapshot. */
  setState: (instanceId: string, state: NodeInstance['state'], error?: string) => void
  /** Drop an instance without a word — a container that vanished, before the next snapshot. */
  forget: (instanceId: string) => void
  /** The next orchestrator frame of `type` not yet taken by a previous `next`. */
  next: <T extends OrchestratorNodeFrameType>(type: T) => Promise<OrchestratorNodeFrameOf<T>>
  /** Every orchestrator frame received, in order, across reconnects. */
  received: () => OrchestratorNodeFrame[]
  /** Every `start` spec, in order. */
  starts: () => InstanceSpec[]
  /** Every stopped instance id, in order. */
  stops: () => string[]
  /** Every node frame sent, in order, across reconnects. */
  sent: () => NodeFrame[]
  nodeId: () => string | undefined
  /** The node token `welcome` handed over, once — what the agent would persist. */
  nodeToken: () => string | undefined
  drained: () => boolean
  heartbeatIntervalMs: () => number
}

const DEFAULT_HELLO: Required<FakeNodeHello> = {
  version: '0.1.0',
  region: 'saarland',
  lan: true,
  labels: { venue: 'devbox', tickrate: '128', cores: '16' },
  capacity: { maxInstances: 2, warm: 0 },
  imageDigest: `sha256:${'11'.repeat(32)}`,
}

function defaultSocket(): LinkSocketConstructor {
  const ctor = (globalThis as { WebSocket?: LinkSocketConstructor }).WebSocket
  if (!ctor) throw new Error('no global WebSocket; pass one in FakeNodeOptions.WebSocket')
  return ctor
}

export function createFakeNode(options: FakeNodeOptions): FakeNode {
  const Socket = options.WebSocket ?? defaultSocket()
  const hello = { ...DEFAULT_HELLO, ...options.hello }
  const autoStart = options.autoStart ?? true
  const received: OrchestratorNodeFrame[] = []
  const sent: NodeFrame[] = []
  const starts: InstanceSpec[] = []
  const stops: string[] = []
  const instances = new Map<string, NodeInstance>()
  const waiters: {
    type: OrchestratorNodeFrameType
    resolve: (frame: OrchestratorNodeFrame) => void
  }[] = []
  const unconsumed: OrchestratorNodeFrame[] = []

  let socket: InstanceType<LinkSocketConstructor> | undefined
  let token = options.token
  let tokenKind: NodeTokenKind = options.tokenKind ?? 'node'
  let nodeId: string | undefined
  let nodeToken: string | undefined
  let drained = false
  let heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS_DEFAULT
  let closure: LinkClosure | undefined
  let settleClosed: (value: LinkClosure) => void = () => undefined
  let closedPromise = new Promise<LinkClosure>(resolve => {
    settleClosed = resolve
  })

  const connected = (): boolean => socket?.readyState === SOCKET_OPEN

  const write = (frame: NodeFrame): void => {
    sent.push(frame)
    socket?.send(JSON.stringify(frame))
  }

  const snapshot = (): NodeInstance[] => [...instances.values()].map(instance => ({ ...instance }))

  const report = (): void => {
    if (!connected()) return
    write(nodeFrameSchema.parse({ type: 'instances', instances: snapshot() }))
  }

  const containerId = (id: string): string => `c-${id}`

  const apply = (frame: OrchestratorNodeFrame): void => {
    switch (frame.type) {
      case 'welcome':
        nodeId = frame.nodeId
        heartbeatIntervalMs = frame.heartbeatIntervalMs
        drained = frame.drained
        if (frame.nodeToken !== undefined) {
          nodeToken = frame.nodeToken
          // What the agent persists: the next dial is a `node` hello.
          token = frame.nodeToken
          tokenKind = 'node'
        }
        return
      case 'start': {
        starts.push(frame.instance)
        const { id, purpose, serverId, ports, matchId } = frame.instance
        if (instances.has(id)) return
        if (options.refuseStarts) {
          instances.set(id, {
            id,
            purpose,
            state: 'failed',
            serverId,
            ports,
            ...(matchId !== undefined && { matchId }),
            error: options.refuseStarts,
          })
          report()
          return
        }
        instances.set(id, {
          id,
          purpose,
          state: autoStart ? 'running' : 'starting',
          serverId,
          containerId: containerId(id),
          ports,
          ...(matchId !== undefined && { matchId }),
        })
        report()
        return
      }
      case 'stop':
        stops.push(frame.instanceId)
        instances.delete(frame.instanceId)
        report()
        return
      case 'drain':
        drained = true
        return
      case 'undrain':
        drained = false
        return
      default:
        return
    }
  }

  const receive = (frame: OrchestratorNodeFrame): void => {
    received.push(frame)
    apply(frame)
    const waiting = waiters.findIndex(entry => entry.type === frame.type)
    if (waiting >= 0) waiters.splice(waiting, 1)[0]?.resolve(frame)
    else unconsumed.push(frame)
  }

  /**
   * The socket ended. Waiters for a frame that will now never come are
   * dropped rather than rejected: a test awaiting one has already failed on
   * its own timeout, and a rejection nobody catches would take the run down
   * with a different error than the real one.
   */
  const closedSocket = (): void => {
    waiters.length = 0
    settleClosed(closure ?? { code: 1006, reason: '' })
  }

  return {
    connect: () =>
      new Promise((resolve, reject) => {
        closure = undefined
        closedPromise = new Promise<LinkClosure>(done => {
          settleClosed = done
        })
        const ws = new Socket(options.url)
        socket = ws
        let settled = false
        ws.addEventListener('open', () => {
          write(
            nodeFrameSchema.parse({
              type: 'hello',
              protocol: PROTOCOL_VERSION,
              token,
              tokenKind,
              version: hello.version,
              region: hello.region,
              lan: hello.lan,
              labels: hello.labels,
              capacity: hello.capacity,
              imageDigest: hello.imageDigest,
              instances: snapshot(),
            }),
          )
        })
        ws.addEventListener('message', event => {
          const frame = orchestratorNodeFrameSchema.parse(JSON.parse(String(event.data)))
          receive(frame)
          if (!settled && frame.type === 'welcome') {
            settled = true
            resolve(frame)
          }
        })
        ws.addEventListener('close', event => {
          closure = { code: event.code ?? 1006, reason: event.reason ?? '' }
          closedSocket()
          if (!settled) {
            settled = true
            reject(new LinkClosedError(closure))
          }
        })
        ws.addEventListener('error', () => {
          if (settled) return
          settled = true
          reject(new LinkClosedError(closure ?? { code: 1006, reason: 'socket error' }))
        })
      }),

    close: (code = 1000, reason = '') => {
      socket?.close(code, reason)
      return closedPromise
    },
    closed: () => closedPromise,
    connected,
    send: frame => write(nodeFrameSchema.parse(frame)),
    raw: text => socket?.send(text),
    heartbeat: () => write(nodeFrameSchema.parse({ type: 'heartbeat' })),
    report,
    instances: snapshot,
    setState: (instanceId, state, error) => {
      const instance = instances.get(instanceId)
      if (!instance) throw new Error(`no instance ${instanceId}`)
      instance.state = state
      if (error !== undefined) instance.error = error
      report()
    },
    forget: instanceId => void instances.delete(instanceId),
    next: <T extends OrchestratorNodeFrameType>(type: T) => {
      const index = unconsumed.findIndex(frame => frame.type === type)
      if (index >= 0)
        return Promise.resolve(unconsumed.splice(index, 1)[0] as OrchestratorNodeFrameOf<T>)
      return new Promise<OrchestratorNodeFrameOf<T>>(resolve =>
        waiters.push({ type, resolve: frame => resolve(frame as OrchestratorNodeFrameOf<T>) }),
      )
    },
    received: () => [...received],
    starts: () => [...starts],
    stops: () => [...stops],
    sent: () => [...sent],
    nodeId: () => nodeId,
    nodeToken: () => nodeToken,
    drained: () => drained,
    heartbeatIntervalMs: () => heartbeatIntervalMs,
  }
}

export type { LinkClosure, LinkSocketConstructor }
export { LinkClosedError, NODE_LINK_PATH }
