import { describe, it } from 'vitest'
import {
  assertConformance,
  type ConformanceOptions,
  MATCH_API_CONFORMANCE_FLOWS,
  runMatchApiConformance,
} from './conformance'

/**
 * **The thin Vitest wrapper** around the conformance runner (PRD-01 T8): one
 * `it()` per flow, so a red run names the flow and the check that broke
 * instead of one opaque failure. The runner itself imports no test framework
 * — this file is the only thing that does, which is why it is *not* a
 * published entry point (`publishConfig.exports` leaves it out): a consumer
 * gets the runner and decides what to do with the report, and this repo's own
 * suites — the fake here, the orchestrator in PRD-02 — get the `it()`s.
 *
 * ```ts
 * describeMatchApiConformance('the fake orchestrator', {
 *   target: () => createFakeConformanceTarget(),
 * })
 * ```
 */
export function describeMatchApiConformance(name: string, options: ConformanceOptions): void {
  const flows = options.flows
    ? MATCH_API_CONFORMANCE_FLOWS.filter(flow => options.flows?.includes(flow.id))
    : MATCH_API_CONFORMANCE_FLOWS
  describe(name, () => {
    for (const flow of flows) {
      it(`${flow.id}: ${flow.title}`, async context => {
        const report = await runMatchApiConformance({ ...options, flows: [flow.id] })
        const result = report.results[0]
        if (result?.status === 'skipped') context.skip(result.reason)
        assertConformance(report)
      })
    }
  })
}
