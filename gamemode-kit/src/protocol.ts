/**
 * **The socket and host constants a widget needs, mirrored.** The truth is
 * `@ezpug/match-api` (`widget/socket.ts`, `resources/widget-host.ts`); these
 * are copies, held equal by `protocol.test.ts`. Copied rather than imported
 * because the package's entry point builds every Zod schema of the Match
 * API at load, and a widget bundle that imported one constant from it would
 * carry all of them onto a phone. Types are free and are imported.
 */

/** The upgrade path of the widget socket on the orchestrator. */
export const WIDGET_SOCKET_PATH = '/v1/widget'
/** The socket's frame protocol; the `hello` names it. */
export const WIDGET_SOCKET_PROTOCOL = 1
/** The host handshake's protocol; `ready` and `init` name it. */
export const WIDGET_HOST_PROTOCOL = 1

/**
 * Why the orchestrator closed the socket. A widget reconnects on a network
 * close (`1006`) and on none of these: each is a decision, and `matchEnded`
 * is the one it shows the player.
 */
export const WIDGET_CLOSE_CODES = Object.freeze({
  matchEnded: 4000,
  unauthorized: 4001,
  protocolMismatch: 4002,
  malformed: 4003,
  forbidden: 4005,
  slowConsumer: 4008,
  helloTimeout: 4009,
})

/** The orchestrator's relay deadline is fifteen seconds; a tap unanswered by then is `unavailable` here too. */
export const WIDGET_COMMAND_TIMEOUT_MS = 20_000

export type {
  Locale,
  WebhookEnvelope,
  WidgetCommandFrame,
  WidgetCommandRefusal,
  WidgetCommandResultFrame,
  WidgetCommandState,
  WidgetEventFrame,
  WidgetHostMessage,
  WidgetHostMessageOf,
  WidgetServerFrame,
  WidgetTokens,
  WidgetWelcomeFrame,
} from '@ezpug/match-api'
