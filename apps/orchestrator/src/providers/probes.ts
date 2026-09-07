import type { Clock, Timer } from '@ezpug/core'
import type { Log } from '../log'
import type { Matches } from '../match/machine'
import type { MatchStore } from '../match/store'
import type { ProviderRegistry } from './registry'

/**
 * **Provider health, on the clock** (PRD-02 T31). Everything else in the
 * orchestrator learns a provider is down by *failing at something*: an
 * allocation refused, a `list()` that threw in the reaper, an `offerings()`
 * call inside `GET /v1/capacity`. That is late and uneven — a night with no
 * match request would find out at the worst possible moment, when the first
 * one arrives.
 *
 * So one loop asks every provider the cheapest question it has, on the
 * injected clock: Dathost reads its account, the node provider reads how
 * long ago its nodes were heard from, the sim answers in-process and is
 * therefore always up. What comes back is written to the registry, which is
 * what `GET /v1/fleet/providers` serves — `healthy`, `lastCheckedAt`,
 * `lastError` — so the platform's health tile is a read of something a
 * timer keeps fresh rather than a call that might hang.
 *
 * **One fact per incident.** The first pass that finds a provider
 * unreachable says `fleet.provider_unreachable` into every open match on it,
 * with the instant the incident began and the error that proved it; a pass
 * that finds it unreachable *again* says nothing. A successful probe closes
 * the incident, and the next outage is a new one worth a new fact. The
 * adapters already swallow a blip — Dathost retries a 5xx and a dropped
 * socket three times inside one call — so a probe that fails here has failed
 * for long enough to be worth an operator's attention.
 *
 * A probe that hangs is not allowed to hold the loop: every one is bounded
 * on the clock, and a provider that does not answer inside the window is
 * unreachable, which is the only honest reading of a control plane that
 * never replies.
 */
export interface Probes {
  /** Arm the loop. Idempotent. */
  start: () => void
  /** Disarm; a pass already running finishes but does not re-arm. */
  stop: () => Promise<void>
  /** One pass over every registered provider — what the interval calls, and what tests drive. */
  probe: () => Promise<ProbeReport[]>
}

/** What one provider's probe found. */
export interface ProbeReport {
  provider: string
  healthy: boolean
  /** The failure, in one phrase; null when it answered. */
  error: string | null
  /** True when this pass opened an incident and said `fleet.provider_unreachable`. */
  incident: boolean
}

export interface ProbesOptions {
  clock: Clock
  log: Log
  registry: ProviderRegistry
  store: MatchStore
  /** Where `fleet.provider_unreachable` goes: the open matches on the provider. */
  matches: Pick<Matches, 'emit'>
  /** How often every provider is asked. Default {@link PROBE_INTERVAL_MS}. */
  intervalMs?: number
  /** How long one probe may take before it counts as unreachable. Default {@link PROBE_TIMEOUT_MS}. */
  timeoutMs?: number
  onReport?: (report: ProbeReport) => void
}

/**
 * Half a minute: often enough that a provider that died between two matches
 * is known before the next request needs it, rare enough that the cheapest
 * authenticated read on a vendor's API is nothing anyone would notice.
 */
export const PROBE_INTERVAL_MS = 30_000

/** Twice the health route's, because a control plane on the far side of the internet is slower than a pool. */
export const PROBE_TIMEOUT_MS = 5_000

/** One provider's failure, in one phrase and never a credential (the adapters redact their own). */
function failureText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, 512)
}

export function createProbes(options: ProbesOptions): Probes {
  const { clock, log, registry, store, matches } = options
  const intervalMs = options.intervalMs ?? PROBE_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS

  /** Open incidents, by provider: when it started, and whether it was said. */
  const incidents = new Map<string, { since: string; announced: boolean }>()
  let timer: Timer | undefined
  let running = false
  let pass: Promise<ProbeReport[]> | undefined

  /** The provider's own probe, else its offerings — bounded on the clock either way. */
  const ask = async (id: string): Promise<void> => {
    const provider = registry.get(id)
    if (!provider) return
    const run = provider.probe ? provider.probe() : provider.offerings().then(() => undefined)
    let deadline: Timer | undefined
    try {
      await Promise.race([
        run,
        new Promise<never>((_resolve, reject) => {
          deadline = clock.after(timeoutMs, () =>
            reject(new Error(`no answer within ${timeoutMs} ms`)),
          )
        }),
      ])
    } finally {
      deadline?.cancel()
    }
  }

  /**
   * Say it once, to the matches it is about: every open match with a ledger
   * row on this provider. A key with nothing running hears nothing and reads
   * `GET /v1/fleet/providers`, which the same pass has just made true.
   */
  const announce = async (provider: string, since: string, lastError: string): Promise<void> => {
    const rows = await store.listOpenServers(provider)
    const matchIds = new Set(rows.map(row => row.matchId).filter((id): id is string => id !== null))
    for (const matchId of matchIds)
      await matches.emit(matchId, {
        type: 'fleet.provider_unreachable',
        provider,
        since,
        lastError,
      })
  }

  const probeOne = async (id: string): Promise<ProbeReport> => {
    const at = clock.date().toISOString()
    let error: string | null = null
    try {
      await ask(id)
    } catch (failure) {
      error = failureText(failure)
    }
    registry.observe(id, { at, error })

    if (error === null) {
      // Back. The incident is over; the next one is worth its own fact.
      if (incidents.delete(id)) log.info(`provider ${id}: answering again`)
      return { provider: id, healthy: true, error: null, incident: false }
    }

    const open = incidents.get(id) ?? { since: at, announced: false }
    incidents.set(id, open)
    if (open.announced) return { provider: id, healthy: false, error, incident: false }
    log.warn(`provider ${id}: unreachable since ${open.since} (${error})`)
    try {
      await announce(id, open.since, error)
      open.announced = true
    } catch (failure) {
      // The fact is worth another try on the next pass; the health surface
      // is already true, which is the part an operator polls.
      log.error(`provider ${id}: could not say fleet.provider_unreachable`, failure)
    }
    return { provider: id, healthy: false, error, incident: open.announced }
  }

  const probe = async (): Promise<ProbeReport[]> => {
    const ids = registry.all().map(provider => provider.id)
    const reports = await Promise.all(
      ids.map(async id => {
        try {
          return await probeOne(id)
        } catch (error) {
          log.error(`probe of ${id} failed`, error)
          return { provider: id, healthy: false, error: failureText(error), incident: false }
        }
      }),
    )
    // A provider that was unregistered under us keeps no incident.
    for (const id of incidents.keys()) if (!ids.includes(id)) incidents.delete(id)
    for (const report of reports) options.onReport?.(report)
    return reports
  }

  const arm = (): void => {
    timer = clock.after(intervalMs, () => {
      pass = probe()
      void pass
        .catch((error: unknown) => {
          log.error('probe pass failed', error)
          return [] as ProbeReport[]
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
    probe,
  }
}
