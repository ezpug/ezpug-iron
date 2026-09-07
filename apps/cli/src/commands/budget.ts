import type { CommandContext } from '../context'
import { EXIT } from '../exit'
import { euros } from '../output'

/**
 * **`ezpug-iron budget`** — the calling key's three ceilings and what it has
 * spent against them (decision 7, `GET /v1/fleet/budget`). The wall in front
 * of the money is enforced in the orchestrator, from the ledger, per key;
 * this verb is how an operator sees the same numbers the refusal would have
 * quoted, before a Saturday night finds them.
 *
 * A ceiling of `0` is "no ceiling" for the monthly line, as the resource
 * states it — printed as such rather than as `€0.00`, which would read like
 * the opposite.
 */

export const BUDGET_USAGE = `ezpug-iron budget — this key's ceilings and what it has spent

  budget            concurrency, per-server lifetime, this month's cents`

export async function runBudget(context: CommandContext): Promise<number> {
  const budget = await context.client().fleet.budget()
  const { limits, usage } = budget
  const { out } = context
  out.say(`key           ${budget.keyId}`)
  out.say(
    `servers       ${usage.concurrentServers} of ${limits.maxConcurrentServers} at once` +
      `${usage.concurrentServers >= limits.maxConcurrentServers ? '  ← at the ceiling' : ''}`,
  )
  out.say(`lifetime      ${limits.maxServerLifetimeMinutes} minutes per server`)
  out.say(
    limits.monthlyCents === 0
      ? `this month    ${euros(usage.monthCents)} spent, no monthly ceiling`
      : `this month    ${euros(usage.monthCents)} of ${euros(limits.monthlyCents)}` +
          ` (${Math.round((usage.monthCents / limits.monthlyCents) * 100)} %)`,
  )
  out.say(`since         ${usage.monthStartedAt}`)
  out.emit(budget)
  return EXIT.ok
}
