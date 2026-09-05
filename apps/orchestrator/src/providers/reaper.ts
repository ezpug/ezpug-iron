import type { Clock, Timer, Timestamp } from '@ezpug/core'
import type { Log } from '../log'
import type { Matches } from '../match/machine'
import type { MatchStore, ServerRow } from '../match/store'
import type { ProvisionedServer } from './provider'
import type { ProviderRegistry } from './registry'

/**
 * **The reaper** (decision 7, CLAUDE.md "every server is a ledger row") —
 * the platform's `reaper.ts`, ported to hold provider truth against the
 * ledger. On an interval on the injected clock it reconciles every
 * provider's `list()` against the open rows and acts on the three ways
 * they can disagree:
 *
 * - **Orphans** (the provider runs a server no open row accounts for) are
 *   deallocated after a grace window that covers the allocate ↔ row race,
 *   and `fleet.orphan_found` is said to the match the server was obtained
 *   for, when it is still open. Money leaks silently without this; it
 *   exists from day one.
 * - **Lost servers** (an open row the provider no longer lists) are
 *   *surfaced* to the machine, which probes and opens the recovery window —
 *   the reaper is the consistency alarm behind the loss detector, never the
 *   one that decides.
 * - **Ceilings**: an open row past its `expires_at` ends its match
 *   `ttl_expired` (or, with no match, is deallocated outright) whether or not
 *   the client ever says stop.
 *
 * A provider API being down must not kill the watchdog: every provider call
 * is caught, reported as a failure, and retried on the next pass. A
 * deallocation that fails stays orphaned and is retried too — which is why
 * `deallocate` is contractually idempotent.
 */
export interface ReapedServer {
  provider: string
  serverId: string
  matchId?: string
  fleetServerId?: string
}

export interface ReaperFailure {
  /** `ledger` when the ledger read itself failed. */
  provider: string
  operation: 'ledger' | 'list' | 'deallocate' | 'expire'
  error: unknown
}

export interface ReaperReport {
  reaped: ReapedServer[]
  /** Open rows the (successfully listed) owning provider does not confirm. */
  lost: ServerRow[]
  /** Rows past their ceiling that were ended. */
  expired: ServerRow[]
  failures: ReaperFailure[]
}

export interface ReaperOptions {
  registry: ProviderRegistry
  store: MatchStore
  matches: Matches
  clock: Clock
  log: Log
  /** Reconciliation cadence. The next pass arms when the previous one finishes — passes never overlap. */
  intervalMs?: number
  /**
   * How long an unaccounted-for server may exist before it is reaped,
   * measured from when *this reaper first saw it orphaned* (provider clocks
   * are not trusted), so a server allocated moments before a pass survives
   * until its row catches up.
   */
  graceMs?: number
  onReaped?: (server: ReapedServer) => void
  onLost?: (row: ServerRow) => void
  onFailure?: (failure: ReaperFailure) => void
}

export interface Reaper {
  /** Arm the interval. Idempotent. */
  start: () => void
  /** Disarm. A pass already running finishes but does not re-arm. */
  stop: () => Promise<void>
  /** One reconciliation pass, on demand — what the interval calls, and what tests drive directly. */
  reconcile: () => Promise<ReaperReport>
}

export const DEFAULT_REAPER_INTERVAL_MS = 60_000
export const DEFAULT_REAPER_GRACE_MS = 120_000

const key = (provider: string, serverId: string): string => `${provider} ${serverId}`

export function createReaper(options: ReaperOptions): Reaper {
  const {
    registry,
    store,
    matches,
    clock,
    log,
    intervalMs = DEFAULT_REAPER_INTERVAL_MS,
    graceMs = DEFAULT_REAPER_GRACE_MS,
  } = options

  const orphanedSince = new Map<string, { provider: string; since: Timestamp }>()
  let timer: Timer | undefined
  let running = false
  let pass: Promise<ReaperReport> | undefined

  const reconcile = async (): Promise<ReaperReport> => {
    const report: ReaperReport = { reaped: [], lost: [], expired: [], failures: [] }
    const fail = (failure: ReaperFailure): void => {
      report.failures.push(failure)
      options.onFailure?.(failure)
      log.error(`reaper: ${failure.operation} on ${failure.provider} failed`, failure.error)
    }

    let open: ServerRow[]
    try {
      open = await store.listOpenServers()
    } catch (error) {
      // Without the ledger every server looks orphaned — reap nothing.
      fail({ provider: 'ledger', operation: 'ledger', error })
      return report
    }
    const now = clock.now()

    // Ceilings first: a row past its expiry ends its match, whatever the provider says.
    for (const row of open) {
      if (row.expiresAt.getTime() > now) continue
      try {
        if (row.matchId) await matches.expire(row.matchId, 'the ledger row reached its expiry')
        else if (row.serverId) {
          await registry.get(row.provider)?.deallocate(row.serverId)
          await store.updateServer(row.id, {
            state: 'released',
            releasedAt: clock.date(),
            releasedReason: 'expired with no match',
          })
        }
        report.expired.push(row)
      } catch (error) {
        fail({ provider: row.provider, operation: 'expire', error })
      }
    }

    const accounted = new Map(
      open
        .filter(row => row.serverId !== null)
        .map(row => [key(row.provider, row.serverId as string), row]),
    )
    const seenThisPass = new Set<string>()
    const unlisted = new Set<string>()

    for (const provider of registry.all()) {
      let servers: ProvisionedServer[]
      try {
        servers = await provider.list()
      } catch (error) {
        unlisted.add(provider.id)
        fail({ provider: provider.id, operation: 'list', error })
        continue
      }
      const listed = new Set<string>()
      for (const server of servers) {
        const k = key(provider.id, server.serverId)
        listed.add(k)
        if (accounted.has(k)) continue
        seenThisPass.add(k)
        const since = orphanedSince.get(k)?.since ?? now
        orphanedSince.set(k, { provider: provider.id, since })
        if (now - since < graceMs) continue
        let released = true
        try {
          await provider.deallocate(server.serverId)
        } catch (error) {
          fail({ provider: provider.id, operation: 'deallocate', error })
          released = false
        }
        if (released) {
          orphanedSince.delete(k)
          seenThisPass.delete(k)
        }
        const reaped: ReapedServer = {
          provider: provider.id,
          serverId: server.serverId,
          ...(server.matchId !== undefined && { matchId: server.matchId }),
          ...(server.fleetServerId !== undefined && { fleetServerId: server.fleetServerId }),
        }
        if (released) {
          report.reaped.push(reaped)
          options.onReaped?.(reaped)
        }
        if (server.matchId) {
          await matches.emit(server.matchId, {
            type: 'fleet.orphan_found',
            provider: provider.id,
            serverId: server.serverId,
            fleetServerId:
              server.fleetServerId ?? (await rowIdFor(store, provider.id, server.serverId)),
            released,
          })
        }
      }
      // Lost = an open row the provider does not confirm.
      for (const row of open) {
        if (row.provider !== provider.id || row.serverId === null) continue
        if (row.releasedAt !== null || listed.has(key(row.provider, row.serverId))) continue
        if (row.expiresAt.getTime() <= now) continue
        report.lost.push(row)
        options.onLost?.(row)
        if (row.matchId)
          await matches.suspect(
            row.matchId,
            `${provider.id} no longer lists server ${row.serverId}`,
          )
      }
    }

    const registered = new Set(registry.all().map(provider => provider.id))
    for (const row of open) {
      if (!registered.has(row.provider))
        fail({
          provider: row.provider,
          operation: 'list',
          error: new Error(`ledger row ${row.id} names unregistered provider "${row.provider}"`),
        })
    }

    for (const [k, orphan] of orphanedSince) {
      if (seenThisPass.has(k) || unlisted.has(orphan.provider)) continue
      orphanedSince.delete(k)
    }
    return report
  }

  const arm = (): void => {
    timer = clock.after(intervalMs, () => {
      pass = reconcile()
      void pass
        .catch((error: unknown) => {
          log.error('reaper pass failed', error)
          return { reaped: [], lost: [], expired: [], failures: [] } as ReaperReport
        })
        .finally(() => {
          pass = undefined
          if (running) arm()
        })
    })
  }

  return {
    start() {
      if (running) return
      running = true
      arm()
    },
    async stop() {
      running = false
      timer?.cancel()
      timer = undefined
      await pass?.catch(() => undefined)
    },
    reconcile,
  }
}

async function rowIdFor(store: MatchStore, provider: string, serverId: string): Promise<string> {
  const row = await store.findServerByHandle(provider, serverId)
  return row?.id ?? '00000000-0000-4000-8000-000000000000'
}
