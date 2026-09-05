import type { ApiKey, MatchApiScope } from '@ezpug/match-api'
import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import type { DatabaseExecutor } from '../db/client'
import { apiKeyBudgetNotices, apiKeys, apiKeyWebhookSecrets } from '../db/schema'
import { KeyNameTakenError, type KeyRecord, type KeyStore } from './store'

type KeyRow = typeof apiKeys.$inferSelect
type SecretRow = typeof apiKeyWebhookSecrets.$inferSelect

/** Postgres' unique-violation code — the name index refusing a duplicate. */
const UNIQUE_VIOLATION = '23505'

function toRecord(row: KeyRow, secrets: readonly SecretRow[]): KeyRecord {
  const webhookSecrets = new Map(secrets.map(secret => [secret.id, secret.secret]))
  const key: ApiKey = {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes as MatchApiScope[],
    budget: {
      maxConcurrentServers: row.budgetMaxConcurrentServers,
      maxServerLifetimeMinutes: row.budgetMaxServerLifetimeMinutes,
      monthlyCents: row.budgetMonthlyCents,
    },
    webhookSecretIds: [...webhookSecrets.keys()],
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  }
  return {
    key,
    secretHash: row.secretHash,
    webhookSecrets,
    fleetWebhookUrl: row.fleetWebhookUrl,
    fleetWebhookSecretId: row.fleetWebhookSecretId,
  }
}

/**
 * The Postgres {@link KeyStore}, over `api_keys` and
 * `api_key_webhook_secrets`. Takes a `DatabaseExecutor`, not a connection:
 * pass a transaction and a mint commits together with whatever caused it.
 */
export function createPostgresKeyStore(executor: DatabaseExecutor): KeyStore {
  const secretsFor = async (ids: readonly string[]): Promise<Map<string, SecretRow[]>> => {
    const grouped = new Map<string, SecretRow[]>()
    if (ids.length === 0) return grouped
    const rows = await executor
      .select()
      .from(apiKeyWebhookSecrets)
      .where(inArray(apiKeyWebhookSecrets.keyId, [...ids]))
      .orderBy(apiKeyWebhookSecrets.createdAt, apiKeyWebhookSecrets.id)
    for (const row of rows) {
      const list = grouped.get(row.keyId) ?? []
      list.push(row)
      grouped.set(row.keyId, list)
    }
    return grouped
  }

  const one = async (row: KeyRow | undefined): Promise<KeyRecord | undefined> => {
    if (!row) return undefined
    const secrets = await secretsFor([row.id])
    return toRecord(row, secrets.get(row.id) ?? [])
  }

  return {
    insert: async input => {
      try {
        await executor.transaction(async tx => {
          await tx.insert(apiKeys).values({
            id: input.id,
            name: input.name,
            prefix: input.prefix,
            secretHash: input.secretHash,
            scopes: [...input.scopes],
            budgetMaxConcurrentServers: input.budget.maxConcurrentServers,
            budgetMaxServerLifetimeMinutes: input.budget.maxServerLifetimeMinutes,
            budgetMonthlyCents: input.budget.monthlyCents,
            createdAt: input.createdAt,
          })
          if (input.webhookSecrets.length > 0)
            await tx.insert(apiKeyWebhookSecrets).values(
              input.webhookSecrets.map(secret => ({
                keyId: input.id,
                id: secret.id,
                secret: secret.secret,
                createdAt: input.createdAt,
              })),
            )
        })
      } catch (error) {
        if (isUniqueViolation(error, 'api_keys_name_live_key'))
          throw new KeyNameTakenError(input.name)
        throw error
      }
      const inserted = await one(
        (await executor.select().from(apiKeys).where(eq(apiKeys.id, input.id)))[0],
      )
      if (!inserted) throw new Error(`api key ${input.id} vanished after insert`)
      return inserted
    },

    findById: async id => one((await executor.select().from(apiKeys).where(eq(apiKeys.id, id)))[0]),

    findBySecretHash: async secretHash =>
      one((await executor.select().from(apiKeys).where(eq(apiKeys.secretHash, secretHash)))[0]),

    list: async () => {
      const rows = await executor.select().from(apiKeys).orderBy(desc(apiKeys.createdAt))
      const secrets = await secretsFor(rows.map(row => row.id))
      return rows.map(row => toRecord(row, secrets.get(row.id) ?? []))
    },

    revoke: async (id, at) => {
      // `revoked_at is null` in the WHERE is what makes a second revoke a
      // no-op instead of a rewrite — the first one is the fact worth keeping.
      await executor
        .update(apiKeys)
        .set({ revokedAt: at })
        .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
      return one((await executor.select().from(apiKeys).where(eq(apiKeys.id, id)))[0])
    },

    replaceWebhookSecrets: async (id, secrets, at) => {
      const existing = (await executor.select().from(apiKeys).where(eq(apiKeys.id, id)))[0]
      if (!existing) return undefined
      await executor.transaction(async tx => {
        await tx.delete(apiKeyWebhookSecrets).where(eq(apiKeyWebhookSecrets.keyId, id))
        if (secrets.length > 0)
          await tx.insert(apiKeyWebhookSecrets).values(
            secrets.map(secret => ({
              keyId: id,
              id: secret.id,
              secret: secret.secret,
              createdAt: at,
            })),
          )
      })
      return one(existing)
    },

    rotateSecret: async (id, secret) => {
      // A revoked key is not rotated back to life: the service refuses it
      // before this, and the WHERE says so again.
      await executor
        .update(apiKeys)
        .set({ secretHash: secret.secretHash, prefix: secret.prefix })
        .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
      return one((await executor.select().from(apiKeys).where(eq(apiKeys.id, id)))[0])
    },

    setBudget: async (id, patch) => {
      const existing = (await executor.select().from(apiKeys).where(eq(apiKeys.id, id)))[0]
      if (!existing) return undefined
      await executor.transaction(async tx => {
        await tx
          .update(apiKeys)
          .set({
            ...(patch.maxConcurrentServers !== undefined && {
              budgetMaxConcurrentServers: patch.maxConcurrentServers,
            }),
            ...(patch.maxServerLifetimeMinutes !== undefined && {
              budgetMaxServerLifetimeMinutes: patch.maxServerLifetimeMinutes,
            }),
            ...(patch.monthlyCents !== undefined && { budgetMonthlyCents: patch.monthlyCents }),
          })
          .where(eq(apiKeys.id, id))
        await tx.delete(apiKeyBudgetNotices).where(eq(apiKeyBudgetNotices.keyId, id))
      })
      return one((await executor.select().from(apiKeys).where(eq(apiKeys.id, id)))[0])
    },

    markBudgetNotice: async (notice, at) => {
      // The primary key is the lock: two processes racing the same crossing
      // means exactly one insert, so exactly one of them announces.
      const inserted = await executor
        .insert(apiKeyBudgetNotices)
        .values({
          keyId: notice.keyId,
          limit: notice.limit,
          fraction: String(notice.fraction),
          monthStartedAt: notice.monthStartedAt,
          sentAt: at,
        })
        .onConflictDoNothing()
        .returning({ keyId: apiKeyBudgetNotices.keyId })
      return inserted.length > 0
    },

    clearBudgetNotices: async id => {
      await executor.delete(apiKeyBudgetNotices).where(eq(apiKeyBudgetNotices.keyId, id))
    },

    touch: async (id, at) => {
      // Only ever moves forward: two processes racing must not make "last
      // used" go backwards.
      await executor
        .update(apiKeys)
        .set({ lastUsedAt: at })
        .where(and(eq(apiKeys.id, id), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, at))))
    },
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const cause = error instanceof Error && error.cause ? error.cause : error
  const code = (cause as { code?: unknown } | undefined)?.code
  const name = (cause as { constraint_name?: unknown } | undefined)?.constraint_name
  return code === UNIQUE_VIOLATION && name === constraint
}
