import type { Clock, Timer } from '@ezpug/core'
import type { ApiKey, Budget, BudgetUsage, MatchRequest, OrchestrationFact } from '@ezpug/match-api'
import {
  ApiError,
  BUDGET_THRESHOLD_FRACTIONS,
  type BudgetLimitName,
  MATCH_API_ERROR_STATUS,
} from '@ezpug/match-api'
import type { KeyStore } from '../keys/store'
import type { Log } from '../log'
import type { MatchStore, ServerRow } from '../match/store'

/**
 * **Budgets** (decision 7, PRD-02 T5, CLAUDE.md "the budget is a wall"): the
 * three ceilings on an API key, enforced here against the **ledger** and
 * never trusted to the caller.
 *
 * - `maxConcurrentServers` — open ledger rows the key is paying for right now.
 * - `maxServerLifetimeMinutes` — the request's own `ttlMinutes`.
 * - `monthlyCents` — this calendar month's spend, `cost_hourly_cents` times
 *   each row's open time, **live rows included** and accruing to now. A
 *   ceiling of `0` is not "no ceiling": it is "no money", which is exactly
 *   right for a key on a free provider and refuses the same key the moment
 *   it is pointed at a paying one.
 *
 * The month is UTC — the first instant of the month the clock is in — so
 * "what did this month cost" is the same question in every timezone, and a
 * clock crossing midnight on the first starts the count over without
 * anything being written.
 *
 * The warnings (`fleet.budget_threshold` at
 * {@link BUDGET_THRESHOLD_FRACTIONS} of a ceiling) go into the key's open
 * matches, once per `(ceiling, fraction, month)` — the mark is a row
 * (`api_key_budget_notices`), not a set in this process, because the
 * contract's "never repeated for the same crossing" has to survive a deploy.
 * A ceiling that is moved clears the key's marks: a new number is a new
 * crossing.
 */

/** The gate the match machine calls at the door, and nothing else of this. */
export interface BudgetGate {
  /**
   * Refuse the request before anything is allocated. `hourlyCents` is the
   * price of the candidate the walk would take first — the cheapest suitable
   * one, or the LAN node, which is what this match would actually cost.
   * Throws `budget_exceeded` (402).
   */
  check: (key: ApiKey, request: MatchRequest, hourlyCents: number) => Promise<void>
  /** A ledger row opened (or the sweep came round): say what crossed, once. */
  announce: (keyId: string) => Promise<void>
}

export interface Budgets extends BudgetGate {
  /** The calling key's ceilings and what it has used — `GET /v1/fleet/budget`. */
  of: (key: ApiKey) => Promise<Budget>
  usage: (keyId: string) => Promise<BudgetUsage>
  /**
   * One pass over the keys with something running: accrual on a live row
   * crosses a fraction without anybody asking.
   */
  sweep: () => Promise<void>
  /** Arm the sweep. Idempotent. */
  start: () => void
  /** Disarm; a pass already running finishes. */
  stop: () => Promise<void>
}

/** How often the accrual of open rows is re-checked against the ceilings. */
export const BUDGET_SWEEP_INTERVAL_MS = 60_000

export interface BudgetsOptions {
  clock: Clock
  log: Log
  store: MatchStore
  keys: KeyStore
  /** Where a warning goes: the key's open matches, in each one's own sequence. */
  emit: (matchId: string, fact: BudgetThresholdFact) => Promise<void>
  intervalMs?: number
}

/** The one fact this service says. */
export type BudgetThresholdFact = Extract<OrchestrationFact, { type: 'fleet.budget_threshold' }>

/** The first instant of the UTC month `at` falls in. */
export function monthStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1))
}

/** What one row has cost by `asOf`: its hourly price times its open time, floored to a cent. */
export function accruedCents(row: ServerRow, asOf: Date): number {
  const end = row.releasedAt ?? asOf
  const elapsedMs = Math.max(0, end.getTime() - row.allocatedAt.getTime())
  return Math.floor((row.costHourlyCents * elapsedMs) / 3_600_000)
}

function refuse(message: string, details: Record<string, unknown>): ApiError {
  return new ApiError(MATCH_API_ERROR_STATUS.budget_exceeded, 'budget_exceeded', message, details)
}

export function createBudgets(options: BudgetsOptions): Budgets {
  const { clock, log, store, keys } = options
  const intervalMs = options.intervalMs ?? BUDGET_SWEEP_INTERVAL_MS
  let timer: Timer | undefined
  let running = false
  let pass: Promise<void> | undefined

  const usage = async (keyId: string): Promise<BudgetUsage> => {
    const at = clock.date()
    const since = monthStart(at)
    const rows = await store.listKeyLedgerSince(keyId, since)
    let monthCents = 0
    let concurrentServers = 0
    for (const row of rows) {
      monthCents += accruedCents(row, at)
      if (row.releasedAt === null) concurrentServers += 1
    }
    return { concurrentServers, monthCents, monthStartedAt: since.toISOString() }
  }

  const budgetOf = async (key: ApiKey): Promise<Budget> => ({
    keyId: key.id,
    limits: { ...key.budget },
    usage: await usage(key.id),
  })

  /** The ceilings that have a ratio — a lifetime ceiling is about one request, not a fraction. */
  const ratios = (budget: Budget): [BudgetLimitName, number][] => {
    const out: [BudgetLimitName, number][] = []
    if (budget.limits.maxConcurrentServers > 0)
      out.push([
        'maxConcurrentServers',
        budget.usage.concurrentServers / budget.limits.maxConcurrentServers,
      ])
    if (budget.limits.monthlyCents > 0)
      out.push(['monthlyCents', budget.usage.monthCents / budget.limits.monthlyCents])
    return out
  }

  const announceFor = async (key: ApiKey): Promise<void> => {
    const budget = await budgetOf(key)
    const monthStartedAt = new Date(budget.usage.monthStartedAt)
    const crossed: BudgetThresholdFact[] = []
    for (const [limit, ratio] of ratios(budget)) {
      for (const fraction of BUDGET_THRESHOLD_FRACTIONS) {
        if (ratio < fraction) continue
        const first = await keys.markBudgetNotice(
          { keyId: key.id, limit, fraction, monthStartedAt },
          clock.date(),
        )
        if (first)
          crossed.push({
            type: 'fleet.budget_threshold',
            limit,
            fraction,
            usage: budget.usage,
            limits: budget.limits,
          })
      }
    }
    if (crossed.length === 0) return
    const open = await store.listOpenMatches(key.id)
    for (const fact of crossed) for (const match of open) await options.emit(match.id, fact)
  }

  const announce = async (keyId: string): Promise<void> => {
    const record = await keys.findById(keyId)
    if (!record || record.key.revokedAt) return
    await announceFor(record.key)
  }

  const sweep = async (): Promise<void> => {
    // Only keys with an open row: a ratio climbs when a server is running
    // (concurrency, and the meter on a live row) and nowhere else, so a key
    // with nothing open cannot have crossed anything since the last pass.
    const open = new Set((await store.listOpenServers()).map(row => row.keyId))
    for (const keyId of open) {
      try {
        await announce(keyId)
      } catch (error) {
        log.error(`budget sweep failed for key ${keyId}`, error)
      }
    }
  }

  const arm = (): void => {
    timer = clock.after(intervalMs, () => {
      pass = sweep()
      void pass
        .catch((error: unknown) => log.error('budget sweep failed', error))
        .finally(() => {
          pass = undefined
          if (running) arm()
        })
    })
  }

  return {
    of: budgetOf,
    usage,
    announce,
    sweep,

    async check(key, request, hourlyCents) {
      const limits = key.budget
      const current = await usage(key.id)
      // Concurrency first: it is the ceiling a client crosses by accident,
      // and the cheapest one to answer.
      if (current.concurrentServers + 1 > limits.maxConcurrentServers)
        throw refuse('the key is at its concurrent-server ceiling', {
          limit: 'maxConcurrentServers',
          ...limits,
          ...current,
        })
      if (request.ttlMinutes > limits.maxServerLifetimeMinutes)
        throw refuse('ttlMinutes is above the key’s server lifetime ceiling', {
          limit: 'maxServerLifetimeMinutes',
          ttlMinutes: request.ttlMinutes,
          maxServerLifetimeMinutes: limits.maxServerLifetimeMinutes,
        })
      // A free provider (a node, the sim) crosses no monthly ceiling: there
      // is nothing to spend, so `monthlyCents: 0` still allows the match.
      const projectedCents = Math.ceil((hourlyCents * request.ttlMinutes) / 60)
      if (projectedCents > 0 && current.monthCents + projectedCents > limits.monthlyCents)
        throw refuse('the match would cross the key’s monthly ceiling', {
          limit: 'monthlyCents',
          projectedCents,
          ...current,
          monthlyCents: limits.monthlyCents,
        })
    },

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
  }
}
