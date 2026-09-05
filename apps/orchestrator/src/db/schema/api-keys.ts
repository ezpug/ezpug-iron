import { sql } from 'drizzle-orm'
import { integer, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, timestamptz, uuidPk } from '../columns'

/**
 * **API keys** (decisions 7, 12; `docs/match-api.md` "Authentication and
 * scopes"). One row per key the platform or an operator holds; the secret is
 * shown once at mint and only its SHA-256 lives here, so a dump of this table
 * lets nobody call anything. Scopes are the closed set in `@ezpug/match-api`
 * as text, because the set is a contract and a Postgres enum would make a new
 * scope a migration.
 *
 * The three budget ceilings live on the row (decision 7): they are enforced
 * here against the ledger, whatever the caller says. `fleet_webhook_url` and
 * its secret id are the per-key fleet webhook PRD-02 T31 delivers to — columns
 * now, so no later task needs a migration for them.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuidPk(),
    /** An operator's label; unique among the keys that are not revoked. */
    name: text().notNull(),
    /** The first characters of the secret, so a human can tell keys apart in a list. */
    prefix: text().notNull(),
    /** SHA-256 of the secret, lowercase hex. The secret itself exists nowhere. */
    secretHash: text('secret_hash').notNull(),
    /** `matches` | `fleet` | `admin` — `MATCH_API_SCOPES`. */
    scopes: text().array().notNull(),
    budgetMaxConcurrentServers: integer('budget_max_concurrent_servers').notNull(),
    budgetMaxServerLifetimeMinutes: integer('budget_max_server_lifetime_minutes').notNull(),
    budgetMonthlyCents: integer('budget_monthly_cents').notNull(),
    /** Where this key's fleet facts go (T31); null means it reads the fleet routes instead. */
    fleetWebhookUrl: text('fleet_webhook_url'),
    /** The id (in `api_key_webhook_secrets`) that signs the fleet webhook. */
    fleetWebhookSecretId: text('fleet_webhook_secret_id'),
    createdAt: createdAt(),
    /** Last successful authentication, written at most once per throttle window. */
    lastUsedAt: timestamptz('last_used_at'),
    revokedAt: timestamptz('revoked_at'),
  },
  table => [
    // Authentication is one lookup by hash; two rows sharing one would make
    // revocation a lie.
    uniqueIndex('api_keys_secret_hash_key').on(table.secretHash),
    // A name is taken while its key lives; a revoked key frees it.
    uniqueIndex('api_keys_name_live_key').on(table.name).where(sql`revoked_at is null`),
  ],
)

/**
 * The webhook secrets a key registered (`PUT /v1/keys/:keyId/webhook-secrets`),
 * by the id a match request names in `callbacks.webhookSecretId`. These are
 * HMAC keys the orchestrator *signs with*, so they cannot be hashed the way
 * the API key is; they are the one credential this database holds in clear.
 * `docs/operations.md` says what that means for the box.
 */
export const apiKeyWebhookSecrets = pgTable(
  'api_key_webhook_secrets',
  {
    keyId: uuid('key_id')
      .notNull()
      .references(() => apiKeys.id),
    /** The client's own id for the secret — `whsec-2026-09`. */
    id: text().notNull(),
    secret: text().notNull(),
    createdAt: createdAt(),
  },
  table => [primaryKey({ columns: [table.keyId, table.id] })],
)
