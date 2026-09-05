import { matchApiRoutes } from '../routes'
import { type StreamFrame, streamFrameSchema } from '../stream/frames'

/**
 * **The stream, subscribed to.** `GET /v1/matches/:matchId/stream` is an
 * upgrade, so it is not a call on the typed client; it is this: open one
 * socket, get every frame parsed against `streamFrameSchema`, and a promise
 * that resolves with the close code whoever closed it.
 *
 * Authentication follows what the caller can do. A server sends the API key
 * as `Authorization: Bearer`, which needs a WebSocket implementation that
 * accepts headers (`ws` on Node — pass it as `WebSocket`). A browser cannot
 * set a header on a socket and passes a **player token** minted for the match
 * as `?token=` instead, which the platform's live page does with the token it
 * minted for that person.
 *
 * The stream is best effort by contract: a frame that never arrived is
 * fetched from `GET /v1/matches/:matchId/events`, never waited for here. So
 * this helper does not reconnect and does not buffer — it hands the caller
 * the close code (`STREAM_CLOSE_CODES`) and lets the caller decide, because
 * only the caller knows whether it still cares about the match.
 */

/** A close, as a subscriber learns of it. `code` is a `STREAM_CLOSE_CODE` or a WebSocket one (`1000`, `1006`). */
export interface StreamClosed {
  code: number
  reason: string
}

/**
 * The bits of a WebSocket event this helper reads — `type` is what every
 * implementation agrees on, the rest is per event kind. Structural on
 * purpose: `ws`, Node's global `WebSocket` and a browser's all satisfy it,
 * and none of them is imported here.
 */
export interface StreamSocketEvent {
  type: string
  data?: unknown
  code?: number
  reason?: string
  error?: unknown
  message?: string
}

/** The socket surface used: listen, and close. */
export interface StreamSocketLike {
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: StreamSocketEvent) => void): void
}

/**
 * A WebSocket constructor. The third argument is `ws`'s options bag, where an
 * `Authorization` header can go; implementations that follow the browser
 * standard ignore it, which is why a browser needs `?token=`.
 */
export type StreamWebSocketConstructor = new (
  url: string,
  protocols?: string[],
  options?: { headers?: Record<string, string> },
) => StreamSocketLike

export interface StreamSubscription {
  /** Where the socket went. */
  readonly url: string
  /** Resolves once the socket is closed, however it closed. Never rejects. */
  readonly closed: Promise<StreamClosed>
  /** Close from this side (`1000`); `closed` resolves with what the socket reports. */
  close: () => void
}

export interface SubscribeStreamOptions {
  matchId: string
  /** Every frame, parsed. A frame that does not parse goes to `onError` and is dropped. */
  onFrame: (frame: StreamFrame) => void
  /**
   * A player token from `POST /v1/matches/:matchId/player-tokens`. With it the
   * socket authenticates by query string and the API key is not sent — the
   * only form a browser can use.
   */
  token?: string
  onOpen?: () => void
  onClose?: (closed: StreamClosed) => void
  /** A socket error, or a frame that did not parse. The socket is not closed for a bad frame. */
  onError?: (error: unknown) => void
  /** Default `globalThis.WebSocket`. Pass `ws` on Node to authenticate with the API key. */
  WebSocket?: StreamWebSocketConstructor
}

/** What `subscribeStream` needs beyond the subscription itself — the client fills these in. */
export interface StreamEndpoint {
  /** The orchestrator's origin, `http(s)` or `ws(s)`, no trailing slash. */
  baseUrl: string
  /** Sent as `Authorization: Bearer` when no `token` is given. */
  apiKey?: string
}

/** The socket URL for a match: the route table's path, `ws(s)`, `?token=` when there is one. */
export function streamUrl(baseUrl: string, matchId: string, token?: string): string {
  const path = matchApiRoutes.matches.stream.path.replace(':matchId', encodeURIComponent(matchId))
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`)
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:'
  if (token !== undefined) url.searchParams.set('token', token)
  return url.href
}

function frameText(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as Uint8Array)
  return String(data)
}

/**
 * Open one socket for one match. Returns immediately; frames arrive on
 * `onFrame`, the first of them a `hello` carrying the `seq` to replay from.
 */
export function subscribeStream(
  options: SubscribeStreamOptions & StreamEndpoint,
): StreamSubscription {
  if (options.token === undefined && options.apiKey === undefined)
    throw new Error(
      'subscribeStream: a socket needs the API key or a player token (`token`), and this one has neither',
    )
  const Ctor =
    options.WebSocket ?? (globalThis.WebSocket as unknown as StreamWebSocketConstructor | undefined)
  if (!Ctor)
    throw new Error(
      'subscribeStream: no WebSocket implementation — pass `WebSocket` (the `ws` package on Node)',
    )

  const url = streamUrl(options.baseUrl, options.matchId, options.token)
  const headers =
    options.token === undefined && options.apiKey !== undefined
      ? { authorization: `Bearer ${options.apiKey}` }
      : undefined
  const socket = new Ctor(url, [], headers ? { headers } : undefined)

  let resolveClosed: (closed: StreamClosed) => void = () => {}
  const closed = new Promise<StreamClosed>(resolve => {
    resolveClosed = resolve
  })

  socket.addEventListener('open', () => options.onOpen?.())
  socket.addEventListener('message', event => {
    let frame: StreamFrame
    try {
      frame = streamFrameSchema.parse(JSON.parse(frameText(event.data)))
    } catch (error) {
      options.onError?.(error)
      return
    }
    options.onFrame(frame)
  })
  socket.addEventListener('error', event => {
    options.onError?.(event.error ?? new Error(event.message ?? 'stream socket error'))
  })
  socket.addEventListener('close', event => {
    const result: StreamClosed = { code: event.code ?? 1006, reason: event.reason ?? '' }
    options.onClose?.(result)
    resolveClosed(result)
  })

  return {
    url,
    closed,
    close: () => socket.close(1000, 'done'),
  }
}
