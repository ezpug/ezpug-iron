import type { CommandContext } from '../context'
import { EXIT } from '../exit'
import { orDash } from '../output'

/**
 * **`ezpug-iron capacity`** — what could be allocated right now, per provider
 * and region (`GET /v1/capacity`, PRD-02 T38b). The question a lobby asks
 * before it asks for a match, and the second thing an operator reads when a
 * provider dies on a Saturday: `providers list` says who is well,
 * this says what they could actually start.
 *
 * It is a `matches`-scope read, not a `fleet` one — a client picks a region
 * out of it, so the key that creates matches is the key that can see them.
 * A drained provider is still listed, with `available: 0`: capacity that
 * exists and is not being offered is a different fact from capacity that is
 * gone, and the table says which. `available` may be `—` where a provider
 * cannot say (Dathost does not publish a quota), which is not zero either.
 */

export const CAPACITY_USAGE = `ezpug-iron capacity — what could be allocated right now

  capacity          per provider and region: games, LAN, servers available

A drained provider is listed with 0 available; a dash means the provider
cannot say how many it would start, which is not the same as none.`

export async function runCapacity(context: CommandContext): Promise<number> {
  const capacity = await context.client().capacity.get()
  const { out } = context
  out.table(
    ['provider', 'health', 'drained', 'region', 'lan', 'games', 'available'],
    capacity.providers.flatMap(provider => {
      const head = [
        provider.id,
        provider.healthy ? 'up' : 'down',
        provider.drained ? 'yes' : 'no',
      ] as const
      if (provider.regions.length === 0) return [[...head, '—', '—', '—', '—']]
      return provider.regions.map(region => [
        ...head,
        region.region,
        region.lan ? 'yes' : 'no',
        region.games.join(','),
        orDash(region.available),
      ])
    }),
  )
  out.say(`\nas of ${capacity.asOf}`)
  if (
    capacity.providers.length > 0 &&
    capacity.providers.every(provider => provider.drained || !provider.healthy)
  )
    out.say('nothing here can take a match: every provider is drained or down')
  out.emit(capacity)
  return EXIT.ok
}
