import { systemClock } from '@ezpug/core'
import type { Match, MatchRequestInput, WebhookEnvelope } from '../../index'
import { CONFORMANCE_TEAMS, MATCH_API_CONFORMANCE_FLOWS, SHORT_RULES } from './flows'
import { createRecordingClient, redact } from './recording'
import type {
  CONFORMANCE_CAPABILITIES,
  ConformanceCall,
  ConformanceCheck,
  ConformanceContext,
  ConformanceFlow,
  ConformanceFlowResult,
  ConformanceOptions,
  ConformanceRecording,
  ConformanceReport,
  ConformanceTarget,
} from './types'

/**
 * **The conformance runner** (PRD-01 T8): drive an implementation of the
 * Match API through {@link MATCH_API_CONFORMANCE_FLOWS} and report what
 * agreed. No test framework — it returns results, so it runs inside Vitest
 * here, inside the orchestrator's own suite in PRD-02, from a script against
 * a deployed orchestrator, or from the platform against the fake it pins.
 * {@link assertConformance} turns a report into a thrown, readable failure;
 * `../vitest.ts` turns one into `it()`s.
 */

/** How long one wait sleeps between polls, in clock time. */
export const CONFORMANCE_POLL_INTERVAL_MS = 10_000
/** How much clock time one wait may take before the flow gives up. */
export const CONFORMANCE_MAX_WAIT_MS = 45 * 60_000

/** Thrown by `require` — the flow cannot go on, and the check already says why. */
class FlowAborted extends Error {
  override readonly name = 'FlowAborted'
}

export async function runMatchApiConformance(
  options: ConformanceOptions,
): Promise<ConformanceReport> {
  const flows = selectFlows(options.flows)
  const results: ConformanceFlowResult[] = []

  for (const flow of flows) {
    const target = options.target ? await options.target(flow) : (options as ConformanceTarget)
    try {
      const result = await runFlow(flow, target)
      results.push(result)
      options.onResult?.(result)
    } finally {
      if (options.target) await target.close?.()
    }
  }

  const passed = results.filter(result => result.status === 'passed').length
  const failed = results.filter(result => result.status === 'failed').length
  const skipped = results.filter(result => result.status === 'skipped').length
  return { ok: failed === 0, results, passed, failed, skipped }
}

function selectFlows(ids: readonly string[] | undefined): readonly ConformanceFlow[] {
  if (!ids) return MATCH_API_CONFORMANCE_FLOWS
  return ids.map(id => {
    const flow = MATCH_API_CONFORMANCE_FLOWS.find(candidate => candidate.id === id)
    if (!flow) throw new Error(`conformance: no flow named "${id}"`)
    return flow
  })
}

/** What the target cannot do, of what this flow needs. */
function missingCapabilities(flow: ConformanceFlow, target: ConformanceTarget): string[] {
  const has: Record<(typeof CONFORMANCE_CAPABILITIES)[number], boolean> = {
    faults: target.faults !== undefined,
    playerCommand: target.playerCommand !== undefined,
    stream: target.stream !== undefined,
    budget: target.budget !== undefined,
    demoUpload: target.callbacks.demoUploadUrl !== undefined,
  }
  return flow.needs.filter(need => !has[need])
}

async function runFlow(
  flow: ConformanceFlow,
  target: ConformanceTarget,
): Promise<ConformanceFlowResult> {
  const calls: ConformanceCall[] = []
  const recording: ConformanceRecording = {
    flow: flow.id,
    calls,
    envelopes: [],
    deliveries: [],
    frames: [],
  }
  const missing = missingCapabilities(flow, target)
  if (missing.length > 0) {
    return {
      flow: flow.id,
      title: flow.title,
      status: 'skipped',
      reason: `the target offers no ${missing.join(', ')}`,
      checks: [],
      recording,
    }
  }

  const checks: ConformanceCheck[] = []
  const clock = target.clock ?? systemClock
  const pollIntervalMs = target.pollIntervalMs ?? CONFORMANCE_POLL_INTERVAL_MS
  const maxWaitMs = target.maxWaitMs ?? CONFORMANCE_MAX_WAIT_MS
  const advance = async (ms: number): Promise<void> => {
    if (target.advance) await target.advance(ms)
    else await clock.sleep(ms)
  }
  const settle = async (): Promise<void> => {
    if (target.settle) await target.settle()
    else await advance(0)
  }

  const received: WebhookEnvelope[] = []
  const unsubscribe = target.webhooks(envelope => {
    received.push(envelope)
    recording.deliveries.push({ seq: envelope.seq, type: envelope.payload.type })
  })

  const check = (name: string, ok: boolean, detail?: string): boolean => {
    checks.push(detail !== undefined && !ok ? { name, ok, detail } : { name, ok })
    return ok
  }

  const ctx: ConformanceContext = {
    target,
    flow,
    api: createRecordingClient(target.client, calls),
    raw: target.client,
    recorded: client => createRecordingClient(client, calls),
    check,
    require(name, ok, detail) {
      if (!check(name, ok, detail)) throw new FlowAborted(name)
    },
    request: overrides => request(flow, target, overrides),
    frames: recording.frames,
    settle,
    async waitFor(what, poll) {
      const deadline = clock.now() + maxWaitMs
      for (;;) {
        const value = await poll()
        if (value !== null) return value
        if (clock.now() >= deadline)
          throw new Error(`conformance: gave up waiting for ${what} after ${maxWaitMs} ms`)
        await advance(pollIntervalMs)
      }
    },
    waitForState(matchId, states) {
      return ctx.waitFor(`the match to be ${states.join(' or ')}`, async () => {
        const match: Match = await target.client.matches.get({ params: { matchId } })
        return states.includes(match.state) ? match : null
      })
    },
    async replay(matchId) {
      const out: WebhookEnvelope[] = []
      let cursor = '0'
      for (let guard = 0; guard < 1_000; guard += 1) {
        const page = await target.client.matches.events({
          params: { matchId },
          query: { cursor, limit: 200 },
        })
        out.push(...page.items)
        if (page.nextCursor === null || page.items.length === 0) break
        cursor = page.nextCursor
      }
      // The golden file keeps the envelopes; the flow keeps the originals.
      recording.envelopes = redact(out)
      return out
    },
    delivered: matchId => received.filter(envelope => envelope.matchId === matchId),
  }

  try {
    await flow.run(ctx)
  } catch (error) {
    if (!(error instanceof FlowAborted)) {
      checks.push({ name: 'the flow ran to its end', ok: false, detail: String(error) })
    }
  } finally {
    unsubscribe()
    recording.frames = redact(recording.frames)
  }

  const failures = checks.filter(entry => !entry.ok)
  return {
    flow: flow.id,
    title: flow.title,
    status: failures.length === 0 ? 'passed' : 'failed',
    ...(failures[0] ? { reason: failures[0].name } : {}),
    checks,
    recording,
  }
}

/** The match request a flow starts from — one shape, the target's callbacks, the flow's own id. */
function request(
  flow: ConformanceFlow,
  target: ConformanceTarget,
  overrides: Partial<MatchRequestInput> = {},
): MatchRequestInput {
  return {
    clientMatchId: `conformance-${flow.id}`,
    game: 'cs2',
    gamemode: 'pug',
    teams: teamsFor(overrides),
    maps: [{ map: 'de_mirage', sides: 'ct' }],
    rules: SHORT_RULES,
    callbacks: { ...target.callbacks },
    ttlMinutes: 120,
    ...overrides,
  }
}

function teamsFor(overrides: Partial<MatchRequestInput>): MatchRequestInput['teams'] {
  return overrides.teams ?? CONFORMANCE_TEAMS
}

/**
 * A report as a human reads it: one line per flow, then every failed check.
 * What a Vitest failure message and a script's stdout both print.
 */
export function formatConformanceReport(report: ConformanceReport): string {
  const lines: string[] = []
  for (const result of report.results) {
    const mark = result.status === 'passed' ? 'ok' : result.status === 'skipped' ? '--' : 'FAIL'
    const counted = `${result.checks.filter(c => c.ok).length}/${result.checks.length}`
    lines.push(
      `${mark.padEnd(4)} ${result.flow.padEnd(20)} ${counted.padEnd(8)} ${result.title}${
        result.reason && result.status === 'skipped' ? ` — ${result.reason}` : ''
      }`,
    )
    for (const failed of result.checks.filter(entry => !entry.ok)) {
      lines.push(`       ✗ ${failed.name}${failed.detail ? ` — ${failed.detail}` : ''}`)
    }
  }
  lines.push(
    `${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped, ` +
      `${report.results.length} flows`,
  )
  return lines.join('\n')
}

/** Throw the report when anything failed — the one line a caller needs. */
export function assertConformance(report: ConformanceReport): void {
  if (report.ok) return
  throw new Error(`Match API conformance failed:\n${formatConformanceReport(report)}`)
}
