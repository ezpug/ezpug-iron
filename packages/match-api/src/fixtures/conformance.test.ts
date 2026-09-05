import { describe, expect, it } from 'vitest'
import { createFakeConformanceTarget } from '../fake/conformance'
import {
  formatConformanceReport,
  MATCH_API_CONFORMANCE_FLOWS,
  runMatchApiConformance,
  stringifyRecording,
} from './conformance'
import { describeMatchApiConformance } from './vitest'

/**
 * **The conformance suite against the fake, in process** (PRD-01 T8). The
 * fake is the first implementation of the contract, so this is where a schema
 * nobody can serve would show up. The same suite runs over HTTP beside this
 * (`conformance.http.test.ts`) and against the real orchestrator in PRD-02.
 */

describeMatchApiConformance('the fake orchestrator', {
  target: () => createFakeConformanceTarget(),
})

describe('the suite itself', () => {
  it('runs every flow against the fake with nothing skipped', async () => {
    const report = await runMatchApiConformance({ target: () => createFakeConformanceTarget() })
    expect(formatConformanceReport(report)).toContain('0 failed')
    expect(report.skipped, formatConformanceReport(report)).toBe(0)
    expect(report.passed).toBe(MATCH_API_CONFORMANCE_FLOWS.length)
    expect(report.ok).toBe(true)
    // Every flow asserted something; a flow that checks nothing passes for free.
    for (const result of report.results) expect(result.checks.length).toBeGreaterThanOrEqual(3)
  })

  it('skips a flow the target cannot do instead of failing it', async () => {
    const report = await runMatchApiConformance({
      flows: ['crash-restore', 'player-command', 'stream-hello', 'budget-refused'],
      target: () => {
        const target = createFakeConformanceTarget()
        return {
          ...target,
          faults: undefined,
          playerCommand: undefined,
          stream: undefined,
          budget: undefined,
        }
      },
    })
    expect(report.ok).toBe(true)
    expect(report.skipped).toBe(4)
    expect(report.results.map(result => result.reason)).toEqual([
      'the target offers no faults',
      'the target offers no playerCommand',
      'the target offers no stream',
      'the target offers no budget',
    ])
  })

  it('fails loudly, and names the flow and the check, when an implementation disagrees', async () => {
    const report = await runMatchApiConformance({
      flows: ['happy-bo1'],
      target: () =>
        createFakeConformanceTarget({ providers: { faults: { allocationRefused: true } } }),
    })
    expect(report.ok).toBe(false)
    expect(report.failed).toBe(1)
    const text = formatConformanceReport(report)
    expect(text).toContain('FAIL happy-bo1')
    expect(text).toContain('1 failed')
  })

  it('is deterministic: the same fake plays the same flow into the same recording', async () => {
    const flows = ['happy-bo1', 'crash-restore', 'stream-hello']
    const runs = await Promise.all(
      [0, 1].map(() =>
        runMatchApiConformance({ flows, target: () => createFakeConformanceTarget() }),
      ),
    )
    for (const [index] of flows.entries()) {
      const [a, b] = runs.map(run => run.results[index])
      expect(a?.status).toBe('passed')
      expect(stringifyRecording(b?.recording)).toBe(stringifyRecording(a?.recording))
    }
  })

  it('records requests, responses, envelopes, deliveries and frames', async () => {
    const report = await runMatchApiConformance({
      flows: ['stream-hello'],
      target: () => createFakeConformanceTarget(),
    })
    const recording = report.results[0]?.recording
    expect(recording?.flow).toBe('stream-hello')
    expect(recording?.calls.map(call => call.route)).toContain('matches.create')
    expect(recording?.envelopes.length).toBeGreaterThan(10)
    expect(recording?.deliveries.length).toBe(recording?.envelopes.length)
    expect(new Set(recording?.frames.map(frame => frame.type))).toContain('hello')
  })

  it('never lets a secret into a recording', async () => {
    const report = await runMatchApiConformance({
      flows: ['happy-bo1', 'player-command'],
      target: () => createFakeConformanceTarget(),
    })
    for (const result of report.results) {
      const text = stringifyRecording(result.recording)
      expect(text).not.toMatch(/fake-key-|fake-player-token-|fake-join-|fake-node-token-/)
      expect(text).toContain('"password": "<redacted>"')
    }
  })
})
