import type {
  MatchCommand,
  MatchCommandResult,
  MatchEndedReason,
  MatchRequest,
  ServerConnect,
  ServerTv,
  SimStatus,
  WebhookPayload,
} from '@ezpug/match-api'
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { DEFAULT_DEPLOYMENT } from '../../deployment'
import { createdAt, timestamptz, updatedAt, uuidPk } from '../columns'
import { apiKeys } from './api-keys'

/**
 * **A match as the orchestrator sees it** — the Match API's `Match` resource
 * as a row, plus what serving it needs: the request as it arrived (the
 * assignment is composed from it, T6), the hash a repeated `clientMatchId` is
 * compared against (`conflict` when the body differs), and the moment the
 * current state was entered, so every deadline the machine arms (T3) re-arms
 * from the row after a restart instead of from a memory nobody kept.
 *
 * `provider` and `server_id` are the badge and the handle every event's
 * `source` carries; the ledger row itself is `fleet_server_id` (`servers`).
 * Rows are never deleted: the events route replays a match for as long as
 * the client wants to read it.
 */
export const matches = pgTable(
  'matches',
  {
    id: uuidPk(),
    /**
     * **Which deployment is running this match** (T21c) — the same stamp the
     * ledger carries and for the same reason: on boot a process re-arms every
     * open match's deadlines and restarts the walks that died with it, and
     * doing that to a match another process is running means two machines on
     * one row, two servers for one match, and a probe against a provider that
     * has never heard of the other's server (`server lost before going live`).
     */
    deployment: text().notNull().default(DEFAULT_DEPLOYMENT),
    keyId: uuid('key_id')
      .notNull()
      .references(() => apiKeys.id),
    /** The client's own id — the idempotency key of `POST /v1/matches`, unique per key. */
    clientMatchId: text('client_match_id').notNull(),
    /** `MATCH_STATES` — `pending … cancelled`. */
    state: text().notNull(),
    /** When `state` was entered; the machine's deadlines count from here. */
    stateChangedAt: timestamptz('state_changed_at').notNull(),
    /** `cs2` | `csgo`. */
    game: text().notNull(),
    /** The gamemode id the request named. */
    gamemode: text().notNull(),
    /** The provider badge (`sim`, `dathost`, a node's), null before allocation. */
    provider: text(),
    /** The provider's handle for the server; `source.serverId` on every event. */
    serverId: text('server_id'),
    /** The open ledger row; the previous ones are found by `servers.match_id`. */
    fleetServerId: uuid('fleet_server_id'),
    /** From `ready` on. The join password is here because the client hands it to players. */
    connect: jsonb().$type<ServerConnect>(),
    tv: jsonb().$type<ServerTv>(),
    /** The last durable sequence number delivered; `match_events.seq` counts from 1. */
    seq: integer().notNull().default(0),
    /** The request, whole, as parsed — what the assignment and the config builders read. */
    requestJson: jsonb('request_json').$type<MatchRequest>().notNull(),
    /** SHA-256 of the canonical request body, for the `clientMatchId` conflict check. */
    requestHash: text('request_hash').notNull(),
    endedReason: jsonb('ended_reason').$type<MatchEndedReason>(),
    /** Present on the `sim` provider only. */
    sim: jsonb().$type<SimStatus>(),
    /** The reaper's deadline: `created_at` plus the effective ttl. */
    expiresAt: timestamptz('expires_at').notNull(),
    readyAt: timestamptz('ready_at'),
    liveAt: timestamptz('live_at'),
    endedAt: timestamptz('ended_at'),
    /** Set when the client's endpoint answered `410 Gone`: no later delivery is attempted. */
    webhooksStoppedAt: timestamptz('webhooks_stopped_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    uniqueIndex('matches_key_client_match_key').on(table.keyId, table.clientMatchId),
    // The key's list, newest first; and the machine's own "what is open" read.
    index('matches_key_created_idx').on(table.keyId, table.createdAt),
    index('matches_state_idx').on(table.state),
    // "What is *this deployment* still running" — the boot's resume (T21c).
    index('matches_deployment_state_idx').on(table.deployment, table.state),
  ],
)

/**
 * **The per-match durable log** (decision 6): every envelope the webhooks
 * carried, one row per `(match, seq)`, `seq` 1-based and gap-free per match.
 * `GET /v1/matches/:id/events?cursor=` reads it in order; the webhook worker
 * delivers from it; the stream's `event` frames mirror it. The envelope is
 * reconstructed from the row and its match (`client_match_id`), always in the
 * same key order, so a replay is byte-for-byte what the signer saw.
 */
export const matchEvents = pgTable(
  'match_events',
  {
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id),
    seq: integer().notNull(),
    /**
     * Names the envelope; a retry carries the same one. A column constraint
     * rather than an index so `webhook_deliveries` can reference it: a
     * foreign key needs the uniqueness to exist when it is declared.
     */
    deliveryId: uuid('delivery_id').notNull().unique('match_events_delivery_id_key'),
    /** `payload.type`, denormalised for filtering. */
    type: text().notNull(),
    /** The orchestrator's clock when it learned the fact, never a server's. */
    occurredAt: timestamptz('occurred_at').notNull(),
    payload: jsonb().$type<WebhookPayload>().notNull(),
  },
  table => [primaryKey({ columns: [table.matchId, table.seq] })],
)

/**
 * **Webhook deliveries** (`docs/match-api.md` "Retries"): one row per
 * envelope, the attempt count and the next try on the clock. The worker (T3)
 * polls `pending` rows whose `next_attempt_at` has passed, POSTs, and either
 * marks `delivered`, schedules the next attempt on `WEBHOOK_RETRY_DELAYS_MS`,
 * or gives up after `WEBHOOK_MAX_ATTEMPTS`; a `410` marks `stopped` and sets
 * `matches.webhooks_stopped_at`. The row outlives the delivery so
 * `fake.deliveries()`-style questions have a real answer.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    deliveryId: uuid('delivery_id')
      .primaryKey()
      .references(() => matchEvents.deliveryId),
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id),
    seq: integer().notNull(),
    url: text().notNull(),
    /** The secret id the signature's `kid` names. */
    secretId: text('secret_id').notNull(),
    /** `pending` | `delivered` | `stopped` | `given_up`. */
    status: text().notNull(),
    /** Attempts made so far; the next one is `attempt + 1`. */
    attempt: integer().notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at'),
    /** The endpoint's last answer, or null for a timeout or a connection error. */
    lastStatus: integer('last_status'),
    lastError: text('last_error'),
    deliveredAt: timestamptz('delivered_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    // The worker's one read: what is due.
    index('webhook_deliveries_due_idx').on(table.status, table.nextAttemptAt),
    index('webhook_deliveries_match_idx').on(table.matchId),
  ],
)

/**
 * **Commands, idempotent on `correlationId`** (`POST /v1/matches/:id/commands`).
 * A retried command with the same id is not applied twice: the first result
 * is returned, from here, across a restart. `result_json` is null while the
 * server has not answered (`accepted`); the `command_result` frame fills it.
 */
export const matchCommands = pgTable(
  'match_commands',
  {
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id),
    correlationId: text('correlation_id').notNull(),
    commandJson: jsonb('command_json').$type<MatchCommand>().notNull(),
    resultJson: jsonb('result_json').$type<MatchCommandResult>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [primaryKey({ columns: [table.matchId, table.correlationId] })],
)

/**
 * **Round backups** (decision 10, T14): small text, the latest few per match,
 * as MatchZy writes them and the plugin relays them over the link. A lost
 * server's match resumes on the next candidate from the newest row here.
 * Older rows are pruned at runtime, never by a migration.
 */
export const backups = pgTable(
  'backups',
  {
    id: uuidPk(),
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id),
    /** The ledger row that wrote it, for the story; null once that row is gone. */
    fleetServerId: uuid('fleet_server_id'),
    mapNumber: integer('map_number').notNull(),
    roundNumber: integer('round_number').notNull(),
    filename: text().notNull(),
    /** The backup file's text, at most `BACKUP_CONTENT_MAX` code units. */
    content: text().notNull(),
    createdAt: createdAt(),
  },
  table => [
    // One backup per round; a re-sent one replaces it.
    uniqueIndex('backups_match_round_key').on(table.matchId, table.mapNumber, table.roundNumber),
  ],
)

/**
 * **Player tokens** (decision 17, T24): a widget's key to one match and one
 * SteamID64, minted by the client, hashed here, dead with the match or at
 * `expires_at`. Rate limits are per token and live in memory.
 */
export const playerTokens = pgTable(
  'player_tokens',
  {
    id: uuidPk(),
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id),
    keyId: uuid('key_id')
      .notNull()
      .references(() => apiKeys.id),
    steamId64: text('steam_id64').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: createdAt(),
    revokedAt: timestamptz('revoked_at'),
  },
  table => [
    uniqueIndex('player_tokens_hash_key').on(table.tokenHash),
    index('player_tokens_match_idx').on(table.matchId),
  ],
)
