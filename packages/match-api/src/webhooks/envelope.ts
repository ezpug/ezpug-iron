import { z } from 'zod'
import { assertClosedSet } from '../closed-set'
import { clientMatchIdSchema, matchIdSchema, timestampSchema } from '../resources/common'
import { budgetLimitsSchema, budgetUsageSchema } from '../resources/fleet'
import {
  matchDemoOutcomeSchema,
  matchEndedReasonSchema,
  serverConnectSchema,
  serverTvSchema,
} from '../resources/match'
import {
  backupWrittenEventSchema,
  bombDefusedEventSchema,
  bombExplodedEventSchema,
  bombPlantedEventSchema,
  chatCommandEventSchema,
  chatMessageEventSchema,
  demoAvailableEventSchema,
  EPHEMERAL_GAMESERVER_EVENT_TYPES,
  GAMESERVER_EVENT_TYPES,
  type GameserverEventType,
  gameserverPlayerSchema,
  goingLiveEventSchema,
  heartbeatEventSchema,
  mapEndEventSchema,
  matchPausedEventSchema,
  matchUnpausedEventSchema,
  playerConnectedEventSchema,
  playerDeathEventSchema,
  playerDisconnectedEventSchema,
  pluginEventSchema,
  roundEndEventSchema,
  roundStartEventSchema,
  seriesEndEventSchema,
  serverReadyEventSchema,
  sideSwapEventSchema,
} from '../vocabulary/gameserver'
import { domainEventNameSchema, kebabNameSchema } from '../vocabulary/naming'

/**
 * **The webhook envelope** (decision 6). Every durable thing the orchestrator
 * has to say about a match is one envelope, POSTed to the request's
 * `callbacks.webhookUrl`, signed ({@link ../webhooks/signature}), retried on
 * the published schedule ({@link ../webhooks/retry}) and replayable from
 * `GET /v1/matches/:matchId/events` — the same envelopes, in the same order.
 *
 * `payload` is either a **gameserver event** (the vocabulary, minus the
 * ephemeral `position_tick`, which goes over the stream and nowhere else) or
 * an **orchestration fact** — what the orchestrator itself knows and no
 * server said: a server was obtained, is ready, was lost, came back, the
 * match failed or ended, a demo landed, a person joined. Both sit under one
 * discriminator (`payload.type`), so a consumer that only wants the game
 * reads one branch and one that wants the whole story reads both.
 *
 * Three identities, one rule each:
 *
 * - `deliveryId` names the envelope. A retry carries the same one, so a
 *   consumer that stores delivery ids sees a retry as the duplicate it is.
 * - `(matchId, seq)` names the *fact*: `seq` is the match's own sequence,
 *   1-based, gap-free, increasing in the order the orchestrator learned
 *   things. `Match.seq` is the last one delivered, the stream's `hello.seq`
 *   is the last one at subscribe time, and the events route is paged by it.
 *   A consumer that has seen `(matchId, seq)` already has the fact whatever
 *   its `deliveryId`.
 * - `occurredAt` is the orchestrator's clock at the moment it learned the
 *   fact, never a server's — the vocabulary carries no wall time on purpose.
 *
 * Order is best effort: deliveries go out in `seq` order, but a delivery
 * stuck in retries does not hold the ones after it back, so a consumer may
 * see `seq` 12 before 11. Gaps are closed by replaying from the events route;
 * a fact is never delivered twice under two sequence numbers.
 */

// ---------------------------------------------------------------------------
// Orchestration facts
// ---------------------------------------------------------------------------

/**
 * The name grammar every fact obeys: `domain.event`, snake_case both sides,
 * exactly one dot — which is also what keeps a fact's `type` disjoint from a
 * gameserver event's (`round_end`, never a dot), so the two unions can share
 * one discriminator.
 */
const factBase = z.object({ type: domainEventNameSchema })

/** A server was obtained: the ledger row is open and the provider answered. */
export const matchAllocatedFactSchema = factBase.extend({
  type: z.literal('match.allocated'),
  /** The provider badge (`sim`, `dathost`, a node's provider id). */
  provider: kebabNameSchema,
  /** The provider's own handle for the server; `source.serverId` on every event to come. */
  serverId: z.string().min(1),
  /** The ledger row. */
  fleetServerId: z.uuid(),
  region: kebabNameSchema.nullable(),
})

/**
 * Players may connect. The same facts as `Match.connect` / `Match.tv`, pushed.
 * Said a second time when a lost server's match comes back on a replacement
 * (`Match.state` is then `recovering`, not `ready`): `restored: true` and
 * `round`, the round play resumes from, mark that one so a consumer can
 * re-announce the connect facts as a return rather than a first call.
 */
export const matchServerReadyFactSchema = factBase.extend({
  type: z.literal('match.server_ready'),
  connect: serverConnectSchema,
  tv: serverTvSchema.nullable(),
  /** Present, and true, only on the replacement server's announcement. */
  restored: z.literal(true).optional(),
  /** The round the replacement resumes from; with `restored` only. */
  round: z.number().int().positive().optional(),
})

/**
 * The server was lost mid-match and the orchestrator is trying to bring it
 * back (`Match.state` is `recovering`). `backupRound` is the round the newest
 * backup holds, or null when there is none — in which case what follows is
 * `match.failed` with `server_lost`.
 */
export const matchRecoveringFactSchema = factBase.extend({
  type: z.literal('match.recovering'),
  /** Why the orchestrator believes the server is gone, for a human. */
  reason: z.string().min(1).max(256),
  backupRound: z.number().int().positive().nullable(),
})

/**
 * The match is `live` again, possibly on a different server (a new
 * `match.allocated` and `match.server_ready` have then preceded this one).
 */
export const matchRecoveredFactSchema = factBase.extend({
  type: z.literal('match.recovered'),
  serverId: z.string().min(1),
  fleetServerId: z.uuid(),
  /** The round play resumed from, or null when the map restarted. */
  resumedFromRound: z.number().int().positive().nullable(),
})

/** The match reached `failed`. `reason.kind` is `server_lost`, `allocation_failed` or `provider_error`. */
export const matchFailedFactSchema = factBase.extend({
  type: z.literal('match.failed'),
  state: z.literal('failed'),
  reason: matchEndedReasonSchema,
})

/**
 * The match reached `ended` or `cancelled` and the server is released.
 * `reason.kind` says which story it was: `completed`, `force_ended`,
 * `cancelled` or `ttl_expired`. The last envelope of a match that did not fail.
 */
export const matchEndedFactSchema = factBase.extend({
  type: z.literal('match.ended'),
  state: z.enum(['ended', 'cancelled']),
  reason: matchEndedReasonSchema,
  /**
   * What became of the demos (PRD-02 T21): how many maps' demos reached the
   * client's storage, and why there were not more. Absent only from a producer
   * older than the field.
   */
  demo: matchDemoOutcomeSchema.optional(),
})

/**
 * The demo of one map landed in the client's storage through the request's
 * `demoUploadUrl` (decision 10). The orchestrator relays size and hash so the
 * client can verify what it holds; it never saw a byte of it. `key` is the
 * object key when the upload URL made it recoverable, else absent.
 */
export const demoUploadedFactSchema = factBase.extend({
  type: z.literal('demo.uploaded'),
  /** 1-based map number within the series. */
  mapNumber: z.number().int().positive(),
  key: z.string().min(1).optional(),
  size: z.number().int().nonnegative(),
  /** Lowercase hex, 64 characters. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase hex sha256'),
  contentType: z.string().min(1),
})

/**
 * A person is on the server, as the orchestrator counts it — the
 * connection the plugin reported, matched against the roster. `rostered` is
 * false in an open-join gamemode for a player the request did not name; the
 * client answers with a `profile` command if it wants them dressed.
 */
export const playerJoinedFactSchema = factBase.extend({
  type: z.literal('player.joined'),
  player: gameserverPlayerSchema,
  rostered: z.boolean(),
})

export const playerLeftFactSchema = factBase.extend({
  type: z.literal('player.left'),
  player: gameserverPlayerSchema,
})

/**
 * The fleet facts. They are about a key's capacity, not about one match, and
 * still travel as envelopes: the orchestrator fans each one out to every
 * open match of the key it touches (the matches on the provider, on the
 * node, the match the orphaned server was obtained for, every open match
 * for a budget threshold), each in that match's own sequence. A key with no
 * open match hears nothing and reads the fleet routes instead.
 */

/** The provider behind this match's server stopped answering probes. */
export const fleetProviderUnreachableFactSchema = factBase.extend({
  type: z.literal('fleet.provider_unreachable'),
  provider: kebabNameSchema,
  since: timestampSchema,
  lastError: z.string().min(1).max(512),
})

/** The node hosting this match's server dropped its link to the orchestrator. */
export const fleetNodeDisconnectedFactSchema = factBase.extend({
  type: z.literal('fleet.node_disconnected'),
  node: kebabNameSchema,
  lastSeenAt: timestampSchema.nullable(),
})

/**
 * The reaper found a server the provider still runs for a ledger row that
 * is closed or a match that is over — money burning with nothing to show.
 * `released` says whether it deallocated it on the spot.
 */
export const fleetOrphanFoundFactSchema = factBase.extend({
  type: z.literal('fleet.orphan_found'),
  provider: kebabNameSchema,
  serverId: z.string().min(1),
  fleetServerId: z.uuid(),
  released: z.boolean(),
})

/** The fractions of a ceiling the orchestrator warns at, in order (decision 7). */
export const BUDGET_THRESHOLD_FRACTIONS = [0.8, 0.95] as const

/** The three ceilings a threshold can be about; the keys of `Budget.limits`. */
export const budgetLimitNameSchema = z.enum([
  'maxConcurrentServers',
  'maxServerLifetimeMinutes',
  'monthlyCents',
])
export type BudgetLimitName = z.infer<typeof budgetLimitNameSchema>

/**
 * The key crossed one of {@link BUDGET_THRESHOLD_FRACTIONS} of a ceiling.
 * Sent once per fraction per month (or per server, for the lifetime
 * ceiling), never repeated for the same crossing.
 */
export const fleetBudgetThresholdFactSchema = factBase.extend({
  type: z.literal('fleet.budget_threshold'),
  limit: budgetLimitNameSchema,
  fraction: z.number().min(0).max(1),
  usage: budgetUsageSchema,
  limits: budgetLimitsSchema,
})

export const orchestrationFactSchema = z.discriminatedUnion('type', [
  matchAllocatedFactSchema,
  matchServerReadyFactSchema,
  matchRecoveringFactSchema,
  matchRecoveredFactSchema,
  matchFailedFactSchema,
  matchEndedFactSchema,
  demoUploadedFactSchema,
  playerJoinedFactSchema,
  playerLeftFactSchema,
  fleetProviderUnreachableFactSchema,
  fleetNodeDisconnectedFactSchema,
  fleetOrphanFoundFactSchema,
  fleetBudgetThresholdFactSchema,
])
export type OrchestrationFact = z.infer<typeof orchestrationFactSchema>

/** Every fact type, in the union's order. */
export const ORCHESTRATION_FACT_TYPES = [
  'match.allocated',
  'match.server_ready',
  'match.recovering',
  'match.recovered',
  'match.failed',
  'match.ended',
  'demo.uploaded',
  'player.joined',
  'player.left',
  'fleet.provider_unreachable',
  'fleet.node_disconnected',
  'fleet.orphan_found',
  'fleet.budget_threshold',
] as const
export type OrchestrationFactType = (typeof ORCHESTRATION_FACT_TYPES)[number]

/** The fact for one `type` — `OrchestrationFactOf<'match.ended'>` etc. */
export type OrchestrationFactOf<T extends OrchestrationFactType> = Extract<
  OrchestrationFact,
  { type: T }
>

assertClosedSet('orchestration facts', orchestrationFactSchema, 'type', ORCHESTRATION_FACT_TYPES)

// ---------------------------------------------------------------------------
// The payload and the envelope
// ---------------------------------------------------------------------------

/**
 * The gameserver event types a webhook carries: the vocabulary minus the
 * ephemeral tier. Derived from the vocabulary's own lists, so the union below
 * is checked against it at load time — a new durable event type that is not
 * added here throws before any test runs.
 */
export const DURABLE_GAMESERVER_EVENT_TYPES = GAMESERVER_EVENT_TYPES.filter(
  type => !(EPHEMERAL_GAMESERVER_EVENT_TYPES as readonly string[]).includes(type),
) as readonly Exclude<GameserverEventType, (typeof EPHEMERAL_GAMESERVER_EVENT_TYPES)[number]>[]

/** The vocabulary's union without `position_tick`: what may be stored, replayed and signed. */
export const durableGameserverEventSchema = z.discriminatedUnion('type', [
  serverReadyEventSchema,
  heartbeatEventSchema,
  playerConnectedEventSchema,
  playerDisconnectedEventSchema,
  goingLiveEventSchema,
  roundStartEventSchema,
  roundEndEventSchema,
  sideSwapEventSchema,
  mapEndEventSchema,
  seriesEndEventSchema,
  matchPausedEventSchema,
  matchUnpausedEventSchema,
  playerDeathEventSchema,
  bombPlantedEventSchema,
  bombDefusedEventSchema,
  bombExplodedEventSchema,
  backupWrittenEventSchema,
  demoAvailableEventSchema,
  chatCommandEventSchema,
  chatMessageEventSchema,
  pluginEventSchema,
])
export type DurableGameserverEvent = z.infer<typeof durableGameserverEventSchema>

assertClosedSet(
  'durable gameserver events',
  durableGameserverEventSchema,
  'type',
  DURABLE_GAMESERVER_EVENT_TYPES,
)

/**
 * What an envelope carries: a durable gameserver event or an orchestration
 * fact, one discriminator (`type`; an event's is snake_case, a fact's has a
 * dot, so the two sets cannot collide). `position_tick` is refused here by
 * construction — a webhook that carried one would be storing what decision 6
 * says is never stored.
 */
export const webhookPayloadSchema = z.discriminatedUnion('type', [
  durableGameserverEventSchema,
  orchestrationFactSchema,
])
export type WebhookPayload = z.infer<typeof webhookPayloadSchema>

/** Every payload type an envelope may carry, gameserver events first, in the unions' order. */
export const WEBHOOK_PAYLOAD_TYPES = [
  ...DURABLE_GAMESERVER_EVENT_TYPES,
  ...ORCHESTRATION_FACT_TYPES,
] as readonly (
  | (typeof DURABLE_GAMESERVER_EVENT_TYPES)[number]
  | (typeof ORCHESTRATION_FACT_TYPES)[number]
)[]
export type WebhookPayloadType = (typeof WEBHOOK_PAYLOAD_TYPES)[number]

export function isOrchestrationFact(payload: WebhookPayload): payload is OrchestrationFact {
  return (ORCHESTRATION_FACT_TYPES as readonly string[]).includes(payload.type)
}

/** A delivery's id — minted by the orchestrator, a uuid, the same across retries. */
export const deliveryIdSchema = z.uuid()

/** A match's sequence number: 1-based, gap-free, the order the orchestrator learned things. */
export const seqSchema = z.number().int().positive()

export const webhookEnvelopeSchema = z.object({
  deliveryId: deliveryIdSchema,
  matchId: matchIdSchema,
  clientMatchId: clientMatchIdSchema,
  seq: seqSchema,
  occurredAt: timestampSchema,
  payload: webhookPayloadSchema,
})
export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>
