// Five known deadline-budget violations: every one of them is a number measured
// on an idle box, which is what goes red under the full e2e tier while the
// pipeline it waits on is fine.

declare const page: {
  click: (options: { timeout: number }) => Promise<void>
  waitForTimeout: (ms: number) => Promise<void>
  setDefaultTimeout: (ms: number) => void
}
declare const test: { setTimeout: (ms: number) => void }
declare const budget: { paint: number; pipeline: number }
declare function scale(ms: number): number
declare function flowBudget(minutes: number): number

export const raw = { timeout: 120_000 }
export const computed = { timeout: 2 * 60_000 }

export async function waits(): Promise<void> {
  test.setTimeout(480_000)
  page.setDefaultTimeout(30_000)
  await page.click({ timeout: budget.paint })
}

const PARSE_TIMEOUT = 120_000

/** The shape the guard asks for — the ladder, and a name over a scaled number. */
const RETHEME_TIMEOUT = scale(20_000)
const HOUR = 3_600_000

export async function budgeted(): Promise<void> {
  test.setTimeout(flowBudget(8))
  await page.waitForTimeout(scale(250))
  await page.click({ timeout: budget.pipeline })
}

export const named = { PARSE_TIMEOUT, RETHEME_TIMEOUT, HOUR }
