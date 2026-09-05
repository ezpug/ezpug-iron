import type { ProviderHealth } from '@ezpug/match-api'
import { ApiError, kebabNameSchema, MATCH_API_ERROR_STATUS } from '@ezpug/match-api'
import type { GameServerProvider } from './provider'

/**
 * **The provider registry** — the platform's `registry.ts`, ported: the one
 * place providers plug in. The composition root registers what
 * `EZPUG_IRON_PROVIDERS` names, and everything downstream (selection, the
 * walk, the reaper, the fleet routes) sees only this, never an adapter.
 *
 * Two facts an operator owns live here beside the adapter: whether the
 * provider is **drained** (`POST /v1/fleet/providers/:id/drain` — it keeps
 * what it runs and allocates nothing) and what its last probe said
 * (`healthy`, `lastError`, `lastCheckedAt`), so `GET /v1/fleet/providers`
 * has an answer today and T31's probes have a place to write.
 */
export interface ProviderEntry {
  readonly provider: GameServerProvider
  drained: boolean
  healthy: boolean
  lastCheckedAt: string | null
  lastError: string | null
}

export interface ProviderRegistry {
  /** Throws on a duplicate or misnamed id — composition mistakes fail at boot, not mid-match. */
  register: (provider: GameServerProvider) => void
  get: (id: string) => GameServerProvider | undefined
  /** The provider, or `not_found` — what a route answers for an id nobody registered. */
  require: (id: string) => ProviderEntry
  entry: (id: string) => ProviderEntry | undefined
  /** Every registered provider, in registration order (a deterministic tie-break input). */
  all: () => GameServerProvider[]
  entries: () => ProviderEntry[]
  setDrained: (id: string, drained: boolean) => ProviderEntry
  /** What a probe (or an `offerings()` call) learned. */
  observe: (id: string, observation: { at: string; error: string | null }) => void
  /** `ProviderHealth` for the fleet route, given the open-row count per provider. */
  health: (id: string, openServers: number) => ProviderHealth
  /** True when something was removed. Unregistering is for teardown; draining is for operators. */
  unregister: (id: string) => boolean
}

export function createProviderRegistry(): ProviderRegistry {
  const entries = new Map<string, ProviderEntry>()

  const require = (id: string): ProviderEntry => {
    const entry = entries.get(id)
    if (!entry)
      throw new ApiError(MATCH_API_ERROR_STATUS.not_found, 'not_found', `no provider ${id}`)
    return entry
  }

  return {
    register(provider) {
      const id = kebabNameSchema.parse(provider.id)
      if (entries.has(id)) throw new Error(`provider registry: duplicate provider id "${id}"`)
      entries.set(id, {
        provider,
        drained: false,
        healthy: true,
        lastCheckedAt: null,
        lastError: null,
      })
    },
    get: id => entries.get(id)?.provider,
    require,
    entry: id => entries.get(id),
    all: () => [...entries.values()].map(entry => entry.provider),
    entries: () => [...entries.values()],
    setDrained(id, drained) {
      const entry = require(id)
      entry.drained = drained
      return entry
    },
    observe(id, observation) {
      const entry = entries.get(id)
      if (!entry) return
      entry.lastCheckedAt = observation.at
      entry.lastError = observation.error
      entry.healthy = observation.error === null
    },
    health(id, openServers) {
      const entry = require(id)
      return {
        id,
        healthy: entry.healthy,
        drained: entry.drained,
        lastCheckedAt: entry.lastCheckedAt,
        lastError: entry.lastError,
        servers: openServers,
      }
    },
    unregister: id => entries.delete(id),
  }
}
