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
import type { LinkServerState, ServerVersions } from '@ezpug/protocol'
import type { RconAuditEntry } from '../db/schema/servers'

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
  /**
   * **Which deployment is running it** (T21c) — stamped by the store, never
   * by a caller, which is why {@link MatchInsert} leaves it out. A boot
   * re-arms and re-walks only its own; see `src/deployment.ts`.
   */
  deployment: string
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

/**
 * A match as a caller writes it: everything but the deployment, which is the
 * store's to stamp (T21c).
 */
export type MatchInsert = Omit<MatchRow, 'deployment'>

export type MatchPatch = Partial<
  Omit<
    MatchRow,
    | 'id'
    | 'deployment'
    | 'keyId'
    | 'clientMatchId'
    | 'requestJson'
    | 'requestHash'
    | 'createdAt'
    | 'seq'
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
  /**
   * **Which deployment opened the row** (T21c) — stamped by the store, never
   * by a caller, which is why {@link ServerInsert} leaves it out. The reaper
   * and the fleet's "what is running" read only their own; see
   * `db/schema/servers.ts`.
   */
  deployment: string
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
  /** The GSLT this row holds (T17); null on a node, on the sim, and while the pool is dry. */
  gsltTokenId: string | null
  providerMeta: Record<string, unknown> | null
  /** What the server said in `hello` over the link (T6); null until it dialled in. */
  versions: ServerVersions | null
  hostname: string | null
  currentMap: string | null
  /** The server's own state as last reported over the link. */
  linkState: LinkServerState | null
  /** The highest link `seq` acknowledged contiguously — `welcome.ackedSeq` on reconnect. */
  linkAckedSeq: number
  lastSeenAt: Date | null
  lastError: string | null
  releasedReason: string | null
  allocatedAt: Date
  releasedAt: Date | null
  expiresAt: Date
}

/**
 * A row as a caller writes it: everything but the deployment, which is the
 * store's to stamp (T21c).
 */
export type ServerInsert = Omit<ServerRow, 'deployment'>

export type ServerPatch = Partial<Omit<ServerRow, 'id' | 'keyId' | 'allocatedAt' | 'deployment'>>

/** How many RCON lines a ledger row keeps. A shift's worth; the oldest fall off. */
export const RCON_AUDIT_KEEP = 200

/**
 * **A node** (decision 23): every `ezpug-node` ever enrolled, by the kebab
 * id the operator chose. The link (T12) writes the connection facts; the
 * row outlives every disconnect, because a node that is not answering is a
 * node with no capacity, never a node that stopped existing.
 */
export interface NodeRow {
  id: string
  region: string
  labels: Record<string, string>
  version: string | null
  imageDigest: string | null
  connected: boolean
  drained: boolean
  capacityTotal: number
  capacityInUse: number
  capacityWarm: number
  /** SHA-256 of the node token; null until the enrolment `hello` claims one. */
  tokenHash: string | null
  /**
   * The key that enrolled it. It is who a warm instance's ledger row is
   * charged to — a container the node runs before any match asked for it
   * still costs nothing but is still a row (T12).
   */
  enrolledByKeyId: string | null
  lastSeenAt: Date | null
  enrolledAt: Date
  revokedAt: Date | null
}

export type NodePatch = Partial<Omit<NodeRow, 'id' | 'enrolledAt'>>

/** The one-time token `POST /v1/fleet/nodes` shows once, spent by the first `hello`. */
export interface NodeEnrolmentRow {
  id: string
  nodeId: string
  tokenHash: string
  createdAt: Date
  expiresAt: Date
  usedAt: Date | null
}

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
  lastUsedAt: Date | null
  revokedAt: Date | null
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

/**
 * **One Steam game server account** (T17): the login token a CS2 server
 * needs to accept anything but a LAN connection. Leased to a ledger row at
 * allocation, freed when the row closes, reset at Steam when the server it
 * was on was lost. Held in clear because it is a credential this process has
 * to *present* to a provider, like a webhook secret.
 */
export interface GsltTokenRow {
  id: string
  steamId: string
  appId: number
  loginToken: string
  memo: string
  /** The ledger row holding it (`servers.id`), or null in the pool. */
  leasedByServerId: string | null
  leasedAt: Date | null
  lastResetAt: Date | null
  createdAt: Date
  deletedAt: Date | null
}

export type GsltTokenPatch = Partial<Omit<GsltTokenRow, 'id' | 'steamId' | 'createdAt'>>

/** A page of rows and the offset the next one starts at. */
export interface Page<T> {
  items: T[]
  nextOffset: number | null
}

export interface MatchStore {
  /**
   * **Whose rows these are** (T21c): the deployment this store stamps on
   * every match and every ledger row, and the only one its open listings
   * answer with. A caller that keeps a row in memory beside the store's copy
   * reads it from here rather than inventing one.
   */
  readonly deployment: string

  // --- matches --------------------------------------------------------------
  insertMatch: (row: MatchInsert) => Promise<void>
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
  /**
   * Every non-terminal match **of this deployment** — the boot's resume and
   * the budget's open count. Another deployment's open matches are not this
   * process's to re-arm: it would put a second machine on one row and walk a
   * second server for a match that already has one (T21c).
   */
  listOpenMatches: (keyId?: string) => Promise<MatchRow[]>

  // --- the durable log --------------------------------------------------------
  /**
   * Append one envelope: `seq` is the match's next (its `seq` column plus
   * one), written together with the bumped column. Returns the row.
   *
   * `patch` is applied to the match **in the same transaction** as the
   * append. That is what makes a state change and the fact that announces it
   * one write: a `GET` never catches a terminal match whose `seq` is still
   * the one before its own `match.ended` (the events route would then hold an
   * envelope past the `seq` the client was told was the last).
   */
  appendEvent: (
    matchId: string,
    event: Omit<MatchEventRow, 'matchId' | 'seq'>,
    updatedAt: Date,
    patch?: MatchPatch,
  ) => Promise<MatchEventRow>
  /** Envelopes after `afterSeq`, in order, at most `limit`. */
  listEvents: (matchId: string, afterSeq: number, limit: number) => Promise<MatchEventRow[]>

  // --- deliveries ---------------------------------------------------------------
  insertDelivery: (row: DeliveryRow) => Promise<void>
  findDelivery: (deliveryId: string) => Promise<DeliveryRow | undefined>
  /**
   * Pending rows due at or before `now`, oldest `(match, seq)` first, at most
   * `limit` — **of this deployment's matches only** (T21c): two workers on one
   * queue POST the same envelope twice and race each other's row updates.
   */
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
  insertServer: (row: ServerInsert) => Promise<void>
  findServer: (id: string) => Promise<ServerRow | undefined>
  /** By the provider's own handle; the newest row when a handle was reused. */
  findServerByHandle: (provider: string, serverId: string) => Promise<ServerRow | undefined>
  updateServer: (id: string, patch: ServerPatch) => Promise<void>
  /**
   * Rows **this deployment** has not yet released, newest first; optionally
   * one provider's. Another deployment's open rows are not this process's to
   * see here — its providers will never list those servers, so the reaper
   * would call every one of them lost (T21c). `listLedger` is the unscoped
   * read, for the history a human asks for.
   */
  listOpenServers: (provider?: string) => Promise<ServerRow[]>
  /** Every row, newest first, filtered, paged by offset. */
  listLedger: (filter: LedgerFilter, offset: number, limit: number) => Promise<Page<ServerRow>>
  /**
   * Every row of one key's that counts toward this month's spend: still
   * open, or closed at or after `since`. The budget's one read — a month's
   * cost is `cost_hourly_cents` times each row's open time, live rows
   * accruing to now.
   */
  listKeyLedgerSince: (keyId: string, since: Date) => Promise<ServerRow[]>
  /** The hash of the link token minted for a row (decision 5); the link (T6) looks it up. */
  insertServerToken: (row: ServerTokenRow) => Promise<void>
  /** The link's one lookup on `hello`: the token's row, revoked or not — the caller decides. */
  findServerTokenByHash: (tokenHash: string) => Promise<ServerTokenRow | undefined>
  /** `last_used_at`, written once per `hello`. */
  touchServerToken: (id: string, at: Date) => Promise<void>
  /** The newest live token of a row — how the node provider finds again what it minted before a restart (T12). */
  findLiveServerToken: (fleetServerId: string) => Promise<ServerTokenRow | undefined>
  /**
   * One line an operator ran through `POST /v1/fleet/servers/:id/rcon` and
   * what came back, appended to the row's audit column (T20). Atomic and
   * bounded to {@link RCON_AUDIT_KEEP} entries — two operators typing at once
   * both leave a trace, and a long night does not grow a row without limit.
   * The line and its output are already redacted by the caller.
   */
  appendRconAudit: (fleetServerId: string, entry: RconAuditEntry) => Promise<void>
  /** The audit as it stands, oldest first — the operator's own trail. */
  rconAudit: (fleetServerId: string) => Promise<RconAuditEntry[]>

  // --- backups and player tokens (written by T6/T14 and T24; read here) ----------
  /**
   * Write one round backup as the link relayed it: the same (match, map,
   * round) replaces the earlier one, and only the newest `keep` rows of the
   * match survive — backups are small text, but a Bo3 writes sixty of them.
   */
  upsertBackup: (row: BackupRow, keep: number) => Promise<void>
  /** Every backup of a match, newest round first. */
  listBackups: (matchId: string) => Promise<BackupRow[]>
  latestBackup: (matchId: string) => Promise<BackupRow | undefined>
  /** A widget's key to one match and one SteamID64 (T24), hashed. */
  insertPlayerToken: (row: PlayerTokenRow) => Promise<void>
  findPlayerTokenByHash: (tokenHash: string) => Promise<PlayerTokenRow | undefined>
  /**
   * Point a live server token at another ledger row. The one caller is the
   * node provider's warm claim (T12): the container keeps the credential it
   * booted with, and that credential now opens the match's row instead of
   * the warm one it was minted for.
   */
  reassignServerToken: (id: string, fleetServerId: string) => Promise<void>

  // --- the GSLT pool (T17) ---------------------------------------------------------
  insertGsltToken: (row: GsltTokenRow) => Promise<void>
  /** Every account this deployment holds and has not deleted, oldest first. */
  listGsltTokens: () => Promise<GsltTokenRow[]>
  findGsltTokenBySteamId: (steamId: string) => Promise<GsltTokenRow | undefined>
  /** The account a ledger row is holding, if any. */
  findGsltTokenByLease: (fleetServerId: string) => Promise<GsltTokenRow | undefined>
  updateGsltToken: (id: string, patch: GsltTokenPatch) => Promise<void>
  /**
   * Take the longest-idle free account for `fleetServerId`, in one write —
   * `undefined` when the pool is dry. Atomic because "one token per running
   * server" is Valve's rule and two servers sharing one evicts the first.
   */
  claimFreeGsltToken: (fleetServerId: string, at: Date) => Promise<GsltTokenRow | undefined>
  /**
   * Every lease whose ledger row is closed or gone — what a process that
   * died between `deallocate` and `release` leaves behind, and what the
   * pool's sweep frees.
   */
  listLeakedGsltLeases: () => Promise<GsltTokenRow[]>

  // --- nodes (T12) ----------------------------------------------------------------
  insertNode: (row: NodeRow) => Promise<void>
  findNode: (id: string) => Promise<NodeRow | undefined>
  /** The node link's one lookup on a `node` `hello`. */
  findNodeByTokenHash: (tokenHash: string) => Promise<NodeRow | undefined>
  /** Every node ever enrolled and not revoked, oldest first. */
  listNodes: () => Promise<NodeRow[]>
  updateNode: (id: string, patch: NodePatch) => Promise<void>
  insertNodeEnrolment: (row: NodeEnrolmentRow) => Promise<void>
  /** The node link's lookup on an `enrolment` `hello`; spent and expired rows come back too, and are refused by the caller. */
  findNodeEnrolmentByHash: (tokenHash: string) => Promise<NodeEnrolmentRow | undefined>
  /** Spend an enrolment: a second `hello` with the same one-time token is refused. */
  useNodeEnrolment: (id: string, at: Date) => Promise<void>
}
