import { createServer, type Server, type Socket } from 'node:net'
import {
  decodeRconPackets,
  encodeRconPacket,
  RCON_AUTH,
  RCON_AUTH_FAILED_ID,
  RCON_AUTH_RESPONSE,
  RCON_EXECCOMMAND,
  RCON_RESPONSE_VALUE,
  type RconPacket,
} from './protocol'

/**
 * **A Source RCON server, in this process** (PRD-02 T20). The client above is
 * framing and deadlines; the only way to know the framing is right is to make
 * something else read it. This is that something: a real TCP listener speaking
 * the real protocol, with the faults a venue box produces — a wrong password,
 * a server that accepts the connection and then says nothing, one that hangs
 * up mid-answer, and an answer far longer than the classic 4 KiB packet.
 *
 * It answers **in CS2's order**, measured on the dev container (PRD-07 T9a,
 * CS2 1.41.8.2): every command gets exactly one `RESPONSE_VALUE`, empty when
 * it printed nothing and never split (`cvarlist` came back as one 647 KB
 * packet), and that packet carries the id of the **newest packet the server
 * had read** when its frame ran the command, not the command's own. A command
 * and an end marker that arrive together therefore come back as the answer
 * and the marker's echo, both with the marker's id. The echo's body is
 * `00 01 00 00`. {@link answerRconFrame} is that behaviour once, for the TCP
 * listener here and for a test's socket double that wants a frame per tick.
 *
 * Test-only, but it lives in `src/` beside the client for the same reason the
 * fake Dathost does: the thing it fakes and the thing that fakes it are read
 * together, and it never leaves the process.
 */
export interface FakeRconOptions {
  password: string
  /** What each command prints. An unknown command prints the engine's own line. */
  commands?: Record<string, string>
}

export interface FakeRconFaults {
  /** Accept the socket and answer nothing at all. */
  silent?: boolean
  /** Hang up as soon as a command has been answered. */
  hangUp?: boolean
  /** Answer with bytes that are not a packet. */
  garbage?: boolean
}

export interface FakeRcon {
  /** The port the listener took; `0` until {@link listen} resolves. */
  readonly port: number
  listen: () => Promise<number>
  close: () => Promise<void>
  setFaults: (faults: FakeRconFaults) => void
  /** Take the password a caller minted after the fact — what a container does with its environment. */
  setPassword: (password: string) => void
  /** Every command the server was asked to run, in order. */
  readonly seen: readonly string[]
}

/** Longer than the 4 KiB packet a classic Source server splits at; CS2 sends it whole. */
export const FAKE_RCON_LONG_ANSWER = 'x'.repeat(5000)

/** What CS2 answers an empty `RESPONSE_VALUE` with. */
export const CS2_RCON_MARKER_ECHO = '\u0000\u0001\u0000\u0000'

/** One connection's memory between frames. */
export interface RconSession {
  authenticated: boolean
}

/**
 * Everything one server frame says to the packets it read in that frame,
 * in CS2's order (see the file's comment). `run` is the console: it receives
 * a command and returns what it printed.
 */
export function answerRconFrame(
  session: RconSession,
  packets: readonly RconPacket[],
  password: string,
  run: (command: string) => string,
): Buffer[] {
  const newest = packets.at(-1)?.id ?? 0
  const out: Buffer[] = []
  for (const packet of packets) {
    if (packet.type === RCON_AUTH) {
      session.authenticated = packet.body === password
      out.push(
        encodeRconPacket({
          id: session.authenticated ? packet.id : RCON_AUTH_FAILED_ID,
          type: RCON_AUTH_RESPONSE,
          body: '',
        }),
      )
      continue
    }
    if (packet.type === RCON_EXECCOMMAND) {
      if (!session.authenticated) {
        out.push(encodeRconPacket({ id: RCON_AUTH_FAILED_ID, type: RCON_RESPONSE_VALUE, body: '' }))
        continue
      }
      out.push(encodeRconPacket({ id: newest, type: RCON_RESPONSE_VALUE, body: run(packet.body) }))
      continue
    }
    // An empty value packet: the end marker, echoed with CS2's four bytes.
    out.push(
      encodeRconPacket({ id: packet.id, type: RCON_RESPONSE_VALUE, body: CS2_RCON_MARKER_ECHO }),
    )
  }
  return out
}

export function createFakeRcon(options: FakeRconOptions): FakeRcon {
  const commands = options.commands ?? {}
  const seen: string[] = []
  let password = options.password
  let faults: FakeRconFaults = {}
  let port = 0

  const run = (command: string): string => {
    seen.push(command)
    return commands[command] ?? `Unknown command '${command}'!\n`
  }

  const onConnection = (socket: Socket): void => {
    let buffered: Buffer = Buffer.alloc(0)
    const session: RconSession = { authenticated: false }
    socket.on('error', () => undefined)
    // A chunk is a frame: what arrived together is read together.
    socket.on('data', chunk => {
      if (faults.silent) return
      if (faults.garbage) {
        socket.write(Buffer.from([0xff, 0xff, 0xff, 0x7f, 1, 2, 3, 4]))
        return
      }
      buffered = Buffer.concat([buffered, chunk])
      const { packets, rest } = decodeRconPackets(buffered)
      buffered = rest
      for (const bytes of answerRconFrame(session, packets, password, run)) socket.write(bytes)
      if (faults.hangUp && packets.some(packet => packet.type === RCON_EXECCOMMAND))
        socket.destroy()
    })
  }

  let server: Server | undefined
  return {
    get port() {
      return port
    },
    get seen() {
      return seen
    },
    setFaults: next => {
      faults = next
    },
    setPassword: next => {
      password = next
    },
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server = createServer(onConnection)
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          const address = server?.address()
          if (address === null || address === undefined || typeof address === 'string') {
            reject(new Error('the fake RCON server did not take a port'))
            return
          }
          port = address.port
          resolve(port)
        })
      }),
    close: () =>
      new Promise<void>(resolve => {
        if (!server) {
          resolve()
          return
        }
        server.close(() => resolve())
        server = undefined
      }),
  }
}
