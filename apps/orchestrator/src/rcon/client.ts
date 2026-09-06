import { createConnection, type Socket } from 'node:net'
import type { Clock } from '@ezpug/core'
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
 * **The operator's last door** (decision 5, PRD-02 T20). A server's whole
 * relationship with this process is the outbound link it dials; RCON exists
 * for the minutes *before* that link is up — a container that booted but
 * whose plugin has not spoken, a box an operator wants to look at while the
 * orchestrator still thinks it is `starting`. It is therefore the fallback
 * **behind** a provider's `rcon` verb, never a second control plane: the
 * Dathost provider answers that verb over the vendor's console, and the node
 * provider answers it here, because a container on a venue box has an address
 * and a password this process minted and nothing else.
 *
 * One connection per command. RCON has no session an operator's occasional
 * line would amortise, and a socket we do not hold is a socket that cannot
 * leak; a CS2 server drops idle RCON connections anyway.
 *
 * Every deadline is on the injected clock — connect, authenticate, answer —
 * so a test that wants to watch one expire advances time rather than waits.
 */

/** Why an RCON call did not produce output. The fleet maps these to the contract's codes. */
export type RconFailure = 'unreachable' | 'auth_failed' | 'timeout' | 'protocol'

export class RconError extends Error {
  readonly failure: RconFailure
  constructor(failure: RconFailure, message: string) {
    super(message)
    this.name = 'RconError'
    this.failure = failure
  }
}

/** Where to knock and what to say. The password lives in the caller's memory and nowhere else. */
export interface RconTarget {
  host: string
  port: number
  password: string
}

/** What a socket has to do for this client — `node:net` by default, a test double otherwise. */
export interface RconSocketPort {
  write: (bytes: Buffer) => void
  destroy: () => void
  onData: (fn: (chunk: Buffer) => void) => void
  onClose: (fn: (error?: Error) => void) => void
}

export interface RconClientOptions {
  clock: Clock
  /** How long a TCP connect may take. */
  connectTimeoutMs?: number
  /** How long the password and then the command may take to be answered. */
  commandTimeoutMs?: number
  /** Injected in tests that do not want a real socket; production opens one. */
  connect?: (host: string, port: number) => Promise<RconSocketPort>
}

export const RCON_CONNECT_TIMEOUT_MS = 5_000
export const RCON_COMMAND_TIMEOUT_MS = 10_000

export interface RconClient {
  /** Run one command and resolve with what the server printed. Throws {@link RconError} and nothing else. */
  exec: (target: RconTarget, command: string) => Promise<string>
}

/** The ids we use, in the order the exchange uses them. */
const AUTH_ID = 1
const COMMAND_ID = 2
/**
 * The end marker. A Source server answers an unknown `RESPONSE_VALUE` sent
 * *after* a command, and does so *after* every chunk of that command's
 * output — which is how a multi-packet answer is known to be complete
 * without guessing at a quiet period.
 */
const SENTINEL_ID = 3

/** How many pre-verdict `RESPONSE_VALUE` packets to sit through before giving up. */
const AUTH_NOISE_MAX = 4

function openSocket(host: string, port: number): Promise<RconSocketPort> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection({ host, port })
    socket.setNoDelay(true)
    const fail = (error: Error): void => {
      socket.destroy()
      reject(
        new RconError(
          'unreachable',
          `rcon: ${host}:${port} refused a connection: ${error.message}`,
        ),
      )
    }
    socket.once('error', fail)
    socket.once('connect', () => {
      socket.off('error', fail)
      resolve({
        write: bytes => void socket.write(bytes),
        destroy: () => socket.destroy(),
        onData: fn => void socket.on('data', fn),
        // `error` and `close` both end the conversation; `close` always follows.
        onClose: fn => {
          let last: Error | undefined
          socket.on('error', error => {
            last = error
          })
          socket.on('close', () => fn(last))
        },
      })
    })
  })
}

export function createRconClient(options: RconClientOptions): RconClient {
  const { clock } = options
  const connectTimeoutMs = options.connectTimeoutMs ?? RCON_CONNECT_TIMEOUT_MS
  const commandTimeoutMs = options.commandTimeoutMs ?? RCON_COMMAND_TIMEOUT_MS
  const connect = options.connect ?? openSocket

  /** Reject `promise` when the clock passes `ms` — the only deadline shape in here. */
  const within = async <T>(ms: number, what: string, promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<Clock['after']> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = clock.after(ms, () =>
        reject(new RconError('timeout', `rcon: ${what} did not finish inside ${ms} ms`)),
      )
    })
    try {
      return await Promise.race([promise, deadline])
    } finally {
      timer?.cancel()
    }
  }

  return {
    async exec(target, command) {
      const socket = await within(
        connectTimeoutMs,
        `connecting to ${target.host}:${target.port}`,
        connect(target.host, target.port),
      )
      try {
        // One reader for the whole exchange: packets arrive in order and each
        // stage takes the ones it recognises, so nothing is read twice.
        let buffered: Buffer = Buffer.alloc(0)
        let waiting: ((packet: RconPacket) => void) | undefined
        const queued: RconPacket[] = []
        let closed: RconError | undefined
        let failReader: ((error: RconError) => void) | undefined

        const deliver = (packet: RconPacket): void => {
          if (waiting) {
            const fn = waiting
            waiting = undefined
            fn(packet)
          } else queued.push(packet)
        }
        socket.onData(chunk => {
          buffered = Buffer.concat([buffered, chunk])
          try {
            const read = decodeRconPackets(buffered)
            buffered = read.rest
            for (const packet of read.packets) deliver(packet)
          } catch (error) {
            const failure = new RconError(
              'protocol',
              `rcon: ${target.host}:${target.port} is not speaking RCON (${error instanceof Error ? error.message : String(error)})`,
            )
            closed = failure
            failReader?.(failure)
          }
        })
        socket.onClose(() => {
          const failure =
            closed ?? new RconError('unreachable', `rcon: ${target.host}:${target.port} hung up`)
          closed = failure
          failReader?.(failure)
        })

        const next = (): Promise<RconPacket> => {
          const ready = queued.shift()
          if (ready) return Promise.resolve(ready)
          if (closed) return Promise.reject(closed)
          return new Promise<RconPacket>((resolve, reject) => {
            waiting = resolve
            failReader = reject
          })
        }

        socket.write(encodeRconPacket({ id: AUTH_ID, type: RCON_AUTH, body: target.password }))
        // Some builds send an empty `RESPONSE_VALUE` before the verdict; it is
        // noise. Bounded, because a peer that only ever sends noise should be
        // called out rather than listened to until the deadline, forever.
        let verdict = await within(commandTimeoutMs, 'authentication', next())
        for (let skipped = 0; verdict.type === RCON_RESPONSE_VALUE; skipped += 1) {
          if (skipped >= AUTH_NOISE_MAX)
            throw new RconError('protocol', 'rcon: the server never answered the password')
          verdict = await within(commandTimeoutMs, 'authentication', next())
        }
        if (verdict.type !== RCON_AUTH_RESPONSE)
          throw new RconError(
            'protocol',
            `rcon: expected an auth response, got type ${verdict.type}`,
          )
        if (verdict.id === RCON_AUTH_FAILED_ID)
          throw new RconError('auth_failed', 'rcon: the server refused the password')

        socket.write(encodeRconPacket({ id: COMMAND_ID, type: RCON_EXECCOMMAND, body: command }))
        socket.write(encodeRconPacket({ id: SENTINEL_ID, type: RCON_RESPONSE_VALUE, body: '' }))

        let output = ''
        for (;;) {
          let packet: RconPacket
          try {
            packet = await within(
              commandTimeoutMs,
              `the answer to ${command.split(' ')[0]}`,
              next(),
            )
          } catch (error) {
            // A server that answered and then went quiet has said what it had
            // to say; only silence from the start is a failure worth raising.
            if (output !== '' && error instanceof RconError && error.failure !== 'protocol') break
            throw error
          }
          if (packet.id === SENTINEL_ID) break
          if (packet.id === RCON_AUTH_FAILED_ID)
            throw new RconError('auth_failed', 'rcon: the server dropped the session')
          if (packet.id === COMMAND_ID) output += packet.body
        }
        return output
      } finally {
        socket.destroy()
      }
    },
  }
}
