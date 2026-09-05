import { ZodError } from 'zod'
import { ApiError, MATCH_API_ERROR_STATUS } from '../errors'
import { matchApiRoutes } from '../routes'
import type { ApiClient, FlatRoute, RouteDef, RouteTree } from '../rpc'
import { flattenRoutes, parseRouteInput } from '../rpc'
import { scopeAllows } from '../scopes'
import type { FakeCore } from './core'
import type { FakeHandlers, HandlerContext } from './handlers'
import type { FakeMatchApiClient } from './types'

/**
 * **One dispatch for both doors.** Authenticate the bearer, gate the scope,
 * parse the raw input through the route's schemas, run the handler, parse
 * the answer through the route's response schema — the same steps whether
 * the call arrived over HTTP (`http.ts`) or from the in-process client
 * (`createInProcessClient`), so a test that passes in-process passes over
 * the wire, and a shape the fake cannot serve is caught by the fake itself.
 */

export interface Dispatched {
  status: number
  value: unknown
}

export type Dispatch = (
  route: FlatRoute,
  apiKey: string | null,
  raw: { params?: unknown; query?: unknown; body?: unknown },
) => Promise<Dispatched>

type AnyHandler = (input: unknown, ctx: HandlerContext) => unknown

function flattenHandlers(
  tree: FakeHandlers,
  routes: RouteTree,
  prefix = '',
): Map<string, AnyHandler> {
  const out = new Map<string, AnyHandler>()
  for (const [key, node] of Object.entries(routes)) {
    const dotted = prefix ? `${prefix}.${key}` : key
    const handler = (tree as unknown as Record<string, unknown>)[key]
    if (isRouteDef(node)) out.set(dotted, handler as AnyHandler)
    else for (const [k, v] of flattenHandlers(handler as FakeHandlers, node, dotted)) out.set(k, v)
  }
  return out
}

function isRouteDef(value: RouteDef | RouteTree): value is RouteDef {
  return typeof value.method === 'string' && typeof value.path === 'string' && 'response' in value
}

export function createDispatch(core: FakeCore, handlers: FakeHandlers): Dispatch {
  const byKey = flattenHandlers(handlers, matchApiRoutes)
  return async (flat, apiKey, raw) => {
    const { route } = flat
    const handler = byKey.get(flat.key)
    if (!handler) throw new Error(`fake orchestrator: no handler for ${flat.key}`)
    const key = core.authenticate(apiKey)
    if (!scopeAllows(key.key.scopes, route.scope))
      throw new ApiError(
        MATCH_API_ERROR_STATUS.forbidden,
        'forbidden',
        `${route.method.toUpperCase()} ${route.path} needs the ${route.scope} scope`,
      )
    let input: ReturnType<typeof parseRouteInput>
    try {
      input = parseRouteInput(route, raw)
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
    const ctx: HandlerContext = { key, status: route.status ?? 200 }
    const value = await handler(input, ctx)
    // The fake's own conformance guard: an answer that does not parse is a
    // fake bug and dies here, not in a consumer.
    return { status: ctx.status, value: route.response.parse(value) }
  }
}

/**
 * The typed client over the dispatch — `ApiClient<typeof matchApiRoutes>`,
 * the same surface `@ezpug/match-api/client` gives over HTTP, so the two are
 * interchangeable wherever a client is taken. Upgrade routes are left out
 * exactly as `createClient` leaves them out.
 */
export function createInProcessClient(dispatch: Dispatch, apiKey: string): FakeMatchApiClient {
  const flats = new Map(flattenRoutes(matchApiRoutes).map(flat => [flat.key, flat]))
  const build = (node: RouteDef | RouteTree, prefix: string): unknown => {
    if (isRouteDef(node)) {
      const flat = flats.get(prefix) as FlatRoute
      return async (input: { params?: unknown; query?: unknown; body?: unknown } = {}) =>
        (await dispatch(flat, apiKey, input)).value
    }
    const group: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      if (isRouteDef(value) && value.upgrade) continue
      group[key] = build(value, prefix ? `${prefix}.${key}` : key)
    }
    return group
  }
  return build(matchApiRoutes, '') as ApiClient<typeof matchApiRoutes>
}
