import { z } from 'zod'
import { assertClosedSet } from '../closed-set'
import { matchIdSchema } from '../resources/common'
import { playerCommandNameSchema, playerCommandSpecSchema } from '../resources/gamemode'
import { matchStateSchema } from '../resources/match'
import { localeSchema } from '../vocabulary/locale'
import { snakeNameSchema } from '../vocabulary/naming'
import { steamId64Schema } from '../vocabulary/steam-id'
import { webhookEnvelopeSchema } from '../webhooks/envelope'

/**
 * **The widget socket** (decision 17, PRD-02 T24): `GET /v1/widget`, a
 * WebSocket upgrade a gamemode's widget opens with the player token the host
 * injected. Where the stream (`stream/frames.ts`) is the orchestrator
 * speaking and a page listening, this socket goes both ways: the widget says
 * `hello` with its token and sends `command` frames — taps, scoped to the one
 * match and the one SteamID64 the token was minted for — and the orchestrator
 * answers each with a `command_result` after relaying it to the plugin as a
 * `player_command`, whose SDK enforces the manifest's cooldowns and charges
 * before the mode sees it. Gameplay traffic never touches the platform.
 *
 * The token travels **in the first frame**, never in the URL: a query string
 * would put it into the orchestrator's request log and a fragment into the
 * browser's history. The `hello` back carries the mode's declared commands
 * with what the orchestrator last learned about their cooldown and charges
 * for this player, and after it every durable fact of the match arrives as
 * an `event` frame — the same envelope the webhook carries — so a widget can
 * follow a death or a round without a second socket. The position-tick
 * firehose never crosses it: a phone is not a spectator client. What can
 * cross is a {@link widgetPushFrameSchema} — one moment a mode chose to give
 * one player, ephemeral, never stored, never replayed — which is how
 * `powerup-dm`'s `radar_peek` puts five seconds of enemy positions on the
 * phone that asked for them (PRD-02 T26).
 *
 * Rate limits are per token ({@link WIDGET_COMMAND_RATE_LIMIT}); a token
 * dies with the match (close `4000`, the way the stream ends) or at its
 * `expiresAt`, whichever comes first.
 */

/** The path of the upgrade. */
export const WIDGET_SOCKET_PATH = '/v1/widget'

/** The version of this socket's frames; a widget and an orchestrator on different majors do not talk. */
export const WIDGET_SOCKET_PROTOCOL = 1

/** No `hello` within this after the upgrade and the socket is closed `helloTimeout`. */
export const WIDGET_HELLO_TIMEOUT_MS = 10_000

/**
 * The token bucket behind every widget socket of one token: `burst` taps at
 * once, refilled at `perSecond`. A tap over it is answered `rate_limited` in
 * a `command_result` (with `cooldownMs` saying how long to wait), never
 * relayed. The manifest's cooldowns are the real limiter; this one exists so
 * a runaway widget cannot flood a plugin.
 */
export const WIDGET_COMMAND_RATE_LIMIT = Object.freeze({ burst: 10, perSecond: 2 })

/** A `correlationId` a widget mints per tap; the answer carries it back. */
export const widgetCorrelationIdSchema = z.string().min(1).max(128)

/**
 * Why a tap was refused. The first seven are the SDK's (`@ezpug/protocol`'s
 * `PLAYER_COMMAND_REFUSALS`, relayed as they came, each a line in the
 * player's language); the last three never reach the plugin — the
 * orchestrator refuses them at the door.
 */
export const WIDGET_COMMAND_REFUSALS = [
  /** The cooldown the manifest declares has not elapsed; `cooldownMs` says how long is left. */
  'cooldown',
  /** No charges left for the period the manifest declares. */
  'no_charges',
  /** The manifest declares no such verb. */
  'unknown_command',
  /** `args` did not match the verb's schema. */
  'invalid_args',
  /** The SteamID64 the token was minted for is not on the server. */
  'not_in_match',
  /** The player is dead and the verb needs a living player. */
  'not_alive',
  /** The mode said no; `message` says why. */
  'refused',
  /** More taps than {@link WIDGET_COMMAND_RATE_LIMIT} allows; `cooldownMs` says how long to wait. */
  'rate_limited',
  /** The match is not `live` — nothing to tap on yet, or not any more. */
  'not_live',
  /** The server did not answer inside the relay deadline; try again. */
  'unavailable',
] as const
export const widgetCommandRefusalSchema = z.enum(WIDGET_COMMAND_REFUSALS)
export type WidgetCommandRefusal = z.infer<typeof widgetCommandRefusalSchema>

// ---------------------------------------------------------------------------
// Widget → orchestrator
// ---------------------------------------------------------------------------

/** The first frame, and the only place the token ever appears. */
export const widgetHelloFrameSchema = z.object({
  type: z.literal('hello'),
  protocol: z.literal(WIDGET_SOCKET_PROTOCOL),
  /** A token from `POST /v1/matches/:matchId/player-tokens`, as the host injected it. */
  token: z.string().min(16).max(256),
})
export type WidgetHelloFrame = z.infer<typeof widgetHelloFrameSchema>

/** A tap: a verb the manifest declares and its arguments, validated against the verb's schema before it is sent. */
export const widgetCommandFrameSchema = z.object({
  type: z.literal('command'),
  correlationId: widgetCorrelationIdSchema,
  command: playerCommandNameSchema,
  args: z.record(z.string(), z.unknown()).optional(),
})
export type WidgetCommandFrame = z.infer<typeof widgetCommandFrameSchema>

export const widgetClientFrameSchema = z.discriminatedUnion('type', [
  widgetHelloFrameSchema,
  widgetCommandFrameSchema,
])
export type WidgetClientFrame = z.infer<typeof widgetClientFrameSchema>

export const WIDGET_CLIENT_FRAME_TYPES = ['hello', 'command'] as const
export type WidgetClientFrameType = (typeof WIDGET_CLIENT_FRAME_TYPES)[number]

assertClosedSet('widget client frames', widgetClientFrameSchema, 'type', WIDGET_CLIENT_FRAME_TYPES)

// ---------------------------------------------------------------------------
// Orchestrator → widget
// ---------------------------------------------------------------------------

/**
 * One declared verb as the widget should draw it: the manifest's spec plus
 * what the orchestrator last learned about this player's use of it. The SDK
 * is the truth — a tap is enforced there whatever this says — so these are
 * a hint for the button's state, refreshed by every `command_result`.
 */
export const widgetCommandStateSchema = playerCommandSpecSchema.extend({
  /** Charges left in the current period as last reported; `null` for a verb without charges. */
  chargesLeft: z.number().int().nonnegative().nullable(),
  /** How long until the verb's cooldown has passed, as last reported; `0` when it can be tapped now. */
  readyInMs: z.number().int().nonnegative(),
})
export type WidgetCommandState = z.infer<typeof widgetCommandStateSchema>

/**
 * The answer to the widget's `hello`: who the token is for, where the match
 * is, and the verbs the mode declares. `locale` is the player's from the
 * roster profile when the orchestrator knows them, so a widget mounted with
 * no `locale` injected still speaks to the right person.
 */
export const widgetWelcomeFrameSchema = z.object({
  type: z.literal('hello'),
  protocol: z.literal(WIDGET_SOCKET_PROTOCOL),
  matchId: matchIdSchema,
  steamId64: steamId64Schema,
  gamemode: z.string().min(1),
  state: matchStateSchema,
  locale: localeSchema.optional(),
  commands: z.array(widgetCommandStateSchema),
})
export type WidgetWelcomeFrame = z.infer<typeof widgetWelcomeFrameSchema>

/** A durable fact of the match, as the webhook carries it — the same envelope the stream's `event` frame has. */
export const widgetEventFrameSchema = z.object({
  type: z.literal('event'),
  envelope: webhookEnvelopeSchema,
})
export type WidgetEventFrame = z.infer<typeof widgetEventFrameSchema>

/**
 * What became of a tap: `applied`, or `rejected` with a code from
 * {@link WIDGET_COMMAND_REFUSALS} and a `message` in the player's language
 * the widget may show as it is. `cooldownMs` and `chargesLeft` are the SDK's
 * own numbers after the tap, where the verb has them.
 */
export const widgetCommandResultFrameSchema = z.object({
  type: z.literal('command_result'),
  correlationId: widgetCorrelationIdSchema,
  command: playerCommandNameSchema,
  status: z.enum(['applied', 'rejected']),
  code: widgetCommandRefusalSchema.optional(),
  message: z.string().max(512).optional(),
  cooldownMs: z.number().int().nonnegative().optional(),
  chargesLeft: z.number().int().nonnegative().optional(),
})
export type WidgetCommandResultFrame = z.infer<typeof widgetCommandResultFrameSchema>

/**
 * **A push**: something the gamemode wants *this* phone to see right now.
 * Mode-defined, addressed to the one SteamID64 the token was minted for,
 * relayed by the orchestrator from the server's link without being read,
 * and gone the moment it is delivered — never logged, never stored in
 * `match_events`, never replayed to a widget that reconnects. A durable
 * fact of the match is an `event`; a push is a picture with a shelf life.
 *
 * `name` is the mode's word for the picture, the same snake_case grammar a
 * `plugin_event` uses (`radar_peek`), so a widget switches on it the way it
 * switches on an event type. `data` is whatever that mode's widget expects —
 * this contract does not know, on purpose, because the plugin that sends it
 * and the widget that draws it ship together in `gamemodes/<id>/`. A widget
 * that does not recognise a `name` ignores the frame.
 *
 * The ceiling is {@link WIDGET_PUSH_DATA_MAX} serialized characters,
 * enforced where a push enters the orchestrator (the server link): a phone
 * on venue wifi is the consumer, and a mode that wants to send more than
 * that wants an event.
 */
export const widgetPushFrameSchema = z.object({
  type: z.literal('push'),
  name: snakeNameSchema,
  data: z.record(z.string(), z.unknown()),
})
export type WidgetPushFrame = z.infer<typeof widgetPushFrameSchema>

/** How much serialized JSON one {@link widgetPushFrameSchema}'s `data` may carry. */
export const WIDGET_PUSH_DATA_MAX = 16 * 1024

export const widgetServerFrameSchema = z.discriminatedUnion('type', [
  widgetWelcomeFrameSchema,
  widgetEventFrameSchema,
  widgetCommandResultFrameSchema,
  widgetPushFrameSchema,
])
export type WidgetServerFrame = z.infer<typeof widgetServerFrameSchema>

export const WIDGET_SERVER_FRAME_TYPES = ['hello', 'event', 'command_result', 'push'] as const
export type WidgetServerFrameType = (typeof WIDGET_SERVER_FRAME_TYPES)[number]

/** The frame for one `type` — `WidgetServerFrameOf<'command_result'>` etc. */
export type WidgetServerFrameOf<T extends WidgetServerFrameType> = Extract<
  WidgetServerFrame,
  { type: T }
>

assertClosedSet('widget server frames', widgetServerFrameSchema, 'type', WIDGET_SERVER_FRAME_TYPES)

/**
 * Why the orchestrator closed a widget socket. Each is a decision, not a
 * hiccup: a widget reconnects on `1006` and on nothing here — and on
 * `matchEnded` it shows that the match is over.
 */
export const WIDGET_CLOSE_CODES = Object.freeze({
  /** The match reached a terminal state; the `event` frame with its `match.ended` or `match.failed` came first. */
  matchEnded: 4000,
  /** No token, one that does not verify, one that expired, or one whose match is over before `hello`. */
  unauthorized: 4001,
  /** The `hello` named a protocol this orchestrator does not speak. */
  protocolMismatch: 4002,
  /** A frame that does not parse, or a first frame that is not `hello`. */
  malformed: 4003,
  /** The browser's origin is not in the request's `streamAllowedOrigins`. */
  forbidden: 4005,
  /** The widget fell too far behind and its frames were dropped. */
  slowConsumer: 4008,
  /** No `hello` within {@link WIDGET_HELLO_TIMEOUT_MS}. */
  helloTimeout: 4009,
})
export type WidgetCloseCode = (typeof WIDGET_CLOSE_CODES)[keyof typeof WIDGET_CLOSE_CODES]
