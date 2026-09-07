import type { GameserverEvent, RosterEntry, WidgetPushFrame } from '@ezpug/match-api'
import { EVENTS_BATCH_MAX, LINK_CLOSE_CODES, PROTOCOL_VERSION } from './constants'
import {
  type LinkAckStatus,
  type LinkCommand,
  type LinkConsoleLine,
  type LinkServerState,
  type OrchestratorFrame,
  type OrchestratorFrameOf,
  type OrchestratorFrameType,
  orchestratorFrameSchema,
  type RoundBackup,
  type SequencedEvent,
  type ServerFrame,
  type ServerFrameInput,
  type ServerFrameOf,
  serverFrameSchema,
} from './server-link'

/**
 * **A server that speaks the link from TypeScript** (PRD-02 T6). It is what
 * every orchestrator test connects in place of a real plugin, and it does
 * exactly what the C# link client (T7) must do, so its exchanges — recorded
 * under `fixtures/link/*.json` — are the files the C# side is proven
 * against:
 *
 * - The first frame is `hello`; nothing is sent before `welcome` arrives.
 * - Events get a **per-server `seq`**, monotonic from 1, and stay in a
 *   buffer until an `ack` names them, whatever the ack said. On reconnect
 *   the `hello` carries `lastSeq` and the match the server believes it
 *   holds; everything at or below `welcome.ackedSeq` is dropped and the rest
 *   is resent, in order, in batches of at most `EVENTS_BATCH_MAX`.
 * - A `command` is answered with a `command_result` carrying the same
 *   `correlationId` (a `console` command with a `console` frame), a
 *   `player_command` with a `player_command_result`; `assign` is answered by
 *   `state: assigned`, `release` by `state: idle`, `drain` by
 *   `state: draining`.
 *
 * No timers, no backoff, no clock: a test drives it and awaits what it
 * expects, and the plugin's reconnect policy is the plugin's own. The socket
 * is the WHATWG one Node ships (or whatever constructor the test hands in).
 */

/** The corner of a WebSocket the fake uses — the WHATWG class and `ws` both fit it. */
export interface LinkSocket {
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
export type LinkSocketConstructor = new (url: string) => LinkSocket

const SOCKET_OPEN = 1

/** How a socket ended, as the fake saw it. */
export interface LinkClosure {
  code: number
  reason: string
}

/** The socket closed (or failed) before the frame the caller was waiting for. */
export class LinkClosedError extends Error {
  override readonly name = 'LinkClosedError'
  constructor(readonly closure: LinkClosure) {
    super(`the link closed ${closure.code}${closure.reason ? ` (${closure.reason})` : ''}`)
  }
}

/**
 * One line of a recorded exchange: a frame each way, or how the socket was
 * closed. The fixture files under `fixtures/link/` are arrays of these.
 */
export type LinkExchangeEntry =
  | { from: 'server'; frame: ServerFrame }
  | { from: 'orchestrator'; frame: OrchestratorFrame }
  | { from: 'orchestrator'; close: LinkClosure }
  | { from: 'server'; close: LinkClosure }

/** The document one `fixtures/link/*.json` file holds. */
export interface LinkExchangeFixture {
  schema: 'LinkExchange'
  exchange: LinkExchangeEntry[]
}

/** What the fake answers a `command` with when a test does not say: what `command_result` carries, or a console tail. */
export type FakeCommandAnswer =
  | Omit<ServerFrameOf<'command_result'>, 'type' | 'correlationId'>
  | { console: LinkConsoleLine[]; uptimeMs?: number }

export type FakePlayerCommandAnswer = Omit<
  ServerFrameOf<'player_command_result'>,
  'type' | 'correlationId' | 'steamId64' | 'command'
>

export interface FakeServerOptions {
  /** `ws://host:port/link`. */
  url: string
  /** The server token the provider planted (`ezpug.json`, the container env). */
  token: string
  /** The socket class. Default: the WHATWG `WebSocket` Node ships. */
  WebSocket?: LinkSocketConstructor
  /** What the `hello` says about this server; defaults describe the dev image. */
  hello?: Partial<
    Pick<
      ServerFrameOf<'hello'>,
      'versions' | 'capabilities' | 'plugins' | 'hostname' | 'map' | 'state'
    >
  >
  /** The server's uptime when it says `hello`; console lines and heartbeats count from it. */
  uptimeMs?: number
  /**
   * What to answer a `command` with. `null` leaves it unanswered (a test of
   * the orchestrator's deadline); `undefined` takes the default: `console` →
   * the tail in {@link FakeServer.consoleLines}, `rcon` → `applied` with
   * empty output, everything else → `applied`.
   */
  onCommand?: (
    command: LinkCommand,
    server: FakeServer,
  ) => FakeCommandAnswer | null | undefined | Promise<FakeCommandAnswer | null | undefined>
  /** What to answer a `player_command` with. `null` = no answer, `undefined` = the default, `applied`. */
  onPlayerCommand?: (
    frame: OrchestratorFrameOf<'player_command'>,
    server: FakeServer,
  ) =>
    | FakePlayerCommandAnswer
    | null
    | undefined
    | Promise<FakePlayerCommandAnswer | null | undefined>
  /** Answer `assign`/`release`/`drain` with the matching `state` frame, as the plugin does. Default true. */
  autoState?: boolean
  /** Every frame each way and every close, appended in order — the fixture writer's input. */
  record?: LinkExchangeEntry[]
}

export interface FakeServer {
  /** Open a socket, say `hello`, resolve on `welcome`; reject with {@link LinkClosedError} if closed first. Resends the unacked buffer past `welcome.ackedSeq`. */
  connect: () => Promise<OrchestratorFrameOf<'welcome'>>
  /** Close from the server's side. */
  close: (code?: number, reason?: string) => Promise<LinkClosure>
  /** Resolves when the current socket closes, however it does. */
  closed: () => Promise<LinkClosure>
  connected: () => boolean
  /** Send any server frame (parsed first, so the bytes are the schema's). */
  send: (frame: ServerFrameInput) => void
  /** Send text as it is — a frame that must not parse, for a test of the orchestrator's refusals. Not recorded. */
  raw: (text: string) => void
  /** Emit vocabulary events with fresh link `seq`s; resolves with their acks once every one is acked. */
  emit: (
    events: GameserverEvent | GameserverEvent[],
  ) => Promise<{ seq: number; status: LinkAckStatus }[]>
  /** Resend one already-sequenced event as is — a test of the orchestrator's dedup. */
  resend: (sequenced: SequencedEvent) => void
  heartbeat: (overrides?: Partial<Omit<ServerFrameOf<'heartbeat'>, 'type'>>) => void
  state: (state: LinkServerState, detail?: string) => void
  backup: (backup: RoundBackup, matchId?: string) => void
  /** A gamemode's push at one player's phone (PRD-02 T26) — ephemeral, unacked, relayed by the orchestrator to that player's widget sockets. */
  widgetPush: (steamId64: string, push: WidgetPushFrame, matchId?: string) => void
  /** Send a console tail, unsolicited or as the answer to `correlationId`. */
  console: (lines: LinkConsoleLine[], correlationId?: string) => void
  /** The next orchestrator frame of `type` not yet taken by a previous `next`. */
  next: <T extends OrchestratorFrameType>(type: T) => Promise<OrchestratorFrameOf<T>>
  /** Every orchestrator frame received, in order, across reconnects. */
  received: () => OrchestratorFrame[]
  /** The last `assign`, until a `release`. */
  assignment: () => OrchestratorFrameOf<'assign'> | undefined
  /** Every `profile` pushed, in order. */
  profiles: () => RosterEntry[]
  /** The match this server believes it holds. */
  matchId: () => string | undefined
  lastSeq: () => number
  ackedSeq: () => number
  /** Events sent and not yet acked, in `seq` order. */
  buffered: () => SequencedEvent[]
  /** What a `console` command answers with, by default. A test fills it. */
  consoleLines: LinkConsoleLine[]
  uptimeMs: () => number
}

const DEFAULT_HELLO: Required<NonNullable<FakeServerOptions['hello']>> = {
  versions: { plugin: '0.1.0', sdk: '0.1.0', counterStrikeSharp: '1.0.373', matchzy: '0.8.15' },
  capabilities: ['positions', 'chat', 'playerCommands', 'widget', 'backups', 'scoreboardRating'],
  plugins: ['EZPug.Core', 'MatchZy', 'RetakesPlugin', 'WeaponPaints'],
  hostname: 'EZPug dev server',
  map: 'de_dust2',
  state: 'idle',
}

function defaultSocket(): LinkSocketConstructor {
  const ctor = (globalThis as { WebSocket?: LinkSocketConstructor }).WebSocket
  if (!ctor) throw new Error('no global WebSocket; pass one in FakeServerOptions.WebSocket')
  return ctor
}

export function createFakeServer(options: FakeServerOptions): FakeServer {
  const Socket = options.WebSocket ?? defaultSocket()
  const hello = { ...DEFAULT_HELLO, ...options.hello }
  const autoState = options.autoState ?? true
  const record = options.record
  const uptimeAtHello = options.uptimeMs ?? 0

  let socket: LinkSocket | undefined
  let closure: Promise<LinkClosure> = Promise.resolve({ code: 1005, reason: 'never opened' })
  let uptime = uptimeAtHello
  let state: LinkServerState = hello.state
  let map = hello.map
  let matchId: string | undefined
  let assignment: OrchestratorFrameOf<'assign'> | undefined
  let lastSeq = 0
  let ackedSeq = 0
  const buffer: SequencedEvent[] = []
  const ackWaiters = new Map<number, (status: LinkAckStatus) => void>()
  const received: OrchestratorFrame[] = []
  const profiles: RosterEntry[] = []
  const unconsumed: OrchestratorFrame[] = []
  const waiters: {
    type: OrchestratorFrameType
    resolve: (frame: OrchestratorFrame) => void
    reject: (error: Error) => void
  }[] = []
  let welcomeWaiter:
    | { resolve: (frame: OrchestratorFrameOf<'welcome'>) => void; reject: (error: Error) => void }
    | undefined

  /** Send one frame, if there is a socket to send it on; a recording holds only what crossed. */
  const write = (frame: ServerFrameInput): void => {
    const parsed = serverFrameSchema.parse(frame)
    if (!socket || socket.readyState !== SOCKET_OPEN) return
    record?.push({ from: 'server', frame: parsed })
    socket.send(JSON.stringify(parsed))
  }

  const helloFrame = (): ServerFrameInput => ({
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    token: options.token,
    versions: hello.versions,
    capabilities: hello.capabilities,
    plugins: hello.plugins,
    hostname: hello.hostname,
    map,
    state,
    ...(matchId !== undefined && { matchId }),
    lastSeq,
  })

  const sendState = (detail?: string): void => {
    write({
      type: 'state',
      state,
      ...(matchId !== undefined && { matchId }),
      ...(detail !== undefined && { detail }),
    })
  }

  const flushBuffer = (): void => {
    const pending = buffer.filter(entry => entry.seq > ackedSeq)
    for (let at = 0; at < pending.length; at += EVENTS_BATCH_MAX)
      write({ type: 'events', events: pending.slice(at, at + EVENTS_BATCH_MAX) })
  }

  const defaultAnswer = (command: LinkCommand): FakeCommandAnswer =>
    command.type === 'console'
      ? { console: fake.consoleLines.slice(-command.lines) }
      : command.type === 'rcon'
        ? { status: 'applied', output: '' }
        : { status: 'applied' }

  const answerCommand = async (command: LinkCommand): Promise<void> => {
    const chosen = options.onCommand ? await options.onCommand(command, fake) : undefined
    const answer = chosen === undefined ? defaultAnswer(command) : chosen
    if (answer === null) return
    if ('console' in answer) {
      write({
        type: 'console',
        correlationId: command.correlationId,
        uptimeMs: answer.uptimeMs ?? uptime,
        lines: answer.console,
      })
      return
    }
    write({ type: 'command_result', correlationId: command.correlationId, ...answer })
  }

  const answerPlayerCommand = async (frame: OrchestratorFrameOf<'player_command'>) => {
    const chosen = options.onPlayerCommand ? await options.onPlayerCommand(frame, fake) : undefined
    const answer = chosen === undefined ? { status: 'applied' as const } : chosen
    if (answer === null) return
    write({
      type: 'player_command_result',
      correlationId: frame.correlationId,
      steamId64: frame.steamId64,
      command: frame.command,
      ...answer,
    })
  }

  const onFrame = (frame: OrchestratorFrame): void => {
    received.push(frame)
    switch (frame.type) {
      case 'welcome': {
        ackedSeq = Math.max(ackedSeq, frame.ackedSeq)
        for (const entry of buffer.splice(0)) {
          if (entry.seq > ackedSeq) buffer.push(entry)
          else ackWaiters.get(entry.seq)?.('accepted')
        }
        welcomeWaiter?.resolve(frame)
        welcomeWaiter = undefined
        flushBuffer()
        break
      }
      case 'ack':
        for (const result of frame.results) {
          const index = buffer.findIndex(entry => entry.seq === result.seq)
          if (index >= 0) buffer.splice(index, 1)
          ackedSeq = Math.max(ackedSeq, result.seq)
          ackWaiters.get(result.seq)?.(result.status)
          ackWaiters.delete(result.seq)
        }
        break
      case 'assign':
        assignment = frame
        matchId = frame.matchId
        map = frame.maps[0]?.map ?? map
        state = 'assigned'
        if (autoState) sendState('plugins loaded')
        break
      case 'release':
        assignment = undefined
        matchId = undefined
        state = 'idle'
        if (autoState) sendState(frame.reason)
        break
      case 'drain':
        state = 'draining'
        if (autoState) sendState()
        break
      case 'profile':
        profiles.push(frame.player)
        break
      case 'command':
        void answerCommand(frame.command)
        break
      case 'player_command':
        void answerPlayerCommand(frame)
        break
      default:
        break
    }
    const waiting = waiters.findIndex(waiter => waiter.type === frame.type)
    if (waiting >= 0) {
      const [waiter] = waiters.splice(waiting, 1)
      waiter?.resolve(frame)
    } else unconsumed.push(frame)
  }

  const fake: FakeServer = {
    consoleLines: [],
    connect: () =>
      new Promise((resolve, reject) => {
        if (socket && socket.readyState === SOCKET_OPEN)
          throw new Error('the fake server is already connected')
        const ws = new Socket(options.url)
        socket = ws
        welcomeWaiter = { resolve, reject }
        let settle: (closure: LinkClosure) => void = () => undefined
        closure = new Promise<LinkClosure>(done => {
          settle = done
        })
        let opened = false
        ws.addEventListener('open', () => {
          opened = true
          write(helloFrame())
        })
        ws.addEventListener('message', event => {
          const text = typeof event.data === 'string' ? event.data : String(event.data)
          const frame = orchestratorFrameSchema.parse(JSON.parse(text))
          record?.push({ from: 'orchestrator', frame })
          onFrame(frame)
        })
        ws.addEventListener('error', event => {
          // A failed handshake (a 503 from a draining orchestrator, a refused
          // connection) is an error with no close after it on the WHATWG
          // socket; an error on an open socket is followed by a close that
          // carries the code. Only the first kind is settled here.
          if (opened) return
          const closed = {
            code: 1006,
            reason: event.message ?? (event.error instanceof Error ? event.error.message : ''),
          }
          if (socket === ws) {
            record?.push({ from: 'orchestrator', close: closed })
            socket = undefined
          }
          const error = new LinkClosedError(closed)
          welcomeWaiter?.reject(error)
          welcomeWaiter = undefined
          settle(closed)
        })
        ws.addEventListener('close', event => {
          const closed = { code: event.code ?? 1006, reason: event.reason ?? '' }
          if (socket === ws) {
            record?.push({ from: 'orchestrator', close: closed })
            socket = undefined
          }
          const error = new LinkClosedError(closed)
          welcomeWaiter?.reject(error)
          welcomeWaiter = undefined
          for (const waiter of waiters.splice(0)) waiter.reject(error)
          settle(closed)
        })
      }),
    close: (code = 1000, reason = '') => {
      if (!socket) return closure
      const ws = socket
      socket = undefined
      record?.push({ from: 'server', close: { code, reason } })
      ws.close(code, reason)
      return closure
    },
    closed: () => closure,
    connected: () => socket !== undefined && socket.readyState === SOCKET_OPEN,
    send: write,
    raw: text => {
      if (socket && socket.readyState === SOCKET_OPEN) socket.send(text)
    },
    emit: events => {
      const list = Array.isArray(events) ? events : [events]
      const sequenced: SequencedEvent[] = list.map(event => {
        lastSeq += 1
        return { seq: lastSeq, event }
      })
      buffer.push(...sequenced)
      const acks = Promise.all(
        sequenced.map(
          entry =>
            new Promise<{ seq: number; status: LinkAckStatus }>(resolve => {
              ackWaiters.set(entry.seq, status => resolve({ seq: entry.seq, status }))
            }),
        ),
      )
      for (let at = 0; at < sequenced.length; at += EVENTS_BATCH_MAX)
        write({ type: 'events', events: sequenced.slice(at, at + EVENTS_BATCH_MAX) })
      return acks
    },
    resend: sequenced => write({ type: 'events', events: [sequenced] }),
    heartbeat: overrides => {
      uptime += 1
      write({
        type: 'heartbeat',
        state,
        map,
        playerCount: 0,
        ...(matchId !== undefined && { matchId }),
        uptimeMs: uptime,
        ...overrides,
      })
    },
    state: (next, detail) => {
      state = next
      sendState(detail)
    },
    backup: (backup, forMatch) => {
      const target = forMatch ?? matchId
      if (target === undefined) throw new Error('no match to back up')
      write({ type: 'backup', matchId: target, backup })
    },
    widgetPush: (steamId64, push, forMatch) => {
      const target = forMatch ?? matchId
      if (target === undefined) throw new Error('no match to push to')
      write({ type: 'widget_push', matchId: target, steamId64, push })
    },
    console: (lines, correlationId) =>
      write({
        type: 'console',
        ...(correlationId !== undefined && { correlationId }),
        uptimeMs: uptime,
        lines,
      }),
    next: <T extends OrchestratorFrameType>(type: T) => {
      const index = unconsumed.findIndex(frame => frame.type === type)
      if (index >= 0) {
        const [frame] = unconsumed.splice(index, 1)
        return Promise.resolve(frame as OrchestratorFrameOf<T>)
      }
      return new Promise<OrchestratorFrameOf<T>>((resolve, reject) => {
        if (!socket) {
          reject(new LinkClosedError({ code: 1006, reason: 'not connected' }))
          return
        }
        waiters.push({ type, resolve: frame => resolve(frame as OrchestratorFrameOf<T>), reject })
      })
    },
    received: () => [...received],
    assignment: () => assignment,
    profiles: () => [...profiles],
    matchId: () => matchId,
    lastSeq: () => lastSeq,
    ackedSeq: () => ackedSeq,
    buffered: () => [...buffer],
    uptimeMs: () => uptime,
  }
  return fake
}

/** The close codes a link client treats as "reconnect with backoff"; every other one is a decision. */
export const LINK_RECONNECT_CLOSE_CODES: readonly number[] = [
  1006,
  1001,
  1011,
  LINK_CLOSE_CODES.replaced,
  LINK_CLOSE_CODES.shuttingDown,
]

/**
 * A recorded exchange with the run's identities replaced by fixture ones —
 * `{ [real]: fixture }`, applied to every string at any depth. The
 * orchestrator's link tests pass the match id and the server token; the
 * resulting file names only `FIXTURE_MATCH_ID` and a token that says it is
 * not a secret.
 */
export function scrubLinkExchange(
  entries: LinkExchangeEntry[],
  replacements: Record<string, string>,
): LinkExchangeFixture {
  let text = JSON.stringify(entries)
  for (const [real, fixture] of Object.entries(replacements)) text = text.replaceAll(real, fixture)
  return { schema: 'LinkExchange', exchange: JSON.parse(text) as LinkExchangeEntry[] }
}
