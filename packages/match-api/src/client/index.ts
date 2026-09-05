import { matchApiRoutes } from '../routes'
import { type ApiClient, type ClientOptions, createClient } from '../rpc'

/**
 * **The typed client**, generated from the route table: `client.matches.create(
 * { body })`, `client.fleet.nodes.enrol({ body })`, every call validated
 * against its route's schemas on the way out and on the way back, every
 * non-2xx an `ApiError` with the code from the envelope.
 *
 * This is the table-driven core; PRD-01 T7 grows it: idempotent create with an
 * `Idempotency-Key`, retries with backoff for `5xx` and `429` on an injected
 * clock, `subscribeStream(matchId)`. Nothing here reads a wall clock.
 */

export interface MatchApiClientOptions extends Omit<ClientOptions, 'headers'> {
  /** The API key, sent as `Authorization: Bearer`. */
  apiKey: string
}

export type MatchApiClient = ApiClient<typeof matchApiRoutes>

export function createMatchApiClient(options: MatchApiClientOptions): MatchApiClient {
  const { apiKey, ...rest } = options
  return createClient(matchApiRoutes, {
    ...rest,
    headers: () => ({ authorization: `Bearer ${apiKey}` }),
  })
}

export { ApiError } from '../errors'
export type { ApiClient, ClientOptions } from '../rpc'
