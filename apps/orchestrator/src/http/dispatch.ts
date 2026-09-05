import type { FlatRoute, RouteDef, RouteTree } from '@ezpug/match-api'
import {
  ApiError,
  MATCH_API_ERROR_STATUS,
  matchApiRoutes,
  parseRouteInput,
  scopeAllows,
} from '@ezpug/match-api'
import { ZodError } from 'zod'
import type { AuthenticatedKey, Keys } from '../keys/service'
import type { HandlerContext, RouteHandlers } from './handlers'

/**
 * **One dispatch for every route** — the fake's `dispatch.ts`, made real:
 * authenticate the bearer, gate the scope from the route's own declaration,
 * parse the raw input through the route's schemas, run the handler, parse
 * the answer through the route's response schema. The HTTP adapter
 * (`app.ts`) calls this and nothing else, so a shape the orchestrator
 * cannot serve is caught by the orchestrator itself, and the conformance
 * suite (T3) and the platform see one behaviour.
 */

export interface Dispatched {
  status: number
  value: unknown
}

export interface DispatchRequest {
  params?: unknown
  query?: unknown
  body?: unknown
  requestId: string
}

export type Dispatch = (
  route: FlatRoute,
  bearer: string | null,
  request: DispatchRequest,
) => Promise<Dispatched>

type AnyHandler = (input: unknown, ctx: HandlerContext) => unknown

function isRouteDef(value: RouteDef | RouteTree): value is RouteDef {
  return typeof value.method === 'string' && typeof value.path === 'string' && 'response' in value
}

function flattenHandlers(
  tree: RouteHandlers,
  routes: RouteTree,
  prefix = '',
): Map<string, AnyHandler> {
  const out = new Map<string, AnyHandler>()
  for (const [key, node] of Object.entries(routes)) {
    const dotted = prefix ? `${prefix}.${key}` : key
    const handler = (tree as unknown as Record<string, unknown>)[key]
    if (handler === undefined) throw new Error(`orchestrator: no handler for ${dotted}`)
    if (isRouteDef(node)) out.set(dotted, handler as AnyHandler)
    else for (const [k, v] of flattenHandlers(handler as RouteHandlers, node, dotted)) out.set(k, v)
  }
  return out
}

export function createDispatch(keys: Keys, handlers: RouteHandlers): Dispatch {
  const byKey = flattenHandlers(handlers, matchApiRoutes)
  return async (flat, bearer, request) => {
    const { route } = flat
    const handler = byKey.get(flat.key)
    if (!handler) throw new Error(`orchestrator: no handler for ${flat.key}`)
    const key: AuthenticatedKey = await keys.authenticate(bearer)
    if (!scopeAllows(key.key.scopes, route.scope))
      throw new ApiError(
        MATCH_API_ERROR_STATUS.forbidden,
        'forbidden',
        `${route.method.toUpperCase()} ${route.path} needs the ${route.scope} scope`,
        { scope: route.scope },
      )
    let input: ReturnType<typeof parseRouteInput>
    try {
      input = parseRouteInput(route, request)
    } catch (error) {
      if (error instanceof ZodError)
        throw new ApiError(
          MATCH_API_ERROR_STATUS.validation_failed,
          'validation_failed',
          'the request did not parse',
          { issues: error.issues },
        )
      throw error
    }
    const ctx: HandlerContext = { key, status: route.status ?? 200, requestId: request.requestId }
    const value = await handler(input, ctx)
    // The orchestrator's own conformance guard: an answer that does not
    // parse is our bug and dies here, as `internal`, not in a client.
    return { status: ctx.status, value: route.response.parse(value) }
  }
}
