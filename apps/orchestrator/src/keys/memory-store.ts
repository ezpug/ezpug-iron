import type { ApiKey } from '@ezpug/match-api'
import { type BudgetNotice, KeyNameTakenError, type KeyRecord, type KeyStore } from './store'

const noticeKey = (notice: BudgetNotice): string =>
  [notice.keyId, notice.limit, notice.fraction, notice.monthStartedAt.toISOString()].join('|')

interface MemoryRow {
  key: ApiKey
  secretHash: string
  webhookSecrets: Map<string, string>
  fleetWebhookUrl: string | null
  fleetWebhookSecretId: string | null
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null)

function view(row: MemoryRow): KeyRecord {
  return {
    key: { ...row.key, webhookSecretIds: [...row.webhookSecrets.keys()] },
    secretHash: row.secretHash,
    webhookSecrets: new Map(row.webhookSecrets),
    fleetWebhookUrl: row.fleetWebhookUrl,
    fleetWebhookSecretId: row.fleetWebhookSecretId,
  }
}

/**
 * The in-memory {@link KeyStore}: the same contract as the Postgres one,
 * for every test of the HTTP rails that has nothing to prove about a
 * database. Insertion order is creation order; `list()` answers newest first
 * like the real one.
 */
export function createMemoryKeyStore(): KeyStore {
  const rows: MemoryRow[] = []
  const notices = new Set<string>()
  const byId = (id: string): MemoryRow | undefined => rows.find(row => row.key.id === id)

  return {
    insert: input => {
      if (rows.some(row => row.key.name === input.name && row.key.revokedAt === null))
        throw new KeyNameTakenError(input.name)
      const row: MemoryRow = {
        key: {
          id: input.id,
          name: input.name,
          prefix: input.prefix,
          scopes: [...input.scopes],
          budget: { ...input.budget },
          webhookSecretIds: input.webhookSecrets.map(s => s.id),
          createdAt: input.createdAt.toISOString(),
          lastUsedAt: null,
          revokedAt: null,
        },
        secretHash: input.secretHash,
        webhookSecrets: new Map(input.webhookSecrets.map(s => [s.id, s.secret])),
        fleetWebhookUrl: null,
        fleetWebhookSecretId: null,
      }
      rows.push(row)
      return Promise.resolve(view(row))
    },
    findById: id => {
      const row = byId(id)
      return Promise.resolve(row ? view(row) : undefined)
    },
    findBySecretHash: secretHash => {
      const row = rows.find(candidate => candidate.secretHash === secretHash)
      return Promise.resolve(row ? view(row) : undefined)
    },
    list: () => Promise.resolve([...rows].reverse().map(view)),
    revoke: (id, at) => {
      const row = byId(id)
      if (!row) return Promise.resolve(undefined)
      row.key.revokedAt ??= iso(at)
      return Promise.resolve(view(row))
    },
    replaceWebhookSecrets: (id, secrets) => {
      const row = byId(id)
      if (!row) return Promise.resolve(undefined)
      row.webhookSecrets = new Map(secrets.map(s => [s.id, s.secret]))
      return Promise.resolve(view(row))
    },
    rotateSecret: (id, secret) => {
      const row = byId(id)
      if (!row) return Promise.resolve(undefined)
      row.secretHash = secret.secretHash
      row.key.prefix = secret.prefix
      return Promise.resolve(view(row))
    },
    setBudget: (id, patch) => {
      const row = byId(id)
      if (!row) return Promise.resolve(undefined)
      row.key.budget = { ...row.key.budget, ...patch }
      for (const mark of [...notices]) if (mark.startsWith(`${id}|`)) notices.delete(mark)
      return Promise.resolve(view(row))
    },
    markBudgetNotice: notice => {
      const mark = noticeKey(notice)
      if (notices.has(mark)) return Promise.resolve(false)
      notices.add(mark)
      return Promise.resolve(true)
    },
    clearBudgetNotices: id => {
      for (const mark of [...notices]) if (mark.startsWith(`${id}|`)) notices.delete(mark)
      return Promise.resolve()
    },
    touch: (id, at) => {
      const row = byId(id)
      if (row && (!row.key.lastUsedAt || new Date(row.key.lastUsedAt) < at))
        row.key.lastUsedAt = at.toISOString()
      return Promise.resolve()
    },
  }
}
