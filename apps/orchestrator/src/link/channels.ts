import type {
  GameserverEvent,
  MatchCommand,
  MatchCommandResult,
  RosterEntry,
} from '@ezpug/match-api'
import type {
  LinkConsoleLine,
  OrchestratorFrameOf,
  RoundBackup,
  ServerFrameOf,
} from '@ezpug/protocol'

/**
 * **The inner half of the link** (decision 5, PRD-02 T3/T6). A server's only
 * relationship with the orchestrator is one channel: events and heartbeats
 * come *up* it, commands go *down* it. T6's `/link` WebSocket handler is one
 * implementation of it for a real plugin; the sim provider's in-process
 * server is another. The match machine speaks to this seam and never learns
 * which — a Dathost server and a simulated one are indistinguishable once
 * attached, which is the whole point of the attitude "one link, everything
 * on it".
 *
 * A server is keyed by `provider/serverId`, the same pair every event's
 * `source` carries, so an event can be attributed to its channel and a
 * command can find its server without a second registry.
 */

/** Who is speaking, as every event's `source` names it. */
export interface ServerRef {
  provider: string
  serverId: string
}

export function serverKey(ref: ServerRef): string {
  return `${ref.provider}/${ref.serverId}`
}

/** What the link answers per event — the platform's ingestion vocabulary plus `rejected` (T1). */
export type IngestStatus = 'accepted' | 'duplicate' | 'ephemeral' | 'rejected'

/**
 * Where events arrive from every kind of server. The match machine owns the
 * implementation; a channel calls `ingest` for each event its server speaks,
 * in order, and reads the answer for its ack (T6) or ignores it (the sim).
 */
export interface ServerEventSink {
  ingest: (source: ServerRef, event: GameserverEvent) => Promise<IngestStatus>
  /**
   * A round backup as the server wrote it — recovery fuel (T14). Persisted
   * for the match this server holds, the newest few kept; `false` when the
   * server holds no open match, in which case nothing is written.
   */
  backup: (source: ServerRef, backup: RoundBackup) => Promise<boolean>
}

/**
 * The answer a server gives to a command sent down its channel: the Match
 * API's own result shape, minus the identity the machine already knows
 * (`correlationId`, `type`), so a channel says only what became of it.
 */
export type ChannelCommandResult = Pick<
  MatchCommandResult,
  'status' | 'code' | 'message' | 'output' | 'sim' | 'stepped'
>

/** A console tail as the link last relayed it, stamped with the orchestrator's clock on arrival. */
export interface ConsoleTail {
  at: Date
  /** The server's uptime when the tail was taken; each line's stamp is on the same clock. */
  uptimeMs: number
  lines: LinkConsoleLine[]
}

/** A widget's tap, as the link relays it (T24 mints them; T6 carries them). */
export type PlayerCommandRelay = Omit<OrchestratorFrameOf<'player_command'>, 'type'>
export type PlayerCommandOutcome = Omit<ServerFrameOf<'player_command_result'>, 'type'>

/**
 * The downward half: a command for the server this channel is attached to.
 * `send` and `announce` are what the machine needs of every server; the
 * rest is what a real plugin can do and a simulated one cannot, optional so
 * the sim's channel stays a sim's.
 */
export interface ServerChannel {
  readonly server: ServerRef
  /**
   * Send one command and resolve with what the server said. Rejects only when
   * the transport broke (the socket went away mid-command, or never answered
   * inside the deadline); a command the server refused resolves with
   * `status: 'rejected'` and a code.
   */
  send: (command: MatchCommand) => Promise<ChannelCommandResult>
  /** Push one line into the server's chat. */
  announce?: (line: string) => Promise<boolean>
  /** Tell the server its match is over: unload the mode, back to the lobby, `state: idle`. */
  release?: (reason: string) => Promise<void>
  /** Finish what you have, take nothing new. */
  drain?: () => Promise<void>
  /** Push one player's profile (open join, a refreshed rating or loadout). */
  profile?: (player: RosterEntry) => Promise<void>
  /** Relay a widget's tap and resolve with what the SDK answered. Rejects on the deadline. */
  playerCommand?: (command: PlayerCommandRelay) => Promise<PlayerCommandOutcome>
  /** Ask the server for its console tail (`lines` from the end). Rejects on the deadline. */
  console?: (lines?: number) => Promise<ConsoleTail>
  /** The tail the server last relayed, solicited or not — the fleet console route's cache (T20). */
  consoleTail?: () => ConsoleTail | undefined
}

/**
 * Every attached channel, by server. A channel attaches when its server is
 * up (the sim at `start`, a plugin at `hello`) and detaches when it goes
 * (deallocated, socket closed). The machine asks here when it has something
 * to send; a server with no channel is one that is not (yet) reachable, and
 * a command for it is `rejected` with `invalid_state`, never lost silently.
 */
export interface LinkRegistry {
  attach: (channel: ServerChannel) => void
  detach: (server: ServerRef) => void
  get: (server: ServerRef) => ServerChannel | undefined
  /** How many channels are attached — a leak check and a fleet fact. */
  size: () => number
}

export function createLinkRegistry(): LinkRegistry {
  const channels = new Map<string, ServerChannel>()
  return {
    attach: channel => void channels.set(serverKey(channel.server), channel),
    detach: server => void channels.delete(serverKey(server)),
    get: server => channels.get(serverKey(server)),
    size: () => channels.size,
  }
}
