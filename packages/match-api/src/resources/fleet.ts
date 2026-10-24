import { z } from 'zod'
import { gameSchema } from '../vocabulary/game'
import { kebabNameSchema } from '../vocabulary/naming'
import { matchIdSchema, timestampSchema } from './common'
import { serverTvSchema } from './match'

/**
 * **The fleet** (decisions 7, 12, 23): the ledger, the providers, the nodes,
 * the money. Read and driven by the platform's admin console through these
 * shapes, and by the `ezpug-iron` CLI. Nothing here carries a secret: no
 * server password, no RCON password, no node token after the one moment it is
 * shown.
 */

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/**
 * A ledger row's life. A row is written *before* the provider returns and
 * closed when the server is gone; the reaper reconciles provider truth
 * against rows, never the other way around.
 */
export const FLEET_SERVER_STATES = [
  /** The provider was asked; a server may or may not exist yet. */
  'allocated',
  /** The server exists and received its assignment. */
  'configured',
  /** Players can connect. */
  'running',
  /** Deallocated; the row is closed and costs nothing more. */
  'released',
  /** The provider never delivered, or the server died and was written off. */
  'failed',
] as const
export const fleetServerStateSchema = z.enum(FLEET_SERVER_STATES)
export type FleetServerState = z.infer<typeof fleetServerStateSchema>

/**
 * What a server has cost so far. Integer cents in euros — the currency the
 * ceilings are set in (decision 7). `hourlyCents: 0` is a node.
 */
export const costSnapshotSchema = z.object({
  currency: z.literal('EUR'),
  hourlyCents: z.number().int().nonnegative(),
  accruedCents: z.number().int().nonnegative(),
  asOf: timestampSchema,
})
export type CostSnapshot = z.infer<typeof costSnapshotSchema>

/** Where a server is reachable — host and port, never the password. */
export const fleetServerAddressSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().max(65_535),
})
export type FleetServerAddress = z.infer<typeof fleetServerAddressSchema>

export const fleetServerSchema = z.object({
  /** The ledger row's own id. */
  id: z.uuid(),
  provider: kebabNameSchema,
  /** The provider's handle for the server; null while `allocated` and not yet delivered. */
  serverId: z.string().min(1).nullable(),
  /** The node hosting it, for a node-backed provider. */
  node: kebabNameSchema.nullable(),
  /** The match it was obtained for. */
  matchId: matchIdSchema.nullable(),
  /** The API key that pays for it. */
  keyId: z.uuid(),
  state: fleetServerStateSchema,
  game: gameSchema,
  region: kebabNameSchema.nullable(),
  lan: z.boolean(),
  address: fleetServerAddressSchema.nullable(),
  tv: serverTvSchema.nullable(),
  cost: costSnapshotSchema,
  allocatedAt: timestampSchema,
  releasedAt: timestampSchema.nullable(),
  /** The reaper's deadline for this row. */
  expiresAt: timestampSchema,
})
export type FleetServer = z.infer<typeof fleetServerSchema>

/** The filter `GET /v1/fleet/ledger` accepts on top of the page query. */
export const ledgerFilterSchema = z.object({
  state: fleetServerStateSchema.optional(),
  provider: kebabNameSchema.optional(),
  matchId: matchIdSchema.optional(),
  /**
   * **What tonight cost** (PRD-02 T31): every row that was open at or after
   * this instant — still open now, or released at or after it. The window a
   * cost is asked over, not the window a row was born in: a server allocated
   * before midnight and running past it is part of tonight's bill, and the
   * month's spend (`GET /v1/fleet/budget`) is this same read with the first
   * of the month as `since`.
   */
  since: timestampSchema.optional(),
})
export type LedgerFilter = z.infer<typeof ledgerFilterSchema>

/** Body of `POST /v1/fleet/servers/:serverId/release`. */
export const releaseServerRequestSchema = z.object({
  reason: z.string().max(256).optional(),
})
export type ReleaseServerRequest = z.infer<typeof releaseServerRequestSchema>

/** Body of `POST /v1/fleet/servers/:serverId/rcon`; the answer is what the server printed. */
export const rconRequestSchema = z.object({
  command: z.string().min(1).max(1024),
})
export type RconRequest = z.infer<typeof rconRequestSchema>

export const rconResponseSchema = z.object({
  output: z.string(),
})
export type RconResponse = z.infer<typeof rconResponseSchema>

/** How many console lines the orchestrator keeps per server, and serves. */
export const CONSOLE_LINES_MAX = 500

export const consoleLineSchema = z.object({
  at: timestampSchema,
  line: z.string(),
})
export type ConsoleLine = z.infer<typeof consoleLineSchema>

/** The tail of a server's console, oldest first. */
export const consoleResponseSchema = z.object({
  lines: z.array(consoleLineSchema).max(CONSOLE_LINES_MAX),
})
export type ConsoleResponse = z.infer<typeof consoleResponseSchema>

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The game's build, and what a canary made of it (PRD-10 T2)
// ---------------------------------------------------------------------------

/**
 * **A build id is the game's own `PatchVersion`** — `1.41.9.2` — because it
 * is the one name every side speaks: Valve's update check answers it with no
 * key, every server carries it in its `steam.inf`, and the fixes upstream
 * ships name it in their titles. The other numbers the same build goes by
 * (Steam's `buildid`, the engine's source revision) ride a fact as labels and
 * never decide anything.
 */
export const gameBuildIdSchema = z.string().min(1).max(64)
export type GameBuildId = z.infer<typeof gameBuildIdSchema>

/** What a canary has said about a build: a pass, a named failure, or nothing yet. */
export const GAME_CANARY_STATES = ['green', 'red', 'unproven'] as const
export const gameCanaryStateSchema = z.enum(GAME_CANARY_STATES)
export type GameCanaryState = z.infer<typeof gameCanaryStateSchema>

/**
 * One verdict as a client reads it. `unproven` is the honest state of a
 * build nobody has played on yet — a server is still allocated on it
 * (there is no safe alternative to a match), and the reading says so.
 */
export const gameCanarySchema = z.object({
  state: gameCanaryStateSchema,
  /** The build the verdict is about; null before any build was seen. */
  build: gameBuildIdSchema.nullable(),
  /** When this state began; null before any build was seen. */
  since: timestampSchema.nullable(),
  /** One sentence: why red, or what the wait is for. Null when there is nothing to say. */
  reason: z.string().max(512).nullable(),
})
export type GameCanary = z.infer<typeof gameCanarySchema>

/**
 * **The game as one provider's servers run it.** A build, one opaque
 * revision of the server stack it was built with, and two verdicts: the
 * plain canary and the one that carried the HUD's addon loader. Nothing
 * here names a plugin — a client learns a build and a verdict, never what
 * the stack is made of.
 */
export const providerGameSchema = z.object({
  /** The build this provider's servers run, and since when; null before the first reading. */
  build: z
    .object({
      id: gameBuildIdSchema,
      since: timestampSchema,
    })
    .nullable(),
  /** One opaque revision of the server stack (an image's, a template's). Null when unknown. */
  stack: z.string().max(128).nullable(),
  canary: gameCanarySchema,
  /** The same match, with the HUD's addon loader on the server. */
  hud: gameCanarySchema,
})
export type ProviderGame = z.infer<typeof providerGameSchema>

export const providerHealthSchema = z.object({
  id: kebabNameSchema,
  healthy: z.boolean(),
  drained: z.boolean(),
  lastCheckedAt: timestampSchema.nullable(),
  /** The last probe's failure, for the console; null when healthy. */
  lastError: z.string().nullable(),
  /** Open ledger rows on this provider. */
  servers: z.number().int().nonnegative(),
  /**
   * The game's build and the canaries' verdicts for it (PRD-10 T2).
   * Optional: a server older than 0.35.0 says nothing here, and a client
   * that never asked reads what it always read.
   */
  game: providerGameSchema.optional(),
})
export type ProviderHealth = z.infer<typeof providerHealthSchema>

/**
 * **The game facts** — what the build watcher writes, append-only, once each.
 * Deliberately **not** members of `orchestrationFactSchema`: that union is an
 * envelope every strict client parses, and a new member there breaks every
 * client that verifies strictly (0.16.0's `team: "unrostered"` did; so did
 * October's highlights skew). A game fact is state a client *reads* off
 * `GET /v1/fleet/game`, never an envelope it must parse.
 */
export const gameBuildMovedFactSchema = z.object({
  type: z.literal('game.build_moved'),
  /** The build before; null the first time a deployment ever saw one. */
  from: gameBuildIdSchema.nullable(),
  to: gameBuildIdSchema,
  observedAt: timestampSchema,
  /** Steam's own number for the same build (`appmanifest` `buildid`), when it was read. */
  steamBuildId: z.string().max(64).nullable(),
  /** The engine's source revision for the same build, when a server was asked. */
  sourceRevision: z.string().max(64).nullable(),
  /** The server stack's pins at the moment of the move — opaque names, opaque versions. */
  pins: z.record(z.string(), z.string()),
})
export type GameBuildMovedFact = z.infer<typeof gameBuildMovedFactSchema>

export const gameUpstreamReleasedFactSchema = z.object({
  type: z.literal('game.upstream_released'),
  /** The upstream, as its own name (`owner/repo`). */
  repo: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
  publishedAt: timestampSchema.nullable(),
  /** What the server stack pins for this upstream at the time. */
  pinned: z.string().min(1).max(64),
  observedAt: timestampSchema,
})
export type GameUpstreamReleasedFact = z.infer<typeof gameUpstreamReleasedFactSchema>

/** Why a canary was played: the watcher saw a provider's build move, or somebody asked (PRD-10 T3). */
export const GAME_CANARY_CAUSES = ['build_moved', 'demand'] as const
export const gameCanaryCauseSchema = z.enum(GAME_CANARY_CAUSES)
export type GameCanaryCause = z.infer<typeof gameCanaryCauseSchema>

/**
 * A canary match was put on a provider for a build (PRD-10 T3): the match a
 * person would run by hand to see whether the build boots, goes live and
 * plays a round. `attempt` counts per (provider, build, hud) from 1, so a red
 * that was run again says which run this is.
 */
export const gameCanaryStartedFactSchema = z.object({
  type: z.literal('game.canary_started'),
  provider: kebabNameSchema,
  build: gameBuildIdSchema,
  /** True for the canary that carries the HUD's addon loader. */
  hud: z.boolean(),
  attempt: z.number().int().positive(),
  matchId: matchIdSchema,
  cause: gameCanaryCauseSchema,
  observedAt: timestampSchema,
})
export type GameCanaryStartedFact = z.infer<typeof gameCanaryStartedFactSchema>

/** What one canary match said about its build: a pass, or a failure in one sentence. */
export const gameCanaryVerdictFactSchema = z.object({
  type: z.literal('game.canary_verdict'),
  provider: kebabNameSchema,
  build: gameBuildIdSchema,
  hud: z.boolean(),
  attempt: z.number().int().positive(),
  matchId: matchIdSchema,
  state: z.enum(['green', 'red']),
  /** Why red: the failure named, with the console lines that showed it. Null on green. */
  reason: z.string().max(512).nullable(),
  observedAt: timestampSchema,
})
export type GameCanaryVerdictFact = z.infer<typeof gameCanaryVerdictFactSchema>

export const gameFactSchema = z.discriminatedUnion('type', [
  gameBuildMovedFactSchema,
  gameUpstreamReleasedFactSchema,
  gameCanaryStartedFactSchema,
  gameCanaryVerdictFactSchema,
])
export type GameFact = z.infer<typeof gameFactSchema>
export type GameFactType = GameFact['type']

/** How many facts `GET /v1/fleet/game` answers at most, newest first. */
export const GAME_FACTS_RECENT_MAX = 50

/** One upstream the watcher follows: what is pinned, what was last released. */
export const gameUpstreamSchema = z.object({
  repo: z.string().min(1).max(128),
  pinned: z.string().min(1).max(64),
  /** The newest release seen; null until one is. */
  latest: z.string().max(64).nullable(),
  publishedAt: timestampSchema.nullable(),
})
export type GameUpstream = z.infer<typeof gameUpstreamSchema>

/** The answer of `GET /v1/fleet/game`: the world's build, the upstreams, every provider's picture, the recent facts. */
export const fleetGameSchema = z.object({
  /** Steam's public build as last read; null before the first reading. */
  build: z
    .object({
      id: gameBuildIdSchema,
      since: timestampSchema,
      steamBuildId: z.string().max(64).nullable(),
      sourceRevision: z.string().max(64).nullable(),
    })
    .nullable(),
  upstream: z.array(gameUpstreamSchema),
  providers: z.array(z.object({ id: kebabNameSchema, game: providerGameSchema })),
  /** Newest first. */
  recent: z.array(gameFactSchema).max(GAME_FACTS_RECENT_MAX),
})
export type FleetGame = z.infer<typeof fleetGameSchema>

/** Body of `POST /v1/fleet/game/canary` (PRD-10 T3): which provider, and whether the HUD's loader rides along. */
export const gameCanaryRequestSchema = z.object({
  provider: kebabNameSchema,
  hud: z.boolean().default(false),
})
export type GameCanaryRequest = z.infer<typeof gameCanaryRequestSchema>
export type GameCanaryRequestInput = z.input<typeof gameCanaryRequestSchema>

/**
 * **One canary run** — the answer of `POST /v1/fleet/game/canary`. A run that
 * is still playing has no `finishedAt` and its verdict reads `unproven`; a
 * second request for the same (provider, build, hud) while it plays is
 * answered with this same run rather than a second match.
 */
export const gameCanaryRunSchema = z.object({
  provider: kebabNameSchema,
  build: gameBuildIdSchema,
  hud: z.boolean(),
  attempt: z.number().int().positive(),
  matchId: matchIdSchema,
  cause: gameCanaryCauseSchema,
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  verdict: gameCanarySchema,
})
export type GameCanaryRun = z.infer<typeof gameCanaryRunSchema>

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/** What a node has and uses. */
export const nodeCapacitySchema = z.object({
  /** Servers the node may run at once. */
  total: z.number().int().nonnegative(),
  inUse: z.number().int().nonnegative(),
  /** Idle instances kept warm, ready to be assigned. */
  warm: z.number().int().nonnegative(),
})
export type NodeCapacity = z.infer<typeof nodeCapacitySchema>

export const nodeSchema = z.object({
  id: kebabNameSchema,
  /** Free-form operator labels (`venue=saarlan`, `rack=2`). */
  labels: z.record(z.string(), z.string()),
  region: kebabNameSchema,
  /** The node agent's version, as it reported it; null before the first hello. */
  version: z.string().nullable(),
  connected: z.boolean(),
  lastSeenAt: timestampSchema.nullable(),
  drained: z.boolean(),
  capacity: nodeCapacitySchema,
  currentMatches: z.array(matchIdSchema),
  enrolledAt: timestampSchema,
})
export type Node = z.infer<typeof nodeSchema>

/** Body of `POST /v1/fleet/nodes`: enrol a node by name. */
export const nodeEnrolRequestSchema = z.object({
  id: kebabNameSchema,
  region: kebabNameSchema,
  labels: z.record(z.string(), z.string()).default({}),
})
export type NodeEnrolRequest = z.infer<typeof nodeEnrolRequestSchema>

/** The enrolment: the node and its one-time token, shown here and never again. */
export const nodeEnrolmentSchema = z.object({
  node: nodeSchema,
  token: z.string().min(16),
})
export type NodeEnrolment = z.infer<typeof nodeEnrolmentSchema>

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** The three ceilings a key lives under (decision 7). */
export const budgetLimitsSchema = z.object({
  maxConcurrentServers: z.number().int().nonnegative(),
  maxServerLifetimeMinutes: z.number().int().positive(),
  monthlyCents: z.number().int().nonnegative(),
})
export type BudgetLimits = z.infer<typeof budgetLimitsSchema>

export const budgetUsageSchema = z.object({
  concurrentServers: z.number().int().nonnegative(),
  /** Spent since `monthStartedAt`, closed rows plus accrued open ones. */
  monthCents: z.number().int().nonnegative(),
  monthStartedAt: timestampSchema,
})
export type BudgetUsage = z.infer<typeof budgetUsageSchema>

export const budgetSchema = z.object({
  keyId: z.uuid(),
  limits: budgetLimitsSchema,
  usage: budgetUsageSchema,
})
export type Budget = z.infer<typeof budgetSchema>

/** The GSLT pool: how many tokens the orchestrator holds and how many are on servers. */
export const gsltPoolSchema = z.object({
  total: z.number().int().nonnegative(),
  inUse: z.number().int().nonnegative(),
})
export type GsltPool = z.infer<typeof gsltPoolSchema>
