import type { z } from 'zod'
import { ApiError, errorEnvelopeSchema } from './errors'
import { type MatchApiScope, matchApiScopeSchema } from './scopes'
import { routePathParams, routePathSchema } from './vocabulary/naming'

/**
 * The typed RPC pattern — the platform's `rpc.ts` on 2026-09-05, ported whole
 * with one substitution: where the platform's routes declare an admin `area`,
 * a Match API route declares the **scope** an API key needs (`scopes.ts`), and
 * every route must declare one. Routes are declared as contracts (`routes.ts`),
 * the orchestrator implements them (checked via `RouteHandler` /
 * `parseRouteInput`), and the client is generated from the same declarations
 * by `createClient`. Both sides validate through one schema at runtime. A
 * hand-written fetch type for a Match API route is a review reject.
 */

/**
 * Every verb a route may declare — as a value, not only a type, because a
 * browser will not send a method its preflight was not told about, and the
 * orchestrator's CORS answer is derived from this list.
 */
export const routeMethods = ['get', 'post', 'put', 'patch', 'delete'] as const
export type RouteMethod = (typeof routeMethods)[number]

export interface RouteDef<
  Method extends RouteMethod = RouteMethod,
  Path extends string = string,
  Params extends z.ZodObject | undefined = z.ZodObject | undefined,
  Query extends z.ZodObject | undefined = z.ZodObject | undefined,
  Body extends z.ZodType | undefined = z.ZodType | undefined,
  Response extends z.ZodType = z.ZodType,
> {
  method: Method
  path: Path
  params?: Params
  query?: Query
  body?: Body
  response: Response
  /**
   * The scope an API key needs to call this route (`scopes.ts`). Part of the
   * *definition* so the same declaration feeds the orchestrator's one
   * authorize path, the fake's, the platform console's "hide what you cannot
   * do" and `docs/match-api.md`. Every route has one; there is no public route.
   */
  scope: MatchApiScope
  /**
   * The status a success answers with — `201` for a create, `200` otherwise.
   * Declared so the conformance suite can assert it.
   */
  status?: 200 | 201 | 202
  /**
   * A route that is a WebSocket upgrade rather than a request/response: the
   * stream. `response` is then the schema of every frame the socket sends.
   * Declared in the same table so the docs check, the scope gate and the
   * conformance suite see it; `createClient` leaves it out (a socket is
   * opened by `subscribeStream`, not called), so the typed client cannot
   * `await` it by mistake.
   */
  upgrade?: 'websocket'
}

/** Where every Match API route lives. A route outside it does not define. */
export const MATCH_API_PREFIX = '/v1/'

export function defineRoute<const Def extends RouteDef>(def: Def): Def {
  routePathSchema.parse(def.path)
  matchApiScopeSchema.parse(def.scope)
  if (!def.path.startsWith(MATCH_API_PREFIX)) {
    throw new Error(
      `route ${def.method.toUpperCase()} ${def.path}: every Match API route lives under ${MATCH_API_PREFIX}`,
    )
  }
  const tokens = routePathParams(def.path)
  const declared = def.params ? Object.keys(def.params.shape) : []
  const missing = tokens.filter(t => !declared.includes(t))
  const extra = declared.filter(d => !tokens.includes(d))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `route ${def.method.toUpperCase()} ${def.path}: params schema must match ` +
        `path tokens exactly (missing: [${missing.join(', ')}], extra: [${extra.join(', ')}])`,
    )
  }
  return def
}

/** Nested grouping is allowed: `{ matches: { create, get }, fleet: { servers: { ... } } }`. */
export interface RouteTree {
  [key: string]: RouteDef | RouteTree
}

/** One route, with the dotted key it sits under in its tree (`fleet.servers.release`). */
export interface FlatRoute<Def extends RouteDef = RouteDef> {
  key: string
  route: Def
}

/**
 * Every route in a tree, depth first, keyed by its dotted path — the walk a
 * table-driven test, a docs check or a gate needs, written once so they all
 * agree about what a route *is* (`isRouteDef`, below).
 */
export function flattenRoutes(tree: RouteTree, prefix = ''): FlatRoute[] {
  const out: FlatRoute[] = []
  for (const [key, node] of Object.entries(tree)) {
    const dotted = prefix ? `${prefix}.${key}` : key
    if (isRouteDef(node)) out.push({ key: dotted, route: node })
    else out.push(...flattenRoutes(node, dotted))
  }
  return out
}

/**
 * The path pattern as a matcher: `:param` segments match one non-empty
 * segment, everything else is literal. How a gate finds a request's route
 * without asking the framework which handler it is about to run.
 */
export function matchRoutePath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/')
  const have = path.split('/')
  if (want.length !== have.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i += 1) {
    const token = want[i] as string
    const segment = have[i] as string
    if (token.startsWith(':')) {
      if (segment.length === 0) return null
      params[token.slice(1)] = decodeURIComponent(segment)
    } else if (token !== segment) return null
  }
  return params
}

// --- Server side ------------------------------------------------------------

/** Validated input as the orchestrator-side handler receives it. */
export interface RouteInput<Def extends RouteDef> {
  params: Def['params'] extends infer P extends z.ZodObject ? z.output<P> : undefined
  query: Def['query'] extends infer Q extends z.ZodObject ? z.output<Q> : undefined
  body: Def['body'] extends infer B extends z.ZodType ? z.output<B> : undefined
}

/** The signature an implementation provides per route (the Hono adapter lives with it). */
export type RouteHandler<Def extends RouteDef, Context = unknown> = (
  input: RouteInput<Def>,
  context: Context,
) => Promise<z.input<Def['response']>> | z.input<Def['response']>

/** Validate raw request pieces against a route contract (throws ZodError). */
export function parseRouteInput<Def extends RouteDef>(
  route: Def,
  raw: { params?: unknown; query?: unknown; body?: unknown },
): RouteInput<Def> {
  return {
    params: route.params ? route.params.parse(raw.params) : undefined,
    query: route.query ? route.query.parse(raw.query) : undefined,
    body: route.body ? route.body.parse(raw.body) : undefined,
  } as RouteInput<Def>
}

// --- Client side ------------------------------------------------------------

type CallInput<Def extends RouteDef> = (Def['params'] extends infer P extends z.ZodObject
  ? { params: z.input<P> }
  : object) &
  (Def['query'] extends infer Q extends z.ZodObject ? { query: z.input<Q> } : object) &
  (Def['body'] extends infer B extends z.ZodType ? { body: z.input<B> } : object)

type Call<Def extends RouteDef> = keyof CallInput<Def> extends never
  ? () => Promise<z.output<Def['response']>>
  : (input: CallInput<Def>) => Promise<z.output<Def['response']>>

export type ApiClient<Routes extends RouteTree> = {
  [K in keyof Routes as Routes[K] extends { upgrade: string }
    ? never
    : K]: Routes[K] extends RouteDef
    ? Call<Routes[K]>
    : Routes[K] extends RouteTree
      ? ApiClient<Routes[K]>
      : never
}

export interface ClientOptions {
  /** The orchestrator's origin, no trailing slash. */
  baseUrl: string
  /** Injectable for tests and servers; defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch
  /** Extra headers per request — the API key's `authorization` arrives here. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>
}

function isRouteDef(value: RouteDef | RouteTree): value is RouteDef {
  return typeof value.method === 'string' && typeof value.path === 'string' && 'response' in value
}

async function callRoute(
  route: RouteDef,
  options: ClientOptions,
  input: { params?: unknown; query?: unknown; body?: unknown },
): Promise<unknown> {
  const parsed = parseRouteInput(route, input)
  let path: string = route.path
  if (parsed.params) {
    for (const [key, value] of Object.entries(parsed.params))
      path = path.replace(`:${key}`, encodeURIComponent(String(value)))
  }
  const url = new URL(`${options.baseUrl}${path}`)
  if (parsed.query) {
    for (const [key, value] of Object.entries(parsed.query)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
  }
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(await options.headers?.()),
  }
  const init: RequestInit = {
    method: route.method.toUpperCase(),
    headers,
  }
  if (parsed.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(parsed.body)
  }
  const fetchImpl = options.fetch ?? globalThis.fetch
  const response = await fetchImpl(url, init)
  if (!response.ok) {
    let code: ApiError['code'] = 'unknown_error'
    let message = `${response.status} ${response.statusText}`
    let details: Record<string, unknown> | undefined
    try {
      const envelope = errorEnvelopeSchema.parse(await response.json())
      code = envelope.error.code
      message = envelope.error.message
      details = envelope.error.details
    } catch {
      // non-JSON or unexpected error body — keep the status-line message
    }
    throw new ApiError(response.status, code, message, details)
  }
  return route.response.parse(await response.json())
}

/** Build the typed client for a route tree — the only way anything calls the Match API. */
export function createClient<const Routes extends RouteTree>(
  routes: Routes,
  options: ClientOptions,
): ApiClient<Routes> {
  const build = (node: RouteDef | RouteTree): unknown => {
    if (isRouteDef(node)) {
      return (input: Parameters<typeof callRoute>[2] = {}) => callRoute(node, options, input)
    }
    const group: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      if (isRouteDef(value) && value.upgrade) continue
      group[key] = build(value)
    }
    return group
  }
  return build(routes) as ApiClient<Routes>
}
