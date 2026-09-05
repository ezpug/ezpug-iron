import type {
  FleetServerAddress,
  FleetServerState,
  LedgerFilter,
  MatchCommand,
  MatchCommandResult,
  MatchEndedReason,
  MatchListFilter,
  MatchRequest,
  MatchState,
  ServerConnect,
  ServerTv,
  SimStatus,
  WebhookPayload,
} from '@ezpug/match-api'

/**
 * **What the match machine needs from storage**, and nothing more (PRD-02
 * T3). Two implementations — Postgres (`postgres-store.ts`, over the T2
 * schema) and memory (`memory-store.ts`) — the same posture as the key
 * store: the machine, the walk, the reaper, the webhook worker and the
 * stream are proven on a fake clock without a database, and the store is
 * proven against one by a contract test both implementations pass.
 *
 * Rows are the schema's own shapes (`src/db/schema`), `Date`s and all;
 * views onto the Match API resources are the machine's business
 * (`views.ts`). Nothing here reasons about state: a store writes what it is
 * told and reads what it is asked.
 *
 * Concurrency: everything about one match runs on that match's chain in
 * one process (`machine.ts`), so no operation here needs a row lock. The
 * one place two matches meet — `appendEvent`'s per-match `seq` — is per
 * match too.
 */

export interface MatchRow {
  id: string
  keyId: string
  clientMatchId: string
  state: MatchState
  stateChangedAt: Date
  game: MatchRequest['game']
  gamemode: string
  provider: string | null
  serverId: string | null
  fleetServerId: string | null
  connect: ServerConnect | null
  tv: ServerTv | null
  seq: number
  requestJson: MatchRequest
  requestHash: string
  endedReason: MatchEndedReason | null
  sim: SimStatus | null
  expiresAt: Date
  readyAt: Date | null
  liveAt: Date | null
  endedAt: Date | null
  webhooksStoppedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type MatchPatch = Partial<
  Omit<
    MatchRow,
    'id' | 'keyId' | 'clientMatchId' | 'requestJson' | 'requestHash' | 'createdAt' | 'seq'
  >
>

export interface MatchEventRow {
  matchId: string
  seq: number
  deliveryId: string
  type: string
  occurredAt: Date
  payload: WebhookPayload
}

export const DELIVERY_STATUSES = ['pending', 'delivered', 'stopped', 'given_up'] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]

export interface DeliveryRow {
  deliveryId: string
  matchId: string
  seq: number
  url: string
  secretId: string
  status: DeliveryStatus
  attempt: number
  nextAttemptAt: Date | null
  lastStatus: number | null
  lastError: string | null
  deliveredAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type DeliveryPatch = Partial<
  Pick<
    DeliveryRow,
    | 'status'
    | 'attempt'
    | 'nextAttemptAt'
    | 'lastStatus'
    | 'lastError'
    | 'deliveredAt'
    | 'updatedAt'
  >
>

export interface CommandRow {
  matchId: string
  correlationId: string
  commandJson: MatchCommand
  resultJson: MatchCommandResult | null
  createdAt: Date
  updatedAt: Date
}

export interface ServerRow {
  id: string
  provider: string
  serverId: string | null
  nodeId: string | null
  matchId: string | null
  keyId: string
  state: FleetServerState
  game: MatchRequest['game']
  region: string | null
  lan: boolean
  address: FleetServerAddress | null
  tv: ServerTv | null
  costHourlyCents: number
  providerMeta: Record<string, unknown> | null
  lastSeenAt: Date | null
  lastError: string | null
  releasedReason: string | null
  allocatedAt: Date
  releasedAt: Date | null
  expiresAt: Date
}

export type ServerPatch = Partial<Omit<ServerRow, 'id' | 'keyId' | 'allocatedAt'>>

export interface BackupRow {
  id: string
  matchId: string
  fleetServerId: string | null
  mapNumber: number
  roundNumber: number
  filename: string
  content: string
  createdAt: Date
}

export interface ServerTokenRow {
  id: string
  fleetServerId: string
  tokenHash: string
  createdAt: Date
}

export interface PlayerTokenRow {
  id: string
  matchId: string
  keyId: string
  steamId64: string
  tokenHash: string
  expiresAt: Date
  createdAt: Date
  revokedAt: Date | null
}

/** A page of rows and the offset the next one starts at. */
export interface Page<T> {
  items: T[]
  nextOffset: number | null
}

export interface MatchStore {
  // --- matches --------------------------------------------------------------
  insertMatch: (row: MatchRow) => Promise<void>
  findMatch: (id: string) => Promise<MatchRow | undefined>
  findMatchByClientId: (keyId: string, clientMatchId: string) => Promise<MatchRow | undefined>
  /** The key's matches, newest first, filtered, paged by offset. */
  listMatches: (
    keyId: string,
    filter: MatchListFilter,
    offset: number,
    limit: number,
  ) => Promise<Page<MatchRow>>
  updateMatch: (id: string, patch: MatchPatch) => Promise<void>
  /** Every non-terminal match — the recovery sweep's and the fan-out's read. */
  listOpenMatches: (keyId?: string) => Promise<MatchRow[]>

  // --- the durable log --------------------------------------------------------
  /**
   * Append one envelope: `seq` is the match's next (its `seq` column plus
   * one), written together with the bumped column. Returns the row.
   */
  appendEvent: (
    matchId: string,
    event: Omit<MatchEventRow, 'matchId' | 'seq'>,
    updatedAt: Date,
  ) => Promise<MatchEventRow>
  /** Envelopes after `afterSeq`, in order, at most `limit`. */
  listEvents: (matchId: string, afterSeq: number, limit: number) => Promise<MatchEventRow[]>

  // --- deliveries ---------------------------------------------------------------
  insertDelivery: (row: DeliveryRow) => Promise<void>
  findDelivery: (deliveryId: string) => Promise<DeliveryRow | undefined>
  /** Pending rows due at or before `now`, oldest `(match, seq)` first, at most `limit`. */
  listDueDeliveries: (now: Date, limit: number) => Promise<DeliveryRow[]>
  updateDelivery: (deliveryId: string, patch: DeliveryPatch) => Promise<void>
  listDeliveries: (matchId: string) => Promise<DeliveryRow[]>

  // --- commands -----------------------------------------------------------------
  findCommand: (matchId: string, correlationId: string) => Promise<CommandRow | undefined>
  insertCommand: (row: CommandRow) => Promise<void>
  setCommandResult: (
    matchId: string,
    correlationId: string,
    result: MatchCommandResult,
    updatedAt: Date,
  ) => Promise<void>

  // --- the ledger ---------------------------------------------------------------
  insertServer: (row: ServerRow) => Promise<void>
  findServer: (id: string) => Promise<ServerRow | undefined>
  /** By the provider's own handle; the newest row when a handle was reused. */
  findServerByHandle: (provider: string, serverId: string) => Promise<ServerRow | undefined>
  updateServer: (id: string, patch: ServerPatch) => Promise<void>
  /** Rows not yet released, newest first; optionally one provider's. */
  listOpenServers: (provider?: string) => Promise<ServerRow[]>
  /** Every row, newest first, filtered, paged by offset. */
  listLedger: (filter: LedgerFilter, offset: number, limit: number) => Promise<Page<ServerRow>>
  /** The hash of the link token minted for a row (decision 5); the link (T6) looks it up. */
  insertServerToken: (row: ServerTokenRow) => Promise<void>

  // --- backups and player tokens (written by T6/T14 and T24; read here) ----------
  latestBackup: (matchId: string) => Promise<BackupRow | undefined>
  findPlayerTokenByHash: (tokenHash: string) => Promise<PlayerTokenRow | undefined>
}
