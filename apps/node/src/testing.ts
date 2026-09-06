import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  NODE_LINK_PATH,
  type NodeFrame,
  type NodeFrameOf,
  type NodeFrameType,
  nodeFrameSchema,
  type OrchestratorNodeFrameInput,
  orchestratorNodeFrameSchema,
  PROTOCOL_VERSION,
} from '@ezpug/protocol'
import { type WebSocket, WebSocketServer } from 'ws'

/**
 * **What a test of the agent talks to** (PRD-02 T11): a scripted `/node`
 * endpoint over a real `ws` server on a loopback port. It is not the
 * orchestrator's node link (that is T12's, in the orchestrator, proven
 * against this app's frames) — it is the other end of the wire as this
 * app's tests need it: parse every node frame, answer the first `hello`
 * with a `welcome` (a node token when the hello was an enrolment), hand a
 * test the frames in order, and let it send any orchestrator frame or
 * close with any code.
 */

export interface FakeNodeEndpointOptions {
  nodeId?: string
  heartbeatIntervalMs?: number
  drained?: boolean
  /** The token an enrolment hello is answered with. */
  nodeToken?: string
  /**
   * Decide what a `hello` gets: `undefined` for the default welcome, a
   * close code (and reason) to refuse it, or `'silence'` to leave it
   * unanswered. Called with the parsed hello.
   */
  onHello?: (
    hello: NodeFrameOf<'hello'>,
  ) => { code: number; reason?: string } | 'silence' | undefined
}

export interface FakeNodeSession {
  readonly socket: WebSocket
  /** Every frame this socket sent, in order. */
  readonly frames: NodeFrame[]
  readonly closed: Promise<{ code: number; reason: string }>
  send: (frame: OrchestratorNodeFrameInput) => void
  close: (code?: number, reason?: string) => void
  /** Drop the connection without a close frame — the network, as the node sees it (1006). */
  terminate: () => void
}

export interface FakeNodeEndpoint {
  readonly url: string
  /** Every session ever opened, oldest first. */
  readonly sessions: FakeNodeSession[]
  /** The current (newest) session, or undefined. */
  current: () => FakeNodeSession | undefined
  /** Resolves with the next session to open (or the newest unclaimed one). */
  nextSession: () => Promise<FakeNodeSession>
  /** The next frame of `type` from the current session not yet taken by a previous `next`. */
  next: <T extends NodeFrameType>(type: T) => Promise<NodeFrameOf<T>>
  /** Every frame across every session, in order. */
  frames: () => NodeFrame[]
  /** Refuse every new upgrade with a 503 — a draining orchestrator. */
  setRefusing: (refusing: boolean) => void
  close: () => Promise<void>
}

export const FAKE_NODE_TOKEN = 'ezin_not-a-secret_node_token_0001'

export async function createFakeNodeEndpoint(
  options: FakeNodeEndpointOptions = {},
): Promise<FakeNodeEndpoint> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(404).end()
  })
  const wss = new WebSocketServer({ noServer: true })
  const sessions: FakeNodeSession[] = []
  const sessionWaiters: ((session: FakeNodeSession) => void)[] = []
  const unclaimedSessions: FakeNodeSession[] = []
  let refusing = false
  const unconsumed: NodeFrame[] = []
  const waiters: { type: NodeFrameType; resolve: (frame: NodeFrame) => void }[] = []

  server.on('upgrade', (request, socket, head) => {
    if (refusing || new URL(request.url ?? '/', 'http://x').pathname !== NODE_LINK_PATH) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, ws => {
      const frames: NodeFrame[] = []
      let settleClosed: (closure: { code: number; reason: string }) => void = () => undefined
      const closed = new Promise<{ code: number; reason: string }>(resolve => {
        settleClosed = resolve
      })
      const session: FakeNodeSession = {
        socket: ws,
        frames,
        closed,
        send: frame => ws.send(JSON.stringify(orchestratorNodeFrameSchema.parse(frame))),
        close: (code = 1000, reason = '') => ws.close(code, reason),
        terminate: () => ws.terminate(),
      }
      sessions.push(session)
      const waiter = sessionWaiters.shift()
      if (waiter) waiter(session)
      else unclaimedSessions.push(session)

      ws.on('message', data => {
        const frame = nodeFrameSchema.parse(JSON.parse(String(data)))
        frames.push(frame)
        if (frame.type === 'hello' && frames.length === 1) {
          const refusal = options.onHello?.(frame)
          if (refusal === 'silence') {
            // Nothing: the node's hello deadline is what is under test.
          } else if (refusal) {
            ws.close(refusal.code, refusal.reason ?? '')
          } else {
            session.send({
              type: 'welcome',
              protocol: PROTOCOL_VERSION,
              nodeId: options.nodeId ?? 'devbox',
              ...(frame.tokenKind === 'enrolment' && {
                nodeToken: options.nodeToken ?? FAKE_NODE_TOKEN,
              }),
              heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
              drained: options.drained ?? false,
            })
          }
        }
        const waiting = waiters.findIndex(entry => entry.type === frame.type)
        if (waiting >= 0) waiters.splice(waiting, 1)[0]?.resolve(frame)
        else unconsumed.push(frame)
      })
      ws.on('close', (code, reason) => settleClosed({ code, reason: reason.toString() }))
    })
  })

  const port = await new Promise<number>(resolve =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  )

  return {
    url: `ws://127.0.0.1:${port}${NODE_LINK_PATH}`,
    sessions,
    current: () => sessions.at(-1),
    nextSession: () => {
      const unclaimed = unclaimedSessions.shift()
      if (unclaimed) return Promise.resolve(unclaimed)
      return new Promise(resolve => sessionWaiters.push(resolve))
    },
    next: <T extends NodeFrameType>(type: T) => {
      const index = unconsumed.findIndex(frame => frame.type === type)
      if (index >= 0) return Promise.resolve(unconsumed.splice(index, 1)[0] as NodeFrameOf<T>)
      return new Promise<NodeFrameOf<T>>(resolve =>
        waiters.push({ type, resolve: frame => resolve(frame as NodeFrameOf<T>) }),
      )
    },
    frames: () => sessions.flatMap(session => session.frames),
    setRefusing: value => {
      refusing = value
    },
    close: async () => {
      for (const session of sessions) session.socket.terminate()
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    },
  }
}

export { createFakeDocker, digestFor, type FakeDocker } from './docker/fake'
export { createMemoryLog } from './log'
export { createMemoryStateStore } from './state'
