import type { GameserverEvent, MatchCommand, MatchCommandResult } from '@ezpug/match-api'

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

/** The downward half: a command for the server this channel is attached to. */
export interface ServerChannel {
  readonly server: ServerRef
  /**
   * Send one command and resolve with what the server said. Rejects only when
   * the transport broke (the socket went away mid-command); a command the
   * server refused resolves with `status: 'rejected'` and a code.
   */
  send: (command: MatchCommand) => Promise<ChannelCommandResult>
  /** Push one line into the server's chat. */
  announce?: (line: string) => Promise<boolean>
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
