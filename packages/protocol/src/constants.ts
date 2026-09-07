import { CONSOLE_LINES_MAX } from '@ezpug/match-api'

/**
 * **The numbers both ends agree on.** Exported into the JSON Schema documents
 * (`x-constants`) and from there into the generated C#, so the plugin and the
 * orchestrator never hold two copies of a limit.
 */

/**
 * Bumped when a frame changes shape incompatibly. Every `hello` states the
 * version it speaks; an orchestrator that does not speak it closes the socket
 * with {@link LINK_CLOSE_CODES.protocolMismatch} before anything else is said.
 * Additive evolution (a new optional field, a new frame type an old peer
 * ignores) does not bump it.
 */
export const PROTOCOL_VERSION = 1

/** The upgrade path a server's plugin dials (decision 5). */
export const SERVER_LINK_PATH = '/link'

/** The upgrade path an `ezpug-node` agent dials (decision 23). */
export const NODE_LINK_PATH = '/node'

/**
 * **The MatchZy door** (decision 19, PRD-02 T9). MatchZy 0.8.15 has no
 * in-process forwards — its "events & forwards" are one HTTP remote log
 * (`matchzy_remote_log_url`) with no retry and no dedup — so the core plugin
 * points that log at this path on the orchestrator, which translates every
 * payload into the vocabulary once. The server authenticates each POST with
 * its own link token in {@link MATCHZY_TOKEN_HEADER}: a header, never the
 * path, so no access log between the two ever holds it.
 */
export const MATCHZY_LOG_PATH = '/matchzy/log'

/** The header a MatchZy remote-log POST carries the server token in (`matchzy_remote_log_header_key`). */
export const MATCHZY_TOKEN_HEADER = 'x-ezpug-server-token'

/** The largest MatchZy payload the door reads; a `round_end` with ten players' stats is a few kilobytes. */
export const MATCHZY_PAYLOAD_MAX = 256 * 1024

/**
 * **The word a restored server says.** The `plugin_event` name a plugin emits
 * once it has written and loaded the round backup an `assign.restore` carried
 * (`data`: `mapNumber`, `roundNumber`, `filename`). It is a state transition
 * and not a nicety: MatchZy says `going_live` once per series and never again
 * after a restore, so this — not a second `going_live` — is what closes the
 * orchestrator's recovery window on a `matchzy` flow (PRD-02 T37a, found on
 * hardware in T37). A name both ends must agree on, so it lives here.
 */
export const BACKUP_RESTORED_EVENT = 'backup_restored'

/**
 * What `welcome` says when nothing else is configured: a heartbeat every ten
 * seconds. Silence past two intervals is what makes the orchestrator probe
 * the provider (PRD-02 T6).
 */
export const HEARTBEAT_INTERVAL_MS_DEFAULT = 10_000

/**
 * How long a freshly opened socket may stay silent before the orchestrator
 * closes it: the first frame is always `hello`, and a peer that has nothing
 * to say is not a peer.
 */
export const HELLO_TIMEOUT_MS = 10_000

/**
 * How many events one `events` frame may carry. Mirrors the platform's
 * ingestion batch (`GAMESERVER_EVENT_BATCH_MAX`): a live server sends one or
 * two at a time, a reconnecting one flushes what it buffered in batches of
 * this.
 */
export const EVENTS_BATCH_MAX = 200

/**
 * The largest round backup that crosses the link, in UTF-16 code units of
 * the file's text. A MatchZy backup is a few kilobytes of key-values; the
 * ceiling exists so a misconfigured server cannot post a demo here.
 */
export const BACKUP_CONTENT_MAX = 256 * 1024

/** The longest console tail a `console` frame carries — the fleet route's own ceiling. */
export const CONSOLE_TAIL_MAX = CONSOLE_LINES_MAX

/** The longest single console line a server relays. Longer lines are cut, never dropped. */
export const CONSOLE_LINE_MAX = 2048

/** How many console lines a `console` command asks for when it does not say. */
export const CONSOLE_TAIL_DEFAULT = 100

/**
 * Why the orchestrator closed a link, as WebSocket close codes in the
 * application range — the same convention as the stream's
 * `STREAM_CLOSE_CODES`. A peer reconnects with backoff on `1006` (the
 * network) and on `replaced`; every other code is a decision the peer must
 * act on, not a hiccup to retry through.
 */
export const LINK_CLOSE_CODES = Object.freeze({
  /** The token in `hello` is unknown, revoked or for another kind of peer. */
  unauthorized: 4001,
  /** `hello.protocol` is not a version this orchestrator speaks. */
  protocolMismatch: 4002,
  /** A frame did not parse. The reason is in the close message. */
  malformed: 4003,
  /** A second socket presented the same token; this one is the older. */
  replaced: 4005,
  /** No `hello` within {@link HELLO_TIMEOUT_MS}. */
  helloTimeout: 4008,
  /** The token was revoked (a node un-enrolled, a server released) while connected. */
  revoked: 4009,
  /** The orchestrator is shutting down; reconnect with backoff. */
  shuttingDown: 4012,
})
export type LinkCloseCode = (typeof LINK_CLOSE_CODES)[keyof typeof LINK_CLOSE_CODES]

/**
 * The constants as the JSON Schema documents carry them (`x-constants`),
 * one flat map, so `scripts/protocol-codegen.mjs` can emit them as a C#
 * static class without knowing what each one means.
 */
export const PROTOCOL_CONSTANTS = Object.freeze({
  PROTOCOL_VERSION,
  SERVER_LINK_PATH,
  NODE_LINK_PATH,
  MATCHZY_LOG_PATH,
  MATCHZY_TOKEN_HEADER,
  MATCHZY_PAYLOAD_MAX,
  BACKUP_RESTORED_EVENT,
  HEARTBEAT_INTERVAL_MS_DEFAULT,
  HELLO_TIMEOUT_MS,
  EVENTS_BATCH_MAX,
  BACKUP_CONTENT_MAX,
  CONSOLE_TAIL_MAX,
  CONSOLE_LINE_MAX,
  CONSOLE_TAIL_DEFAULT,
  ...Object.fromEntries(
    Object.entries(LINK_CLOSE_CODES).map(([name, code]) => [
      `CLOSE_${camelToUpperSnake(name)}`,
      code,
    ]),
  ),
})

function camelToUpperSnake(name: string): string {
  return name.replace(/([A-Z])/g, '_$1').toUpperCase()
}
