import type { MatchRequest } from '@ezpug/match-api'
import type { GameServerProvider, ServerOffering, ServerRequirements } from './provider'
import { offeringMatches } from './provider'
import type { ProviderRegistry } from './registry'

/**
 * **Server selection** — the platform's `selection.ts`, ported with the
 * iron's rules (PRD-02 T3): filter every provider's offerings by what the
 * request demands, order what survives, and hand the provisioning walk a
 * *candidate list* — the thing its retries walk through before failing the
 * match.
 *
 * The rules, in the order they bite:
 *
 * - `requirements.provider` narrows to exactly that provider.
 * - `requirements.simulated` narrows to the `sim` provider.
 * - Otherwise **the sim is never chosen when any real provider is
 *   registered** (a match nobody asked to simulate must land on iron), and
 *   it is the honest fallback when none is — the dev world.
 * - A drained provider offers nothing.
 * - `lan` requested → nodes only (the filter) and nodes first (the ordering);
 *   `preferLan` → nodes first and nothing filtered out, so a LAN night held
 *   before a node is enrolled still gets a rented box (T38a); otherwise
 *   cheapest first. Ties fall back to registration order then offering
 *   order, so the list is deterministic for any ordering.
 */

export const SIM_PROVIDER_ID = 'sim'

/** One allocatable option: which provider, and which of its offerings. */
export interface AllocationCandidate {
  provider: GameServerProvider
  offering: ServerOffering
}

/** The preference seam. Orderings only *rank*; filtering already happened. */
export type CandidateOrdering = (a: AllocationCandidate, b: AllocationCandidate) => number

/** Lowest hourly price allocates first. */
export const cheapestSuitable: CandidateOrdering = (a, b) =>
  a.offering.hourlyCents - b.offering.hourlyCents

/** Venue hardware first, then cheapest (decision 23). */
export const lanFirst: CandidateOrdering = (a, b) => {
  const lanDelta = Number(b.offering.capabilities.lan) - Number(a.offering.capabilities.lan)
  return lanDelta !== 0 ? lanDelta : cheapestSuitable(a, b)
}

/** A provider that could not even answer `offerings()` — reported, never silently dropped. */
export interface SelectionFailure {
  provider: string
  error: unknown
}

export interface SelectionResult {
  /** Best first — the walk allocates from the front and moves down on rejection. */
  candidates: AllocationCandidate[]
  /** Providers excluded because they failed to answer. Empty on a healthy pool. */
  failures: SelectionFailure[]
  /** How many providers were asked at all (after the request's own narrowing). */
  asked: number
}

/** What a match request demands of a server. */
export function requirementsOf(request: MatchRequest): ServerRequirements {
  return {
    game: request.game,
    ...(request.requirements.region !== undefined && { region: request.requirements.region }),
    ...(request.requirements.lan && { lan: true }),
    ...(request.maps.some(entry => entry.map.startsWith('workshop/')) && { workshopMaps: true }),
  }
}

/** Which providers a request may land on, before capability matching. */
export function eligibleProviders(
  registry: ProviderRegistry,
  request: MatchRequest,
): GameServerProvider[] {
  const all = registry.entries().filter(entry => !entry.drained)
  const { provider, simulated } = request.requirements
  if (provider !== undefined)
    return all.filter(e => e.provider.id === provider).map(e => e.provider)
  if (simulated) return all.filter(e => e.provider.id === SIM_PROVIDER_ID).map(e => e.provider)
  const real = all.filter(e => e.provider.id !== SIM_PROVIDER_ID)
  return (real.length > 0 ? real : all).map(e => e.provider)
}

/**
 * The ordering a request asks for. `lan` has already narrowed the pool to
 * nodes by the time this ranks it; `preferLan` narrowed nothing, so this is
 * the whole of what it does.
 */
export function orderingFor(request: MatchRequest): CandidateOrdering {
  return request.requirements.lan || request.requirements.preferLan ? lanFirst : cheapestSuitable
}

/**
 * Produce the candidate list for one match request. A provider whose
 * `offerings()` rejects is excluded *and reported* — one broken adapter must
 * not take matchmaking down, and must not vanish without a trace either.
 */
export async function selectCandidates(
  registry: ProviderRegistry,
  request: MatchRequest,
  options: { now: () => string } = { now: () => new Date(0).toISOString() },
): Promise<SelectionResult> {
  const providers = eligibleProviders(registry, request)
  const requirements = requirementsOf(request)
  const ordering = orderingFor(request)
  const failures: SelectionFailure[] = []

  const pools = await Promise.all(
    providers.map(async provider => {
      try {
        const offerings = await provider.offerings()
        registry.observe(provider.id, { at: options.now(), error: null })
        return { provider, offerings }
      } catch (error) {
        failures.push({ provider: provider.id, error })
        registry.observe(provider.id, {
          at: options.now(),
          error: error instanceof Error ? error.message : String(error),
        })
        return { provider, offerings: [] as ServerOffering[] }
      }
    }),
  )

  const ranked = pools
    .flatMap(({ provider, offerings }, providerIndex) =>
      offerings
        .filter(offering => offeringMatches(offering, requirements))
        .map((offering, offeringIndex) => ({
          candidate: { provider, offering } satisfies AllocationCandidate,
          providerIndex,
          offeringIndex,
        })),
    )
    .sort(
      (a, b) =>
        ordering(a.candidate, b.candidate) ||
        a.providerIndex - b.providerIndex ||
        a.offeringIndex - b.offeringIndex,
    )

  return { candidates: ranked.map(entry => entry.candidate), failures, asked: providers.length }
}
