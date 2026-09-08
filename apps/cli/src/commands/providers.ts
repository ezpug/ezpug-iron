import { boolFlag } from '../args'
import type { CommandContext } from '../context'
import { CliUsageError, EXIT } from '../exit'
import { orDash } from '../output'

/**
 * **`ezpug-iron providers`** — the half of the fleet that is not a node: who
 * could rent a box right now, whether the last probe liked them, and the one
 * lever an outage starts with (PRD-02 T38b, `docs/operations.md` "When a
 * provider dies on a Saturday").
 *
 * - `list` is a read of a **fact**, not a call that can hang: the probe loop
 *   has been asking every thirty seconds since boot, so `lastError` is the
 *   error that proved a provider unhealthy and `lastCheckedAt` is when — the
 *   difference between "their API is 502ing" and "our credentials expired",
 *   without opening anyone's status page.
 * - `drain` (and `--undrain`) decides **where the failure happens**. A
 *   drained provider keeps what it is running and is offered nothing new, so
 *   a request that cannot be placed is refused `no_capable_server` at the
 *   door in a second, instead of walking a candidate list into a
 *   twenty-second allocation timeout while a lobby waits.
 * - `gslt` is the pool the Dathost half leases from (T17,
 *   `GET /v1/fleet/gslt`): `{ total, inUse }` and never a token. It belongs
 *   here because it is a *provider's* capacity — servers that boot and that
 *   nobody outside the datacentre can join is this number, and the answer is
 *   one read rather than an evening.
 *
 * Until this group existed, every one of these was `curl` in the runbook,
 * which is the wrong place for the first move of an outage.
 */

export const PROVIDERS_USAGE = `ezpug-iron providers — who can rent a box, and the outage lever

  providers list                     health, last probe, last error, open rows
  providers drain <providerId>       stop placing here; running servers finish
  providers drain <providerId> --undrain
  providers gslt                     the Steam login token pool (Dathost)

Draining is the first move of an outage: a request that cannot be placed is
refused no_capable_server at the door instead of walking a candidate list into
an allocation timeout while a lobby waits. The next probe does not undrain it
— that is yours (docs/operations.md, "When a provider dies on a Saturday").`

export async function runProviders(context: CommandContext): Promise<number> {
  const [verb, argument] = context.args.positionals.slice(1)
  switch (verb) {
    case 'list':
      return await list(context)
    case 'drain':
      return await drain(context, argument)
    case 'gslt':
      return await gslt(context)
    default:
      throw new CliUsageError(
        verb === undefined ? 'providers needs a verb' : `unknown verb 'providers ${verb}'`,
        PROVIDERS_USAGE,
      )
  }
}

async function list(context: CommandContext): Promise<number> {
  const { providers } = await context.client().fleet.providers.list()
  context.out.table(
    ['id', 'health', 'drained', 'servers', 'checked', 'last error'],
    providers.map(provider => [
      provider.id,
      provider.healthy ? 'up' : 'down',
      provider.drained ? 'yes' : 'no',
      String(provider.servers),
      orDash(provider.lastCheckedAt),
      orDash(provider.lastError),
    ]),
  )
  context.out.emit({ providers })
  return EXIT.ok
}

async function drain(context: CommandContext, providerId: string | undefined): Promise<number> {
  if (!providerId) throw new CliUsageError('providers drain needs the provider id', PROVIDERS_USAGE)
  const undrain = boolFlag(context.args, 'undrain')
  const fleet = context.client().fleet.providers
  const provider = undrain
    ? await fleet.undrain({ params: { providerId } })
    : await fleet.drain({ params: { providerId } })
  context.out.say(
    provider.drained
      ? `${provider.id} is draining — nothing new is placed here; ${provider.servers} open row${
          provider.servers === 1 ? '' : 's'
        } keep running`
      : `${provider.id} takes allocations again` +
          (provider.healthy ? '' : ' — but the last probe says it is down'),
  )
  context.out.emit(provider)
  return EXIT.ok
}

/**
 * **The GSLT pool**, which is a Saturday's second question. `total: 0` is no
 * `STEAM_WEB_API_KEY`, a wrong one or a ceiling of zero; `inUse == total` is
 * a saturated pool, and both end the same way — a server that boots, plays,
 * and is invisible to everyone outside the datacentre. A dry pool is a
 * warning and never a refusal (the match still runs), which is exactly why
 * nothing else tells you about it.
 */
async function gslt(context: CommandContext): Promise<number> {
  const pool = await context.client().fleet.gslt()
  const { out } = context
  out.say(`gslt          ${pool.inUse} of ${pool.total} leased`)
  if (pool.total === 0)
    out.say(
      'the pool is empty — no STEAM_WEB_API_KEY, a wrong one, or EZPUG_IRON_GSLT_POOL_MAX at 0.' +
        ' Servers still boot; nobody outside the datacentre can join them.',
    )
  else if (pool.inUse >= pool.total)
    out.say(
      'the pool is saturated — raise EZPUG_IRON_GSLT_POOL_MAX and restart, or find out why' +
        ' nothing is releasing. The next server boots without a token.',
    )
  out.emit(pool)
  return EXIT.ok
}
