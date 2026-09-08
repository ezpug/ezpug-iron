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
import { gamemodeCatalogSchema, gamemodeManifestSchema } from './resources/gamemode'
import {
  apiKeyCreatedSchema,
  apiKeyCreateRequestSchema,
  apiKeySchema,
  budgetPatchRequestSchema,
  fleetWebhookRequestSchema,
  webhookSecretsRequestSchema,
} from './resources/keys'
import { matchListFilterSchema, matchSchema } from './resources/match'
import { matchRequestSchema } from './resources/match-request'
import { playerTokenRequestSchema, playerTokenSchema } from './resources/player-token'
import { simScenarioCatalogSchema } from './resources/sim'
import { defineRoute } from './rpc'
import { streamFrameSchema, streamQuerySchema } from './stream/frames'
import { kebabNameSchema } from './vocabulary/naming'
import { eventsPageSchema, eventsQuerySchema } from './webhooks/events'
import { WIDGET_SOCKET_PATH, widgetServerFrameSchema } from './widget/socket'

/**
 * **The Match API, as a table** (decision 3, CLAUDE.md "The Match API is the
 * only door"). Every capability a client needs is a route here, as a Zod
 * schema, before anything serves or consumes it: the orchestrator implements
 * this table, the fake implements this table, the client is generated from
 * it, `docs/match-api.md` has a section per entry (a test checks), and the
 * conformance suite walks it. A route that is not here does not exist.
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
      response: gamemodeCatalogSchema,
    }),
    /** One manifest, whole. `not_found` for an id the orchestrator does not ship. */
    get: defineRoute({
      method: 'get',
      path: '/v1/gamemodes/:gamemodeId',
      params: z.object({ gamemodeId: kebabNameSchema }),
      scope: 'matches',
      response: gamemodeManifestSchema,
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
  sim: {
    /**
     * The scenarios this build's simulator can play (decision 9). A console
     * that offers a dropdown reads it here rather than keeping a second list
     * — an added scenario used to be discovered as a `validation_failed` on
     * a match somebody meant to demo. Served whether or not the `sim`
     * provider is registered: it is what this build knows how to play, and
     * `GET /v1/capacity` is what says whether it could.
     */
    scenarios: defineRoute({
      method: 'get',
      path: '/v1/sim/scenarios',
      scope: 'matches',
      response: simScenarioCatalogSchema,
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
    /**
     * The webhook replay (decision 6): the match's envelopes in `seq` order,
     * from the cursor on. The cursor is the `seq` to resume after, as a
     * decimal string — `Match.seq`, the stream's `hello.seq` and a stored
     * envelope's `seq` all plug in; `"0"` (the default) is everything.
     */
    events: defineRoute({
      method: 'get',
      path: '/v1/matches/:matchId/events',
      scope: 'matches',
      params: matchParams,
      query: eventsQuerySchema,
      response: eventsPageSchema,
    }),
    /**
     * The stream (decision 6): a WebSocket upgrade; every frame the socket
     * sends parses as `StreamFrame`, the first is a `hello`. Authenticated by
     * the bearer header or a player token in `?token=`.
     */
    stream: defineRoute({
      method: 'get',
      path: '/v1/matches/:matchId/stream',
      scope: 'matches',
      upgrade: 'websocket',
      params: matchParams,
      query: streamQuerySchema,
      response: streamFrameSchema,
    }),
  },
  /**
   * The widget socket (decision 17, PRD-02 T24): a WebSocket upgrade a
   * gamemode's widget opens with a player token — in its first frame, never
   * in the URL — to tap the mode's declared commands and follow the match.
   * The scope is the one the token's minting key needed; no API key is
   * presented on the socket itself. Every frame the socket sends parses as
   * `WidgetServerFrame`, the first is a `hello`.
   */
  widget: defineRoute({
    method: 'get',
    path: WIDGET_SOCKET_PATH,
    scope: 'matches',
    upgrade: 'websocket',
    response: widgetServerFrameSchema,
  }),
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
    /**
     * Draw the key a new secret and kill the old one on the spot — what an
     * operator does when a key leaked. Same id, same scopes, same budget,
     * same webhook secrets; the new secret is in the answer and nowhere
     * else, like a mint.
     */
    rotate: defineRoute({
      method: 'post',
      path: '/v1/keys/:keyId/rotate',
      scope: 'admin',
      params: keyParams,
      response: apiKeyCreatedSchema,
    }),
    /** Move one or more of the key's three ceilings (decision 7). */
    setBudget: defineRoute({
      method: 'patch',
      path: '/v1/keys/:keyId/budget',
      scope: 'admin',
      params: keyParams,
      body: budgetPatchRequestSchema,
      response: apiKeySchema,
    }),
    /** Replace the key's webhook secrets — how a client rotates a signature. */
    setWebhookSecrets: defineRoute({
      method: 'put',
      path: '/v1/keys/:keyId/webhook-secrets',
      scope: 'admin',
      params: keyParams,
      body: webhookSecretsRequestSchema,
      response: apiKeySchema,
    }),
    /**
     * Register (or clear, with `null`) where the key's `fleet.*` facts are
     * POSTed. `validation_failed` when the `secretId` is not one of the key's
     * registered webhook secrets — an endpoint nothing can sign for is worse
     * than none at all.
     */
    setFleetWebhook: defineRoute({
      method: 'put',
      path: '/v1/keys/:keyId/fleet-webhook',
      scope: 'admin',
      params: keyParams,
      body: fleetWebhookRequestSchema,
      response: apiKeySchema,
    }),
  },
} as const

export type MatchApiRoutes = typeof matchApiRoutes
