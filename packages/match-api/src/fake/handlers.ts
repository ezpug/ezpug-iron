import { ApiError, MATCH_API_ERROR_STATUS } from '../errors'
import type { MatchApiRoutes } from '../routes'
import type { RouteDef, RouteHandler, RouteTree } from '../rpc'
import { parseEventsCursor } from '../webhooks/events'
import type { FakeCore, KeyRecord } from './core'

/**
 * **One handler per route**, the shape of the table itself, typed by it: a
 * route added to `routes.ts` without a handler here does not compile, and a
 * handler that answers the wrong shape does not either. Every handler is a
 * thin call into the core; the HTTP adapter and the in-process client both
 * dispatch through this object.
 */

/** What a handler is given besides its parsed input. */
export interface HandlerContext {
  key: KeyRecord
  /** The status the answer travels with — the route's declared one unless a handler says otherwise. */
  status: number
}

export type FakeHandlers<Routes extends RouteTree = MatchApiRoutes> = {
  [K in keyof Routes]: Routes[K] extends RouteDef
    ? RouteHandler<Routes[K], HandlerContext>
    : Routes[K] extends RouteTree
      ? FakeHandlers<Routes[K]>
      : never
}

/** An opaque list cursor: the offset, as digits. The shape is the fake's own business. */
function page<T>(items: T[], cursor: string | undefined, limit: number) {
  const offset = cursor ? Number.parseInt(cursor, 10) : 0
  const slice = items.slice(offset, offset + limit)
  const next = offset + slice.length
  return { items: slice, nextCursor: next < items.length ? String(next) : null }
}

export function createFakeHandlers(core: FakeCore): FakeHandlers {
  return {
    gamemodes: {
      list: () => ({ gamemodes: [...core.gamemodes] }),
      get: ({ params }) => {
        const manifest = core.gamemodes.find(m => m.id === params.gamemodeId)
        if (!manifest) throw notFound(`no gamemode ${params.gamemodeId}`)
        return manifest
      },
    },
    capacity: {
      get: () => core.capacity(),
    },
    matches: {
      create: ({ body }, ctx) => {
        const { match, replayed } = core.createMatch(ctx.key, body)
        if (replayed) ctx.status = 200
        return match
      },
      list: ({ query }, ctx) => {
        const rows = core
          .listMatches(ctx.key)
          .filter(r => query.state === undefined || r.match.state === query.state)
          .filter(
            r => query.clientMatchId === undefined || r.match.clientMatchId === query.clientMatchId,
          )
          .map(r => core.view(r))
        return page(rows, query.cursor, query.limit)
      },
      get: ({ params }, ctx) => core.view(core.requireMatch(ctx.key, params.matchId)),
      cancel: ({ params }, ctx) => core.cancelMatch(ctx.key, params.matchId),
      command: ({ params, body }, ctx) => core.command(ctx.key, params.matchId, body),
      mintPlayerToken: ({ params, body }, ctx) =>
        core.mintPlayerToken(ctx.key, params.matchId, body),
      events: ({ params, query }, ctx) =>
        core.events(ctx.key, params.matchId, parseEventsCursor(query.cursor), query.limit),
      // The stream is an upgrade, not a request; the HTTP adapter answers a
      // plain GET here with an explanation and `listen()` performs the upgrade.
      stream: () => {
        throw upgradeRequired()
      },
    },
    fleet: {
      servers: {
        list: () => ({ servers: core.openServers() }),
        release: ({ params, body }) => core.releaseServer(params.serverId, body.reason),
        console: ({ params }) => ({ lines: core.consoleOf(params.serverId) }),
        rcon: ({ params }) => {
          // A sim has no RCON (route doc). The row must exist, though.
          core.consoleOf(params.serverId)
          throw commandUnsupported('a simulated server has no RCON')
        },
      },
      providers: {
        list: () => ({ providers: [core.providerHealth()] }),
        drain: ({ params }) => {
          core.requireProvider(params.providerId)
          core.setProviderDrained(true)
          return core.providerHealth()
        },
        undrain: ({ params }) => {
          core.requireProvider(params.providerId)
          core.setProviderDrained(false)
          return core.providerHealth()
        },
      },
      nodes: {
        list: () => ({ nodes: core.listNodes() }),
        enrol: ({ body }) => core.enrolNode(body),
        revoke: ({ params }) => {
          core.revokeNode(params.nodeId)
          return { ok: true as const }
        },
        drain: ({ params }) => core.setNodeDrained(params.nodeId, true),
        undrain: ({ params }) => core.setNodeDrained(params.nodeId, false),
      },
      ledger: ({ query }) => {
        const rows = core
          .ledgerRows()
          .filter(r => query.state === undefined || r.state === query.state)
          .filter(r => query.provider === undefined || r.provider === query.provider)
          .filter(r => query.matchId === undefined || r.matchId === query.matchId)
        return page(rows, query.cursor, query.limit)
      },
      budget: (_input, ctx) => core.budgetOf(ctx.key),
      gslt: () => core.gslt(),
    },
    keys: {
      create: ({ body }) => core.mintKey(body),
      list: () => ({ keys: core.listKeys() }),
      revoke: ({ params }) => core.revokeKey(params.keyId),
      setWebhookSecrets: ({ params, body }) => core.setWebhookSecrets(params.keyId, body),
    },
  }
}

function notFound(message: string): ApiError {
  return new ApiError(MATCH_API_ERROR_STATUS.not_found, 'not_found', message)
}

function commandUnsupported(message: string): ApiError {
  return new ApiError(MATCH_API_ERROR_STATUS.command_unsupported, 'command_unsupported', message)
}

function upgradeRequired(): ApiError {
  return new ApiError(
    MATCH_API_ERROR_STATUS.validation_failed,
    'validation_failed',
    'GET /v1/matches/:matchId/stream is a WebSocket upgrade; connect with a WebSocket client',
  )
}
