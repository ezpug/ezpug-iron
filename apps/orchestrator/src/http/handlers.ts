import type {
  GamemodeManifest,
  MatchApiRoutes,
  RouteDef,
  RouteHandler,
  RouteTree,
} from '@ezpug/match-api'
import { ApiError, MATCH_API_ERROR_STATUS } from '@ezpug/match-api'
import type { AuthenticatedKey, Keys } from '../keys/service'

/**
 * **One handler per route, the shape of the table itself, typed by it**: a
 * route added to `routes.ts` without a handler here does not compile, and a
 * handler that answers the wrong shape does not either. The dispatch walks
 * this object; nothing registers a path by hand.
 *
 * This task (PRD-02 T2) serves what a standing orchestrator owns outright —
 * the catalog and the keys. Everything about a match, the fleet and the
 * providers answers {@link notServedYet} until the task that builds it
 * replaces the entry: T3 (matches, capacity, fleet servers/providers/ledger),
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
  const { keys, gamemodes } = deps
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
      get: notServedYet('T3'),
    },
    matches: {
      create: notServedYet('T3'),
      list: notServedYet('T3'),
      get: notServedYet('T3'),
      cancel: notServedYet('T3'),
      command: notServedYet('T3'),
      mintPlayerToken: notServedYet('T24'),
      events: notServedYet('T3'),
      // The stream is an upgrade, not a request; a plain GET here gets the
      // explanation and the upgrade itself is T3's.
      stream: () => {
        throw upgradeRequired()
      },
    },
    fleet: {
      servers: {
        list: notServedYet('T3'),
        release: notServedYet('T3'),
        console: notServedYet('T20'),
        rcon: notServedYet('T20'),
      },
      providers: {
        list: notServedYet('T3'),
        drain: notServedYet('T3'),
        undrain: notServedYet('T3'),
      },
      nodes: {
        list: notServedYet('T12'),
        enrol: notServedYet('T12'),
        revoke: notServedYet('T12'),
        drain: notServedYet('T12'),
        undrain: notServedYet('T12'),
      },
      ledger: notServedYet('T3'),
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
