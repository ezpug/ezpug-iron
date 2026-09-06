import type { Clock, Timer } from '@ezpug/core'
import {
  HELLO_TIMEOUT_MS,
  type InstanceSpec,
  LINK_CLOSE_CODES,
  type NodeFrameInput,
  type NodeFrameOf,
  type NodeTokenKind,
  nodeFrameSchema,
  type OrchestratorNodeFrame,
  type OrchestratorNodeFrameOf,
  orchestratorNodeFrameSchema,
  PROTOCOL_VERSION,
} from '@ezpug/protocol'
import type { Log } from './log'

/**
 * **The node link, from the node's side** (decision 23, PRD-02 T11): one
 * outbound WebSocket to the orchestrator's `/node`, `hello` first, nothing
 * before `welcome`, heartbeats on the interval `welcome` gave, and the
 * orchestrator's `start`/`stop`/`drain`/`undrain` applied **in the order
 * they arrive** through the handler. Two ways to use it:
 *
 * - {@link NodeLink.connectOnce} — one dial, resolve on `welcome`, no
 *   retry. What `ezpug-node enrol` does with the one-time token: the
 *   `welcome` carries the node token, it is persisted, and the socket is
 *   closed.
 * - {@link NodeLink.run} — dial and keep dialling. A lost socket, a refused
 *   handshake, a `4005 replaced` or a `4012 shuttingDown` is retried with
 *   capped exponential backoff on the clock (one second doubling to thirty,
 *   reset by a `welcome`); `4001 unauthorized`, `4002 protocolMismatch`,
 *   `4003 malformed` and `4009 revoked` are decisions, not hiccups — the
 *   loop stops and the handler hears `onFatal`, because a revoked node
 *   hammering an orchestrator every second helps nobody.
 *
 * The socket is the WHATWG one Node ships (or whatever constructor a test
 * hands in), so a test drives a real socket against a scripted endpoint and
 * the clock alone decides when a retry or a heartbeat happens.
 */

/** The corner of a WebSocket this needs — the WHATWG class and `ws` both fit it. */
export interface NodeLinkSocket {
  readonly readyState: number
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  addEventListener: (
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: {
      data?: unknown
      code?: number
      reason?: string
      message?: string
      error?: unknown
    }) => void,
  ) => void
}
export type NodeLinkSocketConstructor = new (url: string) => NodeLinkSocket

const SOCKET_OPEN = 1

export interface LinkClosure {
  code: number
  reason: string
}

/** The socket closed (or never opened) before the `welcome` the caller was waiting for. */
export class NodeLinkClosedError extends Error {
  override readonly name = 'NodeLinkClosedError'
  constructor(readonly closure: LinkClosure) {
    super(`the node link closed ${closure.code}${closure.reason ? ` (${closure.reason})` : ''}`)
  }
}

/** Close codes that end the loop: the orchestrator has decided, and dialling again changes nothing. */
export const NODE_LINK_FATAL_CLOSE_CODES: readonly number[] = [
  LINK_CLOSE_CODES.unauthorized,
  LINK_CLOSE_CODES.protocolMismatch,
  LINK_CLOSE_CODES.malformed,
  LINK_CLOSE_CODES.revoked,
]

/** The close code the node uses when it hangs up on purpose. */
export const NODE_LINK_CLOSE_BY_NODE = 1000

export const BACKOFF_INITIAL_MS_DEFAULT = 1_000
export const BACKOFF_MAX_MS_DEFAULT = 30_000

/** What `hello` says beyond the token: the agent fills it from its config and its containers. */
export type HelloBody = Omit<NodeFrameOf<'hello'>, 'type' | 'protocol' | 'token' | 'tokenKind'>

export interface NodeLinkCredentials {
  token: string
  tokenKind: NodeTokenKind
}

export interface NodeLinkHandler {
  /** Composed at every dial, so a reconnect reports the instances as they are now. */
  hello: () => HelloBody | Promise<HelloBody>
  onWelcome: (welcome: OrchestratorNodeFrameOf<'welcome'>) => void | Promise<void>
  onStart: (spec: InstanceSpec) => void | Promise<void>
  onStop: (instanceId: string, reason?: string) => void | Promise<void>
  onDrain: () => void | Promise<void>
  onUndrain: () => void | Promise<void>
  /** A heartbeat just went out — the link is known up at this instant. */
  onHeartbeat?: () => void
  /** The socket went away and the loop will dial again (or was told to stop). */
  onDisconnect?: (closure: LinkClosure, willRetry: boolean) => void
  /** A fatal close code: the loop has stopped. */
  onFatal?: (closure: LinkClosure) => void
}

export interface NodeLinkOptions {
  /** `ws://host:port/node`. */
  url: string
  clock: Clock
  log: Log
  /** Read at every dial: the enrolment token once, the node token after. */
  credentials: () => NodeLinkCredentials
  handler: NodeLinkHandler
  WebSocket?: NodeLinkSocketConstructor
  /** How long an open socket may wait for `welcome`. Default `HELLO_TIMEOUT_MS`. */
  helloTimeoutMs?: number
  backoffInitialMs?: number
  backoffMaxMs?: number
}

export interface NodeLink {
  connectOnce: () => Promise<OrchestratorNodeFrameOf<'welcome'>>
  /** Dial, and keep dialling with backoff, until `close()`. Returns at once. */
  run: () => void
  /** Send a frame if the link is welcomed; false (and nothing sent) otherwise. */
  send: (frame: NodeFrameInput) => boolean
  connected: () => boolean
  /** Hang up and stop the loop. Resolves once the socket is closed. */
  close: () => Promise<void>
}

function defaultSocket(): NodeLinkSocketConstructor {
  const ctor = (globalThis as { WebSocket?: NodeLinkSocketConstructor }).WebSocket
  if (!ctor) throw new Error('no global WebSocket; pass one in NodeLinkOptions.WebSocket')
  return ctor
}

export function createNodeLink(options: NodeLinkOptions): NodeLink {
  const { clock, log, handler } = options
  const Socket = options.WebSocket ?? defaultSocket()
  const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS
  const backoffInitialMs = options.backoffInitialMs ?? BACKOFF_INITIAL_MS_DEFAULT
  const backoffMaxMs = options.backoffMaxMs ?? BACKOFF_MAX_MS_DEFAULT

  let socket: NodeLinkSocket | undefined
  let welcomed = false
  let stopped = false
  let attempts = 0
  let redial: Timer | undefined
  let heartbeat: Timer | undefined
  let helloDeadline: Timer | undefined
  let closing: Promise<void> | undefined
  // Inbound frames are applied one after another: a `start` and the `stop`
  // for the same id must land in the order the orchestrator sent them.
  let inbound: Promise<void> = Promise.resolve()

  const write = (target: NodeLinkSocket, frame: NodeFrameInput): void => {
    const parsed = nodeFrameSchema.parse(frame)
    if (target.readyState !== SOCKET_OPEN) return
    target.send(JSON.stringify(parsed))
  }

  const disarmTimers = (): void => {
    heartbeat?.cancel()
    heartbeat = undefined
    helloDeadline?.cancel()
    helloDeadline = undefined
  }

  const armHeartbeat = (target: NodeLinkSocket, intervalMs: number): void => {
    heartbeat?.cancel()
    heartbeat = clock.after(intervalMs, () => {
      if (socket !== target || !welcomed) return
      write(target, { type: 'heartbeat' })
      handler.onHeartbeat?.()
      armHeartbeat(target, intervalMs)
    })
  }

  const apply = (frame: OrchestratorNodeFrame): Promise<void> => {
    switch (frame.type) {
      case 'welcome':
        return Promise.resolve()
      case 'start':
        return Promise.resolve(handler.onStart(frame.instance))
      case 'stop':
        return Promise.resolve(handler.onStop(frame.instanceId, frame.reason))
      case 'drain':
        return Promise.resolve(handler.onDrain())
      case 'undrain':
        return Promise.resolve(handler.onUndrain())
    }
  }

  /**
   * One dial. Resolves with the `welcome`, rejects with
   * {@link NodeLinkClosedError} when the socket ends first. `onClosed` runs
   * exactly once, whenever this socket ends — before or after welcome.
   */
  const dial = (onClosed: (closure: LinkClosure) => void) =>
    new Promise<OrchestratorNodeFrameOf<'welcome'>>((resolve, reject) => {
      const credentials = options.credentials()
      const ws = new Socket(options.url)
      socket = ws
      welcomed = false
      let settled = false
      let waitingForWelcome = true

      const ended = (closure: LinkClosure): void => {
        if (settled) return
        settled = true
        if (socket === ws) {
          socket = undefined
          welcomed = false
          disarmTimers()
        }
        if (waitingForWelcome) {
          waitingForWelcome = false
          reject(new NodeLinkClosedError(closure))
        }
        onClosed(closure)
      }

      ws.addEventListener('open', () => {
        void Promise.resolve(handler.hello()).then(
          body => {
            if (socket !== ws) return
            write(ws, {
              type: 'hello',
              protocol: PROTOCOL_VERSION,
              token: credentials.token,
              tokenKind: credentials.tokenKind,
              ...body,
            })
            helloDeadline = clock.after(helloTimeoutMs, () => {
              if (socket !== ws || welcomed) return
              log.warn(`no welcome within ${helloTimeoutMs}ms; hanging up to dial again`)
              ws.close(NODE_LINK_CLOSE_BY_NODE, 'no welcome')
            })
          },
          error => {
            log.error('could not compose hello', error)
            ws.close(NODE_LINK_CLOSE_BY_NODE, 'hello failed')
          },
        )
      })
      ws.addEventListener('message', event => {
        const text = typeof event.data === 'string' ? event.data : String(event.data)
        let frame: OrchestratorNodeFrame
        try {
          frame = orchestratorNodeFrameSchema.parse(JSON.parse(text))
        } catch (error) {
          log.error('an orchestrator frame did not parse; ignored', error)
          return
        }
        if (frame.type === 'welcome') {
          if (welcomed) return
          welcomed = true
          attempts = 0
          helloDeadline?.cancel()
          helloDeadline = undefined
          armHeartbeat(ws, frame.heartbeatIntervalMs)
          inbound = inbound
            .then(() => Promise.resolve(handler.onWelcome(frame)))
            .catch(error => {
              log.error('the welcome handler failed', error)
            })
          waitingForWelcome = false
          resolve(frame)
          return
        }
        if (!welcomed) {
          log.warn(`a ${frame.type} arrived before welcome; ignored`)
          return
        }
        inbound = inbound
          .then(() => apply(frame))
          .catch(error => {
            log.error(`applying ${frame.type} failed`, error)
          })
      })
      ws.addEventListener('error', event => {
        // A failed handshake (a 503 from a draining orchestrator, a refused
        // connection) is an error that may or may not be followed by a close
        // on the WHATWG socket; `ended` runs once either way.
        ended({
          code: 1006,
          reason: event.message ?? (event.error instanceof Error ? event.error.message : ''),
        })
      })
      ws.addEventListener('close', event => {
        ended({ code: event.code ?? 1006, reason: event.reason ?? '' })
      })
    })

  const backoffMs = (): number =>
    Math.min(backoffInitialMs * 2 ** Math.max(attempts - 1, 0), backoffMaxMs)

  const loop = (): void => {
    if (stopped) return
    void dial(closure => {
      const fatal = NODE_LINK_FATAL_CLOSE_CODES.includes(closure.code)
      const willRetry = !stopped && !fatal
      handler.onDisconnect?.(closure, willRetry)
      if (stopped) return
      if (fatal) {
        stopped = true
        log.error(
          `the orchestrator closed the node link ${closure.code}${closure.reason ? ` (${closure.reason})` : ''}; not dialling again`,
        )
        handler.onFatal?.(closure)
        return
      }
      attempts += 1
      const delay = backoffMs()
      log.warn(
        `the node link closed ${closure.code}${closure.reason ? ` (${closure.reason})` : ''}; dialling again in ${delay}ms`,
      )
      redial = clock.after(delay, () => {
        redial = undefined
        loop()
      })
    }).catch((error: unknown) => {
      // The dial rejected before welcome; `onClosed` above has the retry.
      if (!(error instanceof NodeLinkClosedError)) log.error('dial failed', error)
    })
  }

  return {
    connectOnce: () => {
      if (socket) throw new Error('the node link is already dialling')
      return dial(() => undefined)
    },
    run: () => {
      if (stopped) throw new Error('the node link was closed')
      if (socket || redial) return
      loop()
    },
    send: frame => {
      if (!socket || !welcomed) return false
      write(socket, frame)
      return true
    },
    connected: () => socket !== undefined && welcomed,
    close: () => {
      closing ??= (async () => {
        stopped = true
        redial?.cancel()
        redial = undefined
        disarmTimers()
        const ws = socket
        if (!ws) return
        await new Promise<void>(resolve => {
          ws.addEventListener('close', () => resolve())
          ws.addEventListener('error', () => resolve())
          if (ws.readyState === SOCKET_OPEN) ws.close(NODE_LINK_CLOSE_BY_NODE, 'node stopping')
          else if (ws.readyState > SOCKET_OPEN) resolve()
          else ws.close()
        })
        await inbound
      })()
      return closing
    },
  }
}
