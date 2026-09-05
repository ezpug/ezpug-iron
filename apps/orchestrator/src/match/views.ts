import type { FleetServer, Match, SimStatus, WebhookEnvelope } from '@ezpug/match-api'
import type { MatchEventRow, MatchRow, ServerRow } from './store'

/**
 * Rows → the Match API's resources. One writer per shape, so the key order
 * a client sees is decided once: an envelope replayed from the events route
 * is byte for byte what the signer saw, and a `Match` read twice compares
 * equal as text.
 */

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null)

/** A match, as `GET /v1/matches/:id` answers it. `connect` is shown from `ready` on. */
export function matchView(row: MatchRow, sim: SimStatus | null): Match {
  const before = row.readyAt === null
  return {
    id: row.id,
    clientMatchId: row.clientMatchId,
    state: row.state,
    game: row.game,
    gamemode: row.gamemode,
    provider: row.provider,
    serverId: row.serverId,
    fleetServerId: row.fleetServerId,
    connect: before ? null : row.connect,
    tv: before ? null : row.tv,
    seq: row.seq,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    readyAt: iso(row.readyAt),
    liveAt: iso(row.liveAt),
    endedAt: iso(row.endedAt),
    expiresAt: row.expiresAt.toISOString(),
    endedReason: row.endedReason,
    sim,
  }
}

/** What a row has cost between its allocation and `asOf` (or its release). */
export function accruedCents(row: ServerRow, asOf: Date): number {
  const until = row.releasedAt ?? asOf
  const elapsedMs = Math.max(0, until.getTime() - row.allocatedAt.getTime())
  return Math.floor((row.costHourlyCents * elapsedMs) / 3_600_000)
}

/** A ledger row, as the fleet routes answer it. Never a password. */
export function fleetServerView(row: ServerRow, asOf: Date): FleetServer {
  return {
    id: row.id,
    provider: row.provider,
    serverId: row.serverId,
    node: row.nodeId,
    matchId: row.matchId,
    keyId: row.keyId,
    state: row.state,
    game: row.game,
    region: row.region,
    lan: row.lan,
    address: row.address,
    tv: row.tv,
    cost: {
      currency: 'EUR',
      hourlyCents: row.costHourlyCents,
      accruedCents: accruedCents(row, asOf),
      asOf: asOf.toISOString(),
    },
    allocatedAt: row.allocatedAt.toISOString(),
    releasedAt: iso(row.releasedAt),
    expiresAt: row.expiresAt.toISOString(),
  }
}

/** The envelope, reconstructed the same way every time (decision 6's replay rule). */
export function envelopeOf(
  match: Pick<MatchRow, 'clientMatchId'>,
  event: MatchEventRow,
): WebhookEnvelope {
  return {
    deliveryId: event.deliveryId,
    matchId: event.matchId,
    clientMatchId: match.clientMatchId,
    seq: event.seq,
    occurredAt: event.occurredAt.toISOString(),
    payload: event.payload,
  }
}
