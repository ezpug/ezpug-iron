import type {
  GamemodeManifest,
  MatchApiRoutes,
  RouteDef,
  RouteHandler,
  RouteTree,
} from '@ezpug/match-api'
import { ApiError, MATCH_API_ERROR_STATUS, parseEventsCursor } from '@ezpug/match-api'
import type { Fleet } from '../fleet/service'
import type { AuthenticatedKey, Keys } from '../keys/service'
import type { Matches } from '../match/machine'

/**
 * **One handler per route, the shape of the table itself, typed by it**: a
 * route added to `routes.ts` without a handler here does not compile, and a
 * handler that answers the wrong shape does not either. The dispatch walks
 * this object; nothing registers a path by hand.
 *
 * Served: the catalog and the keys (T2), matches, capacity, the fleet's
 * servers, providers and ledger (T3). Everything else answers
 * {@link notServedYet} until the task that builds it replaces the entry:
 * T5 (budget), T12 (nodes), T17 (gslt), T20 (console, rcon), T24 (player
 * tokens). A route that is not yet served still exists: it authenticates,
 * gates its scope and validates its input like every other, and then says
 * so with `internal` — never a `404` that would lie about the contract.
 */

/** What a handler is given besides its parsed input. */
export interface HandlerContext {
  key: AuthenticatedKey
  /** The status the answer travels with — the route's declared one unless a handler says otherwise. */
  status: number
  requestId: string
}

export type RouteHandlers<Routes extends RouteTree = MatchApiRoutes> = {
  [K in keyof Routes]: Routes[K] extends RouteDef
    ? RouteHandler<Routes[K], HandlerContext>
    : Routes[K] extends RouteTree
      ? RouteHandlers<Routes[K]>
      : never
}

export interface HandlerDependencies {
  keys: Keys
  /** The catalog `GET /v1/gamemodes` serves, `pug` first. */
  gamemodes: readonly GamemodeManifest[]
  matches: Matches
  fleet: Fleet
}

/** A handler for a route a later task serves; names the task so the answer is honest. */
export function notServedYet(task: string): () => never {
  return () => {
    throw new ApiError(
      MATCH_API_ERROR_STATUS.internal,
      'internal',
      `this route is not served by this build yet (PRD-02 ${task})`,
      { task },
    )
  }
}

function notFound(message: string): ApiError {
  return new ApiError(MATCH_API_ERROR_STATUS.not_found, 'not_found', message)
}

function upgradeRequired(): ApiError {
  return new ApiError(
    MATCH_API_ERROR_STATUS.validation_failed,
    'validation_failed',
    'GET /v1/matches/:matchId/stream is a WebSocket upgrade; connect with a WebSocket client',
  )
}

export function createHandlers(deps: HandlerDependencies): RouteHandlers {
  const { keys, gamemodes, matches, fleet } = deps
  return {
    gamemodes: {
      list: () => ({ gamemodes: [...gamemodes] }),
      get: ({ params }) => {
        const manifest = gamemodes.find(m => m.id === params.gamemodeId)
        if (!manifest) throw notFound(`no gamemode ${params.gamemodeId}`)
        return manifest
      },
    },
    capacity: {
      get: () => fleet.capacity(),
    },
    matches: {
      create: async ({ body }, ctx) => {
        const { match, replayed } = await matches.create(ctx.key, body)
        if (replayed) ctx.status = 200
        return match
      },
      list: ({ query }, ctx) => {
        const { cursor, limit, ...filter } = query
        return matches.list(ctx.key, filter, cursor, limit)
      },
      get: ({ params }, ctx) => matches.get(ctx.key, params.matchId),
      cancel: ({ params }, ctx) => matches.cancel(ctx.key, params.matchId),
      command: ({ params, body }, ctx) => matches.command(ctx.key, params.matchId, body),
      mintPlayerToken: notServedYet('T24'),
      events: ({ params, query }, ctx) =>
        matches.events(ctx.key, params.matchId, parseEventsCursor(query.cursor), query.limit),
      // The stream is an upgrade, not a request; a plain GET here gets the
      // explanation and `stream/upgrade.ts` performs the upgrade.
      stream: () => {
        throw upgradeRequired()
      },
    },
    fleet: {
      servers: {
        list: async () => ({ servers: await fleet.servers() }),
        release: ({ params, body }) => fleet.release(params.serverId, body.reason),
        console: notServedYet('T20'),
        rcon: notServedYet('T20'),
      },
      providers: {
        list: async () => ({ providers: await fleet.providers() }),
        drain: ({ params }) => fleet.setDrained(params.providerId, true),
        undrain: ({ params }) => fleet.setDrained(params.providerId, false),
      },
      nodes: {
        list: notServedYet('T12'),
        enrol: notServedYet('T12'),
        revoke: notServedYet('T12'),
        drain: notServedYet('T12'),
        undrain: notServedYet('T12'),
      },
      ledger: ({ query }) => {
        const { cursor, limit, ...filter } = query
        return fleet.ledger(filter, cursor, limit)
      },
      budget: notServedYet('T5'),
      gslt: notServedYet('T17'),
    },
    keys: {
      create: ({ body }) => keys.mint(body),
      list: async () => ({ keys: await keys.list() }),
      revoke: ({ params }) => keys.revoke(params.keyId),
      setWebhookSecrets: ({ params, body }) => keys.setWebhookSecrets(params.keyId, body),
    },
  }
}
