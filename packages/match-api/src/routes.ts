import { z } from 'zod'
import { capacitySchema } from './resources/capacity'
import { matchCommandResultSchema, matchCommandSchema } from './resources/commands'
import { matchIdSchema, pageQuerySchema, pageSchema } from './resources/common'
import {
  budgetSchema,
  consoleResponseSchema,
  fleetServerSchema,
  gsltPoolSchema,
  ledgerFilterSchema,
  nodeEnrolmentSchema,
  nodeEnrolRequestSchema,
  nodeSchema,
  providerHealthSchema,
  rconRequestSchema,
  rconResponseSchema,
  releaseServerRequestSchema,
} from './resources/fleet'
import { gamemodeSummarySchema } from './resources/gamemode'
import {
  apiKeyCreatedSchema,
  apiKeyCreateRequestSchema,
  apiKeySchema,
  webhookSecretsRequestSchema,
} from './resources/keys'
import { matchListFilterSchema, matchSchema } from './resources/match'
import { matchRequestSchema } from './resources/match-request'
import { playerTokenRequestSchema, playerTokenSchema } from './resources/player-token'
import { defineRoute } from './rpc'
import { kebabNameSchema } from './vocabulary/naming'

/**
 * **The Match API, as a table** (decision 3, CLAUDE.md "The Match API is the
 * only door"). Every capability a client needs is a route here, as a Zod
 * schema, before anything serves or consumes it: the orchestrator implements
 * this table, the fake implements this table, the client is generated from
 * it, `docs/match-api.md` has a section per entry (a test checks), and the
 * conformance suite walks it. A route that is not here does not exist.
 *
 * Two routes the table does not yet hold, by design of the round:
 * `GET /v1/matches/:matchId/events` (the webhook replay) and
 * `GET /v1/matches/:matchId/stream` (the upgrade) arrive with the envelope
 * and the frames they carry (PRD-01 T3).
 */

const matchParams = z.object({ matchId: matchIdSchema })
const serverParams = z.object({ serverId: z.string().min(1) })
const providerParams = z.object({ providerId: kebabNameSchema })
const nodeParams = z.object({ nodeId: kebabNameSchema })
const keyParams = z.object({ keyId: z.uuid() })

const okSchema = z.object({ ok: z.literal(true) })

export const matchApiRoutes = {
  gamemodes: {
    /** The catalog the orchestrator ships (decision 14). Cached by the client, changes with a release. */
    list: defineRoute({
      method: 'get',
      path: '/v1/gamemodes',
      scope: 'matches',
      response: z.object({ gamemodes: z.array(gamemodeSummarySchema) }),
    }),
  },
  capacity: {
    /** What could be allocated right now, per provider and region. */
    get: defineRoute({
      method: 'get',
      path: '/v1/capacity',
      scope: 'matches',
      response: capacitySchema,
    }),
  },
  matches: {
    /**
     * Ask for a match. Idempotent on `clientMatchId`: the same body again
     * returns the same match with `200`; a different body under a used id is
     * `conflict`. Refused at the door with `unknown_gamemode`,
     * `game_unsupported`, `no_capable_server` or `budget_exceeded`.
     */
    create: defineRoute({
      method: 'post',
      path: '/v1/matches',
      scope: 'matches',
      status: 201,
      body: matchRequestSchema,
      response: matchSchema,
    }),
    /** The key's matches, newest first. */
    list: defineRoute({
      method: 'get',
      path: '/v1/matches',
      scope: 'matches',
      query: pageQuerySchema.extend(matchListFilterSchema.shape),
      response: pageSchema(matchSchema),
    }),
    get: defineRoute({
      method: 'get',
      path: '/v1/matches/:matchId',
      scope: 'matches',
      params: matchParams,
      response: matchSchema,
    }),
    /**
     * Cancel before going live; the server is released and the match ends
     * `cancelled`. `invalid_state` from `live` on — use a `force_end` command.
     */
    cancel: defineRoute({
      method: 'post',
      path: '/v1/matches/:matchId/cancel',
      scope: 'matches',
      params: matchParams,
      response: matchSchema,
    }),
    /** Tell the match something. Idempotent on `correlationId`. */
    command: defineRoute({
      method: 'post',
      path: '/v1/matches/:matchId/commands',
      scope: 'matches',
      params: matchParams,
      body: matchCommandSchema,
      response: matchCommandResultSchema,
    }),
    /** Mint a player's key to this match, for the gamemode's widget (decision 17). */
    mintPlayerToken: defineRoute({
      method: 'post',
      path: '/v1/matches/:matchId/player-tokens',
      scope: 'matches',
      status: 201,
      params: matchParams,
      body: playerTokenRequestSchema,
      response: playerTokenSchema,
    }),
  },
  fleet: {
    servers: {
      /** Open ledger rows — every server the orchestrator believes exists. */
      list: defineRoute({
        method: 'get',
        path: '/v1/fleet/servers',
        scope: 'fleet',
        response: z.object({ servers: z.array(fleetServerSchema) }),
      }),
      /** Deallocate a server now, whatever its match thinks. The match ends `provider_error`. */
      release: defineRoute({
        method: 'post',
        path: '/v1/fleet/servers/:serverId/release',
        scope: 'fleet',
        params: serverParams,
        body: releaseServerRequestSchema,
        response: fleetServerSchema,
      }),
      /** The tail of the server's console. */
      console: defineRoute({
        method: 'get',
        path: '/v1/fleet/servers/:serverId/console',
        scope: 'fleet',
        params: serverParams,
        response: consoleResponseSchema,
      }),
      /** RCON, the operator fallback (decision 5). `command_unsupported` on a sim. */
      rcon: defineRoute({
        method: 'post',
        path: '/v1/fleet/servers/:serverId/rcon',
        scope: 'fleet',
        params: serverParams,
        body: rconRequestSchema,
        response: rconResponseSchema,
      }),
    },
    providers: {
      list: defineRoute({
        method: 'get',
        path: '/v1/fleet/providers',
        scope: 'fleet',
        response: z.object({ providers: z.array(providerHealthSchema) }),
      }),
      /** Stop allocating here; running servers finish. */
      drain: defineRoute({
        method: 'post',
        path: '/v1/fleet/providers/:providerId/drain',
        scope: 'fleet',
        params: providerParams,
        response: providerHealthSchema,
      }),
      undrain: defineRoute({
        method: 'post',
        path: '/v1/fleet/providers/:providerId/undrain',
        scope: 'fleet',
        params: providerParams,
        response: providerHealthSchema,
      }),
    },
    nodes: {
      list: defineRoute({
        method: 'get',
        path: '/v1/fleet/nodes',
        scope: 'fleet',
        response: z.object({ nodes: z.array(nodeSchema) }),
      }),
      /** Enrol a node: the response carries its token, once (decision 23). */
      enrol: defineRoute({
        method: 'post',
        path: '/v1/fleet/nodes',
        scope: 'fleet',
        status: 201,
        body: nodeEnrolRequestSchema,
        response: nodeEnrolmentSchema,
      }),
      /** Revoke the node's token; it is disconnected and forgotten. */
      revoke: defineRoute({
        method: 'delete',
        path: '/v1/fleet/nodes/:nodeId',
        scope: 'fleet',
        params: nodeParams,
        response: okSchema,
      }),
      drain: defineRoute({
        method: 'post',
        path: '/v1/fleet/nodes/:nodeId/drain',
        scope: 'fleet',
        params: nodeParams,
        response: nodeSchema,
      }),
      undrain: defineRoute({
        method: 'post',
        path: '/v1/fleet/nodes/:nodeId/undrain',
        scope: 'fleet',
        params: nodeParams,
        response: nodeSchema,
      }),
    },
    /** Every ledger row, newest first, open and closed. */
    ledger: defineRoute({
      method: 'get',
      path: '/v1/fleet/ledger',
      scope: 'fleet',
      query: pageQuerySchema.extend(ledgerFilterSchema.shape),
      response: pageSchema(fleetServerSchema),
    }),
    /** The calling key's ceilings and what it has used. */
    budget: defineRoute({
      method: 'get',
      path: '/v1/fleet/budget',
      scope: 'fleet',
      response: budgetSchema,
    }),
    gslt: defineRoute({
      method: 'get',
      path: '/v1/fleet/gslt',
      scope: 'fleet',
      response: gsltPoolSchema,
    }),
  },
  keys: {
    /** Mint a key. The secret is in the response and nowhere else, ever. */
    create: defineRoute({
      method: 'post',
      path: '/v1/keys',
      scope: 'admin',
      status: 201,
      body: apiKeyCreateRequestSchema,
      response: apiKeyCreatedSchema,
    }),
    list: defineRoute({
      method: 'get',
      path: '/v1/keys',
      scope: 'admin',
      response: z.object({ keys: z.array(apiKeySchema) }),
    }),
    revoke: defineRoute({
      method: 'delete',
      path: '/v1/keys/:keyId',
      scope: 'admin',
      params: keyParams,
      response: apiKeySchema,
    }),
    /** Replace the key's webhook secrets — how a client rotates. */
    setWebhookSecrets: defineRoute({
      method: 'put',
      path: '/v1/keys/:keyId/webhook-secrets',
      scope: 'admin',
      params: keyParams,
      body: webhookSecretsRequestSchema,
      response: apiKeySchema,
    }),
  },
} as const

export type MatchApiRoutes = typeof matchApiRoutes
