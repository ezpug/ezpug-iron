import { randomUUID } from 'node:crypto'
import type { Clock } from '@ezpug/core'
import {
  ApiError,
  type ApiKey,
  type ApiKeyCreated,
  type ApiKeyCreateRequest,
  type BudgetPatchRequest,
  type FleetWebhookRequest,
  MATCH_API_ERROR_STATUS,
  type WebhookSecretsRequest,
} from '@ezpug/match-api'
import { apiKeyPrefix, hashToken, looksLikeToken, mintToken, type RandomBytes } from '../tokens'
import { KeyNameTakenError, type KeyRecord, type KeyStore } from './store'

/**
 * **API keys, the service**: mint (the secret shown once, only its hash
 * kept), authenticate a bearer, list, revoke, rotate the secret, move the
 * ceilings, rotate webhook secrets, and the throttled "last used" touch. The
 * scope gate is not here — it is the dispatch's, from the route table
 * (`http/dispatch.ts`) — and enforcing the ceilings is the budget service's
 * (`../budget/service.ts`); this is the identity half of decision 7.
 */

/**
 * How often `lastUsedAt` is written per key: once a minute at most. It is a
 * "still alive" signal for an operator's list, not an access log, and a
 * write per request would be the busiest statement in the process.
 */
export const KEY_TOUCH_INTERVAL_MS = 60_000

export interface KeysOptions {
  store: KeyStore
  clock: Clock
  /** Injectable for a test that wants to pin a secret's shape; defaults to the CSPRNG. */
  random?: RandomBytes
  /** Where a failed touch is reported — never a request failure. */
  onError?: (error: unknown, context: Record<string, unknown>) => void
}

/** The key behind a request, as every handler sees it. */
export interface AuthenticatedKey {
  readonly key: ApiKey
  readonly webhookSecrets: ReadonlyMap<string, string>
}

export interface Keys {
  /** Mint a key. The secret is in the answer and nowhere else, ever. */
  mint: (request: ApiKeyCreateRequest) => Promise<ApiKeyCreated>
  /**
   * Mint a key whose secret is **given** rather than drawn, unless a live key
   * already carries it. The one caller is the dev bootstrap key
   * (`keys/bootstrap.ts`, PRD-02 T4), where another project's compose file
   * decided the secret before this process existed; production refuses it a
   * layer up, in the configuration. Idempotent: a restart adopts the key it
   * adopted last time.
   */
  adopt: (
    secret: string,
    request: ApiKeyCreateRequest,
  ) => Promise<ApiKeyCreated & { created: boolean }>
  /** Resolve a bearer to its key, or throw `unauthorized`. Touches `lastUsedAt` on the clock's schedule. */
  authenticate: (bearer: string | null) => Promise<AuthenticatedKey>
  list: () => Promise<ApiKey[]>
  /** Revoke; `not_found` for an unknown id. Idempotent. */
  revoke: (id: string) => Promise<ApiKey>
  /**
   * Draw the key a new secret and kill the old one on the spot — what an
   * operator does when a key leaked. `not_found` for an unknown id,
   * `invalid_state` for a revoked one (revoking is the way to end a key;
   * rotation must never bring one back).
   */
  rotate: (id: string) => Promise<ApiKeyCreated>
  /** Move one or more of the three ceilings; `not_found` for an unknown id. */
  setBudget: (id: string, patch: BudgetPatchRequest) => Promise<ApiKey>
  /** Replace the registered webhook secrets; `not_found` for an unknown id. */
  setWebhookSecrets: (id: string, request: WebhookSecretsRequest) => Promise<ApiKey>
  /**
   * Register (or clear) where the key's `fleet.*` facts go (T31).
   * `not_found` for an unknown id, `validation_failed` when the `secretId` is
   * not one the key registered.
   */
  setFleetWebhook: (id: string, request: FleetWebhookRequest) => Promise<ApiKey>
  get: (id: string) => Promise<AuthenticatedKey | undefined>
}

function unauthorized(message: string): ApiError {
  return new ApiError(MATCH_API_ERROR_STATUS.unauthorized, 'unauthorized', message)
}

function notFound(id: string): ApiError {
  return new ApiError(MATCH_API_ERROR_STATUS.not_found, 'not_found', `no API key ${id}`)
}

function toAuthenticated(record: KeyRecord): AuthenticatedKey {
  return { key: record.key, webhookSecrets: record.webhookSecrets }
}

export function createKeys(options: KeysOptions): Keys {
  const { store, clock } = options
  const onError = options.onError ?? ((error, context) => console.error(context, error))
  /** When each key was last touched, per process — the throttle's memory. */
  const touched = new Map<string, number>()

  const touch = (id: string): void => {
    const now = clock.now()
    const last = touched.get(id)
    if (last !== undefined && now - last < KEY_TOUCH_INTERVAL_MS) return
    touched.set(id, now)
    void store.touch(id, clock.date()).catch((error: unknown) => {
      onError(error, { op: 'keys.touch', keyId: id })
    })
  }

  /** The one place a row is written, whoever decided the secret. */
  const insert = async (secret: string, request: ApiKeyCreateRequest): Promise<ApiKeyCreated> => {
    try {
      const record = await store.insert({
        id: randomUUID(),
        name: request.name,
        prefix: apiKeyPrefix(secret),
        secretHash: hashToken(secret),
        scopes: request.scopes,
        budget: request.budget,
        webhookSecrets: request.webhookSecrets,
        fleetWebhook: request.fleetWebhook ?? null,
        createdAt: clock.date(),
      })
      return { key: record.key, secret }
    } catch (error) {
      if (error instanceof KeyNameTakenError)
        throw new ApiError(MATCH_API_ERROR_STATUS.conflict, 'conflict', error.message, {
          name: request.name,
        })
      throw error
    }
  }

  return {
    mint: request => insert(mintToken('apiKey', options.random), request),

    async adopt(secret, request) {
      const existing = await store.findBySecretHash(hashToken(secret))
      if (existing && !existing.key.revokedAt) return { key: existing.key, secret, created: false }
      const { key } = await insert(secret, request)
      return { key, secret, created: true }
    },

    async authenticate(bearer) {
      if (!bearer) throw unauthorized('no API key — send `Authorization: Bearer <key>`')
      // The shape check is a free refusal before a lookup: a bearer that is
      // not one of ours never reaches the database.
      if (!looksLikeToken('apiKey', bearer)) throw unauthorized('the API key is not one of ours')
      const record = await store.findBySecretHash(hashToken(bearer))
      if (!record) throw unauthorized('unknown API key')
      if (record.key.revokedAt) throw unauthorized('the API key was revoked')
      touch(record.key.id)
      return toAuthenticated(record)
    },

    async list() {
      return (await store.list()).map(record => record.key)
    },

    async revoke(id) {
      const record = await store.revoke(id, clock.date())
      if (!record) throw notFound(id)
      return record.key
    },

    async rotate(id) {
      const existing = await store.findById(id)
      if (!existing) throw notFound(id)
      if (existing.key.revokedAt)
        throw new ApiError(
          MATCH_API_ERROR_STATUS.invalid_state,
          'invalid_state',
          `API key ${id} was revoked`,
        )
      const secret = mintToken('apiKey', options.random)
      const record = await store.rotateSecret(
        id,
        { prefix: apiKeyPrefix(secret), secretHash: hashToken(secret) },
        clock.date(),
      )
      if (!record) throw notFound(id)
      // The throttle remembers the key by id, not by secret; the new secret
      // should still touch on its first use.
      touched.delete(id)
      return { key: record.key, secret }
    },

    async setBudget(id, patch) {
      const record = await store.setBudget(id, patch, clock.date())
      if (!record) throw notFound(id)
      return record.key
    },

    async setWebhookSecrets(id, request) {
      const record = await store.replaceWebhookSecrets(id, request.secrets, clock.date())
      if (!record) throw notFound(id)
      return record.key
    },

    /**
     * The `secretId` has to be one the key registered: an endpoint whose
     * envelopes are signed with a `kid` no verifier knows fails silently at
     * three in the morning, and a refusal now is the whole of the cure.
     */
    async setFleetWebhook(id, request) {
      const existing = await store.findById(id)
      if (!existing) throw notFound(id)
      const { fleetWebhook } = request
      if (fleetWebhook && !existing.webhookSecrets.has(fleetWebhook.secretId))
        throw new ApiError(
          MATCH_API_ERROR_STATUS.validation_failed,
          'validation_failed',
          `no webhook secret ${fleetWebhook.secretId} is registered on API key ${id}`,
        )
      const record = await store.setFleetWebhook(id, fleetWebhook, clock.date())
      if (!record) throw notFound(id)
      return record.key
    },

    async get(id) {
      const record = await store.findById(id)
      return record ? toAuthenticated(record) : undefined
    },
  }
}
