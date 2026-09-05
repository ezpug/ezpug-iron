/**
 * `@ezpug/match-api/fake` — the in-process fake orchestrator (decision 3):
 * every route of the Match API without a network, matches played by the
 * simulator engine on an injected clock, real signatures on every webhook,
 * the published retry schedule, the stream, a ledger that refuses. What the
 * platform's tests and history seed run on, and what the conformance suite
 * proves the real orchestrator against.
 */

export { ApiError } from '../errors'
export {
  FAKE_ADMIN_KEY_NAME,
  FAKE_OUT_OF_ORDER_DELAY_MS,
  FAKE_PLAYER_COMMAND_EVENT,
  FAKE_PRNG_SEED,
  FAKE_SECRET_PREFIXES,
  FAKE_SERVER_PORT,
  FAKE_SYNTHETIC_FAILURE_STATUS,
  FAKE_TV_PORT,
} from './core'
export { createFakeOrchestrator } from './orchestrator'
export type * from './types'
