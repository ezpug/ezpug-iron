import type { ApiKey, MatchApiScope } from '@ezpug/match-api'

/**
 * **What the key service needs from storage**, and nothing more: rows in,
 * rows out, by id or by the hash of a presented secret. Two implementations
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
  readonly fleetWebhookUrl: string | null
  readonly fleetWebhookSecretId: string | null
}

export interface InsertKeyInput {
  readonly id: string
  readonly name: string
  readonly prefix: string
  readonly secretHash: string
  readonly scopes: readonly MatchApiScope[]
  readonly budget: ApiKey['budget']
  readonly webhookSecrets: readonly { id: string; secret: string }[]
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
  /** Replace the whole set of webhook secrets. Undefined for an unknown id. */
  replaceWebhookSecrets: (
    id: string,
    secrets: readonly { id: string; secret: string }[],
    at: Date,
  ) => Promise<KeyRecord | undefined>
  /** Move `lastUsedAt` forward, never back. */
  touch: (id: string, at: Date) => Promise<void>
}

/** A live key already carries this name (`conflict` on the wire). */
export class KeyNameTakenError extends Error {
  override readonly name = 'KeyNameTakenError'
  constructor(readonly keyName: string) {
    super(`an API key named ${JSON.stringify(keyName)} already exists`)
  }
}
