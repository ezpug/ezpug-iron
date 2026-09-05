import { assertClosedSet, kebabNameSchema, matchIdSchema } from '@ezpug/match-api'
import { z } from 'zod'
import { PROTOCOL_VERSION } from './constants'
import { linkTokenSchema, versionStringSchema } from './server-link'

/**
 * **The node link** (decision 23): the one outbound WebSocket an
 * `ezpug-node` agent opens to the orchestrator at `/node`. A node turns a
 * docker host into capacity: it enrols once with a one-time token, then
 * says `hello` with what it has, starts and stops server containers on
 * request and reports what is running. The servers it starts open server
 * links of their own — this link never carries a match; it carries
 * containers.
 *
 * - {@link nodeFrameSchema} — what a node sends: `hello`, `heartbeat`,
 *   `instances`.
 * - {@link orchestratorNodeFrameSchema} — what the orchestrator sends a
 *   node: `welcome`, `start`, `stop`, `drain`, `undrain`.
 *
 * Nothing here is acked: an `instances` frame is a whole snapshot, so a
 * lost one is superseded by the next and a node reconnecting resends its
 * state in `hello`. The orchestrator's ledger, not the node, is the truth
 * about which server belongs to which match.
 */

/** Which kind of token a node's `hello` presents. */
export const NODE_TOKEN_KINDS = [
  /** The one-time token `POST /v1/fleet/nodes` minted; `welcome` answers with the node token. */
  'enrolment',
  /** The node token a previous `welcome` handed over, persisted on the node. */
  'node',
] as const
export const nodeTokenKindSchema = z.enum(NODE_TOKEN_KINDS)
export type NodeTokenKind = z.infer<typeof nodeTokenKindSchema>

/** A UDP/TCP port a server container publishes on the host. */
export const portSchema = z.number().int().positive().max(65_535)

/** The two ports every server container publishes: the game and its GOTV relay. */
export const instancePortsSchema = z.object({
  game: portSchema,
  tv: portSchema,
})
export type InstancePorts = z.infer<typeof instancePortsSchema>

/**
 * Why an instance exists. `warm` instances are started ahead of demand
 * (`EZPUG_NODE_WARM`) and dial in idle so a `lan` request is ready in
 * seconds; `match` instances are started for one allocation. Both are
 * servers with server tokens; the orchestrator picks a warm one first.
 */
export const INSTANCE_PURPOSES = ['warm', 'match'] as const
export const instancePurposeSchema = z.enum(INSTANCE_PURPOSES)
export type InstancePurpose = z.infer<typeof instancePurposeSchema>

/**
 * A container's life as the node sees it. The *server's* state (idle,
 * assigned, live) travels on the server link; this is docker's view.
 */
export const INSTANCE_STATES = ['starting', 'running', 'stopping', 'stopped', 'failed'] as const
export const instanceStateSchema = z.enum(INSTANCE_STATES)
export type InstanceState = z.infer<typeof instanceStateSchema>

/** An instance id: the orchestrator's, kebab-case, unique per node. */
export const instanceIdSchema = kebabNameSchema

/** One container, as the node reports it. */
export const nodeInstanceSchema = z.object({
  id: instanceIdSchema,
  purpose: instancePurposeSchema,
  state: instanceStateSchema,
  /** The provider's handle for the server inside — `welcome.serverId` on its own link. */
  serverId: z.string().min(1).max(128),
  /** Docker's id, for the operator. */
  containerId: z.string().min(1).max(128).optional(),
  ports: instancePortsSchema,
  /** The match it holds, where the node was told (in `start`); the ledger is the truth. */
  matchId: matchIdSchema.optional(),
  /** For `failed`: what docker said. */
  error: z.string().max(1024).optional(),
})
export type NodeInstance = z.infer<typeof nodeInstanceSchema>

/** How many containers the node will run at once, and how many it keeps warm. */
export const nodeCapacitySchema = z.object({
  maxInstances: z.number().int().nonnegative().max(256),
  warm: z.number().int().nonnegative().max(256),
})
export type NodeLinkCapacity = z.infer<typeof nodeCapacitySchema>

/** An OCI image digest, so the fleet knows which build a node holds. */
export const imageDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'an image digest (`sha256:` and 64 hex characters)')

/**
 * What `start` tells a node to run: the image, the ports, the server token
 * the container will dial in with, and the environment (the orchestrator's
 * URL among it). `env` never carries anything the container should not
 * read from `ezpug.json` instead — the token is here because the node
 * writes the file.
 */
export const instanceSpecSchema = z.object({
  id: instanceIdSchema,
  purpose: instancePurposeSchema,
  /** Image reference with digest, the one `docs/pins.md` names for nodes. */
  image: z.string().min(1).max(512),
  serverId: z.string().min(1).max(128),
  serverToken: linkTokenSchema,
  ports: instancePortsSchema,
  env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string().max(4096)).default({}),
  matchId: matchIdSchema.optional(),
})
export type InstanceSpec = z.infer<typeof instanceSpecSchema>

// ---------------------------------------------------------------------------
// Node → orchestrator
// ---------------------------------------------------------------------------

/**
 * The first frame. An enrolment token is answered by a `welcome` carrying
 * the node token; a node token by a plain `welcome`. `instances` is the
 * node's current state, so a reconnect needs no second frame.
 */
export const helloNodeFrameSchema = z.object({
  type: z.literal('hello'),
  protocol: z.literal(PROTOCOL_VERSION),
  token: linkTokenSchema,
  tokenKind: nodeTokenKindSchema,
  /** The node agent's version. */
  version: versionStringSchema,
  /** A provider region id (`eu-central`); a `lan` request matches on labels, not on this. */
  region: kebabNameSchema,
  /** Every node is LAN capacity (decision 23); false only for a node placed in a datacentre. */
  lan: z.boolean().default(true),
  /** Free-form operator labels (`venue=saarlan`, `tickrate=128`, `cores=16`). */
  labels: z.record(z.string().max(64), z.string().max(256)).default({}),
  capacity: nodeCapacitySchema,
  imageDigest: imageDigestSchema,
  instances: z.array(nodeInstanceSchema).max(256),
})

/** Liveness, every `welcome.heartbeatIntervalMs`. */
export const heartbeatNodeFrameSchema = z.object({
  type: z.literal('heartbeat'),
})

/** Every container the node runs, whole, whenever one changes state. A snapshot, never a delta. */
export const instancesNodeFrameSchema = z.object({
  type: z.literal('instances'),
  instances: z.array(nodeInstanceSchema).max(256),
})

export const nodeFrameSchema = z.discriminatedUnion('type', [
  helloNodeFrameSchema,
  heartbeatNodeFrameSchema,
  instancesNodeFrameSchema,
])
export type NodeFrame = z.infer<typeof nodeFrameSchema>
export type NodeFrameInput = z.input<typeof nodeFrameSchema>

export const NODE_FRAME_TYPES = ['hello', 'heartbeat', 'instances'] as const
export type NodeFrameType = (typeof NODE_FRAME_TYPES)[number]
export type NodeFrameOf<T extends NodeFrameType> = Extract<NodeFrame, { type: T }>

assertClosedSet('node frames', nodeFrameSchema, 'type', NODE_FRAME_TYPES)

// ---------------------------------------------------------------------------
// Orchestrator → node
// ---------------------------------------------------------------------------

/**
 * The answer to an accepted `hello`. `nodeToken` is present exactly once:
 * after an enrolment `hello`. The node persists it and never sees it again;
 * the orchestrator holds only its hash.
 */
export const welcomeOrchestratorNodeFrameSchema = z.object({
  type: z.literal('welcome'),
  protocol: z.literal(PROTOCOL_VERSION),
  nodeId: kebabNameSchema,
  nodeToken: linkTokenSchema.optional(),
  heartbeatIntervalMs: z.number().int().positive(),
  drained: z.boolean(),
})

/** Run this container. The node answers with an `instances` snapshot as it changes state. */
export const startOrchestratorNodeFrameSchema = z.object({
  type: z.literal('start'),
  instance: instanceSpecSchema,
})

/** Remove this container. Idempotent: stopping what is already gone is nothing. */
export const stopOrchestratorNodeFrameSchema = z.object({
  type: z.literal('stop'),
  instanceId: instanceIdSchema,
  reason: z.string().max(256).optional(),
})

/** Finish live matches, start nothing. */
export const drainOrchestratorNodeFrameSchema = z.object({
  type: z.literal('drain'),
})

/** Take work again. */
export const undrainOrchestratorNodeFrameSchema = z.object({
  type: z.literal('undrain'),
})

export const orchestratorNodeFrameSchema = z.discriminatedUnion('type', [
  welcomeOrchestratorNodeFrameSchema,
  startOrchestratorNodeFrameSchema,
  stopOrchestratorNodeFrameSchema,
  drainOrchestratorNodeFrameSchema,
  undrainOrchestratorNodeFrameSchema,
])
export type OrchestratorNodeFrame = z.infer<typeof orchestratorNodeFrameSchema>
export type OrchestratorNodeFrameInput = z.input<typeof orchestratorNodeFrameSchema>

export const ORCHESTRATOR_NODE_FRAME_TYPES = [
  'welcome',
  'start',
  'stop',
  'drain',
  'undrain',
] as const
export type OrchestratorNodeFrameType = (typeof ORCHESTRATOR_NODE_FRAME_TYPES)[number]
export type OrchestratorNodeFrameOf<T extends OrchestratorNodeFrameType> = Extract<
  OrchestratorNodeFrame,
  { type: T }
>

assertClosedSet(
  'orchestrator node frames',
  orchestratorNodeFrameSchema,
  'type',
  ORCHESTRATOR_NODE_FRAME_TYPES,
)
