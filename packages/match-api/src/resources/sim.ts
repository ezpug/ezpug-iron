import { z } from 'zod'
import { kebabNameSchema } from '../vocabulary/naming'

/**
 * **The simulator's knobs, as the Match API exposes them** (decision 9): the
 * platform's `simulator.ts` vocabulary — mode, chaos, time scale, outcome —
 * carried over so the platform's console keeps its words. They apply only to
 * a match on the `sim` provider; a `sim.*` command on any other server is
 * `command_unsupported`.
 */

/**
 * How a simulated server deals its story: `auto` plays it on the clock,
 * `step` arms no timers at all and every beat is a `sim.step`.
 */
export const simModeSchema = z.enum(['auto', 'step'])
export type SimMode = z.infer<typeof simModeSchema>

/**
 * Per-match delivery chaos — this server's own event delivery, nothing else.
 * Chances are 0..1 per delivery; `delayMs` is how long a delayed one waits
 * before it arrives (out of order, which is the point). Dropping is not
 * offered: a real server retries, so a lost result-bearing event would be
 * faking a guarantee rather than testing one.
 */
export const simChaosSchema = z.object({
  delay: z.number().min(0).max(1).optional(),
  duplicate: z.number().min(0).max(1).optional(),
  delayMs: z.number().int().positive().max(60_000).optional(),
})
export type SimChaos = z.infer<typeof simChaosSchema>

/**
 * 1 = real time (a Bo1 takes the forty minutes it takes). The platform's
 * console defaults to {@link SIM_CONSOLE_TIME_SCALE} so a demo is watchable in
 * a couple of minutes; the cap keeps a slider from arming a thousand timers
 * for the same millisecond.
 */
export const SIM_TIME_SCALE_MIN = 0.25
export const SIM_TIME_SCALE_MAX = 600
export const SIM_CONSOLE_TIME_SCALE = 20
export const simTimeScaleSchema = z.number().min(SIM_TIME_SCALE_MIN).max(SIM_TIME_SCALE_MAX)

/** How the story ends, once the simulator has built it. */
export const simOutcomeSchema = z.enum(['completed', 'crashed', 'idle'])
export type SimOutcome = z.infer<typeof simOutcomeSchema>

/**
 * **One scenario the simulator can play**, with every knob spelled out —
 * what `GET /v1/sim/scenarios` lists so a console that offers a name knows
 * this build has it. `MatchRequest.sim.scenario` takes the `name`; a name
 * nobody defined is `validation_failed` on the match, which is a bad moment
 * to find out.
 */
export const simScenarioSchema = z.object({
  name: kebabNameSchema,
  /** The server never finishes booting; the provisioning timeout ends the match. */
  neverReady: z.boolean(),
  /** This many rostered players never connect (`no_show`). */
  absentPlayers: z.number().int().nonnegative(),
  /** The server goes silent right after this round of map 1; null = it never does. */
  crashAfterRound: z.number().int().positive().nullable(),
  /** Tactical pauses sprinkled into map 1. */
  pauses: z.number().int().nonnegative(),
  /** Overtimes forced on map 1 — ignored when the request disabled overtime. */
  overtimes: z.number().int().nonnegative(),
  /** The winner trails badly at the half, then runs the table. */
  comeback: z.boolean(),
})
export type SimScenario = z.infer<typeof simScenarioSchema>

/** The catalog, and which entry a request that names none is played as. */
export const simScenarioCatalogSchema = z.object({
  scenarios: z.array(simScenarioSchema).min(1),
  /** The `name` of the scenario a `sim` block without one gets. */
  default: kebabNameSchema,
})
export type SimScenarioCatalog = z.infer<typeof simScenarioCatalogSchema>

/**
 * What a simulated server reports about itself — present on a `Match` that
 * runs on the `sim` provider, null on every other.
 */
export const simStatusSchema = z.object({
  scenario: kebabNameSchema,
  /** The seed the story was built from — carry it into a bug report. */
  seed: z.string().min(1),
  mode: simModeSchema,
  timeScale: simTimeScaleSchema,
  /** Story beats not yet dealt — the step button's fuel gauge. */
  remainingBeats: z.number().int().nonnegative(),
  finished: z.boolean(),
  outcome: simOutcomeSchema.nullable(),
  chaos: simChaosSchema.nullable(),
})
export type SimStatus = z.infer<typeof simStatusSchema>
