import { z } from 'zod'
import { assertClosedSet } from '../closed-set'
import { matchCommandResultSchema } from '../resources/commands'
import { matchIdSchema } from '../resources/common'
import { matchStateSchema } from '../resources/match'
import { gameserverPlayerSchema, positionTickEventSchema } from '../vocabulary/gameserver'
import { webhookEnvelopeSchema } from '../webhooks/envelope'

/**
 * **The stream** (decision 6): `GET /v1/matches/:matchId/stream`, a WebSocket
 * upgrade, one socket per match per subscriber, the orchestrator speaking and
 * the subscriber listening. It carries what a webhook cannot — position
 * ticks, which are never stored — and mirrors what a webhook also carries,
 * so a live page needs exactly one socket and no polling.
 *
 * The contract is *best effort* on purpose: a frame the subscriber missed
 * (a reconnect, a slow consumer the orchestrator dropped) is gone from the
 * stream. That costs nothing, because every durable fact is also a webhook
 * and is replayable from the events route: the first frame of every socket
 * is a `hello` with the match's current `seq`, so a subscriber that
 * reconnects compares it with the last `seq` it holds and replays the gap
 * through `GET /v1/matches/:matchId/events?cursor=`. The stream never
 * replays.
 *
 * Every frame is one JSON text message with a `type` from a closed set. The
 * subscriber sends nothing; player-scoped commands travel on the widget's
 * own socket (decision 17, PRD-02), never on this one.
 */

/**
 * The first frame of every socket. `seq` is the last durable sequence number
 * at subscribe time (`Match.seq`); `state` is where the match is, so a page
 * that connects to an ended match learns it before waiting for a frame that
 * will not come.
 */
export const streamHelloFrameSchema = z.object({
  type: z.literal('hello'),
  matchId: matchIdSchema,
  seq: z.number().int().nonnegative(),
  state: matchStateSchema,
})
export type StreamHelloFrame = z.infer<typeof streamHelloFrameSchema>

/**
 * A durable fact, as it goes out by webhook — the same envelope, `seq` and
 * `deliveryId` included, so one deduper serves both paths.
 */
export const streamEventFrameSchema = z.object({
  type: z.literal('event'),
  envelope: webhookEnvelopeSchema,
})
export type StreamEventFrame = z.infer<typeof streamEventFrameSchema>

/** How many position ticks one `tick` frame may batch. */
export const STREAM_TICK_BATCH_MAX = 64

/**
 * The ephemeral tier: `position_tick` events, batched. Never stored, never
 * replayed, never in a webhook; missing one costs a stale minimap frame.
 */
export const streamTickFrameSchema = z.object({
  type: z.literal('tick'),
  ticks: z.array(positionTickEventSchema).min(1).max(STREAM_TICK_BATCH_MAX),
})
export type StreamTickFrame = z.infer<typeof streamTickFrameSchema>

/**
 * The late answer to a command the route acknowledged with `accepted`: the
 * same `correlationId`, now `applied` or `rejected`. A subscriber that did
 * not send the command sees it too — a live page learns of a pause the
 * admin console requested.
 */
export const streamCommandResultFrameSchema = z.object({
  type: z.literal('command_result'),
  result: matchCommandResultSchema,
})
export type StreamCommandResultFrame = z.infer<typeof streamCommandResultFrameSchema>

/**
 * Who is on the server right now, whole, every time it changes — a snapshot,
 * not a delta, so a subscriber never has to reconcile. `players` includes
 * spectators (`team: 'spec'`); the roster is the client's own knowledge.
 */
export const streamPresenceFrameSchema = z.object({
  type: z.literal('presence'),
  players: z.array(gameserverPlayerSchema),
})
export type StreamPresenceFrame = z.infer<typeof streamPresenceFrameSchema>

export const streamFrameSchema = z.discriminatedUnion('type', [
  streamHelloFrameSchema,
  streamEventFrameSchema,
  streamTickFrameSchema,
  streamCommandResultFrameSchema,
  streamPresenceFrameSchema,
])
export type StreamFrame = z.infer<typeof streamFrameSchema>

/** Every frame type, in the union's order. */
export const STREAM_FRAME_TYPES = ['hello', 'event', 'tick', 'command_result', 'presence'] as const
export type StreamFrameType = (typeof STREAM_FRAME_TYPES)[number]

/** The frame for one `type` — `StreamFrameOf<'tick'>` etc. */
export type StreamFrameOf<T extends StreamFrameType> = Extract<StreamFrame, { type: T }>

assertClosedSet('stream frames', streamFrameSchema, 'type', STREAM_FRAME_TYPES)

/**
 * The query the upgrade accepts. A server-side subscriber sends the API key
 * as `Authorization: Bearer` like every other route; a browser cannot set a
 * header on a WebSocket, so it passes a **player token** minted for this
 * match (`POST /v1/matches/:matchId/player-tokens`) as `?token=` instead —
 * scoped to the match, short-lived, and only ever handed to the page by the
 * client that minted it. One of the two is required.
 */
export const streamQuerySchema = z.object({
  token: z.string().min(16).optional(),
})
export type StreamQuery = z.infer<typeof streamQuerySchema>

/**
 * Why the orchestrator closed a socket, as WebSocket close codes in the
 * application range. A subscriber reconnects on `1006` (the network) and on
 * nothing here: each of these is a decision, not a hiccup.
 */
export const STREAM_CLOSE_CODES = Object.freeze({
  /** The match reached a terminal state; the `event` frame with its `match.ended` or `match.failed` came first. */
  matchEnded: 4000,
  /** No key, no token, or one that does not verify. */
  unauthorized: 4001,
  /** The key lacks `matches`, the token is for another match, or the origin is not in `streamAllowedOrigins`. */
  forbidden: 4003,
  /** No such match for this key. */
  notFound: 4004,
  /** The subscriber fell too far behind and its frames were dropped; reconnect and replay from the events route. */
  slowConsumer: 4008,
})
export type StreamCloseCode = (typeof STREAM_CLOSE_CODES)[keyof typeof STREAM_CLOSE_CODES]
