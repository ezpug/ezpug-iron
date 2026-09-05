import type { Clock } from '@ezpug/core'
import type { Capacity, FleetServer, LedgerFilter, ProviderHealth } from '@ezpug/match-api'
import { ApiError, MATCH_API_ERROR_STATUS } from '@ezpug/match-api'
import type { Matches } from '../match/machine'
import type { MatchStore, ServerRow } from '../match/store'
import { fleetServerView } from '../match/views'
import type { ProviderRegistry } from '../providers/registry'

/**
 * **The fleet, read and driven** (decisions 7, 12): the open rows, the
 * whole ledger, a release by an operator, the providers' health with drain
 * and undrain, and capacity — what the platform's admin console and the
 * CLI see. Nothing here carries a secret.
 */
export interface Fleet {
  servers: () => Promise<FleetServer[]>
  ledger: (
    filter: LedgerFilter,
    cursor: string | undefined,
    limit: number,
  ) => Promise<{ items: FleetServer[]; nextCursor: string | null }>
  /** By row id or by the provider's handle; `not_found` otherwise, `invalid_state` when closed. */
  release: (serverId: string, reason: string | undefined) => Promise<FleetServer>
  providers: () => Promise<ProviderHealth[]>
  provider: (id: string) => Promise<ProviderHealth>
  setDrained: (id: string, drained: boolean) => Promise<ProviderHealth>
  capacity: () => Promise<Capacity>
}

export interface FleetOptions {
  clock: Clock
  store: MatchStore
  registry: ProviderRegistry
  matches: Matches
}

function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  if (!/^\d{1,9}$/.test(cursor))
    throw new ApiError(
      MATCH_API_ERROR_STATUS.validation_failed,
      'validation_failed',
      'the cursor is not one of ours',
    )
  return Number(cursor)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function createFleet(options: FleetOptions): Fleet {
  const { clock, store, registry, matches } = options

  const openCount = async (providerId: string): Promise<number> =>
    (await store.listOpenServers(providerId)).length

  const health = async (id: string): Promise<ProviderHealth> =>
    registry.health(id, await openCount(id))

  const findRow = async (serverId: string): Promise<ServerRow> => {
    let row = UUID.test(serverId) ? await store.findServer(serverId) : undefined
    if (!row) {
      for (const provider of registry.all()) {
        row = await store.findServerByHandle(provider.id, serverId)
        if (row) break
      }
    }
    if (!row)
      throw new ApiError(MATCH_API_ERROR_STATUS.not_found, 'not_found', `no server ${serverId}`)
    return row
  }

  return {
    servers: async () =>
      (await store.listOpenServers()).map(row => fleetServerView(row, clock.date())),
    ledger: async (filter, cursor, limit) => {
      const result = await store.listLedger(filter, offsetOf(cursor), limit)
      return {
        items: result.items.map(row => fleetServerView(row, clock.date())),
        nextCursor: result.nextOffset === null ? null : String(result.nextOffset),
      }
    },
    release: async (serverId, reason) => {
      const row = await findRow(serverId)
      if (row.releasedAt)
        throw new ApiError(
          MATCH_API_ERROR_STATUS.invalid_state,
          'invalid_state',
          `server ${serverId} is ${row.state}`,
        )
      await matches.releaseRow(row, reason)
      const after = await store.findServer(row.id)
      return fleetServerView(after ?? row, clock.date())
    },
    providers: () => Promise.all(registry.all().map(provider => health(provider.id))),
    provider: health,
    setDrained: (id, drained) => {
      registry.setDrained(id, drained)
      return health(id)
    },
    capacity: async () => {
      const providers = await Promise.all(
        registry.entries().map(async entry => {
          const { provider } = entry
          let offerings: Awaited<ReturnType<typeof provider.offerings>> = []
          try {
            offerings = await provider.offerings()
            registry.observe(provider.id, { at: clock.date().toISOString(), error: null })
          } catch (error) {
            registry.observe(provider.id, {
              at: clock.date().toISOString(),
              error: error instanceof Error ? error.message : String(error),
            })
          }
          const regions = new Map<string, Capacity['providers'][number]['regions'][number]>()
          for (const offering of offerings) {
            const { region, games, lan } = offering.capabilities
            const known = regions.get(region)
            const available = entry.drained || !entry.healthy ? 0 : (offering.available ?? null)
            if (!known) {
              regions.set(region, { region, games: [...games], lan, available })
              continue
            }
            for (const game of games) if (!known.games.includes(game)) known.games.push(game)
            known.available =
              known.available === null || available === null ? null : known.available + available
          }
          return {
            id: provider.id,
            healthy: entry.healthy,
            drained: entry.drained,
            regions: [...regions.values()],
          }
        }),
      )
      return { providers, asOf: clock.date().toISOString() }
    },
  }
}
