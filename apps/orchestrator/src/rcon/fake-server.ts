import { createServer, type Server, type Socket } from 'node:net'
import {
  decodeRconPackets,
  encodeRconPacket,
  RCON_AUTH,
  RCON_AUTH_FAILED_ID,
  RCON_AUTH_RESPONSE,
  RCON_EXECCOMMAND,
  RCON_RESPONSE_VALUE,
} from './protocol'

/**
 * **A Source RCON server, in this process** (PRD-02 T20). The client above is
 * framing and deadlines; the only way to know the framing is right is to make
 * something else read it. This is that something: a real TCP listener speaking
 * the real protocol, with the faults a venue box produces — a wrong password,
 * a server that accepts the connection and then says nothing, one that hangs
 * up mid-answer, and an answer long enough to arrive in several packets.
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
  /** Hang up as soon as a command arrives, after the first chunk. */
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

/** A body long enough that the client must stitch two packets together. */
export const FAKE_RCON_LONG_ANSWER = 'x'.repeat(5000)

export function createFakeRcon(options: FakeRconOptions): FakeRcon {
  const commands = options.commands ?? {}
  const seen: string[] = []
  let password = options.password
  let faults: FakeRconFaults = {}
  let port = 0

  const onConnection = (socket: Socket): void => {
    let buffered: Buffer = Buffer.alloc(0)
    let authenticated = false
    socket.on('error', () => undefined)
    socket.on('data', chunk => {
      if (faults.silent) return
      if (faults.garbage) {
        socket.write(Buffer.from([0xff, 0xff, 0xff, 0x7f, 1, 2, 3, 4]))
        return
      }
      buffered = Buffer.concat([buffered, chunk])
      const { packets, rest } = decodeRconPackets(buffered)
      buffered = rest
      for (const packet of packets) {
        if (packet.type === RCON_AUTH) {
          authenticated = packet.body === password
          // The engine sends an empty value packet before the verdict.
          socket.write(encodeRconPacket({ id: packet.id, type: RCON_RESPONSE_VALUE, body: '' }))
          socket.write(
            encodeRconPacket({
              id: authenticated ? packet.id : RCON_AUTH_FAILED_ID,
              type: RCON_AUTH_RESPONSE,
              body: '',
            }),
          )
          continue
        }
        if (packet.type === RCON_EXECCOMMAND) {
          if (!authenticated) {
            socket.write(
              encodeRconPacket({ id: RCON_AUTH_FAILED_ID, type: RCON_RESPONSE_VALUE, body: '' }),
            )
            continue
          }
          seen.push(packet.body)
          const answer = commands[packet.body] ?? `Unknown command "${packet.body}"`
          // Split at the engine's own 4 KiB ceiling, exactly as a real server does.
          for (let at = 0; at < Math.max(answer.length, 1); at += 4000)
            socket.write(
              encodeRconPacket({
                id: packet.id,
                type: RCON_RESPONSE_VALUE,
                body: answer.slice(at, at + 4000),
              }),
            )
          if (faults.hangUp) socket.destroy()
          continue
        }
        // The end marker: bounced back, which is what tells the client it is done.
        socket.write(encodeRconPacket({ id: packet.id, type: RCON_RESPONSE_VALUE, body: '' }))
      }
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
