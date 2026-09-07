import type { ApiKey, FleetWebhook, MatchApiScope } from '@ezpug/match-api'

/**
 * **What the key service needs from storage**, and nothing more: rows in,
 * rows out, by id or by the hash of a presented secret, plus the one thing
 * the budget service needs to keep a promise across a restart — which
 * threshold warnings this key has already been sent. Two implementations
 * — Postgres (`postgres-store.ts`, over `api_keys`) and memory
 * (`memory-store.ts`, for the app's own tests) — so the HTTP rails are proven
 * without a database and the store is proven against one.
 */

/** A key as the store holds it: the public resource plus what auth needs. */
export interface KeyRecord {
  readonly key: ApiKey
  /** SHA-256 of the secret. */
  readonly secretHash: string
  /** The registered webhook secrets, by id, in clear (they sign). */
  readonly webhookSecrets: ReadonlyMap<string, string>
}

export interface InsertKeyInput {
  readonly id: string
  readonly name: string
  readonly prefix: string
  readonly secretHash: string
  readonly scopes: readonly MatchApiScope[]
  readonly budget: ApiKey['budget']
  readonly webhookSecrets: readonly { id: string; secret: string }[]
  /** Registered at the mint; `setFleetWebhook` moves it later. Absent is none. */
  readonly fleetWebhook?: FleetWebhook | null
  readonly createdAt: Date
}

export interface KeyStore {
  /** Throws {@link KeyNameTakenError} when a live key already carries the name. */
  insert: (input: InsertKeyInput) => Promise<KeyRecord>
  findById: (id: string) => Promise<KeyRecord | undefined>
  findBySecretHash: (secretHash: string) => Promise<KeyRecord | undefined>
  /** Every key, revoked ones included, newest first. */
  list: () => Promise<KeyRecord[]>
  /** Idempotent: a second revoke keeps the first `revokedAt`. Undefined for an unknown id. */
  revoke: (id: string, at: Date) => Promise<KeyRecord | undefined>
  /**
   * Register (or clear) where the key's `fleet.*` facts are POSTed (T31).
   * Undefined for an unknown id; the caller has already checked that the
   * `secretId` is one of the key's own.
   */
  setFleetWebhook: (
    id: string,
    fleetWebhook: FleetWebhook | null,
    at: Date,
  ) => Promise<KeyRecord | undefined>
  /** Replace the whole set of webhook secrets. Undefined for an unknown id. */
  replaceWebhookSecrets: (
    id: string,
    secrets: readonly { id: string; secret: string }[],
    at: Date,
  ) => Promise<KeyRecord | undefined>
  /** Draw a new secret for a live key; the old hash is gone. Undefined for an unknown id. */
  rotateSecret: (
    id: string,
    secret: { prefix: string; secretHash: string },
    at: Date,
  ) => Promise<KeyRecord | undefined>
  /**
   * Move one or more ceilings. Undefined for an unknown id. Clears the key's
   * budget notices with it — a ceiling that moved is a new crossing.
   */
  setBudget: (
    id: string,
    patch: Partial<ApiKey['budget']>,
    at: Date,
  ) => Promise<KeyRecord | undefined>

  /**
   * Record that a `fleet.budget_threshold` was said for this key, ceiling,
   * fraction and month. **True when it is the first time** — the caller
   * announces only then, so a restart never repeats a crossing.
   */
  markBudgetNotice: (notice: BudgetNotice, at: Date) => Promise<boolean>
  /** Forget this key's notices — a moved ceiling, or a test. */
  clearBudgetNotices: (id: string) => Promise<void>

  /** Move `lastUsedAt` forward, never back. */
  touch: (id: string, at: Date) => Promise<void>
}

/** One threshold warning, by the four things that make it unique. */
export interface BudgetNotice {
  readonly keyId: string
  readonly limit: string
  readonly fraction: number
  readonly monthStartedAt: Date
}

/** A live key already carries this name (`conflict` on the wire). */
export class KeyNameTakenError extends Error {
  override readonly name = 'KeyNameTakenError'
  constructor(readonly keyName: string) {
    super(`an API key named ${JSON.stringify(keyName)} already exists`)
  }
}
