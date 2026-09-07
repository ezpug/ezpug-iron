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

export const providerHealthSchema = z.object({
  id: kebabNameSchema,
  healthy: z.boolean(),
  drained: z.boolean(),
  lastCheckedAt: timestampSchema.nullable(),
  /** The last probe's failure, for the console; null when healthy. */
  lastError: z.string().nullable(),
  /** Open ledger rows on this provider. */
  servers: z.number().int().nonnegative(),
})
export type ProviderHealth = z.infer<typeof providerHealthSchema>

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
