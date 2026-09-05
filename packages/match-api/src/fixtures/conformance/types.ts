import type { Clock } from '@ezpug/core'
import type { Match, MatchRequestInput, StreamFrame, WebhookEnvelope } from '../../index'
import type { matchApiRoutes } from '../../routes'
import type { ApiClient } from '../../rpc'

/**
 * **The conformance suite's vocabulary** (PRD-01 T8). The suite drives *an
 * implementation of the Match API* — the fake here, the real orchestrator in
 * PRD-02, whatever the platform pins — through the flows a client actually
 * performs, and reports what agreed and what did not. It is the seam test:
 * if the fake, the orchestrator and the platform's expectations ever
 * disagree, this is where it shows, and the recorded fixtures beside it
 * decide who moved.
 *
 * Nothing here imports a test framework: the runner returns results, and a
 * four-line Vitest wrapper turns them into `it()`s (`../vitest.ts`).
 */

/** The calls a target offers — the typed client of the route table, however it was made. */
export type ConformanceClient = ApiClient<typeof matchApiRoutes>

/**
 * Something an implementation may or may not be able to do. A flow that
 * needs one the target does not offer is **skipped with a reason**, never
 * failed: a real orchestrator has no fault knobs in production, and the
 * platform's fake has no widget socket.
 */
export const CONFORMANCE_CAPABILITIES = [
  /** `target.faults` — the crash knobs the recovery flows need. */
  'faults',
  /** `target.playerCommand` — a gamemode widget's tap (decision 17). */
  'playerCommand',
  /** `target.stream` — a subscription to `GET /v1/matches/:matchId/stream`. */
  'stream',
  /** `target.budget` — a second key whose ceiling can be exceeded on purpose. */
  'budget',
  /** `callbacks.demoUploadUrl` — somewhere for a demo to land. */
  'demoUpload',
] as const
export type ConformanceCapability = (typeof CONFORMANCE_CAPABILITIES)[number]

/** The fault knobs a flow asks for. An implementation maps them onto its own. */
export interface ConformanceFaults {
  /**
   * The server dies after this round of map 1; `backup` says whether the
   * round backups survived it (a restore) or went with the box (a loss).
   */
  crash?: { afterRound: number; backup: boolean } | null
}

/** A player-scoped command as a widget would send it, and the event it answered with. */
export interface ConformancePlayerCommand {
  token: string
  command: string
  args?: Record<string, unknown>
}

/** How a flow subscribes to a match's stream — a socket, or an in-process listener. */
export type ConformanceSubscribe = (
  subscription: { matchId: string; token?: string },
  onFrame: (frame: StreamFrame) => void,
) => () => void

/**
 * **The implementation under test.** `client`, `webhooks` and `callbacks` are
 * what every implementation must offer; the rest narrows what can be asked
 * of it.
 */
export interface ConformanceTarget {
  /** The typed client, pointed at the implementation. */
  client: ConformanceClient
  /**
   * Subscribe to every webhook delivery the implementation makes for this
   * key — after verifying its signature, which is the consumer's job.
   * Returns the unsubscribe.
   */
  webhooks: (handler: (envelope: WebhookEnvelope) => void) => () => void
  /** What a flow puts in `MatchRequest.callbacks`. The secret id must be registered on the key. */
  callbacks: {
    webhookUrl: string
    webhookSecretId: string
    /** Omitted = no demo lands anywhere, and the demo checks are skipped. */
    demoUploadUrl?: string
  }
  /** Where the suite's own waits happen. Defaults to the system clock. */
  clock?: Clock
  /**
   * Let `ms` of the implementation's time pass. A fake clock advances; a
   * real orchestrator sleeps (the default). Every wait in the suite goes
   * through here, so nothing reads `Date.now()`.
   */
  advance?: (ms: number) => Promise<void> | void
  /** Flush whatever is in flight — deliveries, uploads. Default: one `advance(0)`. */
  settle?: () => Promise<void> | void
  /** Arm the fault knobs before a flow creates its match. */
  faults?: (faults: ConformanceFaults) => Promise<void> | void
  /** Send a player-scoped command and resolve with the envelope the plugin answered with. */
  playerCommand?: (command: ConformancePlayerCommand) => Promise<WebhookEnvelope>
  /** Open a stream subscription. */
  stream?: ConformanceSubscribe
  /**
   * A second key whose budget can be exceeded without spending anything:
   * the flow asks for one minute more than the key's lifetime ceiling and
   * expects `budget_exceeded` at the door.
   */
  budget?: {
    client: ConformanceClient
    maxServerLifetimeMinutes: number
  }
  /** How long one `waitFor` sleeps between polls. Default 15 s of clock time. */
  pollIntervalMs?: number
  /** How much clock time one wait may take before the flow fails. Default 45 min. */
  maxWaitMs?: number
  /** Called when the flow is done with this target (a per-flow factory's teardown). */
  close?: () => Promise<void> | void
}

/** One assertion a flow made. */
export interface ConformanceCheck {
  name: string
  ok: boolean
  /** What was seen, when it was not what was wanted. */
  detail?: string
}

/** One call a flow made, as the golden files record it. */
export type ConformanceCall =
  | {
      route: string
      input?: Record<string, unknown>
      ok: true
      response: unknown
    }
  | {
      route: string
      input?: Record<string, unknown>
      ok: false
      status: number
      code: string
      message: string
    }

/**
 * **What one flow produced**, recorded so a later run can be compared against
 * it byte for byte (`fixtures/recorded/<flow>.json`): every call with its
 * input and its answer, every durable envelope in `seq` order, the order the
 * deliveries arrived in, and the stream frames when the flow opened a socket.
 * Secrets are redacted by name — a public repo never carries one, even a
 * fake one.
 */
export interface ConformanceRecording {
  flow: string
  calls: ConformanceCall[]
  envelopes: WebhookEnvelope[]
  /** `seq` and payload type per delivery, in arrival order; the bodies are `envelopes`. */
  deliveries: { seq: number; type: string }[]
  frames: StreamFrame[]
}

export interface ConformanceFlowResult {
  flow: string
  title: string
  status: 'passed' | 'failed' | 'skipped'
  /** Why it was skipped, or what threw. */
  reason?: string
  checks: ConformanceCheck[]
  recording: ConformanceRecording
}

export interface ConformanceReport {
  ok: boolean
  results: ConformanceFlowResult[]
  passed: number
  failed: number
  skipped: number
}

/** What a flow is handed. */
export interface ConformanceContext {
  target: ConformanceTarget
  flow: ConformanceFlow
  /** The client whose calls land in the recording. */
  api: ConformanceClient
  /** The same client, unrecorded — what the polling loop uses so a golden is not a timing log. */
  raw: ConformanceClient
  /** Another client (a second key) with its calls landing in the same recording. */
  recorded: (client: ConformanceClient) => ConformanceClient
  /** Record an assertion; returns whether it held. */
  check: (name: string, ok: boolean, detail?: string) => boolean
  /** An assertion the rest of the flow depends on: a false one ends the flow. */
  require: (name: string, ok: boolean, detail?: string) => void
  /** A match request for this flow, with the target's callbacks filled in. */
  request: (overrides?: Partial<MatchRequestInput>) => MatchRequestInput
  /** Poll until `poll` returns something, advancing the implementation's clock between tries. */
  waitFor: <T>(what: string, poll: () => Promise<T | null>) => Promise<T>
  /** Poll until the match is in one of these states. */
  waitForState: (matchId: string, states: readonly Match['state'][]) => Promise<Match>
  /** Let everything in flight finish. */
  settle: () => Promise<void>
  /** The whole `GET /v1/matches/:id/events` replay, paged to the end (recorded). */
  replay: (matchId: string) => Promise<WebhookEnvelope[]>
  /** The deliveries this flow received for a match, in arrival order. */
  delivered: (matchId: string) => WebhookEnvelope[]
  /** Frames collected by a subscription this flow opened. */
  frames: StreamFrame[]
}

export interface ConformanceFlow {
  id: string
  title: string
  /** Missing one of these on the target and the flow is skipped. */
  needs: readonly ConformanceCapability[]
  run: (ctx: ConformanceContext) => Promise<void>
}

/**
 * A target for every flow, or one target for all of them. A factory is what
 * an in-process fake wants: the fault knobs are global, so a crash flow gets
 * its own instance and the goldens stay independent of flow order.
 */
export type ConformanceTargetFactory = (
  flow: ConformanceFlow,
) => ConformanceTarget | Promise<ConformanceTarget>

export interface ConformanceOptions extends Partial<ConformanceTarget> {
  /** A fresh target per flow. Without it, the options themselves are the target. */
  target?: ConformanceTargetFactory
  /** Run only these flows, in this order. Default: all of them, in order. */
  flows?: readonly string[]
  /** Called as each flow finishes — a progress line, a Vitest `it()`. */
  onResult?: (result: ConformanceFlowResult) => void
}
