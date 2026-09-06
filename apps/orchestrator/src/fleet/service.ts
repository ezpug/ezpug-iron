import { randomUUID } from 'node:crypto'
import type { Clock } from '@ezpug/core'
import type {
  Capacity,
  ConsoleLine,
  FleetServer,
  LedgerFilter,
  ProviderHealth,
} from '@ezpug/match-api'
import { ApiError, CONSOLE_LINES_MAX, MATCH_API_ERROR_STATUS } from '@ezpug/match-api'
import type { AuthenticatedKey } from '../keys/service'
import type { ConsoleTail, LinkRegistry, ServerChannel } from '../link/channels'
import type { Matches } from '../match/machine'
import type { MatchStore, ServerRow } from '../match/store'
import { fleetServerView } from '../match/views'
import type { ProviderRegistry } from '../providers/registry'
import { RconError } from '../rcon/client'
import { redactConsoleLine } from '../rcon/redact'

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
  /** The tail of a server's console: the plugin's, or the provider's backlog before the link is up (T20). */
  console: (serverId: string) => Promise<ConsoleLine[]>
  /** One RCON line and what came back, recorded in the row's audit column (T20). */
  rcon: (key: AuthenticatedKey, serverId: string, command: string) => Promise<string>
}

export interface FleetOptions {
  clock: Clock
  store: MatchStore
  registry: ProviderRegistry
  matches: Matches
  /** The attached links, so the console route can read a plugin's own tail (T20). */
  links: LinkRegistry
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

/**
 * Why an RCON attempt did not produce output, in one phrase. Our own client
 * answers with a word; anything else is whatever it threw, put through the
 * same redaction as a console line — a provider's error message is not a
 * place a credential is *supposed* to be, which is exactly why it is checked.
 */
function rconFailure(error: unknown): string {
  if (error instanceof RconError) return error.failure
  return redactConsoleLine(error instanceof Error ? error.message : String(error))
}

export function createFleet(options: FleetOptions): Fleet {
  const { clock, store, registry, matches, links } = options

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

  /** The channel a row's server holds, if it dialled in and is still there. */
  const channelOf = (row: ServerRow): ServerChannel | undefined =>
    row.serverId === null
      ? undefined
      : links.get({ provider: row.provider, serverId: row.serverId })

  /**
   * A link tail stamps its lines with the *server's* uptime; the tail itself
   * is stamped with ours when it arrived. One subtraction turns the pair into
   * the wall-clock times the contract asks for, and a line older than the
   * tail's own arrival is exactly that far in the past.
   */
  const linesOf = (tail: ConsoleTail): ConsoleLine[] =>
    tail.lines.map(line => ({
      at: new Date(tail.at.getTime() - (tail.uptimeMs - line.uptimeMs)).toISOString(),
      line: redactConsoleLine(line.line),
    }))

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

    /**
     * **What the server has been saying.** The plugin relays its own tail
     * over the link (T6 caches the last one on the session), and that is the
     * good answer: it is the game's console, whoever rents the box. Before
     * the link is up there is only whatever the *control plane* kept — the
     * Dathost console backlog — which is the moment this route exists for.
     *
     * A tail nobody has asked for yet is asked for now: the round trip is one
     * frame, and an operator opening the console wants the console, not an
     * empty page that fills in later. A server that does not answer inside
     * the link's deadline falls through to the provider rather than failing;
     * the whole route is a best effort by construction.
     */
    console: async serverId => {
      const row = await findRow(serverId)
      const channel = channelOf(row)
      if (channel) {
        let tail = channel.consoleTail?.()
        if (!tail && channel.console) {
          try {
            tail = await channel.console(CONSOLE_LINES_MAX)
          } catch {
            tail = undefined
          }
        }
        if (tail) return linesOf(tail).slice(-CONSOLE_LINES_MAX)
      }
      const provider = registry.get(row.provider)
      if (!provider?.console || row.serverId === null) return []
      const backlog = await provider.console(row.serverId)
      return (backlog ?? [])
        .slice(-CONSOLE_LINES_MAX)
        .map(line => ({ at: line.at, line: redactConsoleLine(line.line) }))
    },

    /**
     * **The operator's fallback** (decision 5). Order matters and is not the
     * obvious one: the **provider's** `rcon` verb goes first, because it is
     * the only door that hands back what the server *printed* — Dathost reads
     * its console log around the command, a node opens a Source RCON socket
     * on the game port (`../rcon/client.ts`). The link is the fallback behind
     * it, not the other way round: a plugin can run a command but cannot
     * capture the engine's answer, so it applies the line and says nothing.
     * A provider with neither (the sim) is `command_unsupported`, which is
     * what the route's contract promises.
     *
     * Whatever happens, the line and its answer land in the row's audit
     * column — redacted, because a console prints passwords and this response
     * may not.
     */
    rcon: async (key, serverId, command) => {
      const row = await findRow(serverId)
      if (row.releasedAt)
        throw new ApiError(
          MATCH_API_ERROR_STATUS.invalid_state,
          'invalid_state',
          `server ${serverId} is ${row.state}`,
        )
      if (row.serverId === null)
        throw new ApiError(
          MATCH_API_ERROR_STATUS.invalid_state,
          'invalid_state',
          `server ${serverId} has no handle yet; the provider has not answered`,
        )
      const line = redactConsoleLine(command)
      const record = async (output: string): Promise<string> => {
        await store.appendRconAudit(row.id, {
          at: clock.date().toISOString(),
          keyId: key.key.id,
          command: line,
          output,
        })
        return output
      }

      const provider = registry.get(row.provider)
      if (provider?.rcon) {
        let answered: string | null
        try {
          answered = await provider.rcon(row.serverId, command)
        } catch (error) {
          await record(`<failed: ${rconFailure(error)}>`)
          throw new ApiError(
            MATCH_API_ERROR_STATUS.provider_unavailable,
            'provider_unavailable',
            `rcon on ${serverId} failed: ${rconFailure(error)}`,
          )
        }
        if (answered !== null) return await record(redactConsoleLine(answered))
      }

      const channel = channelOf(row)
      if (!channel)
        throw new ApiError(
          MATCH_API_ERROR_STATUS.command_unsupported,
          'command_unsupported',
          `${row.provider} has no RCON for ${serverId}`,
        )
      const result = await channel.send({ type: 'rcon', correlationId: randomUUID(), command })
      if (result.status === 'rejected')
        throw new ApiError(
          MATCH_API_ERROR_STATUS[result.code ?? 'command_unsupported'],
          result.code ?? 'command_unsupported',
          result.message ?? `${serverId} refused the command`,
        )
      // The plugin ran it; the engine's answer went to the server's own
      // console, which is what the console route is for.
      return await record(redactConsoleLine(result.output ?? ''))
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
