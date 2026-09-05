import { randomUUID } from 'node:crypto'
import type { Clock, Timer } from '@ezpug/core'
import type {
  LinkAckStatus,
  OrchestratorFrame,
  OrchestratorFrameOf,
  ServerFrame,
} from '@ezpug/protocol'
import {
  HEARTBEAT_INTERVAL_MS_DEFAULT,
  HELLO_TIMEOUT_MS,
  LINK_CLOSE_CODES,
  linkCommandSchema,
  PROTOCOL_VERSION,
  SERVER_LINK_PATH,
  serverFrameSchema,
} from '@ezpug/protocol'
import { type WebSocket, WebSocketServer } from 'ws'
import type { Log } from '../log'
import type { MatchStore, ServerRow, ServerTokenRow } from '../match/store'
import type { UpgradeRouter } from '../stream/upgrade'
import { hashToken, looksLikeToken } from '../tokens'
import type {
  ChannelCommandResult,
  ConsoleTail,
  LinkRegistry,
  PlayerCommandOutcome,
  PlayerCommandRelay,
  ServerChannel,
  ServerEventSink,
  ServerRef,
} from './channels'
import { serverKey } from './channels'

/**
 * **`/link` — the socket every server dials** (decision 5, PRD-02 T6). A
 * raw `ws` upgrade beside Hono, matched on the server's own `upgrade`
 * event before any framework and attached before the port opens, with
 * every listener on a socket added **before anything is awaited** — the
 * platform's Socket.IO lesson: a frame that arrives while the token is
 * being looked up must queue, not vanish.
 *
 * One session per server, keyed `provider/serverId` like every event's
 * `source`:
 *
 * - **`hello` first.** The token is hashed and looked up in `server_tokens`;
 *   its ledger row must be open. A wrong first frame, an unknown or revoked
 *   token, a protocol this build does not speak, no `hello` at all: closed
 *   with the `LINK_CLOSE_CODES` code that says which. A second socket with
 *   the same token replaces the first (`4005`).
 * - **`welcome`, then the assignment.** The row's match, composed by the
 *   machine from the request, the manifest and what it learned since — sent
 *   unless the `hello` says the server already holds it (a reconnect
 *   mid-match), refused when the manifest names a plugin the image lacks.
 * - **Events are acked one by one, batches applied in order.** The link's
 *   per-server `seq` is deduplicated here (at or below the contiguous
 *   `ackedSeq`, or already in the window above it, is `duplicate`); the rest
 *   go to the machine in order and its answer is the ack. `ackedSeq` is
 *   persisted on the row after every batch, so `welcome.ackedSeq` survives a
 *   restart on either side.
 * - **Commands are relayed by `correlationId` with a deadline** on the clock,
 *   and their answers are resolved the moment they arrive — off the session's
 *   inbound chain, because the machine sends a command while holding the
 *   match's chain and the server may report an event *before* it answers.
 * - **Heartbeats are life.** Every frame re-arms a silence timer at two
 *   intervals; silence past that is a `suspect` to the machine (which probes
 *   the provider and opens the recovery window from `live`) and the socket is
 *   terminated so the plugin reconnects. `last_seen_at` is written at most
 *   once every few seconds.
 * - **`backup` frames are persisted**, the newest few per match; a `console`
 *   tail is cached on the session for the fleet console route (T20).
 */

/** How long a relayed command may go unanswered before the machine hears `provider_unavailable`. */
export const COMMAND_TIMEOUT_MS_DEFAULT = 15_000

/** Round backups kept per match — MatchZy writes one a round; recovery wants the newest. */
export const BACKUPS_KEPT_PER_MATCH = 8

/** `last_seen_at` is a heartbeat's fact, not a write per frame. */
const LAST_SEEN_WRITE_INTERVAL_MS = 5_000

/** What the link needs of the machine: the sink, and three doors the `hello`, the heartbeat and the silence use. */
export interface LinkMachine extends ServerEventSink {
  /** A server said something: re-arm the loss detector of the match it plays for. */
  touch: (source: ServerRef) => Promise<void>
  /** The assignment for the match this server's row holds, or null when there is none to send. */
  assignment: (
    source: ServerRef,
    hello: { plugins: readonly string[]; matchId?: string },
  ) => Promise<OrchestratorFrameOf<'assign'> | null>
  /** The server went quiet: probe the provider and decide. */
  suspect: (matchId: string, detail: string) => Promise<void>
}

export interface ServerLinkOptions {
  router: UpgradeRouter
  clock: Clock
  log: Log
  store: MatchStore
  matches: LinkMachine
  links: LinkRegistry
  /** What `welcome` asks for. Default `HEARTBEAT_INTERVAL_MS_DEFAULT`. */
  heartbeatIntervalMs?: number
  helloTimeoutMs?: number
  commandTimeoutMs?: number
  /** Once true, new sockets are refused with a 503 before the upgrade. */
  isDraining?: () => boolean
}

/** One connected server, as the fleet and a test see it. Never the token. */
export interface LinkSessionView {
  server: ServerRef
  fleetServerId: string
  matchId: string | null
  ackedSeq: number
  consoleTail: ConsoleTail | undefined
}

export interface ServerLink {
  sessions: () => LinkSessionView[]
  get: (server: ServerRef) => LinkSessionView | undefined
  /** Compose and send the assignment for a connected server's row (a warm instance that just got a match, T12). */
  assign: (server: ServerRef) => Promise<boolean>
  /** Wait for every tracked write (a throttled `last_seen_at`) to land — a test's door. */
  settle: () => Promise<void>
  /** Close every session `shuttingDown`; peers reconnect with backoff. */
  close: () => Promise<void>
}

type Answer = Extract<ServerFrame, { type: 'command_result' | 'console' | 'player_command_result' }>

interface Pending {
  want: Answer['type']
  resolve: (frame: Answer) => void
  reject: (error: Error) => void
  timer: Timer
}

interface Session {
  readonly ref: ServerRef
  readonly channel: ServerChannel
  /** The plugin folders the `hello` listed — what a later assignment is checked against. */
  readonly installed: readonly string[]
  /** A frame arrived: re-arm silence, note the time. */
  seen: () => void
  /** Resolve a correlated answer at once. True when it was one. */
  answer: (frame: ServerFrame) => boolean
  /** Everything else, on the session's inbound chain, in order. */
  handle: (frame: ServerFrame) => Promise<void>
  write: (frame: OrchestratorFrame) => void
  replace: () => void
  closed: () => void
  view: () => LinkSessionView
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isAnswer(frame: ServerFrame): frame is Answer {
  return (
    frame.type === 'command_result' ||
    frame.type === 'player_command_result' ||
    (frame.type === 'console' && frame.correlationId !== undefined)
  )
}

export function attachServerLink(options: ServerLinkOptions): ServerLink {
  const { router, clock, log, store, matches, links } = options
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS_DEFAULT
  const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS
  const commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS_DEFAULT
  const wss = new WebSocketServer({ noServer: true })
  const sessions = new Map<string, Session>()
  const inflight = new Set<Promise<unknown>>()
  let closing = false

  const track = (promise: Promise<unknown>, what: string): void => {
    const tracked = promise
      .catch((error: unknown) => log.error(`link ${what} failed`, error))
      .finally(() => inflight.delete(tracked))
    inflight.add(tracked)
  }

  const createSession = (
    ws: WebSocket,
    row: ServerRow,
    ref: ServerRef,
    ackedAtHello: number,
    installed: readonly string[],
  ): Session => {
    const key = serverKey(ref)
    const matchId = row.matchId
    let ackedSeq = ackedAtHello
    /** Seqs above `ackedSeq` already taken — the gap a reordered batch leaves. */
    const window = new Set<number>()
    const pending = new Map<string, Pending>()
    let consoleTail: ConsoleTail | undefined
    let linkState = row.linkState
    let currentMap = row.currentMap
    let lastSeenWrittenAt = clock.now()
    let silence: Timer | undefined
    let gone = false
    let correlation = 0

    const write = (frame: OrchestratorFrame): void => {
      if (ws.readyState !== ws.OPEN) return
      ws.send(JSON.stringify(frame))
    }

    const onSilent = (): void => {
      const quiet = 2 * heartbeatIntervalMs
      log.warn(`link ${key}: silent for ${quiet} ms; probing and closing`)
      if (matchId) track(matches.suspect(matchId, `link silent for ${quiet} ms`), `${key} suspect`)
      ws.terminate()
    }
    const armSilence = (): void => {
      silence?.cancel()
      silence = clock.after(2 * heartbeatIntervalMs, onSilent)
    }

    const seen = (): void => {
      if (gone) return
      armSilence()
      if (clock.now() - lastSeenWrittenAt < LAST_SEEN_WRITE_INTERVAL_MS) return
      lastSeenWrittenAt = clock.now()
      track(store.updateServer(row.id, { lastSeenAt: clock.date() }), `${key} last_seen_at`)
    }

    const request = <T extends Answer['type']>(
      correlationId: string,
      frame: OrchestratorFrame,
      want: T,
    ): Promise<Extract<Answer, { type: T }>> =>
      new Promise((resolve, reject) => {
        if (ws.readyState !== ws.OPEN) {
          reject(new Error(`link ${key} is closed`))
          return
        }
        if (pending.has(correlationId)) {
          reject(new Error(`link ${key}: ${correlationId} is already in flight`))
          return
        }
        const timer = clock.after(commandTimeoutMs, () => {
          pending.delete(correlationId)
          reject(
            new Error(`link ${key}: no ${want} for ${correlationId} within ${commandTimeoutMs} ms`),
          )
        })
        pending.set(correlationId, {
          want,
          resolve: answer => resolve(answer as Extract<Answer, { type: T }>),
          reject,
          timer,
        })
        write(frame)
      })

    /** For the link's own requests (an announce, a console tail): unique within this session's pending map, which is all a correlation id has to be. */
    const mintCorrelationId = (): string => {
      correlation += 1
      return `link-${correlation}`
    }

    const rejected = (
      code: ChannelCommandResult['code'],
      message: string,
    ): ChannelCommandResult => ({ status: 'rejected', code, message })

    const channel: ServerChannel = {
      server: ref,
      async send(command) {
        const relayed = linkCommandSchema.safeParse(command)
        if (!relayed.success)
          return rejected('command_unsupported', `${command.type} never reaches a real server`)
        const result = await request(
          command.correlationId,
          { type: 'command', command: relayed.data },
          'command_result',
        )
        return {
          status: result.status,
          ...(result.code !== undefined && { code: result.code }),
          ...(result.message !== undefined && { message: result.message }),
          ...(result.output !== undefined && { output: result.output }),
        }
      },
      async announce(line) {
        const correlationId = mintCorrelationId()
        const result = await request(
          correlationId,
          { type: 'command', command: { type: 'announce', correlationId, text: line } },
          'command_result',
        )
        return result.status === 'applied'
      },
      release: reason => {
        write({ type: 'release', reason: reason.slice(0, 256) })
        return Promise.resolve()
      },
      drain: () => {
        write({ type: 'drain' })
        return Promise.resolve()
      },
      profile: player => {
        write({ type: 'profile', player })
        return Promise.resolve()
      },
      async playerCommand(command: PlayerCommandRelay): Promise<PlayerCommandOutcome> {
        const { type: _type, ...outcome } = await request(
          command.correlationId,
          { type: 'player_command', ...command },
          'player_command_result',
        )
        return outcome
      },
      async console(lines) {
        const correlationId = mintCorrelationId()
        const frame = await request(
          correlationId,
          {
            type: 'command',
            command: linkCommandSchema.parse({
              type: 'console',
              correlationId,
              ...(lines !== undefined && { lines }),
            }),
          },
          'console',
        )
        return cacheTail(frame)
      },
      consoleTail: () => consoleTail,
    }

    const cacheTail = (frame: Extract<ServerFrame, { type: 'console' }>): ConsoleTail => {
      consoleTail = { at: clock.date(), uptimeMs: frame.uptimeMs, lines: frame.lines }
      return consoleTail
    }

    const answer = (frame: ServerFrame): boolean => {
      if (!isAnswer(frame) || frame.correlationId === undefined) return false
      if (frame.type === 'console') cacheTail(frame)
      const waiting = pending.get(frame.correlationId)
      if (!waiting || waiting.want !== frame.type) return false
      pending.delete(frame.correlationId)
      waiting.timer.cancel()
      waiting.resolve(frame)
      return true
    }

    const noteState = async (state: ServerRow['linkState'], map: string | null): Promise<void> => {
      const patch: Parameters<MatchStore['updateServer']>[1] = {}
      if (state !== null && state !== linkState) {
        linkState = state
        patch.linkState = state
      }
      if (map !== null && map !== currentMap) {
        currentMap = map
        patch.currentMap = map
      }
      if (Object.keys(patch).length > 0) await store.updateServer(row.id, patch)
    }

    const ingestBatch = async (frame: Extract<ServerFrame, { type: 'events' }>) => {
      const results: OrchestratorFrameOf<'ack'>['results'] = []
      for (const { seq, event } of frame.events) {
        let status: LinkAckStatus
        let message: string | undefined
        if (seq <= ackedSeq || window.has(seq)) status = 'duplicate'
        else {
          if (event.matchId !== matchId) {
            status = 'rejected'
            message = matchId
              ? `names match ${event.matchId}; this server holds ${matchId}`
              : `names match ${event.matchId}; this server holds no match`
          } else status = await matches.ingest(ref, event)
          window.add(seq)
          while (window.has(ackedSeq + 1)) {
            ackedSeq += 1
            window.delete(ackedSeq)
          }
        }
        results.push({ seq, status, ...(message !== undefined && { message }) })
      }
      await store.updateServer(row.id, { linkAckedSeq: ackedSeq, lastSeenAt: clock.date() })
      lastSeenWrittenAt = clock.now()
      write({ type: 'ack', results })
    }

    const handle = async (frame: ServerFrame): Promise<void> => {
      switch (frame.type) {
        case 'hello':
          ws.close(LINK_CLOSE_CODES.malformed, 'hello twice')
          return
        case 'heartbeat':
          await noteState(frame.state, frame.map)
          await matches.touch(ref)
          return
        case 'state':
          log.info(`link ${key}: ${frame.state}${frame.detail ? ` (${frame.detail})` : ''}`)
          await noteState(frame.state, null)
          await matches.touch(ref)
          return
        case 'events':
          await ingestBatch(frame)
          return
        case 'backup':
          if (frame.matchId !== matchId) {
            log.warn(`link ${key}: a backup for ${frame.matchId}, which this server does not hold`)
            return
          }
          await store.upsertBackup(
            {
              id: randomUUID(),
              matchId: frame.matchId,
              fleetServerId: row.id,
              mapNumber: frame.backup.mapNumber,
              roundNumber: frame.backup.roundNumber,
              filename: frame.backup.filename,
              content: frame.backup.content,
              createdAt: clock.date(),
            },
            BACKUPS_KEPT_PER_MATCH,
          )
          return
        case 'console':
          cacheTail(frame)
          return
        case 'command_result':
        case 'player_command_result':
          log.warn(
            `link ${key}: a ${frame.type} for ${frame.correlationId}, which nobody is waiting for`,
          )
          return
        default:
          return
      }
    }

    const closed = (): void => {
      gone = true
      silence?.cancel()
      for (const waiting of pending.values()) {
        waiting.timer.cancel()
        waiting.reject(new Error(`link ${key} closed`))
      }
      pending.clear()
      if (sessions.get(key) === session) {
        sessions.delete(key)
        if (links.get(ref) === channel) links.detach(ref)
      }
      log.info(`link ${key}: closed`)
    }

    const session: Session = {
      ref,
      channel,
      installed,
      seen,
      answer,
      handle,
      write,
      replace: () => {
        log.info(`link ${key}: replaced by a newer socket`)
        ws.close(LINK_CLOSE_CODES.replaced, 'replaced by a newer socket')
      },
      closed,
      view: () => ({ server: ref, fleetServerId: row.id, matchId, ackedSeq, consoleTail }),
    }
    armSilence()
    return session
  }

  /** The row a token opens, or why it does not. */
  const resolveToken = async (
    token: string,
  ): Promise<{ row: ServerRow; token: ServerTokenRow } | string> => {
    if (!looksLikeToken('server', token)) return 'not a server token'
    const record = await store.findServerTokenByHash(hashToken(token))
    if (!record || record.revokedAt) return 'unknown or revoked token'
    const row = await store.findServer(record.fleetServerId)
    if (!row || row.releasedAt || !row.serverId) return 'no open server for this token'
    return { row, token: record }
  }

  const sendAssignment = async (
    session: Session,
    hello: { plugins: readonly string[]; matchId?: string },
  ): Promise<boolean> => {
    const assign = await matches.assignment(session.ref, hello)
    if (!assign) return false
    session.write(assign)
    return true
  }

  const greet = async (
    ws: WebSocket,
    hello: Extract<ServerFrame, { type: 'hello' }>,
  ): Promise<Session | undefined> => {
    const resolved = await resolveToken(hello.token)
    if (typeof resolved === 'string') {
      ws.close(LINK_CLOSE_CODES.unauthorized, resolved)
      return undefined
    }
    if (ws.readyState !== ws.OPEN) return undefined
    const { row, token } = resolved
    const ref: ServerRef = { provider: row.provider, serverId: row.serverId as string }
    const key = serverKey(ref)
    sessions.get(key)?.replace()
    // A plugin whose counter is behind ours started afresh (a reinstall, a
    // wiped buffer): its next events would all look like duplicates. Its
    // `lastSeq` is the truth about what it will send next.
    const ackedSeq = Math.min(row.linkAckedSeq, hello.lastSeq)
    const at = clock.date()
    await store.touchServerToken(token.id, at)
    await store.updateServer(row.id, {
      versions: hello.versions,
      hostname: hello.hostname,
      currentMap: hello.map,
      linkState: hello.state,
      linkAckedSeq: ackedSeq,
      lastSeenAt: at,
    })
    const session = createSession(
      ws,
      { ...row, linkAckedSeq: ackedSeq },
      ref,
      ackedSeq,
      hello.plugins,
    )
    sessions.set(key, session)
    links.attach(session.channel)
    session.write({
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      provider: ref.provider,
      serverId: ref.serverId,
      heartbeatIntervalMs,
      ackedSeq,
    })
    log.info(
      `link ${key}: hello from plugin ${hello.versions.plugin} on ${hello.map}, ${hello.state}` +
        `${hello.matchId ? `, holding ${hello.matchId}` : ''}, acked ${ackedSeq}`,
    )
    // The assignment, unless the server already holds the row's match.
    if (row.matchId && hello.matchId !== row.matchId)
      await sendAssignment(session, { plugins: hello.plugins, matchId: hello.matchId })
    else await matches.touch(ref)
    return session
  }

  const open = (ws: WebSocket): void => {
    let session: Session | undefined
    let chain: Promise<void> = Promise.resolve()
    const helloTimer = clock.after(helloTimeoutMs, () => {
      if (!session) ws.close(LINK_CLOSE_CODES.helloTimeout, `no hello within ${helloTimeoutMs} ms`)
    })
    const step = (run: () => Promise<void>): void => {
      chain = chain.then(run).catch((error: unknown) => {
        log.error('link frame failed', error)
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
      const parsed = serverFrameSchema.safeParse(raw)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        ws.close(
          LINK_CLOSE_CODES.malformed,
          `${issue?.path.join('.') || 'frame'}: ${issue?.message ?? 'invalid'}`.slice(0, 123),
        )
        return
      }
      const frame = parsed.data
      if (session) {
        session.seen()
        if (session.answer(frame)) return
        step(() => (session as Session).handle(frame))
        return
      }
      step(async () => {
        if (session) {
          session.seen()
          if (!session.answer(frame)) await session.handle(frame)
          return
        }
        if (frame.type !== 'hello') {
          ws.close(LINK_CLOSE_CODES.malformed, 'the first frame is hello')
          return
        }
        session = await greet(ws, frame)
        if (session) helloTimer.cancel()
      })
    })
    ws.on('close', () => {
      helloTimer.cancel()
      session?.closed()
    })
    ws.on('error', error => log.error('link socket', error))
  }

  router.route(SERVER_LINK_PATH, (request, socket, head) => {
    if (closing || options.isDraining?.()) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, open)
  })

  return {
    sessions: () => [...sessions.values()].map(session => session.view()),
    get: server => sessions.get(serverKey(server))?.view(),
    assign: async server => {
      const session = sessions.get(serverKey(server))
      if (!session) return false
      const row = await store.findServer(session.view().fleetServerId)
      if (!row?.matchId) return false
      return sendAssignment(session, { plugins: session.installed })
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
