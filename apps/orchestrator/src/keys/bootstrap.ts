import type { ApiKey, ApiKeyCreateRequest, MatchApiScope } from '@ezpug/match-api'
import { ApiError } from '@ezpug/match-api'
import type { Keys } from './service'

/**
 * **The dev bootstrap key** (PRD-02 T4): the one door another project's dev
 * world can walk through without a human minting anything.
 *
 * The offline-first rule (CLAUDE.md) says the platform's `pnpm dev:up` must
 * bring up a working orchestrator on its own. It cannot: a key is shown once,
 * at mint, and a compose file has nobody to show it to. So the contract runs
 * the other way — the *consumer* decides the secret, puts it in its compose
 * beside the image, and this process adopts it at boot:
 * `EZPUG_IRON_BOOTSTRAP_API_KEY=ezik_…`.
 *
 * The rules that keep it honest:
 *
 * - **Dev only.** `readOrchestratorConfig` refuses the variable under
 *   `NODE_ENV=production`, and {@link ensureBootstrapKey} refuses it again
 *   here — a secret that lives in an environment variable in clear is a
 *   convenience, never a production credential.
 * - **Idempotent.** A restart with the same value adopts the key it adopted
 *   last time; nothing is written and no second key appears.
 * - **One bootstrap key at a time.** Change the value and the previous one is
 *   *revoked*, not left live: the environment says which key the dev world
 *   holds, and a key nobody can see any more is a key nobody should be able
 *   to use.
 * - **Never logged.** The caller learns the key's id and name, and the secret
 *   stays in the environment it came from.
 */

/** The name the adopted key carries, and the name a stale one is found by. */
export const BOOTSTRAP_KEY_NAME = 'bootstrap'

/**
 * Everything, because a dev world drives every route: matches, the fleet
 * console and the keys door itself (so an operator can mint a narrower key
 * from it without touching the box).
 */
export const BOOTSTRAP_KEY_SCOPES: readonly MatchApiScope[] = ['matches', 'fleet', 'admin']

/**
 * A dev budget, not a production one: four servers at a time, four hours
 * each, and **no money** — `monthlyCents: 0` is a ceiling of zero, not the
 * absence of one (T5). The sim and a node cost nothing, so a dev world runs
 * unhindered; a dev world pointed at a paying provider is refused
 * `budget_exceeded` on the first request, which is the honest answer, and
 * the operator raises the ceiling with `PATCH /v1/keys/:keyId/budget`.
 */
export const BOOTSTRAP_KEY_BUDGET = {
  maxConcurrentServers: 4,
  maxServerLifetimeMinutes: 240,
  monthlyCents: 0,
} as const

export interface EnsureBootstrapKeyOptions {
  keys: Keys
  /** The secret the environment carries — the key's identity, not a hint. */
  secret: string
  /** `config.production`; true refuses. */
  production: boolean
  /** Override for a test that wants two bootstrap keys side by side. */
  name?: string
}

export interface BootstrapKeyOutcome {
  key: ApiKey
  /** False when the key already existed — the normal restart. */
  created: boolean
  /** The id of the key this one replaced, when the secret changed. */
  revoked: string | null
}

export function bootstrapKeyRequest(name = BOOTSTRAP_KEY_NAME): ApiKeyCreateRequest {
  return {
    name,
    scopes: [...BOOTSTRAP_KEY_SCOPES],
    budget: { ...BOOTSTRAP_KEY_BUDGET },
    webhookSecrets: [],
  }
}

export async function ensureBootstrapKey(
  options: EnsureBootstrapKeyOptions,
): Promise<BootstrapKeyOutcome> {
  const { keys, secret, production } = options
  const name = options.name ?? BOOTSTRAP_KEY_NAME
  if (production)
    throw new Error('the bootstrap API key is a dev-only door and is refused in production')

  const request = bootstrapKeyRequest(name)
  try {
    const adopted = await keys.adopt(secret, request)
    return { key: adopted.key, created: adopted.created, revoked: null }
  } catch (error) {
    // The name is taken by a live key whose secret is not this one: the
    // environment's value changed since that key was adopted.
    if (!(error instanceof ApiError) || error.code !== 'conflict') throw error
  }
  const stale = (await keys.list()).find(key => key.name === name && key.revokedAt === null)
  if (stale) await keys.revoke(stale.id)
  const adopted = await keys.adopt(secret, request)
  return { key: adopted.key, created: adopted.created, revoked: stale?.id ?? null }
}
