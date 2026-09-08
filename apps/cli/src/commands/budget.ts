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
 * **A monthly ceiling of `0` is a ceiling of zero, not the absence of one**
 * (PRD-02 T37d). This verb used to print it as "no monthly ceiling", which
 * reads as the opposite of what the orchestrator does with it: nothing may be
 * spent, so free providers (the sim, a node) run forever and the first paid
 * allocation is refused `budget_exceeded`. It is printed as the zero it is,
 * with what that buys said in the same line.
 */

export const BUDGET_USAGE = `ezpug-iron budget — this key's ceilings and what it has spent

  budget            concurrency, per-server lifetime, this month's cents

A monthly ceiling of €0.00 is a ceiling of zero, not the absence of one: free
providers (the sim, a node) run under it forever and the first paid server is
refused 402 budget_exceeded. PATCH /v1/keys/:keyId/budget moves it.`

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
      ? `this month    ${euros(usage.monthCents)} spent of €0.00 — free providers only,` +
          ` a paid server is refused`
      : `this month    ${euros(usage.monthCents)} of ${euros(limits.monthlyCents)}` +
          ` (${Math.round((usage.monthCents / limits.monthlyCents) * 100)} %)`,
  )
  out.say(`since         ${usage.monthStartedAt}`)
  out.emit(budget)
  return EXIT.ok
}
