import { type Clock, systemClock } from '@ezpug/core'
import { matchApiRoutes } from '../routes'
import {
  type ApiClient,
  type ClientRequest,
  createClient,
  IDEMPOTENCY_KEY_HEADER,
  type RouteDef,
} from '../rpc'
import { createRetryingFetch, type RetryPolicy } from './retry'
import {
  type StreamSubscription,
  type StreamWebSocketConstructor,
  type SubscribeStreamOptions,
  subscribeStream,
} from './stream'

/**
 * **The typed client**, generated from the route table:
 * `client.matches.create({ body })`, `client.fleet.nodes.enrol({ body })`,
 * every call validated against its route's schemas on the way out and on the
 * way back, every non-2xx an `ApiError` carrying the code from the error
 * envelope. A hand-written fetch against a Match API route is a review
 * reject; this is generated from the same declarations the orchestrator
 * serves, so the two cannot disagree about a path, a method or a shape.
 *
 * On top of the table it does the three things every caller would otherwise
 * write again:
 *
 * - **An idempotency key on the calls that have one.** A create carries
 *   `clientMatchId`, a command carries `correlationId`; either becomes the
 *   `Idempotency-Key` header ({@link idempotencyKeyFor}), so the orchestrator
 *   can answer a repeat with the first answer instead of doing the thing
 *   twice.
 * - **Retries with backoff** for `429` and `5xx`, and for a connection that
 *   produced no answer at all — only for a `GET` or a request that carries
 *   that key (`./retry`, the published policy). Every wait sleeps on the
 *   injected clock; nothing here reads `Date.now()`, so a test drives a whole
 *   retry storm in microseconds.
 * - **The stream**, which is an upgrade and therefore not a call:
 *   `client.subscribeStream({ matchId, onFrame })` (`./stream`).
 */

/** The body fields that are an idempotency key, in the order they are looked for. */
export const IDEMPOTENCY_BODY_FIELDS = ['clientMatchId', 'correlationId'] as const

/**
 * The `Idempotency-Key` for one call, or undefined when the body names none —
 * the route's dotted key and the body's own key, so a create and a command
 * that happen to share a string are still two different requests. Minting a
 * player token and creating an API key name none: they make a new secret
 * every time, and repeating one is the caller's decision, not the client's.
 */
export function idempotencyKeyFor(request: ClientRequest): string | undefined {
  const body: unknown = request.input.body
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  for (const field of IDEMPOTENCY_BODY_FIELDS) {
    const value = record[field]
    if (typeof value === 'string' && value.length > 0) return `${request.key}:${value}`
  }
  return undefined
}

export interface MatchApiClientOptions {
  /** The orchestrator's origin, no trailing slash. */
  baseUrl: string
  /** The API key, sent as `Authorization: Bearer`. */
  apiKey: string
  /** Injectable for tests and servers; defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch
  /** Where the retry waits happen. Defaults to the system clock. */
  clock?: Clock
  /** The published policy by default; `false` attempts every request once. */
  retry?: RetryPolicy | false
  /** What `subscribeStream` opens sockets with. Defaults to `globalThis.WebSocket`. */
  WebSocket?: StreamWebSocketConstructor
  /** Override the idempotency key per call; return undefined to send none. */
  idempotencyKey?: (request: ClientRequest) => string | undefined
}

export type MatchApiClient = ApiClient<typeof matchApiRoutes> & {
  /**
   * Open the match's stream. Returns a handle with `closed` and `close()`;
   * the API key travels as a header, so pass `WebSocket` from `ws` on Node —
   * or hand a browser a player token and let it subscribe with that.
   */
  readonly subscribeStream: (options: SubscribeStreamOptions) => StreamSubscription
}

export function createMatchApiClient(options: MatchApiClientOptions): MatchApiClient {
  const clock = options.clock ?? systemClock
  const keyFor = options.idempotencyKey ?? idempotencyKeyFor
  const fetchImpl =
    options.retry === false
      ? (options.fetch ?? globalThis.fetch)
      : createRetryingFetch({ ...options.retry, clock, fetch: options.fetch })

  const client = createClient(matchApiRoutes, {
    baseUrl: options.baseUrl,
    fetch: fetchImpl,
    headers: request => {
      const headers: Record<string, string> = { authorization: `Bearer ${options.apiKey}` }
      const idempotencyKey = isUnsafe(request.route) ? keyFor(request) : undefined
      if (idempotencyKey !== undefined) headers[IDEMPOTENCY_KEY_HEADER] = idempotencyKey
      return headers
    },
  })

  return Object.assign(client, {
    subscribeStream: (subscription: SubscribeStreamOptions): StreamSubscription =>
      subscribeStream({
        WebSocket: options.WebSocket,
        ...subscription,
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
      }),
  })
}

/** A method that changes something — the only kind an idempotency key is about. */
function isUnsafe(route: RouteDef): boolean {
  return route.method !== 'get'
}

export { ApiError } from '../errors'
export type { ApiClient, ClientOptions, ClientRequest } from '../rpc'
export { IDEMPOTENCY_KEY_HEADER } from '../rpc'
export * from './retry'
export * from './stream'
