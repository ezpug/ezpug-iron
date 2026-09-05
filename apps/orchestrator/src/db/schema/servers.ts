import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, timestamptz, uuidPk } from '../columns'
import { apiKeys } from './api-keys'
import type { FleetServerAddress, ServerTv, ServerVersions } from './types'

/**
 * **The ledger** (decision 7, CLAUDE.md "every server is a ledger row"): one
 * row per server the orchestrator ever asked a provider for. The row is
 * written *before* the provider returns (`allocated`, `server_id` null),
 * filled in when it answers, closed (`released` | `failed`) when the server
 * is gone; the reaper reconciles provider truth against rows and never the
 * other way round. "What is running" is `released_at is null`; "what did
 * tonight cost" is `cost_hourly_cents` times the row's open time.
 *
 * What is **not** here: a password. The join password is the match's
 * (`matches.connect`) because the client is handed it; the RCON password is
 * the provider's to know (Dathost answers it, a node holds it) and this
 * process asks for it at the moment it needs it (T20). The server token is
 * hashed in `server_tokens`.
 *
 * The link's facts (T6) land on this row too — `last_seen_at`, `link_state`,
 * `versions`, `link_acked_seq` — so a reconnecting server's `welcome.ackedSeq`
 * and the reaper's silence check read one table.
 */
export const servers = pgTable(
  'servers',
  {
    id: uuidPk(),
    /** The provider id (`sim`, `dathost`, `nodes`). */
    provider: text().notNull(),
    /** The provider's handle for the server; null while `allocated` and not yet delivered. */
    serverId: text('server_id'),
    /** The node hosting it, for the node provider. */
    nodeId: text('node_id'),
    /** The match it was obtained for. */
    matchId: uuid('match_id'),
    /** The API key that pays for it. */
    keyId: uuid('key_id')
      .notNull()
      .references(() => apiKeys.id),
    /** `FLEET_SERVER_STATES` — `allocated … failed`. */
    state: text().notNull(),
    game: text().notNull(),
    region: text(),
    lan: boolean().notNull().default(false),
    /** Host and port, never the password. */
    address: jsonb().$type<FleetServerAddress>(),
    tv: jsonb().$type<ServerTv>(),
    /** The provider's price at allocation, integer euro cents per hour; 0 on a node. */
    costHourlyCents: integer('cost_hourly_cents').notNull(),
    /** The GSLT leased to this server (T17), null on a node. */
    gsltTokenId: uuid('gslt_token_id'),
    /** Provider-private handle details (a Dathost server's raw id, a node's container id). */
    providerMeta: jsonb('provider_meta').$type<Record<string, unknown>>(),
    /** What the server reported in `hello` (T6). */
    versions: jsonb().$type<ServerVersions>(),
    hostname: text(),
    currentMap: text('current_map'),
    /** The server's own `LINK_SERVER_STATES` as last reported over the link. */
    linkState: text('link_state'),
    /** The last link `seq` acknowledged; `welcome.ackedSeq` on reconnect. */
    linkAckedSeq: integer('link_acked_seq').notNull().default(0),
    /** Last heartbeat or frame over the link; silence past two intervals is a probe. */
    lastSeenAt: timestamptz('last_seen_at'),
    /** Every RCON line an operator sent through this process and what came back (T20). */
    rconAudit: jsonb('rcon_audit').$type<RconAuditEntry[]>().notNull().default([]),
    lastError: text('last_error'),
    releasedReason: text('released_reason'),
    allocatedAt: createdAt('allocated_at'),
    releasedAt: timestamptz('released_at'),
    /** The reaper's deadline for this row. */
    expiresAt: timestamptz('expires_at').notNull(),
  },
  table => [
    // Open rows, the fleet's one question.
    index('servers_open_idx').on(table.provider, table.releasedAt),
    index('servers_match_idx').on(table.matchId),
    index('servers_key_allocated_idx').on(table.keyId, table.allocatedAt),
  ],
)

/** One line of the ledger's RCON audit. */
export interface RconAuditEntry {
  at: string
  keyId: string
  command: string
  output: string
}

/**
 * **Server tokens** (decision 5): the per-server credential a plugin presents
 * in `hello`. Minted at allocation, uploaded to the server (Dathost's
 * `ezpug.json`, a node's container env), hashed here, revoked when the row
 * closes. One live token per row; a re-issue revokes the old one.
 */
export const serverTokens = pgTable(
  'server_tokens',
  {
    id: uuidPk(),
    fleetServerId: uuid('fleet_server_id')
      .notNull()
      .references(() => servers.id),
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamptz('last_used_at'),
    revokedAt: timestamptz('revoked_at'),
  },
  table => [
    uniqueIndex('server_tokens_hash_key').on(table.tokenHash),
    index('server_tokens_server_idx').on(table.fleetServerId),
  ],
)

/**
 * **Nodes** (decision 23): every `ezpug-node` ever enrolled, by the kebab id
 * the operator chose. Connection facts are written by the node link (T11,
 * T12); a disconnected node keeps its row and advertises zero. `token_hash`
 * is the node token issued after the enrolment `hello`; null until then.
 */
export const nodes = pgTable('nodes', {
  /** The operator's name for it (`saarlan-rack-2`). */
  id: text().primaryKey(),
  region: text().notNull(),
  labels: jsonb().$type<Record<string, string>>().notNull().default({}),
  /** The agent's version, as it reported it; null before the first hello. */
  version: text(),
  /** The image digest the node holds, from its last hello. */
  imageDigest: text('image_digest'),
  connected: boolean().notNull().default(false),
  drained: boolean().notNull().default(false),
  capacityTotal: integer('capacity_total').notNull().default(0),
  capacityInUse: integer('capacity_in_use').notNull().default(0),
  capacityWarm: integer('capacity_warm').notNull().default(0),
  /** SHA-256 of the node token; null until the enrolment hello. */
  tokenHash: text('token_hash'),
  lastSeenAt: timestamptz('last_seen_at'),
  enrolledAt: createdAt('enrolled_at'),
  revokedAt: timestamptz('revoked_at'),
})

/**
 * **Enrolments**: the one-time token `POST /v1/fleet/nodes` shows once. A
 * node presents it in its first `hello`, gets a node token back, and the
 * enrolment is spent (`used_at`). Expired or spent rows are refused.
 */
export const nodeEnrolments = pgTable(
  'node_enrolments',
  {
    id: uuidPk(),
    nodeId: text('node_id')
      .notNull()
      .references(() => nodes.id),
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
  },
  table => [uniqueIndex('node_enrolments_hash_key').on(table.tokenHash)],
)

/**
 * **The GSLT pool** (T17): the Steam game server accounts this deployment
 * minted, one login token each, leased to a server at allocation and
 * released with its row. The login token is a credential the orchestrator
 * has to *present* to a provider, so it is held in clear, like a webhook
 * secret; `docs/operations.md` says what that means. A node needs none.
 */
export const gsltTokens = pgTable(
  'gslt_tokens',
  {
    id: uuidPk(),
    /** The game server account's SteamID, as Steam returns it. */
    steamId: text('steam_id').notNull(),
    appId: integer('app_id').notNull().default(730),
    loginToken: text('login_token').notNull(),
    /** The memo the account was created with (`ezpug-iron <hostname>`). */
    memo: text().notNull(),
    /** The ledger row holding it, or null in the pool. */
    leasedByServerId: uuid('leased_by_server_id'),
    leasedAt: timestamptz('leased_at'),
    /** The last `ResetLoginToken` after a lost server. */
    lastResetAt: timestamptz('last_reset_at'),
    createdAt: createdAt(),
    /** Deleted at Steam (`DeleteAccount`); the row stays for the story. */
    deletedAt: timestamptz('deleted_at'),
  },
  table => [uniqueIndex('gslt_tokens_steam_id_key').on(table.steamId)],
)
